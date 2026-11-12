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
