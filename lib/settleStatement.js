// Settle a combined-statement payment (one Stripe payment link covering several
// invoices) from a checkout.session.completed / async_payment_succeeded event.
//
// Membership — an invoice belongs to the statement if ANY of:
//   - the latest statement record the app stamped names this link
//     (metadata.statement.sessionId);
//   - the statement HISTORY names it (metadata.statementSessions[link]) — a member that
//     was re-stated later, or re-linked on its own, still belongs to the statement the
//     customer actually paid;
//   - it still carries the link as its current stripe_invoice_id (statements minted
//     before the records existed).
//
// Money rules (shared with the app's poller — src/paymentAllocation.js):
//   - what an invoice still needs is its OPEN BALANCE (total minus earlier partial
//     receipts), so a statement minted for remainders is allocated against remainders;
//   - never allocate more than was received; oldest invoice first;
//   - a short payment leaves the unpaid balance on the books and flags it for review;
//   - an overpayment is flagged for review (once per payment), never absorbed;
//   - each member records what THIS payment put on it (metadata.payments[paymentId]),
//     keyed by the payment, not the link: a redelivery only allocates what has not
//     been applied yet, a duplicate applies nothing, and a SECOND payment through the
//     same link is a new payment (flagged as overpayment when nothing is open).
//
// Every write is guarded by the row's updated_at as read; a row changed under us
// makes the settle report `conflict` and the caller re-runs from a fresh read.
// Result.failed is true when ANY database write failed — the caller must then answer
// Stripe with a non-2xx so the event is redelivered and the remaining work finishes.
const { allocatePayment, openBalance, round2, paymentIdOf, appliedByPayment } = require('./paymentAllocation');
const { writeLedger, ledgerKeysFor, paidEntry } = require('./ledger');

// Stamps a fresh updated_at itself so the lock works whether or not the table has a trigger.
async function guardedUpdate(supabase, inv, patch) {
  let q = supabase.from('invoices').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', inv.id);
  if (inv.updated_at) q = q.eq('updated_at', inv.updated_at);
  const { data, error } = await q.select('id');
  if (error) return { error, conflict: false };
  return { error: null, conflict: !data || data.length === 0 };
}

async function settleStatementByLink({ supabase, session, paidAt, amountPaid, log = console }) {
  const link = session.payment_link;
  const result = { handled: false, failed: false, conflict: false, duplicate: false, flagged: false, settled: 0, partial: 0, untouched: 0, shortfall: 0, overpayment: 0, invoiceIds: [], receiptRecorded: false };
  if (!link) return result;
  const pid = paymentIdOf(session);

  const cols = 'id, org_id, customer_id, total, status, invoice_date, amount_paid, stripe_payment_intent, metadata, updated_at';
  const [byLink, byRecord, byHistory] = await Promise.all([
    supabase.from('invoices').select(cols).eq('stripe_invoice_id', link),
    supabase.from('invoices').select(cols).eq('metadata->statement->>sessionId', link),
    supabase.from('invoices').select(cols).contains('metadata', { statementSessions: { [link]: true } }),
  ]);
  for (const q of [byLink, byRecord, byHistory]) {
    if (q.error) { log.error('Statement lookup failed:', q.error.message); result.failed = true; return result; }
  }

  const seen = new Set();
  const members = [...(byLink.data || []), ...(byRecord.data || []), ...(byHistory.data || [])].filter((inv) => {
    if (!inv || seen.has(inv.id)) return false;
    seen.add(inv.id);
    return inv.status !== 'void';
  });
  if (members.length === 0) return result; // not a statement link — caller falls through

  result.handled = true;
  result.invoiceIds = members.map((m) => m.id);
  result.receiptRecorded = members.some((m) => m.metadata && m.metadata.receipts && m.metadata.receipts[pid]);
  const orgId = members[0].org_id;
  // Members this payment already touched — by the payments record, or (rows settled by
  // the OLD statement webhook) by the stored payment intent.
  const isApplied = (m) => Boolean(appliedByPayment(m, pid))
    || (m.status === 'paid' && Boolean(session.payment_intent) && m.stripe_payment_intent === session.payment_intent);
  const appliedHere = members.filter(isApplied);
  const open = members.filter((m) => m.status !== 'paid' && !isApplied(m));

  // "Already flagged" is remembered ON THE PAYMENT (payments[pid].flagged), not read
  // from the live review: the owner resolving a review in the app must not make a
  // redelivery raise it again.
  const alreadyFlagged = members.some((m) => (appliedByPayment(m, pid) || {}).flagged);

  if (open.length === 0) {
    if (appliedHere.length > 0) {
      // Redelivery / duplicate of a payment already on the books. The ledger may still
      // be the part that failed last time — repair it (idempotent) first.
      // Only for members THIS payment actually paid (money applied, or the old
      // webhook's intent match) — never for one it merely flagged or that a check paid.
      const paidByThis = (m) => m.status === 'paid'
        && (Number((appliedByPayment(m, pid) || {}).amount) > 0
          || (Boolean(session.payment_intent) && m.stripe_payment_intent === session.payment_intent));
      const entries = {};
      appliedHere.filter(paidByThis).forEach((m) => Object.assign(entries, ledgerKeysFor(m, null, paidEntry(paidAt, round2(Number(m.amount_paid) || Number(m.total) || 0)))));
      const ledger = await writeLedger({ supabase, orgId, entries, log });
      if (ledger.failed) { result.failed = true; return result; }
      const ledgerWork = ledger.changed && !ledger.hadAny;
      // Part of this payment may still be unplaced: a member that was open when the
      // first pass allocated (or a concurrent writer) took its share elsewhere. Money
      // this payment did not manage to place is an overpayment — flag it once.
      const placed = appliedHere.reduce((s, m) => s + (Number((appliedByPayment(m, pid) || {}).amount) || 0), 0);
      const surplus = round2(Math.max(0, amountPaid - placed));
      const target = appliedHere.find((m) => appliedByPayment(m, pid));
      if (surplus > 0 && !alreadyFlagged && target) {
        const meta = { ...(target.metadata || {}) };
        meta.payments = { ...(meta.payments || {}), [pid]: { ...(meta.payments || {})[pid], flagged: true, overpayment: surplus } };
        meta.paymentReview = { reason: 'overpayment', amount: surplus, received: round2(amountPaid), invoiced: round2(placed), sessionId: link, at: paidAt };
        const w = await guardedUpdate(supabase, target, { metadata: meta });
        if (w.error) { log.error(`Statement ${link}: failed to flag surplus on ${target.id}:`, w.error.message); result.failed = true; return result; }
        if (w.conflict) { result.conflict = true; return result; }
        result.flagged = true;
        result.overpayment = surplus;
        log.warn(`Statement ${link}: $${surplus.toFixed(2)} of payment ${pid} could not be applied — flagged as overpayment on ${target.id}`);
        return result;
      }
      result.duplicate = !ledgerWork;
      log.log(`Statement ${link}: payment ${pid} already applied to ${appliedHere.length} invoice(s) — ${ledgerWork ? 'ledger repaired' : 'duplicate delivery, nothing to do'}`);
      return result;
    }
    // Every member was settled some OTHER way (check, cash, another payment) and this
    // is a further payment: money with nowhere to go. Record it against the payment so
    // a redelivery is a duplicate, and flag it.
    const first = members[0];
    const meta = { ...(first.metadata || {}) };
    meta.payments = { ...(meta.payments || {}), [pid]: { amount: 0, link, at: paidAt, overpayment: round2(amountPaid), flagged: true } };
    meta.paymentReview = { reason: 'overpayment', amount: round2(amountPaid), received: round2(amountPaid), invoiced: 0, sessionId: link, at: paidAt };
    const w = await guardedUpdate(supabase, first, { metadata: meta });
    if (w.error) { log.error(`Statement ${link}: failed to flag overpayment on ${first.id}:`, w.error.message); result.failed = true; return result; }
    if (w.conflict) { result.conflict = true; return result; }
    result.flagged = true;
    result.overpayment = round2(amountPaid);
    log.warn(`Statement ${link}: received $${amountPaid.toFixed(2)} but every member was already paid — flagged as overpayment on ${first.id}`);
    return result;
  }

  // Money this same payment already put on other members (a redelivery after a
  // partial failure) is not available again.
  const alreadyApplied = appliedHere.reduce((s, m) => s + (Number((appliedByPayment(m, pid) || {}).amount) || 0), 0);
  const available = round2(Math.max(0, amountPaid - alreadyApplied));
  const plan = allocatePayment(open.map((m) => ({ id: m.id, total: openBalance(m), date: m.invoice_date })), available);
  result.shortfall = plan.shortfall;
  result.overpayment = plan.overpayment;
  const invoiced = round2(open.reduce((s, m) => s + openBalance(m), 0));
  if (plan.shortfall > 0) log.warn(`Statement ${link}: $${available.toFixed(2)} available against $${invoiced.toFixed(2)} open — $${plan.shortfall.toFixed(2)} stays receivable`);
  if (plan.overpayment > 0) log.warn(`Statement ${link}: $${available.toFixed(2)} available but only $${invoiced.toFixed(2)} open — $${plan.overpayment.toFixed(2)} overpayment flagged for review`);
  // One overpayment flag per payment (alreadyFlagged): a redelivery after a partial
  // failure must not flag a second member when the first delivery already flagged one.
  const ledgerEntries = {};
  const reviewBase = { sessionId: link, received: round2(amountPaid), invoiced, at: paidAt };
  let firstSettled = true;
  for (const line of plan.lines) {
    const inv = open.find((m) => m.id === line.id);
    const meta = { ...(inv.metadata || {}) };
    const prior = Number(meta.partialPayment && meta.partialPayment.received) || 0;
    meta.payments = { ...(meta.payments || {}), [pid]: { amount: line.allocated, link, at: paidAt } };
    let patch;
    if (line.settled) {
      delete meta.partialPayment;
      if (plan.overpayment > 0 && firstSettled && !alreadyFlagged) {
        meta.paymentReview = { ...reviewBase, reason: 'overpayment', amount: plan.overpayment };
        meta.payments[pid].flagged = true;
      } else delete meta.paymentReview;
      firstSettled = false;
      patch = { status: 'paid', payment_date: paidAt, payment_method: 'stripe', amount_paid: round2(prior + line.allocated), stripe_payment_intent: session.payment_intent || '', metadata: meta };
    } else {
      // Short: keep the balance open and flag it. Status stays as it was.
      if (line.allocated > 0) meta.partialPayment = { received: round2(prior + line.allocated), sessionId: link, at: paidAt };
      meta.paymentReview = { ...reviewBase, reason: 'short', amount: round2(line.own - line.allocated) };
      patch = { amount_paid: round2(prior + line.allocated), metadata: meta };
    }
    const w = await guardedUpdate(supabase, inv, patch);
    if (w.error) {
      log.error(`Statement ${link}: failed to update invoice ${inv.id}:`, w.error.message);
      result.failed = true;
      continue;
    }
    if (w.conflict) { result.conflict = true; continue; } // caller re-runs from a fresh read; what landed is idempotent
    if (line.settled) {
      result.settled += 1;
      Object.assign(ledgerEntries, ledgerKeysFor(inv, null, paidEntry(paidAt, round2(prior + line.allocated))));
    } else if (line.partial) result.partial += 1;
    else result.untouched += 1;
  }

  const ledger = await writeLedger({ supabase, orgId, entries: ledgerEntries, log });
  if (ledger.failed) result.failed = true;
  log.log(`Statement ${link}: ${result.settled} settled, ${result.partial} partial, ${result.untouched} untouched${result.failed ? ' — WITH FAILURES (will retry)' : ''}${result.conflict ? ' — CONFLICT (re-reading)' : ''}`);
  return result;
}

module.exports = { settleStatementByLink };
