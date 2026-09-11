// The organizations.paid_invoices ledger — the "durable" paid store the billing UI
// reads. Merges are upgrade-only (a key already marked paid is never overwritten), so
// a redelivery can safely re-run them. The write is guarded by the organization row's
// updated_at (optimistic lock) and retried from a fresh read on conflict, so two
// settlements merging at the same moment both keep their keys.
//
// Returns { failed, changed, hadAny }: `changed` = at least one key was newly written;
// `hadAny` = at least one of the keys was already paid before this call (so a change
// was a top-up of an existing record, not the first record of the payment).
async function writeLedger({ supabase, orgId, entries, log = console, maxAttempts = 5 }) {
  const keys = Object.keys(entries || {});
  if (!orgId || keys.length === 0) return { failed: false, changed: false, hadAny: false };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { data: org, error: readErr } = await supabase.from('organizations').select('paid_invoices, updated_at').eq('id', orgId).single();
    if (readErr || !org) { log.error('Paid ledger read failed:', readErr ? readErr.message : 'organization not found'); return { failed: true, changed: false, hadAny: false }; }
    const merged = { ...(org.paid_invoices || {}) };
    let changed = false;
    let hadAny = false;
    keys.forEach((k) => {
      if (merged[k] && merged[k].paid) hadAny = true;
      else { merged[k] = entries[k]; changed = true; }
    });
    if (!changed) return { failed: false, changed: false, hadAny };
    let q = supabase.from('organizations').update({ paid_invoices: merged, updated_at: new Date().toISOString() }).eq('id', orgId);
    if (org.updated_at) q = q.eq('updated_at', org.updated_at);
    const { data: written, error: writeErr } = await q.select('id');
    if (writeErr) { log.error('Paid ledger write failed:', writeErr.message); return { failed: true, changed: false, hadAny }; }
    if (written && written.length > 0) return { failed: false, changed: true, hadAny };
    log.warn(`Paid ledger changed under us (attempt ${attempt}) — re-reading`);
  }
  log.error('Paid ledger: still contended after retries — leaving for redelivery');
  return { failed: true, changed: false, hadAny: false };
}

// Every key the app looks a paid invoice up by: bare id, customer-month, job, quote,
// and each service on the invoice.
function ledgerKeysFor(inv, sessionMeta, entry) {
  const m = inv.metadata || {};
  const out = { [inv.id]: entry };
  const billingMonth = m.billingMonth || (sessionMeta && sessionMeta.billingMonth) || '';
  const customerId = inv.customer_id || (sessionMeta && sessionMeta.customerId) || '';
  if (billingMonth && customerId) out[`${customerId}-${billingMonth}`] = entry;
  const jobId = m.jobId || (sessionMeta && sessionMeta.jobId) || '';
  if (jobId) out[`job-${jobId}`] = entry;
  const quoteId = m.quoteId || (sessionMeta && sessionMeta.quoteId) || '';
  if (quoteId) out[`quote-inv-${quoteId}`] = entry;
  (Array.isArray(m.serviceIds) ? m.serviceIds : []).forEach((sid) => { out[`job-${sid}`] = entry; });
  return out;
}

const paidEntry = (paidAt, amount) => ({ paid: true, method: 'electronic', source: 'Stripe', paidDate: paidAt, amount });

module.exports = { writeLedger, ledgerKeysFor, paidEntry };
