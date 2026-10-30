'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { merge } = require('../lib/merge.js');

const ex = (...expenses) => ({ expenses, budget: null, currency: 'PHP' });
const bills = (list, payments = {}) => ({ v: 1, bills: list, payments });
const data = (e, b) => ({ v: 1, expenses: e, bills: b });
const ids = (d) => d.expenses.expenses.map((x) => x.id);

test('first sync keeps entries from both devices', () => {
  const ipad = data(ex({ id: 'a', amount: 1 }), bills([{ id: 'b1', name: 'Rent' }]));
  const online = data(ex({ id: 'b', amount: 2 }), bills([{ id: 'b2', name: 'Water' }], { 'b2:2026-10': { amount: 300 } }));
  const m = merge(null, ipad, online);
  assert.deepEqual(ids(m), ['a', 'b']);
  assert.deepEqual(m.bills.bills.map((x) => x.id), ['b1', 'b2']);
  assert.deepEqual(m.bills.payments, { 'b2:2026-10': { amount: 300 } });
});

test('a fresh device takes everything online', () => {
  const online = data(ex({ id: 'a', amount: 1 }), bills([{ id: 'b1' }]));
  const m = merge(null, data(null, null), online);
  assert.deepEqual(m, { v: 1, ...online });
});

test('adds, edits and deletes on either side all survive', () => {
  const base = data(ex({ id: 'a', amount: 1 }, { id: 'b', amount: 2 }, { id: 'c', amount: 3 }), bills([], { k1: { amount: 5 } }));
  const local = data(ex({ id: 'a', amount: 10 }, { id: 'c', amount: 3 }, { id: 'd', amount: 4 }), bills([], { k1: { amount: 5 }, k2: { amount: 7 } }));
  const remote = data(ex({ id: 'a', amount: 1 }, { id: 'b', amount: 2 }, { id: 'e', amount: 6 }), bills([], {}));
  const m = merge(base, local, remote);
  // a edited here; b deleted here; c deleted online; d added here; e added online
  assert.deepEqual(m.expenses.expenses, [{ id: 'a', amount: 10 }, { id: 'd', amount: 4 }, { id: 'e', amount: 6 }]);
  // k1 deleted online (unpaid on another device), k2 paid here
  assert.deepEqual(m.bills.payments, { k2: { amount: 7 } });
});

test('an edit wins over a delete, and settings follow the side that changed', () => {
  const base = data({ ...ex({ id: 'a', amount: 1 }), budget: 100 }, bills([]));
  const local = data({ ...ex(), budget: 100 }, bills([]));
  const remote = data({ ...ex({ id: 'a', amount: 9 }), budget: 500 }, bills([]));
  const m = merge(base, local, remote);
  assert.deepEqual(m.expenses.expenses, [{ id: 'a', amount: 9 }]);
  assert.equal(m.expenses.budget, 500);
});

test('key order does not count as a change', () => {
  const base = data(ex({ id: 'a', amount: 1, note: 'x' }), bills([]));
  const local = data(ex({ note: 'x', amount: 1, id: 'a' }), bills([]));
  const remote = data(ex({ id: 'a', amount: 2, note: 'x' }), bills([]));
  assert.equal(merge(base, local, remote).expenses.expenses[0].amount, 2);
});
