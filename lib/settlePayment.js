// Turn a paid Stripe checkout session into invoice + ledger updates.
//
//   settleCheckoutSession({ supabase, session }) →
//     { failed, duplicate, handled, mode, detail }
//
// The single-invoice path (session.metadata.invoiceNumber names one invoice row) and
// the combined-statement path (the payment link is stamped on several rows) share
// the same money rules — see lib/paymentAllocation.js and lib/settleStatement.js.
// Idempotency keys on the PAYMENT (metadata.payments[paymentId]), never on the link.
//
// Concurrency: every invoice write is guarded by the row's updated_at as read
// (optimistic lock). If another writer (a second payment's event, the app's poller)
// changed the row in between, the write matches nothing, the settle reports
// `conflict`, and settleCheckoutSession re-runs it from a fresh read — so two
// payments landing on one invoice at once both end up recorded.
//
//   failed    → the caller must answer Stripe with a non-2xx so the event is redelivered
//   duplicate → this exact payment is already fully on the books (no receipt)
const { allocatePayment, openBalance, round2, paymentIdOf, appliedByPayment } = require('./paymentAllocation');
const { settleStatementByLink } = require('./settleStatement');
const { writeLedger, ledgerKeysFor, paidEntry } = require('./ledger');

// Invoice numbers are not guaranteed unique (a voided and re-issued job invoice share
// one). Pick the row this payment is really for: the id stamped on the payment link
// wins; then the live row carrying this link; then any live unpaid row; then any live
// row. Only void rows left → the void row (the caller flags, never settles, it).
function pickInvoiceRow(rows, session) {
  const meta = session.metadata || {};
  const link = session.payment_link;
  const byId = meta.invoiceId && rows.find((r) => r.id === meta.invoiceId);
  if (byId) return byId;
  const live = rows.filter((r) => r.status !== 'void');
  if (live.length === 0) return rows[0] || null;
  return live.find((r) => link && r.stripe_invoice_id === link)
    || live.find((r) => r.status !== 'paid')
    || live[0];
}

// Update guarded by the row version we read. { error, conflict }. The write stamps a
// fresh updated_at itself so the lock works whether or not the table has a trigger.
async function guardedUpdate(supabase, inv, patch) {
  let q = supabase.from('invoices').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', inv.id);
  if (inv.updated_at) q = q.eq('updated_at', inv.updated_at);
  const { data, error } = await q.select('id');
  if (error) return { error, conflict: false };
  return { error: null, conflict: !data || data.length === 0 };
}

async function settleSingleInvoice({ supabase, session, paidAt, amountPaid, log }) {
  const number = session.metadata && session.metadata.invoiceNumber;
  const result = { handled: false, failed: false, conflict: false, duplicate: false, flagged: false, settled: false, partial: false, ledger: {}, orgId: null };
  if (!number) return result;
  const { data: rows, error } = await supabase.from('invoices')
    .select('id, org_id, customer_id, total, status, invoice_number, invoice_date, stripe_invoice_id, stripe_payment_intent, amount_paid, metadata, updated_at')
    .eq('invoice_number', number)
    .order('created_at', { ascending: false })
    .limit(10);
  if (error) { log.error(`Invoice ${number}: lookup failed:`, error.message); result.failed = true; return result; }
  const inv = pickInvoiceRow(rows || [], session);
  if (!inv) return result; // no such row (statement STMT- numbers land here)

  result.handled = true;
  result.orgId = inv.org_id;
  const link = session.payment_link || session.id;
  const pid = paymentIdOf(session);
  const meta = { ...(inv.metadata || {}) };
  const applied = appliedByPayment(inv, pid);
  // Rows settled by the old webhook carry the payment intent but no payments map.
  const legacySame = inv.status === 'paid' && Boolean(session.payment_intent) && inv.stripe_payment_intent === session.payment_intent;

  result.invoiceIds = [inv.id];
  result.receiptRecorded = receiptRecordedOn(inv, pid);

  if (applied || legacySame) {
    // Redelivery / duplicate of this exact payment. Only a missing ledger key can be
    // outstanding (the caller merges it, idempotently) — and only when this payment is
    // what actually paid the invoice, not when it was merely flagged against it.
    result.duplicate = true;
    const paidByThis = legacySame || (applied && Number(applied.amount) > 0);
    if (inv.status === 'paid' && paidByThis) {
      result.settled = true;
      result.ledger = ledgerKeysFor(inv, session.metadata, paidEntry(paidAt, round2(Number(inv.amount_paid) || Number(inv.total) || 0)));
    }
    return result;
  }

  if (inv.status === 'paid' || inv.status === 'void') {
    // Paid some other way (check, another payment), or CANCELLED, and money arrived for
    // it anyway: record the payment so a redelivery is a duplicate, flag it for review,
    // and never touch the status.
    meta.payments = { ...(meta.payments || {}), [pid]: { amount: 0, link, at: paidAt, overpayment: round2(amountPaid), flagged: true } };
    meta.paymentReview = { reason: 'overpayment', amount: round2(amountPaid), received: round2(amountPaid), invoiced: 0, sessionId: link, at: paidAt, note: inv.status === 'void' ? 'paid against a voided invoice' : undefined };
    const w = await guardedUpdate(supabase, inv, { metadata: meta });
    if (w.error) { log.error(`Invoice ${number}: failed to flag overpayment:`, w.error.message); result.failed = true; return result; }
    if (w.conflict) { result.conflict = true; return result; }
    result.flagged = true;
    log.warn(`Invoice ${number}: ${inv.status}, received $${amountPaid.toFixed(2)} via ${link} — flagged for review`);
    return result;
  }

  const balance = openBalance(inv);
  const prior = Number(meta.partialPayment && meta.partialPayment.received) || 0;
  const plan = allocatePayment([{ id: inv.id, total: balance, date: inv.invoice_date }], amountPaid);
  const line = plan.lines[0];
  meta.payments = { ...(meta.payments || {}), [pid]: { amount: line.allocated, link, at: paidAt } };
  let patch;
  if (line.settled) {
    delete meta.partialPayment;
    if (plan.overpayment > 0) { meta.paymentReview = { reason: 'overpayment', amount: plan.overpayment, received: round2(amountPaid), invoiced: balance, sessionId: link, at: paidAt }; meta.payments[pid].flagged = true; }
    else delete meta.paymentReview;
    patch = { status: 'paid', payment_date: paidAt, payment_method: 'stripe', amount_paid: round2(prior + line.allocated), stripe_payment_intent: session.payment_intent || '', metadata: meta };
  } else {
    if (line.allocated > 0) meta.partialPayment = { received: round2(prior + line.allocated), sessionId: link, at: paidAt };
    meta.paymentReview = { reason: 'short', amount: round2(balance - line.allocated), received: round2(amountPaid), invoiced: balance, sessionId: link, at: paidAt };
    patch = { amount_paid: round2(prior + line.allocated), stripe_payment_intent: session.payment_intent || '', metadata: meta };
    log.warn(`Invoice ${number}: received $${amountPaid.toFixed(2)} against $${balance.toFixed(2)} open — $${(balance - line.allocated).toFixed(2)} stays receivable`);
  }
  const w = await guardedUpdate(supabase, inv, patch);
  if (w.error) { log.error(`Invoice ${number}: update failed:`, w.error.message); result.failed = true; return result; }
  if (w.conflict) { result.conflict = true; return result; }
  if (line.settled) {
    result.settled = true;
    result.ledger = ledgerKeysFor(inv, session.metadata, paidEntry(paidAt, round2(prior + line.allocated)));
  } else {
    result.partial = true;
  }
  return result;
}

// Remember that the customer was sent a receipt for this payment (on the first
// invoice the payment touched), so a redelivery does not send a second one. Receipts
// are decoupled from "did this delivery do work": the app's settle endpoint may have
// recorded the payment first, and the customer still deserves exactly one receipt.
// The marker lives in its OWN map (metadata.receipts[pid]) — never in `payments`,
// which means "money this payment put here" and drives allocation decisions.
async function markReceiptSent({ supabase, invoiceId, session, log = console, maxAttempts = 3 }) {
  const pid = paymentIdOf(session);
  if (!invoiceId || !pid) return false;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { data: inv, error } = await supabase.from('invoices').select('id, metadata, updated_at').eq('id', invoiceId).maybeSingle();
    if (error || !inv) { log.warn(`Receipt marker: could not read invoice ${invoiceId}:`, error ? error.message : 'not found'); return false; }
    const meta = { ...(inv.metadata || {}) };
    meta.receipts = { ...(meta.receipts || {}), [pid]: new Date().toISOString() };
    const w = await guardedUpdate(supabase, inv, { metadata: meta });
    if (w.error) { log.warn(`Receipt marker: write failed for ${invoiceId}:`, w.error.message); return false; }
    if (!w.conflict) return true;
  }
  return false;
}
const receiptRecordedOn = (inv, pid) => Boolean(inv && inv.metadata && inv.metadata.receipts && inv.metadata.receipts[pid]);

async function settleOnce({ supabase, session, paidAt, amountPaid, log }) {
  const out = { failed: false, conflict: false, duplicate: false, handled: false, mode: 'none', detail: null, invoiceIds: [], receiptRecorded: false };
  const meta = session.metadata || {};

  const single = await settleSingleInvoice({ supabase, session: { ...session, metadata: meta }, paidAt, amountPaid, log });
  if (single.failed) { out.failed = true; out.mode = 'single'; out.detail = single; return out; }
  if (single.conflict) { out.conflict = true; out.mode = 'single'; out.detail = single; return out; }
  if (single.handled) {
    out.handled = true; out.mode = 'single'; out.detail = single;
    out.invoiceIds = single.invoiceIds || []; out.receiptRecorded = Boolean(single.receiptRecorded);
    const ledger = await writeLedger({ supabase, orgId: single.orgId, entries: single.ledger, log });
    if (ledger.failed) out.failed = true;
    // A re-delivery of a recorded payment is a duplicate unless it is the first time
    // ANY ledger key for the invoice got written (the earlier delivery failed before
    // the ledger and never sent a receipt).
    out.duplicate = single.duplicate && (!ledger.changed || ledger.hadAny);
    if (!out.duplicate && !out.failed) log.log(`Invoice ${meta.invoiceNumber}: ${single.settled ? 'paid' : single.partial ? 'partially paid' : 'flagged'} ($${amountPaid.toFixed(2)})`);
    return out;
  }

  // Not a single invoice row — try the combined-statement link.
  const stmt = await settleStatementByLink({ supabase, session, paidAt, amountPaid, log });
  if (stmt.handled) {
    out.handled = true; out.mode = 'statement'; out.detail = stmt;
    out.failed = stmt.failed;
    out.conflict = stmt.conflict;
    out.duplicate = stmt.duplicate;
    out.invoiceIds = stmt.invoiceIds || []; out.receiptRecorded = Boolean(stmt.receiptRecorded);
    return out;
  }
  log.warn(`Checkout ${session.id}: no invoice matched ${meta.invoiceNumber || '(no number)'} or link ${session.payment_link || '(none)'} — nothing recorded`);
  return out;
}

async function settleCheckoutSession({ supabase, session, log = console, now = () => new Date(), maxAttempts = 4 }) {
  const paidAt = now().toISOString();
  const amountPaid = round2((Number(session.amount_total) || 0) / 100);
  let out = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    out = await settleOnce({ supabase, session, paidAt, amountPaid, log });
    if (!out.conflict) return out;
    log.warn(`Checkout ${session.id}: invoice changed under us (attempt ${attempt}) — re-reading`);
  }
  // Still contended after several fresh reads: let Stripe redeliver rather than guess.
  out.failed = true;
  return out;
}

module.exports = { settleCheckoutSession, settleSingleInvoice, pickInvoiceRow, guardedUpdate, markReceiptSent, receiptRecordedOn };
