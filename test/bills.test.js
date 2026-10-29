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
  assert.deepStrictEqual(Bills.totals(items), { due: 4839, paid: 640, left: 4199, overdue: 2500, fixed: 4839, variable: 0, count: 3, unpaid: 2 });

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

test('fixed vs variable bills, and bills without a set due date', () => {
  // Older bills: amount 0 meant "varies".
  assert.strictEqual(Bills.amountType({ amount: 0 }), 'variable');
  assert.strictEqual(Bills.amountType({ amount: 900 }), 'fixed');
  assert.strictEqual(Bills.amountType({ amount: 900, amountType: 'variable' }), 'variable');

  const state = { bills: [
    bill({ id: 'rent', name: 'Rent', kind: 'rent', amount: 12000, amountType: 'fixed', dueDay: 5 }),
    bill({ id: 'elec', name: 'Meralco', amount: 2800, amountType: 'variable', dueDay: 20 }),
    bill({ id: 'load', name: 'Mobile load', kind: 'mobile', amount: 300, amountType: 'variable', hasDueDate: false }),
  ], payments: {} };
  const items = Bills.forMonth(state, '2026-11', '2026-11-27');
  assert.deepStrictEqual(items.map((i) => [i.bill.name, i.type, i.anytime, i.dueDate, i.status]), [
    ['Rent', 'fixed', false, '2026-11-05', 'overdue'],
    ['Meralco', 'variable', false, '2026-11-20', 'overdue'],
    ['Mobile load', 'variable', true, '2026-11-30', 'due-soon'],
  ]);
  const t = Bills.totals(items);
  assert.strictEqual(t.fixed, 12000);
  assert.strictEqual(t.variable, 3100);
  // No set due date: only overdue once the month is over.
  assert.strictEqual(Bills.forMonth(state, '2026-11', '2026-11-10').find((i) => i.anytime).status, 'upcoming');
  assert.strictEqual(Bills.forMonth(state, '2026-11', '2026-12-01').find((i) => i.anytime).status, 'overdue');

  assert.throws(() => Bills.cleanBill({ name: 'Rent', amountType: 'fixed', amount: 0, dueDay: 5, every: 1, startMonth: '2026-10' }), /Variable/);
  const v = Bills.cleanBill({ name: 'Water', amountType: 'variable', amount: '', dueDay: 2, every: 1, startMonth: '2026-10' });
  assert.deepStrictEqual([v.amountType, v.amount, v.hasDueDate], ['variable', 0, true]);
  const any = Bills.cleanBill({ name: 'Load', amountType: 'variable', amount: 300, hasDueDate: false, dueDay: '', every: 1, startMonth: '2026-10' });
  assert.deepStrictEqual([any.hasDueDate, any.dueDay], [false, 31]);
});

test('every paid bill is in Expenses exactly once', () => {
  const bills = { bills: [bill({ id: 'elec', name: 'Meralco', kind: 'electricity' }), bill({ id: 'net', name: 'PLDT', kind: 'internet' })], payments: {
    'elec:2026-09': { amount: 2900, paidOn: '2026-09-18' },                          // never added (old setting off)
    'elec:2026-10': { amount: 3150, paidOn: '2026-10-19', expenseId: 'old-id' },     // linked, old-style id
    'net:2026-10': { amount: 1699, paidOn: '2026-10-25', expenseId: 'deleted' },     // linked expense was deleted
    'gone:2026-10': { amount: 500, paidOn: '2026-10-02' },                           // bill since removed
  } };
  const exp = { expenses: [{ id: 'old-id', type: 'out', amount: 3150, category: 'Utilities', date: '2026-10-19', note: 'Bill: Meralco' }] };

  assert.deepStrictEqual(Bills.syncExpenses(bills, exp), { billsChanged: true, expensesChanged: true });
  const out = exp.expenses.map((e) => [e.billPayment, e.amount, e.category, e.date]).sort();
  assert.deepStrictEqual(out, [
    ['elec:2026-09', 2900, 'Utilities', '2026-09-18'],
    ['elec:2026-10', 3150, 'Utilities', '2026-10-19'],
    ['gone:2026-10', 500, 'Other', '2026-10-02'],
    ['net:2026-10', 1699, 'Utilities', '2026-10-25'],
  ]);
  assert.ok(exp.expenses.every((e) => !e.type || e.type === 'out'));
  for (const [k, p] of Object.entries(bills.payments)) assert.strictEqual(exp.expenses.find((e) => e.id === p.expenseId).billPayment, k);

  // Running again changes nothing (no duplicates).
  assert.deepStrictEqual(Bills.syncExpenses(bills, exp), { billsChanged: false, expensesChanged: false });
  assert.strictEqual(exp.expenses.length, 4);
});
