// Run: npm test   (plain node, no framework)
// Exercises lib/settlePayment.js + lib/settleStatement.js against an in-memory fake
// of the Supabase client. Covers the failure cases from the September 2026 external
// review and the adversarial passes that followed: replacement links, short payments,
// partial database failure + Stripe redelivery, duplicates keyed on the PAYMENT (not
// the link), a second checkout through the same link, redelivery of an earlier link's
// event after a later link was paid, remainder links after a short payment, a
// statement paid after its members were settled by check, re-stated statements
// (history), and ledger repair on redelivery.
const assert = require('assert');
const { settleStatementByLink } = require('../lib/settleStatement');
const { settleCheckoutSession } = require('../lib/settlePayment');

// ---- minimal fake supabase --------------------------------------------------------
const clone = (o) => JSON.parse(JSON.stringify(o));
const getPath = (row, col) => {
  if (!col.includes('->')) return row[col];
  const parts = col.split(/->>?/);
  let v = row[parts[0]];
  for (let i = 1; i < parts.length && v != null; i++) v = v[parts[i]];
  return v;
};
const containsDeep = (hay, needle) => {
  if (needle === null || typeof needle !== 'object') return hay === needle;
  if (hay === null || typeof hay !== 'object') return false;
  return Object.keys(needle).every((k) => containsDeep(hay[k], needle[k]));
};
function fakeSupabase(state, opts = {}) {
  return {
    from(table) {
      const rows = state[table];
      return {
        select(cols) {
          const filters = [];
          let max = Infinity;
          const exec = () => {
            if (opts.failSelect && opts.failSelect(table, cols, filters)) return { data: null, error: { message: 'simulated read failure' } };
            const out = rows.filter((r) => filters.every((f) => f(r))).map(clone);
            return { data: out.slice(0, max), error: null };
          };
          if (opts.latency) {
            const delayed = (fn) => new Promise((r) => setTimeout(() => r(fn()), opts.latency));
            const lazy = {
              eq(c, v) { filters.push((r) => getPath(r, c) === v); return lazy; },
              contains(c, obj) { filters.push((r) => containsDeep(r[c], obj)); return lazy; },
              order() { return lazy; },
              limit(n) { max = n; return lazy; },
              single() { return delayed(() => { const r = exec(); if (r.error) return r; return r.data.length === 1 ? { data: r.data[0], error: null } : { data: null, error: { message: 'PGRST116' } }; }); },
              maybeSingle() { return delayed(() => { const r = exec(); if (r.error) return r; return r.data.length > 1 ? { data: null, error: { message: 'PGRST116' } } : { data: r.data[0] || null, error: null }; }); },
              then(res, rej) { return delayed(exec).then(res, rej); },
            };
            return lazy;
          }
          const chain = {
            eq(c, v) { filters.push((r) => getPath(r, c) === v); return chain; },
            contains(c, obj) { filters.push((r) => containsDeep(r[c], obj)); return chain; },
            order() { return chain; },
            limit(n) { max = n; return chain; },
            single() { const r = exec(); if (r.error) return Promise.resolve(r); if (r.data.length !== 1) return Promise.resolve({ data: null, error: { message: 'PGRST116' } }); return Promise.resolve({ data: r.data[0], error: null }); },
            maybeSingle() { const r = exec(); if (r.error) return Promise.resolve(r); if (r.data.length > 1) return Promise.resolve({ data: null, error: { message: 'PGRST116' } }); return Promise.resolve({ data: r.data[0] || null, error: null }); },
            then(res, rej) { return Promise.resolve(exec()).then(res, rej); },
          };
          return chain;
        },
        update(patch) {
          // Mirrors PostgREST: filters accumulate, the write happens when awaited; the
          // fake bumps updated_at like the table trigger so optimistic locks are real.
          const filters = [];
          const run = () => {
            const id = (filters.find((f) => f.c === 'id') || {}).v;
            if (opts.failUpdate && opts.failUpdate(table, patch, id)) return { data: null, error: { message: 'simulated write failure' } };
            const targets = rows.filter((r) => filters.every((f) => getPath(r, f.c) === f.v));
            targets.forEach((r) => { Object.assign(r, clone(patch)); r.updated_at = String((state.tick = (state.tick || 0) + 1)); });
            return { data: targets.map(clone), error: null };
          };
          const chain = {
            eq(c, v) { filters.push({ c, v }); return chain; },
            select() { const p = opts.latency ? new Promise((r) => setTimeout(() => r(run()), opts.latency)) : Promise.resolve(run()); return p; },
            then(res, rej) { return Promise.resolve(run()).then(res, rej); },
          };
          return chain;
        },
      };
    },
  };
}
const quiet = { log() {}, warn() {}, error() {} };
const ORG = 'org-1';
const LINK = 'plink_STATEMENT';
const AT = '2026-09-06T00:00:00.000Z';
const session = (amount, { link = LINK, number = 'STMT-1', intent = 'pi_1', id = 'cs_1', extraMeta = {} } = {}) =>
  ({ id, payment_link: link, amount_total: Math.round(amount * 100), payment_intent: intent, payment_status: 'paid', metadata: { invoiceNumber: number, ...extraMeta } });
const inv = (id, total, extra = {}) => ({ id, org_id: ORG, customer_id: 'cust-1', invoice_number: extra.number || `INV-${id}`, total, status: extra.status || 'sent', invoice_date: extra.date || '2026-08-01', stripe_invoice_id: extra.link || LINK, stripe_payment_intent: extra.intent || '', amount_paid: extra.amount_paid || 0, metadata: extra.metadata || { billingMonth: extra.month || null }, updated_at: '0' /* real rows always carry one */ });
const freshState = (invoices) => ({ invoices: clone(invoices), organizations: [{ id: ORG, paid_invoices: {}, updated_at: '0' }] });
const runStmt = (state, amount, opts, sess) => settleStatementByLink({ supabase: fakeSupabase(state, opts), session: sess || session(amount), paidAt: AT, amountPaid: amount, log: quiet });
const runSession = (state, sess, opts) => settleCheckoutSession({ supabase: fakeSupabase(state, opts), session: sess, log: quiet, now: () => new Date(AT) });
const get = (state, id) => state.invoices.find((i) => i.id === id);
const ledger = (state) => state.organizations[0].paid_invoices;

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ───────── statements ─────────
test('plain statement: $300 over $100 + $200 settles each for its own total', async () => {
  const state = freshState([inv('a', 100, { date: '2026-07-01', month: '2026-07' }), inv('b', 200, { date: '2026-08-01', month: '2026-08' })]);
  const r = await runStmt(state, 300);
  assert.strictEqual(r.handled, true); assert.strictEqual(r.failed, false); assert.strictEqual(r.settled, 2);
  assert.strictEqual(get(state, 'a').status, 'paid'); assert.strictEqual(get(state, 'a').amount_paid, 100);
  assert.strictEqual(get(state, 'b').status, 'paid'); assert.strictEqual(get(state, 'b').amount_paid, 200);
  assert.deepStrictEqual(get(state, 'a').metadata.payments, { pi_1: { amount: 100, link: LINK, at: AT } });
  assert.strictEqual(ledger(state).a.amount, 100); assert.strictEqual(ledger(state).b.amount, 200);
  assert.strictEqual(ledger(state)['cust-1-2026-07'].amount, 100); assert.strictEqual(ledger(state)['cust-1-2026-08'].amount, 200);
});

test('replacement link: a member re-linked after minting still settles from the original statement', async () => {
  const record = { sessionId: LINK, number: 'STMT-1', invoiceIds: ['a', 'b'], total: 300 };
  const state = freshState([inv('a', 100, { link: 'plink_REPLACEMENT', metadata: { statement: record } }), inv('b', 200, { metadata: { statement: record } })]);
  const r = await runStmt(state, 300);
  assert.strictEqual(r.settled, 2);
  assert.strictEqual(get(state, 'a').amount_paid, 100, 'a must get its own $100');
  assert.strictEqual(get(state, 'b').amount_paid, 200, 'b must NOT be credited the whole $300');
});

test('re-stated: the OLD statement link is paid after a new statement replaced the record — history still finds its members', async () => {
  const S1 = 'plink_S1', S2 = 'plink_S2';
  const hist = { [S1]: true, [S2]: true };
  const state = freshState([
    inv('a', 100, { date: '2026-07-01', link: S2, metadata: { statement: { sessionId: S2 }, statementSessions: hist } }),
    inv('b', 200, { date: '2026-08-01', link: S2, metadata: { statement: { sessionId: S2 }, statementSessions: hist } }),
    inv('c', 150, { date: '2026-09-01', link: S2, metadata: { statement: { sessionId: S2 }, statementSessions: { [S2]: true } } }),
  ]);
  const r = await runStmt(state, 300, {}, session(300, { link: S1, number: 'STMT-1' }));
  assert.strictEqual(r.handled, true, 'S1 must still resolve to a and b');
  assert.strictEqual(r.settled, 2);
  assert.strictEqual(get(state, 'a').status, 'paid'); assert.strictEqual(get(state, 'b').status, 'paid');
  assert.strictEqual(get(state, 'c').status, 'sent', 'c was never on S1');
  // Now S2 ($450) is paid too: a and b already paid → only c open → $300 overpayment flagged
  const r2 = await runStmt(state, 450, {}, session(450, { link: S2, number: 'STMT-2', intent: 'pi_2', id: 'cs_2' }));
  assert.strictEqual(r2.settled, 1); assert.strictEqual(r2.overpayment, 300);
  assert.strictEqual(get(state, 'c').metadata.paymentReview.reason, 'overpayment');
});

test('short payment: $300 against $100 + $250 leaves $50 receivable and flags review', async () => {
  const state = freshState([inv('a', 100, { date: '2026-07-01' }), inv('b', 250, { date: '2026-08-01' })]);
  const r = await runStmt(state, 300);
  assert.strictEqual(r.settled, 1); assert.strictEqual(r.partial, 1); assert.strictEqual(r.shortfall, 50);
  const b = get(state, 'b');
  assert.strictEqual(get(state, 'a').status, 'paid');
  assert.strictEqual(b.status, 'sent', 'partially covered invoice stays open');
  assert.strictEqual(b.amount_paid, 200);
  assert.deepStrictEqual(b.metadata.partialPayment, { received: 200, sessionId: LINK, at: AT });
  assert.strictEqual(b.metadata.paymentReview.reason, 'short'); assert.strictEqual(b.metadata.paymentReview.amount, 50);
  assert.strictEqual(b.metadata.payments.pi_1.amount, 200);
  assert.ok(ledger(state).a); assert.ok(!ledger(state).b, 'no paid ledger entry for a partially paid invoice');
});

test('redelivery after a partial DB failure finishes with only the money not yet applied (short payment)', async () => {
  const state = freshState([inv('a', 100, { date: '2026-07-01' }), inv('b', 250, { date: '2026-08-01' })]);
  let failedOnce = false;
  const first = await runStmt(state, 300, { failUpdate: (t, p, id) => { if (t === 'invoices' && id === 'b' && !failedOnce) { failedOnce = true; return true; } return false; } });
  assert.strictEqual(first.failed, true);
  const second = await runStmt(state, 300);
  assert.strictEqual(second.failed, false); assert.strictEqual(second.partial, 1); assert.strictEqual(second.settled, 0);
  assert.strictEqual(get(state, 'a').amount_paid, 100, 'a not re-applied');
  assert.strictEqual(get(state, 'b').amount_paid, 200, 'b gets 300 - 100 already applied');
  const third = await runStmt(state, 300);
  assert.strictEqual(third.duplicate, true); assert.strictEqual(third.settled + third.partial + third.untouched, 0);
});

test('redelivery after a partial DB failure (exact payment) completes and then reports duplicate', async () => {
  const state = freshState([inv('a', 100, { date: '2026-07-01' }), inv('b', 200, { date: '2026-08-01' })]);
  let failedOnce = false;
  const first = await runStmt(state, 300, { failUpdate: (t, p, id) => { if (t === 'invoices' && id === 'b' && !failedOnce) { failedOnce = true; return true; } return false; } });
  assert.strictEqual(first.failed, true);
  const second = await runStmt(state, 300);
  assert.strictEqual(second.failed, false); assert.strictEqual(second.settled, 1);
  assert.ok(ledger(state).a && ledger(state).b, 'ledger complete after retry');
  const third = await runStmt(state, 300);
  assert.strictEqual(third.duplicate, true);
});

test('ledger write fails after every member row saved → failed; redelivery repairs the ledger (not a bare duplicate)', async () => {
  const state = freshState([inv('a', 100, { month: '2026-07' }), inv('b', 200, { month: '2026-08' })]);
  const r = await runStmt(state, 300, { failUpdate: (table) => table === 'organizations' });
  assert.strictEqual(r.failed, true); assert.strictEqual(r.settled, 2);
  assert.deepStrictEqual(ledger(state), {});
  const again = await runStmt(state, 300);
  assert.strictEqual(again.failed, false); assert.strictEqual(again.duplicate, false, 'ledger was repaired on this delivery');
  assert.ok(ledger(state).a && ledger(state).b && ledger(state)['cust-1-2026-07'] && ledger(state)['cust-1-2026-08']);
  const third = await runStmt(state, 300);
  assert.strictEqual(third.duplicate, true);
});

test('overpayment: $300 against the one $200 invoice still open is flagged, not absorbed', async () => {
  const state = freshState([inv('a', 100, { status: 'paid', amount_paid: 100 }), inv('b', 200)]);
  const r = await runStmt(state, 300);
  assert.strictEqual(r.settled, 1); assert.strictEqual(r.overpayment, 100);
  assert.strictEqual(get(state, 'b').metadata.paymentReview.reason, 'overpayment'); assert.strictEqual(get(state, 'b').metadata.paymentReview.amount, 100);
});

test('statement paid after every member was settled by check: flagged as overpayment, NOT a duplicate; its redelivery IS a duplicate', async () => {
  const state = freshState([inv('a', 100, { status: 'paid', amount_paid: 100 }), inv('b', 200, { status: 'paid', amount_paid: 200 })]);
  state.organizations[0].paid_invoices = { a: { paid: true, method: 'check', amount: 100 }, b: { paid: true, method: 'check', amount: 200 } };
  const r = await runStmt(state, 300);
  assert.strictEqual(r.duplicate, false); assert.strictEqual(r.flagged, true); assert.strictEqual(r.overpayment, 300);
  assert.strictEqual(get(state, 'a').metadata.paymentReview.amount, 300);
  const again = await runStmt(state, 300);
  assert.strictEqual(again.duplicate, true);
});

test('a SECOND checkout through the same statement link is a new payment: flagged as overpayment, not a duplicate', async () => {
  const state = freshState([inv('a', 100, { date: '2026-07-01' }), inv('b', 200, { date: '2026-08-01' })]);
  await runStmt(state, 300);
  const r = await runStmt(state, 300, {}, session(300, { intent: 'pi_2', id: 'cs_2' }));
  assert.strictEqual(r.duplicate, false); assert.strictEqual(r.flagged, true); assert.strictEqual(r.overpayment, 300);
  assert.ok(get(state, 'a').metadata.payments.pi_2, 'second payment recorded');
});

test('remainder statement: after a short payment, a new statement for the remainders settles them fully', async () => {
  const state = freshState([inv('a', 100, { date: '2026-07-01' }), inv('b', 250, { date: '2026-08-01' }), inv('c', 100, { date: '2026-08-15', link: 'plink_NONE' })]);
  await runStmt(state, 300);
  assert.strictEqual(get(state, 'b').amount_paid, 200);
  const S2 = 'plink_S2';
  const rec = { sessionId: S2, number: 'STMT-2', invoiceIds: ['b', 'c'], total: 150, amounts: { b: 50, c: 100 } };
  get(state, 'b').stripe_invoice_id = S2; get(state, 'b').metadata.statement = rec;
  get(state, 'c').stripe_invoice_id = S2; get(state, 'c').metadata.statement = rec;
  const r = await runStmt(state, 150, {}, session(150, { link: S2, number: 'STMT-2', intent: 'pi_2', id: 'cs_2' }));
  assert.strictEqual(r.settled, 2); assert.strictEqual(r.shortfall, 0); assert.strictEqual(r.overpayment, 0);
  const b = get(state, 'b');
  assert.strictEqual(b.status, 'paid'); assert.strictEqual(b.amount_paid, 250, 'prior $200 + $50 remainder');
  assert.ok(!b.metadata.partialPayment); assert.ok(!b.metadata.paymentReview);
  assert.strictEqual(ledger(state).b.amount, 250);
});

test('link that is not a statement is left to the single-invoice path', async () => {
  const state = freshState([inv('a', 100, { link: 'plink_OTHER' })]);
  const r = await runStmt(state, 100);
  assert.strictEqual(r.handled, false);
});

// ───────── whole session (single-invoice path + fallthrough) ─────────
test('single invoice paid in full: paid, ledger keys written', async () => {
  const state = freshState([inv('a', 150, { number: 'INV-100', link: 'plink_ONE', month: '2026-08' })]);
  const r = await runSession(state, session(150, { link: 'plink_ONE', number: 'INV-100', extraMeta: { customerId: 'cust-1', billingMonth: '2026-08' } }));
  assert.strictEqual(r.failed, false); assert.strictEqual(r.duplicate, false); assert.strictEqual(r.mode, 'single');
  const a = get(state, 'a');
  assert.strictEqual(a.status, 'paid'); assert.strictEqual(a.amount_paid, 150); assert.strictEqual(a.stripe_payment_intent, 'pi_1');
  assert.ok(ledger(state).a); assert.ok(ledger(state)['cust-1-2026-08']);
});

test('single invoice short payment: stays open with the remainder receivable; redelivery applies nothing', async () => {
  const state = freshState([inv('a', 150, { number: 'INV-100', link: 'plink_ONE' })]);
  const s = session(100, { link: 'plink_ONE', number: 'INV-100' });
  const r = await runSession(state, s);
  assert.strictEqual(r.failed, false);
  const a = get(state, 'a');
  assert.strictEqual(a.status, 'sent'); assert.strictEqual(a.amount_paid, 100);
  assert.strictEqual(a.metadata.partialPayment.received, 100); assert.strictEqual(a.metadata.paymentReview.amount, 50);
  const again = await runSession(state, s);
  assert.strictEqual(again.duplicate, true, 'short single payment must not be applied twice');
  assert.strictEqual(get(state, 'a').amount_paid, 100);
});

test('remainder link after a short single payment settles at the full total and clears the flags', async () => {
  const state = freshState([inv('a', 250, { number: 'INV-100', link: 'plink_R', amount_paid: 200, metadata: { partialPayment: { received: 200, sessionId: 'plink_ONE', at: AT }, paymentReview: { reason: 'short', amount: 50 }, payments: { pi_1: { amount: 200, link: 'plink_ONE', at: AT } } } })]);
  const r = await runSession(state, session(50, { link: 'plink_R', number: 'INV-100', intent: 'pi_2', id: 'cs_2' }));
  assert.strictEqual(r.failed, false);
  const a = get(state, 'a');
  assert.strictEqual(a.status, 'paid'); assert.strictEqual(a.amount_paid, 250);
  assert.ok(!a.metadata.partialPayment); assert.ok(!a.metadata.paymentReview);
  assert.ok(a.metadata.payments.pi_1 && a.metadata.payments.pi_2, 'both payments kept');
  assert.strictEqual(ledger(state).a.amount, 250);
});

test('redelivery of an EARLIER link\'s event after a later link was paid is a duplicate (payment-keyed, not link-keyed)', async () => {
  const state = freshState([inv('a', 250, { number: 'INV-100', link: 'plink_L1' })]);
  const e1 = session(100, { link: 'plink_L1', number: 'INV-100', intent: 'pi_1', id: 'cs_1' });
  await runSession(state, e1);                                   // partial 100
  get(state, 'a').stripe_invoice_id = 'plink_L2';               // app re-links (reminder)
  await runSession(state, session(100, { link: 'plink_L2', number: 'INV-100', intent: 'pi_2', id: 'cs_2' })); // partial 200
  assert.strictEqual(get(state, 'a').amount_paid, 200);
  const r = await runSession(state, e1);                         // Stripe redelivers L1's event
  assert.strictEqual(r.duplicate, true);
  assert.strictEqual(get(state, 'a').amount_paid, 200, 'L1 money not applied a second time');
});

test('a second checkout through the same single link (new payment intent) is a new payment, flagged as overpayment', async () => {
  const state = freshState([inv('a', 150, { number: 'INV-100', link: 'plink_ONE' })]);
  await runSession(state, session(150, { link: 'plink_ONE', number: 'INV-100' }));
  const r = await runSession(state, session(150, { link: 'plink_ONE', number: 'INV-100', intent: 'pi_2', id: 'cs_2' }));
  assert.strictEqual(r.duplicate, false); assert.strictEqual(r.detail.flagged, true);
  assert.strictEqual(get(state, 'a').metadata.paymentReview.reason, 'overpayment');
  assert.strictEqual(get(state, 'a').metadata.paymentReview.amount, 150);
});

test('duplicate delivery of the same payment: nothing changes, no receipt', async () => {
  const state = freshState([inv('a', 150, { number: 'INV-100', link: 'plink_ONE' })]);
  const s = session(150, { link: 'plink_ONE', number: 'INV-100' });
  await runSession(state, s);
  const again = await runSession(state, s);
  assert.strictEqual(again.duplicate, true); assert.strictEqual(again.failed, false);
  assert.strictEqual(get(state, 'a').amount_paid, 150);
});

test('legacy row paid by the old webhook (payment intent stored, no payments map): redelivery is a duplicate', async () => {
  const state = freshState([inv('a', 150, { number: 'INV-100', link: 'plink_ONE', status: 'paid', amount_paid: 150, intent: 'pi_1', metadata: { billingMonth: '2026-08' } })]);
  state.organizations[0].paid_invoices = { 'cust-1-2026-08': { paid: true, method: 'electronic', amount: 150 } }; // what the old webhook wrote
  const r = await runSession(state, session(150, { link: 'plink_ONE', number: 'INV-100' }));
  assert.strictEqual(r.duplicate, true);
  assert.ok(!get(state, 'a').metadata.paymentReview);
});

test('invoice paid by check, then its link is paid too: flagged as overpayment with a receipt, not swallowed', async () => {
  const state = freshState([inv('a', 150, { number: 'INV-100', link: 'plink_ONE', status: 'paid', amount_paid: 150 })]);
  state.organizations[0].paid_invoices = { a: { paid: true, method: 'check', amount: 150 } };
  const r = await runSession(state, session(150, { link: 'plink_ONE', number: 'INV-100', intent: 'pi_9', id: 'cs_9' }));
  assert.strictEqual(r.duplicate, false); assert.strictEqual(r.failed, false); assert.strictEqual(r.detail.flagged, true);
  assert.strictEqual(get(state, 'a').metadata.paymentReview.reason, 'overpayment');
  const again = await runSession(state, session(150, { link: 'plink_ONE', number: 'INV-100', intent: 'pi_9', id: 'cs_9' }));
  assert.strictEqual(again.duplicate, true, 'the flagged payment is remembered');
});

test('ledger write fails on first delivery → failed; redelivery completes the ledger; third is a duplicate', async () => {
  const state = freshState([inv('a', 150, { number: 'INV-100', link: 'plink_ONE', month: '2026-08' })]);
  const s = session(150, { link: 'plink_ONE', number: 'INV-100', extraMeta: { customerId: 'cust-1', billingMonth: '2026-08' } });
  const first = await runSession(state, s, { failUpdate: (t) => t === 'organizations' });
  assert.strictEqual(first.failed, true); assert.strictEqual(get(state, 'a').status, 'paid');
  const second = await runSession(state, s);
  assert.strictEqual(second.failed, false); assert.strictEqual(second.duplicate, false, 'ledger work was done on this delivery');
  assert.ok(ledger(state)['cust-1-2026-08']);
  const third = await runSession(state, s);
  assert.strictEqual(third.duplicate, true);
});

test('duplicate invoice numbers (voided + re-issued): the live row is settled, no PGRST116 failure loop', async () => {
  const state = freshState([
    inv('old', 150, { number: 'JOB-abc', link: 'plink_OLD', status: 'void' }),
    inv('new', 150, { number: 'JOB-abc', link: 'plink_NEW' }),
  ]);
  const r = await runSession(state, session(150, { link: 'plink_NEW', number: 'JOB-abc' }));
  assert.strictEqual(r.failed, false); assert.strictEqual(get(state, 'new').status, 'paid'); assert.strictEqual(get(state, 'old').status, 'void');
});

test('invoice lookup error is reported as failed (Stripe will retry), nothing written', async () => {
  const state = freshState([inv('a', 150, { number: 'INV-100', link: 'plink_ONE' })]);
  const r = await runSession(state, session(150, { link: 'plink_ONE', number: 'INV-100' }), { failSelect: (t) => t === 'invoices' });
  assert.strictEqual(r.failed, true); assert.strictEqual(get(state, 'a').status, 'sent');
});

test('single update error does NOT fall through to the statement path', async () => {
  const state = freshState([inv('a', 150, { number: 'INV-100', link: 'plink_ONE' })]);
  const r = await runSession(state, session(150, { link: 'plink_ONE', number: 'INV-100' }), { failUpdate: (t) => t === 'invoices' });
  assert.strictEqual(r.failed, true); assert.strictEqual(r.mode, 'single'); assert.strictEqual(get(state, 'a').status, 'sent');
});

test('payment against a VOIDED invoice number (no live row): flagged for review, never marked paid', async () => {
  const state = freshState([inv('v', 150, { number: 'INV-100', link: 'plink_ONE', status: 'void' })]);
  const r = await runSession(state, session(150, { link: 'plink_ONE', number: 'INV-100' }));
  assert.strictEqual(r.failed, false); assert.strictEqual(r.detail.flagged, true); assert.strictEqual(r.detail.settled, false);
  const v = get(state, 'v');
  assert.strictEqual(v.status, 'void', 'status untouched'); assert.strictEqual(v.amount_paid, 0);
  assert.strictEqual(v.metadata.paymentReview.reason, 'overpayment'); assert.strictEqual(v.metadata.paymentReview.note, 'paid against a voided invoice');
  assert.deepStrictEqual(ledger(state), {}, 'no paid ledger entry');
  const again = await runSession(state, session(150, { link: 'plink_ONE', number: 'INV-100' }));
  assert.strictEqual(again.duplicate, true);
});

test('the payment link id picks the right row when several share an invoice number', async () => {
  const state = freshState([
    inv('old', 150, { number: 'JOB-abc', link: 'plink_OLD', status: 'sent' }),
    inv('new', 150, { number: 'JOB-abc', link: 'plink_NEW', status: 'sent' }),
  ]);
  const r = await runSession(state, session(150, { link: 'plink_NEW', number: 'JOB-abc', extraMeta: { invoiceId: 'new' } }));
  assert.strictEqual(r.failed, false);
  assert.strictEqual(get(state, 'new').status, 'paid'); assert.strictEqual(get(state, 'old').status, 'sent');
});

test('overpayment is flagged ONCE per payment across a partial-failure redelivery', async () => {
  const state = freshState([inv('a', 100, { date: '2026-07-01' }), inv('b', 200, { date: '2026-08-01' })]);
  let failedOnce = false;
  const first = await runStmt(state, 450, { failUpdate: (t, p, id) => { if (t === 'invoices' && id === 'b' && !failedOnce) { failedOnce = true; return true; } return false; } });
  assert.strictEqual(first.failed, true);
  assert.strictEqual(get(state, 'a').metadata.paymentReview.reason, 'overpayment');
  const second = await runStmt(state, 450);
  assert.strictEqual(second.failed, false); assert.strictEqual(get(state, 'b').status, 'paid');
  const flags = state.invoices.filter((i) => i.metadata.paymentReview && i.metadata.paymentReview.reason === 'overpayment');
  assert.strictEqual(flags.length, 1, 'exactly one overpayment flag for the $150');
});

test('legacy statement rows settled by the OLD webhook (payment intent, no payments map): redelivery is a duplicate', async () => {
  const state = freshState([inv('a', 100, { status: 'paid', amount_paid: 100, intent: 'pi_1' }), inv('b', 200, { status: 'paid', amount_paid: 200, intent: 'pi_1' })]);
  state.organizations[0].paid_invoices = { a: { paid: true, amount: 100 }, b: { paid: true, amount: 200 } };
  const r = await runStmt(state, 300);
  assert.strictEqual(r.duplicate, true); assert.strictEqual(r.flagged, false);
  assert.ok(!get(state, 'a').metadata.paymentReview);
});

test('two DIFFERENT payments landing on one invoice at the same moment are both recorded (optimistic lock + re-read)', async () => {
  // Invoice a ($100) is on statement S1 with b ($200); a also has its own link L1.
  const state = freshState([inv('a', 100, { number: 'INV-A', date: '2026-07-01', link: 'plink_L1', metadata: { statement: { sessionId: LINK }, statementSessions: { [LINK]: true } } }), inv('b', 200, { date: '2026-08-01' })]);
  const opts = { latency: 5 };
  const [r1, r2] = await Promise.all([
    runSession(state, session(100, { link: 'plink_L1', number: 'INV-A', intent: 'pi_1', id: 'cs_1' }), opts),
    runSession(state, session(300, { link: LINK, number: 'STMT-1', intent: 'pi_2', id: 'cs_2' }), opts),
  ]);
  assert.strictEqual(r1.failed, false); assert.strictEqual(r2.failed, false);
  assert.strictEqual(get(state, 'a').status, 'paid'); assert.strictEqual(get(state, 'b').status, 'paid');
  // $400 arrived for $300 of invoices: every dollar is either applied or flagged.
  const applied = state.invoices.reduce((s, i) => s + Object.values(i.metadata.payments || {}).reduce((t, p) => t + (p.amount || 0), 0), 0);
  const flagged = state.invoices.filter((i) => i.metadata.paymentReview && i.metadata.paymentReview.reason === 'overpayment');
  const flaggedAmt = flagged.reduce((s, i) => s + i.metadata.paymentReview.amount, 0);
  assert.strictEqual(applied, 300, 'exactly the invoiced total is applied');
  assert.strictEqual(flaggedAmt, 100, 'the surplus $100 is flagged once');
  assert.ok(state.invoices.every((i) => (i.metadata.payments.pi_1 || i.metadata.payments.pi_2)), 'both payments are recorded somewhere');
});

test('a surplus flag the owner already resolved is not re-raised by a redelivery; the ledger is repaired and no second receipt is due', async () => {
  // a open, b paid by check; $300 pays the statement → a settled, $200 surplus flagged; ledger write fails.
  const state = freshState([inv('a', 100, { date: '2026-07-01' }), inv('b', 200, { date: '2026-08-01', status: 'paid', amount_paid: 200 })]);
  state.organizations[0].paid_invoices = { b: { paid: true, method: 'check', amount: 200 } };
  const first = await runStmt(state, 300, { failUpdate: (t) => t === 'organizations' });
  assert.strictEqual(first.failed, true); assert.strictEqual(get(state, 'a').metadata.paymentReview.amount, 200);
  // Owner resolves the review in the app before Stripe retries.
  get(state, 'a').metadata.paymentReview = null;
  const retry = await runStmt(state, 300);
  assert.strictEqual(retry.failed, false);
  assert.strictEqual(get(state, 'a').metadata.paymentReview, null, 'resolved review stays resolved');
  assert.ok(ledger(state).a, 'ledger repaired on the retry');
  assert.strictEqual(retry.duplicate, false, 'first ledger write for a — receipt still due once');
  const third = await runStmt(state, 300);
  assert.strictEqual(third.duplicate, true);
});

test('two settlements in one org at the same moment both keep their ledger keys (guarded ledger write + retry)', async () => {
  const state = freshState([inv('a', 100, { number: 'INV-A', link: 'plink_A', month: '2026-07' }), inv('b', 200, { number: 'INV-B', link: 'plink_B', month: '2026-08' })]);
  const opts = { latency: 5 };
  const [ra, rb] = await Promise.all([
    runSession(state, session(100, { link: 'plink_A', number: 'INV-A', intent: 'pi_a', id: 'cs_a', extraMeta: { customerId: 'cust-1', billingMonth: '2026-07' } }), opts),
    runSession(state, session(200, { link: 'plink_B', number: 'INV-B', intent: 'pi_b', id: 'cs_b', extraMeta: { customerId: 'cust-1', billingMonth: '2026-08' } }), opts),
  ]);
  assert.strictEqual(ra.failed, false); assert.strictEqual(rb.failed, false);
  const l = ledger(state);
  assert.ok(l.a && l.b && l['cust-1-2026-07'] && l['cust-1-2026-08'], 'neither settlement lost its keys');
});

test('receipt is owed once per payment: settled first by the app endpoint, the webhook still owes it; after marking, a redelivery does not', async () => {
  const { markReceiptSent } = require('../lib/settlePayment');
  const state = freshState([inv('a', 150, { number: 'INV-100', link: 'plink_ONE' })]);
  const s = session(150, { link: 'plink_ONE', number: 'INV-100' });
  const viaApp = await runSession(state, s);            // POST /api/settle-payment — records the money, no receipt
  assert.strictEqual(viaApp.failed, false); assert.strictEqual(viaApp.receiptRecorded, false);
  const webhook = await runSession(state, s);           // Stripe's delivery lands afterwards
  assert.strictEqual(webhook.duplicate, true, 'no new work');
  assert.strictEqual(webhook.receiptRecorded, false, 'but the customer has NOT had a receipt yet');
  assert.deepStrictEqual(webhook.invoiceIds, ['a']);
  const marked = await markReceiptSent({ supabase: fakeSupabase(state), invoiceId: 'a', session: s, log: quiet });
  assert.strictEqual(marked, true);
  assert.ok(get(state, 'a').metadata.receipts.pi_1, 'receipt remembered in its own map');
  assert.deepStrictEqual(get(state, 'a').metadata.payments.pi_1, { amount: 150, link: 'plink_ONE', at: AT }, 'payment record untouched');
  const again = await runSession(state, s);
  assert.strictEqual(again.receiptRecorded, true, 'a later redelivery owes nothing');
});

test('statement: receipt marker on one member is seen by the statement path', async () => {
  const { markReceiptSent } = require('../lib/settlePayment');
  const state = freshState([inv('a', 100, { date: '2026-07-01' }), inv('b', 200, { date: '2026-08-01' })]);
  const first = await runSession(state, session(300));
  assert.strictEqual(first.receiptRecorded, false); assert.deepStrictEqual(first.invoiceIds.sort(), ['a', 'b']);
  await markReceiptSent({ supabase: fakeSupabase(state), invoiceId: first.invoiceIds[0], session: session(300), log: quiet });
  const again = await runSession(state, session(300));
  assert.strictEqual(again.duplicate, true); assert.strictEqual(again.receiptRecorded, true);
});

test('a payment that only FLAGGED a check-paid invoice does not write Stripe ledger entries on redelivery', async () => {
  const state = freshState([inv('a', 150, { number: 'INV-100', link: 'plink_ONE', status: 'paid', amount_paid: 150, month: '2026-08' })]);
  state.organizations[0].paid_invoices = { a: { paid: true, method: 'check', amount: 150 } };
  const s = session(150, { link: 'plink_ONE', number: 'INV-100', intent: 'pi_9', id: 'cs_9', extraMeta: { customerId: 'cust-1', billingMonth: '2026-08' } });
  await runSession(state, s);                           // flagged as overpayment
  const again = await runSession(state, s);
  assert.strictEqual(again.duplicate, true);
  assert.ok(!ledger(state)['cust-1-2026-08'], 'no Stripe ledger key invented for a check payment');
  assert.strictEqual(ledger(state).a.method, 'check');
});

test('receipt marker on a member paid by CHECK does not turn it into "paid by this payment": no invented ledger keys, no false overpayment', async () => {
  const { markReceiptSent } = require('../lib/settlePayment');
  // a paid by check earlier (app wrote only its month key), b open; statement $200 pays b. Members come back a-first.
  const state = freshState([
    inv('a', 100, { date: '2026-07-01', status: 'paid', amount_paid: 100, metadata: { billingMonth: '2026-07', serviceIds: ['svc-1'] } }),
    inv('b', 200, { date: '2026-08-01', month: '2026-08' }),
  ]);
  state.organizations[0].paid_invoices = { 'cust-1-2026-07': { paid: true, method: 'check', amount: 100 } };
  const first = await runSession(state, session(200));
  assert.strictEqual(first.failed, false); assert.strictEqual(get(state, 'b').status, 'paid');
  await markReceiptSent({ supabase: fakeSupabase(state), invoiceId: first.invoiceIds[0], session: session(200), log: quiet });
  const again = await runSession(state, session(200));
  assert.strictEqual(again.duplicate, true); assert.strictEqual(again.receiptRecorded, true);
  assert.strictEqual(again.detail.flagged, false, 'no false overpayment');
  const l = ledger(state);
  assert.ok(!l.a && !l['job-svc-1'], 'no Stripe keys invented for the check-paid member');
  assert.strictEqual(l['cust-1-2026-07'].method, 'check');
  assert.ok(l.b && l['cust-1-2026-08'], 'the member this payment paid has its keys');
});

test('legacy statement rows + receipt marker: redelivery stays a duplicate with nothing flagged', async () => {
  const { markReceiptSent } = require('../lib/settlePayment');
  const state = freshState([inv('a', 100, { status: 'paid', amount_paid: 100, intent: 'pi_1', metadata: {} }), inv('b', 200, { status: 'paid', amount_paid: 200, intent: 'pi_1', metadata: {} })]);
  state.organizations[0].paid_invoices = { a: { paid: true, amount: 100 }, b: { paid: true, amount: 200 } };
  await markReceiptSent({ supabase: fakeSupabase(state), invoiceId: 'a', session: session(300), log: quiet });
  const r = await runStmt(state, 300);
  assert.strictEqual(r.duplicate, true); assert.strictEqual(r.flagged, false);
  assert.ok(!get(state, 'a').metadata.paymentReview);
});

test('session without metadata does not crash; STMT- number falls through to the statement path', async () => {
  const state = freshState([inv('a', 100, { date: '2026-07-01' }), inv('b', 200, { date: '2026-08-01' })]);
  const r0 = await runSession(state, { id: 'cs_x', payment_link: 'plink_NOTHING', amount_total: 100, payment_intent: 'pi_x', payment_status: 'paid' });
  assert.strictEqual(r0.handled, false); assert.strictEqual(r0.failed, false);
  const r = await runSession(state, session(300));
  assert.strictEqual(r.mode, 'statement'); assert.strictEqual(r.failed, false);
  assert.strictEqual(get(state, 'a').status, 'paid'); assert.strictEqual(get(state, 'b').status, 'paid');
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log('  ✓', t.name); }
    catch (e) { failed += 1; console.log('  ✗', t.name, '\n     ', e.message); }
  }
  console.log(failed ? `\n${failed} test(s) FAILED` : `\nAll ${tests.length} tests passed`);
  process.exit(failed ? 1 : 0);
})();
