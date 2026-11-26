'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Insights = require('../lib/insights.js');

const at = (iso) => new Date(iso + 'T10:00:00').getTime();
const expenses = [
  { id: 'a', type: 'in', amount: 30000, category: 'Salary', date: '2026-09-15' },
  { id: 'b', type: 'in', amount: 30000, category: 'Salary', date: '2026-10-15' },
  { id: 'c', type: 'in', amount: 40000, category: 'Salary', date: '2026-11-15' },
  { id: 'd', type: 'out', amount: 999, category: 'Food', date: '2026-11-02' }, // old money-out entry: not counted
];
const tracker = {
  loans: [
    { id: 'L', name: 'Phone', category: 'loan', termAmount: 2000, terms: 12, firstMonth: '2026-09', dueDay: 15 },
    { id: 'E', name: 'Electricity', category: 'bill', kind: 'variable', estimate: 2500, months: null, firstMonth: '2026-09', dueDay: 20 },
    { id: 'R', name: 'Rent', category: 'bill', termAmount: 8000, terms: 12, firstMonth: '2026-09', dueDay: 5 },
  ],
  payments: [
    { id: 'p1', loanId: 'L', month: '2026-09', terms: 1, amount: 2000, created: at('2026-09-14') }, // 1 day early
    { id: 'p2', loanId: 'L', month: '2026-10', terms: 1, amount: 2000, created: at('2026-10-18') }, // 3 days late
    { id: 'p3', loanId: 'L', month: '2026-11', terms: 1, amount: 2000, created: at('2026-11-15') }, // on the day
    { id: 'e1', loanId: 'E', month: '2026-09', terms: 0, amount: 2000, created: at('2026-09-19') },
    { id: 'e2', loanId: 'E', month: '2026-10', terms: 0, amount: 2200, created: at('2026-10-20') },
    { id: 'e3', loanId: 'E', month: '2026-11', terms: 0, amount: 3150, created: at('2026-11-10') },
    { id: 'r1', loanId: 'R', month: '2026-09', terms: 1, amount: 8000, created: at('2026-09-01') },
    { id: 'r2', loanId: 'R', month: '2026-10', terms: 1, amount: 8000, created: at('2026-10-03') },
    { id: 'r3', loanId: 'R', month: '2026-11', terms: 1, amount: 8000, created: at('2026-11-04') },
  ],
};

test('trend: money in, expenses paid and net per month', () => {
  const t = Insights.trend(expenses, tracker, '2026-11', 4);
  assert.deepEqual(t.map((r) => [r.month, r.in, r.out, r.net]), [
    ['2026-08', 0, 0, 0],
    ['2026-09', 30000, 12000, 18000],
    ['2026-10', 30000, 12200, 17800],
    ['2026-11', 40000, 13150, 26850],
  ]);
});

test('headline figures for a month', () => {
  const h = Insights.headline(expenses, tracker, '2026-11');
  assert.equal(h.out, 13150);
  assert.equal(h.average, 12100); // Sep and Oct only: August had no data
  assert.equal(h.averageMonths, 2);
  assert.ok(Math.abs(h.change - (13150 - 12100) / 12100) < 1e-9);
  assert.ok(Math.abs(h.savingsRate - 26850 / 40000) < 1e-9);
  assert.equal(h.loanPaid, 2000);
  assert.equal(h.loanShare, 0.05);
  assert.equal(h.fixedPaid, 10000);
  assert.equal(h.varyingPaid, 3150);
  assert.equal(Insights.loanLevel(0.05), 'ok');
  assert.equal(Insights.loanLevel(0.35), 'watch');
  assert.equal(Insights.loanLevel(0.45), 'high');
  // A month with nothing in it.
  const empty = Insights.headline(expenses, tracker, '2026-06');
  assert.equal(empty.savingsRate, null);
  assert.equal(empty.fixedShare, null);
  assert.equal(empty.average, null);
});

test('bills that vary: history and a flag when well above average', () => {
  const [e] = Insights.varyingBills(tracker, '2026-11', 6);
  assert.equal(e.loan.id, 'E');
  assert.deepEqual(e.months.map((m) => [m.month, m.amount]), [['2026-09', 2000], ['2026-10', 2200], ['2026-11', 3150]]);
  assert.equal(e.min, 2000);
  assert.equal(e.max, 3150);
  assert.equal(e.current, 3150);
  assert.ok(Math.abs(e.above - (3150 - 2100) / 2100) < 1e-9); // 50% above Sep-Oct
  assert.equal(e.flagged, true);
  // October isn't flagged: only one earlier month to compare with.
  assert.equal(Insights.varyingBills(tracker, '2026-10')[0].flagged, false);
});

test('paying on time', () => {
  const o = Insights.onTime(tracker);
  assert.equal(o.count, 9);
  // Late: phone in October (3 days), electricity in October? due the 20th, logged the 20th: on time.
  // Rent October: due the 5th, logged the 3rd: early. Late ones: p2 only.
  assert.equal(o.lateCount, 1);
  assert.equal(o.averageLateDays, 3);
  assert.equal(o.onTimeCount, 8);
  assert.ok(Math.abs(o.rate - 8 / 9) < 1e-9);
  // In logged order the last ones are e2 (Oct 20), r3, e3, p3, all on time; before them p2 (Oct 18) was late.
  assert.equal(o.streak, 4);
  // Payments without a due day or logged date are left out.
  const noDates = Insights.onTime({ loans: [{ id: 'X', name: 'X', termAmount: 1, terms: 2, firstMonth: '2026-01' }], payments: [{ id: 'x', loanId: 'X', month: '2026-01', terms: 1, amount: 1 }] });
  assert.equal(noDates.count, 0);
  assert.equal(noDates.rate, null);
});
