// Allocate one received payment across the invoices it was meant to cover.
//
// Rules (shared with the frontend poller — keep src/paymentAllocation.js in step):
//   - never allocate more than was received;
//   - oldest invoice first (date asc, then id) so the longest-standing balance clears;
//   - an invoice is "settled" only when its full amount is covered; a partially covered
//     one keeps its remaining balance open; anything beyond the invoices is an
//     overpayment to be reviewed, never silently absorbed.
// Callers pass each member's OPEN amount as `total` (see openBalance) — after an
// earlier short payment that is the remainder, not the invoice total.
// Works in integer cents so $0.10 + $0.20 style float drift can't flip a line.
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function allocatePayment(members, received) {
  const cents = (n) => Math.round((Number(n) || 0) * 100);
  const sorted = [...(members || [])].sort((a, b) =>
    String(a.date || '').localeCompare(String(b.date || '')) || String(a.id).localeCompare(String(b.id)));
  let remaining = Math.max(0, cents(received));
  const lines = sorted.map((m) => {
    const own = Math.max(0, cents(m.total));
    const allocated = Math.min(own, remaining);
    remaining -= allocated;
    return {
      id: m.id,
      own: own / 100,
      allocated: allocated / 100,
      settled: allocated >= own,          // a $0 balance settles trivially
      partial: allocated > 0 && allocated < own,
    };
  });
  const shortfall = lines.reduce((s, l) => s + (l.own - l.allocated), 0);
  return {
    lines,
    shortfall: round2(shortfall),
    overpayment: remaining / 100,
  };
}

// What an invoice row still needs: its total less any earlier partial receipt
// (metadata.partialPayment.received), never below zero. Accepts a DB row (snake
// case) or an app invoice (camel case).
function openBalance(inv) {
  const total = Number(inv.total != null ? inv.total : inv.amount) || 0;
  const meta = inv.metadata || {};
  const prior = Number(meta.partialPayment && meta.partialPayment.received) || 0;
  return round2(Math.max(0, total - prior));
}

// The identity of a PAYMENT (not of the link it came through): a payment link can be
// paid more than once, and one payment's event can be redelivered — idempotency has
// to key on the payment itself. Checkout Sessions carry a payment_intent once paid;
// the session id is the fallback.
function paymentIdOf(session) {
  return String(session.payment_intent || session.id || '');
}

// What a given payment already put on an invoice (metadata.payments[paymentId]).
function appliedByPayment(inv, paymentId) {
  const p = inv && inv.metadata && inv.metadata.payments;
  return p && paymentId && p[paymentId] ? p[paymentId] : null;
}

module.exports = { allocatePayment, openBalance, round2, paymentIdOf, appliedByPayment };
