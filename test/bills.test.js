'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Bills = require('../lib/bills');

const bill = (over = {}) => ({ id: over.id || 'b1', paused: false, ...Bills.cleanBill({ name: 'Meralco', kind: 'electricity', amount: 2500, dueDay: 15, every: 1, startMonth: '2026-10', ...over }) });

test('repeats: monthly, every N months, yearly, once, with an end month', () => {
  const due = (b, months) => months.filter((m) => Bills.isDueIn(b, m));
  const months = ['2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-04', '2027-10'];
  assert.deepStrictEqual(due(bill(), months), months.slice(1));
  assert.deepStrictEqual(due(bill({ every: 3 }), months), ['2026-10', '2027-01', '2027-04', '2027-10']);
  assert.deepStrictEqual(due(bill({ every: 12 }), months), ['2026-10', '2027-10']);
  assert.deepStrictEqual(due(bill({ every: 0 }), months), ['2026-10']);
  assert.deepStrictEqual(due(bill({ endMonth: '2026-12' }), months), ['2026-10', '2026-11', '2026-12']);
});

test('due day 31 is clamped to short months', () => {
  assert.strictEqual(Bills.dueDateIn('2027-02', 31), '2027-02-28');
  assert.strictEqual(Bills.dueDateIn('2028-02', 30), '2028-02-29');
  assert.strictEqual(Bills.dueDateIn('2026-11', 31), '2026-11-30');
  assert.strictEqual(Bills.shiftMonth('2026-12', 1), '2027-01');
  assert.strictEqual(Bills.shiftMonth('2027-01', -1), '2026-12');
});

test('status, totals and overdue from earlier months', () => {
  const state = { bills: [
    bill(),
    bill({ id: 'b2', name: 'Water', kind: 'water', amount: 600, dueDay: 2 }),
    bill({ id: 'b3', name: 'PLDT', kind: 'internet', amount: 1699, dueDay: 30 }),
    { ...bill({ id: 'b4', name: 'Gym', amount: 1000, dueDay: 1 }), paused: true },
  ], payments: { 'b2:2026-10': { amount: 640, paidOn: '2026-10-02' } } };

  const items = Bills.forMonth(state, '2026-10', '2026-10-29');
  assert.deepStrictEqual(items.map((i) => [i.bill.name, i.status]), [['Water', 'paid'], ['Meralco', 'overdue'], ['PLDT', 'due-soon']]);
  assert.strictEqual(items[0].amount, 640, 'paid amount wins over the usual amount');
  assert.deepStrictEqual(Bills.totals(items), { due: 4839, paid: 640, left: 4199, overdue: 2500, count: 3, unpaid: 2 });

  const late = Bills.overdueBefore(state, '2026-11', '2026-11-03');
  assert.deepStrictEqual(late.map((i) => `${i.bill.name} ${i.key}`), ['Meralco 2026-10', 'PLDT 2026-10']);
});

test('bill validation', () => {
  assert.throws(() => Bills.cleanBill({ name: '', amount: 1, dueDay: 1, every: 1, startMonth: '2026-10' }), /name/);
  assert.throws(() => Bills.cleanBill({ name: 'X', amount: -1, dueDay: 1, every: 1, startMonth: '2026-10' }), /amount/);
  assert.throws(() => Bills.cleanBill({ name: 'X', amount: 1, dueDay: 32, every: 1, startMonth: '2026-10' }), /Due day/);
  assert.throws(() => Bills.cleanBill({ name: 'X', amount: 1, dueDay: 1, every: 5, startMonth: '2026-10' }), /repeats/);
  assert.strictEqual(Bills.cleanBill({ name: 'X', kind: 'nope', amount: 0, dueDay: 1, every: '0', startMonth: '2026-10' }).kind, 'other');
});
