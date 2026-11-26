'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Loans = require('../lib/loans.js');

const loan = Loans.cleanLoan({ name: 'Phone', lender: 'Home Credit', termAmount: 1500, terms: 18, firstMonth: '2026-06', borrowed: '22000' });
const L = { id: 'L1', ...loan };
const pay = (id, month, terms, amount) => ({ id, loanId: 'L1', month, terms, amount: amount ?? terms * 1500 });

test('paying several terms in one month counts them all', () => {
  const s = Loans.summary(L, [pay('a', '2026-06', 1), pay('b', '2026-07', 1), pay('c', '2026-11', 4)], '2026-11');
  assert.equal(s.total, 27000);
  assert.equal(s.termsPaid, 6);
  assert.equal(s.paid, 9000);
  assert.equal(s.remaining, 18000);
  assert.equal(s.nextTerm, 7);
  assert.equal(s.nextMonth, '2026-12');
  assert.equal(s.status, 'on-track');
  assert.deepEqual(s.history.map((h) => [h.month, h.fromTerm, h.toTerm]), [['2026-06', 1, 1], ['2026-07', 2, 2], ['2026-11', 3, 6]]);
  assert.equal(s.interest, 5000);
  assert.equal(s.lastMonth, '2027-11');
});

test('behind, ahead and done', () => {
  assert.equal(Loans.summary(L, [pay('a', '2026-06', 2)], '2026-11').behind, 4);
  const ahead = Loans.summary(L, [pay('a', '2026-06', 9)], '2026-07');
  assert.equal(ahead.status, 'ahead');
  assert.equal(ahead.ahead, 7);
  const done = Loans.summary(L, [pay('a', '2026-06', 18)], '2026-07');
  assert.equal(done.status, 'done');
  assert.equal(done.nextTerm, null);
  assert.equal(done.remaining, 0);
  assert.equal(Loans.summary(L, [], '2026-05').status, 'on-track');
});

test('payments default to terms x amount, and inputs are checked', () => {
  assert.deepEqual(Loans.cleanPayment({ terms: 3, month: '2026-11' }, loan), { terms: 3, amount: 4500, month: '2026-11', note: '' });
  assert.equal(Loans.cleanPayment({ terms: 1, amount: '1600', month: '2026-11' }, loan).amount, 1600);
  assert.throws(() => Loans.cleanPayment({ terms: 19, month: '2026-11' }, loan), /between 0 and 18/);
  assert.throws(() => Loans.cleanLoan({ name: 'x', termAmount: 0, terms: 3, firstMonth: '2026-01' }), /amount per term/);
  assert.equal(Loans.addMonths('2026-11', 3), '2027-02');
});

test('paidInMonth adds up a month across loans', () => {
  const st = { loans: [L], payments: [pay('a', '2026-11', 2), { id: 'b', loanId: 'L2', month: '2026-11', terms: 1, amount: 800 }, pay('c', '2026-10', 1)] };
  assert.deepEqual(Loans.paidInMonth(st, '2026-11'), { amount: 3800, terms: 3, count: 2 });
});

const bill = { id: 'B1', ...Loans.cleanVariable({ name: 'Electricity', lender: 'Meralco', estimate: '2500', months: '', firstMonth: '2026-08', dueDay: '20' }) };
const bpay = (id, month, amount, loanId = 'B1') => ({ id, loanId, month, terms: 0, amount });

test('variable bills: unpaid months, averages and estimates', () => {
  assert.equal(bill.kind, 'variable');
  assert.ok(Loans.isVariable(bill));
  assert.equal(bill.months, null);
  const s = Loans.variableSummary(bill, [bpay('a', '2026-08', 2100), bpay('b', '2026-10', 2900)], '2026-11');
  assert.deepEqual(s.unpaid, ['2026-09', '2026-11']);
  assert.equal(s.behind, 2);
  assert.equal(s.paid, 5000);
  assert.equal(s.average, 2500);
  assert.equal(s.lastAmount, 2900);
  assert.equal(s.overdueEstimate, 5000); // 2 months x the usual 2500
  assert.equal(s.remainingEstimate, null); // no end month
  assert.equal(s.nextMonth, '2026-09');
  assert.equal(s.status, 'behind');
  const up = Loans.variableSummary(bill, ['08', '09', '10', '11'].map((m, i) => bpay(String(i), `2026-${m}`, 2000)), '2026-11');
  assert.equal(up.status, 'on-track');
  assert.equal(up.nextMonth, '2026-12');
  // Not started yet.
  assert.equal(Loans.variableSummary(bill, [], '2026-06').nextMonth, '2026-08');
});

test('variable bills with an end month finish, and payments are checked', () => {
  const b = { id: 'B2', ...Loans.cleanVariable({ name: 'Water', months: '3', firstMonth: '2026-09' }) };
  const s = Loans.variableSummary(b, [bpay('a', '2026-09', 300, 'B2')], '2026-09');
  assert.equal(s.lastMonth, '2026-11');
  assert.equal(s.monthsLeft, 2);
  assert.equal(s.remainingEstimate, 600); // no usual amount, so the average
  const done = Loans.variableSummary(b, ['09', '10', '11'].map((m) => bpay(m, `2026-${m}`, 300, 'B2')), '2027-03');
  assert.equal(done.status, 'done');
  assert.equal(done.nextMonth, null);
  assert.deepEqual(Loans.cleanVariablePayment({ month: '2026-10', amount: '312.5' }, b), { terms: 0, amount: 312.5, month: '2026-10', note: '' });
  assert.throws(() => Loans.cleanVariablePayment({ month: '2026-08', amount: 1 }, b), /before/);
  assert.throws(() => Loans.cleanVariablePayment({ month: '2026-12', amount: 1 }, b), /after/);
  assert.throws(() => Loans.cleanVariablePayment({ month: '2026-10', amount: '' }, b), /amount/);
  assert.throws(() => Loans.cleanVariable({ name: 'x', firstMonth: '2026-01', months: '0' }), /between 1 and 360/);
});
