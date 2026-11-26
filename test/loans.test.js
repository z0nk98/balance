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

test('month view: what is due, paid and overdue in a month', () => {
  const st = {
    loans: [L, bill],
    payments: [pay('a', '2026-06', 2), bpay('e', '2026-10', 2900)],
  };
  // November, on the 25th: phone term 6 (terms 3-5 unpaid before it); electricity unpaid, due on the 20th.
  const nov = Loans.monthItems(st, '2026-11', '2026-11', 25);
  const phone = nov.find((i) => i.loan.id === 'L1');
  assert.equal(phone.termNo, 6);
  assert.equal(phone.paid, false);
  assert.equal(phone.cover, 4); // terms 3 to 6
  assert.equal(phone.status, 'due-soon'); // no due day
  const elec = nov.find((i) => i.loan.id === 'B1');
  assert.equal(elec.status, 'overdue'); // past the 20th
  assert.equal(elec.amount, 2500);
  assert.equal(elec.estimated, true);
  // October: electricity paid with the actual amount; phone term 5 overdue.
  const oct = Loans.monthItems(st, '2026-10', '2026-11', 25);
  assert.deepEqual(oct.map((i) => [i.loan.id, i.status, i.amount]), [['L1', 'overdue', 1500], ['B1', 'paid', 2900]]);
  // Paid terms show as paid in their month; months outside a loan are left out.
  assert.equal(Loans.monthItems(st, '2026-07', '2026-11', 1).find((i) => i.loan.id === 'L1').status, 'paid');
  assert.equal(Loans.monthItems(st, '2026-05', '2026-11', 1).length, 0);
  assert.equal(Loans.monthItems(st, '2027-01', '2026-11', 1).find((i) => i.loan.id === 'L1').status, 'upcoming');
  // Still unpaid from earlier months.
  const early = Loans.unpaidBefore(st, '2026-11', '2026-11');
  assert.deepEqual(early.map((e) => [e.loan.id, e.months, e.amount]), [
    ['B1', ['2026-08', '2026-09'], 5000],
    ['L1', ['2026-08', '2026-09', '2026-10'], 4500],
  ]);
});

test('month totals: paid is what was logged in that month', () => {
  const st = {
    loans: [L, bill],
    // Terms 1-2 logged in June (3,200); terms 3-6 logged together in November (6,000);
    // a partial 500 in November; electricity 2,900 logged for October.
    payments: [pay('a', '2026-06', 2, 3200), pay('b', '2026-11', 4, 6000), { id: 'pp', loanId: 'L1', month: '2026-11', terms: 0, amount: 500 }, bpay('e', '2026-10', 2900)],
  };
  // November: the whole 6,000 plus the 500 count, in the month they were logged.
  const nov = Loans.monthTotals(st, '2026-11', '2026-11', 25);
  assert.equal(nov.paid, 6500);
  assert.equal(nov.payments.length, 2);
  // What's due in November: phone term 6 (paid, 6,000 / 4) and electricity (~2,500, unpaid).
  assert.equal(nov.due, 4000);
  assert.equal(nov.left, 2500);
  assert.equal(nov.estimated, true);
  // July: term 2 is paid, but nothing was logged in July.
  const jul = Loans.monthTotals(st, '2026-07', '2026-11', 25);
  assert.equal(jul.paid, 0);
  assert.equal(jul.left, 0);
  // October: electricity's 2,900 was logged for October; the phone's term 4 is paid (by November's payment).
  const oct = Loans.monthTotals(st, '2026-10', '2026-11', 25);
  assert.deepEqual([oct.paid, oct.left, oct.overdue], [2900, 0, 0]);
  // June: the 3,200 for terms 1-2.
  assert.equal(Loans.monthTotals(st, '2026-06', '2026-11', 25).paid, 3200);
});

test('paid in advance: a zero balance counts as paid off', () => {
  // 18 x 1,500 = 27,000. Two terms paid, then the remaining 24,000 in one go,
  // recorded as a single term.
  const payments = [pay('a', '2026-06', 2), pay('b', '2026-08', 1, 24000)];
  const s = Loans.summary(L, payments, '2026-08');
  assert.equal(s.remaining, 0);
  assert.equal(s.status, 'done');
  assert.equal(s.termsPaid, 18);
  assert.equal(s.behind, 0);
  assert.equal(s.nextTerm, null);
  assert.equal(s.paidOffIn, '2026-08');
  assert.equal(s.early, true);
  // Partial payments (0 terms) that add up to the total count too.
  assert.equal(Loans.summary(L, [pay('c', '2026-06', 0, 27000)], '2026-06').status, 'done');
  // Not paid off while money is still owed.
  assert.notEqual(Loans.summary(L, [pay('d', '2026-06', 0, 26000)], '2026-06').status, 'done');
  // After an early payoff the loan isn't due in later months, or overdue before.
  const st = { loans: [L], payments };
  assert.equal(Loans.monthItems(st, '2026-09', '2026-11', 1).length, 0);
  assert.equal(Loans.monthItems(st, '2026-08', '2026-11', 1)[0].status, 'paid');
  assert.equal(Loans.unpaidBefore(st, '2026-11', '2026-11').length, 0);
  // Paid off on schedule isn't "early".
  const onTime = Loans.summary(L, [pay('e', '2027-11', 18)], '2027-11');
  assert.equal(onTime.early, false);
});

test('each expense is a bill or a loan', () => {
  assert.equal(Loans.cleanLoan({ name: 'Rent', category: 'bill', termAmount: 8000, terms: 12, firstMonth: '2026-01' }).category, 'bill');
  assert.equal(Loans.cleanLoan({ name: 'Phone', termAmount: 1500, terms: 12, firstMonth: '2026-01' }).category, 'loan');
  assert.equal(Loans.cleanVariable({ name: 'Electricity', firstMonth: '2026-01' }).category, 'bill');
  assert.equal(Loans.cleanVariable({ name: 'Credit line', category: 'loan', firstMonth: '2026-01' }).category, 'loan');
  assert.equal(Loans.cleanLoan({ name: 'X', category: 'nope', termAmount: 1, terms: 1, firstMonth: '2026-01' }).category, 'loan');
  // Saved before there was a choice.
  assert.equal(Loans.categoryOf({ name: 'Old phone', termAmount: 1500 }), 'loan');
  assert.equal(Loans.categoryOf({ name: 'Old water', kind: 'variable' }), 'bill');
  // Icons: loans get the loan icon; a fixed bill like rent gets its own.
  assert.equal(Loans.iconKind({ name: 'Rent', category: 'bill', termAmount: 8000 }), 'rent');
  assert.equal(Loans.iconKind({ name: 'Electricity', kind: 'variable', lender: 'Meralco' }), 'electricity');
  assert.equal(Loans.iconKind({ name: 'SSS loan', category: 'loan' }), 'loan');
});

test('a third type: other expenses', () => {
  const e = Loans.cleanVariable({ name: 'Groceries', category: 'expense', firstMonth: '2026-01' });
  assert.equal(e.category, 'expense');
  assert.equal(Loans.categoryLabel(e), 'Other');
  assert.equal(Loans.categoryLabel({ name: 'Old phone', termAmount: 1 }), 'Loan');
  assert.equal(Loans.cleanLoan({ name: 'Allowance', category: 'expense', termAmount: 3500, terms: 12, firstMonth: '2026-01' }).category, 'expense');
  assert.equal(Loans.iconKind({ name: 'Groceries', category: 'expense', kind: 'variable' }), 'groceries');
  assert.equal(Loans.iconKind({ name: 'Misc', category: 'expense', kind: 'variable' }), 'other');
  assert.equal(Loans.iconKind({ name: 'Tuition', category: 'expense', termAmount: 5000 }), 'school');
});

test('icons: chosen in the form, else guessed', () => {
  assert.equal(Loans.cleanVariable({ name: 'Groceries', firstMonth: '2026-01', icon: 'shopping' }).icon, 'shopping');
  assert.equal(Loans.cleanVariable({ name: 'Groceries', firstMonth: '2026-01', icon: 'bogus' }).icon, null);
  assert.equal(Loans.iconKind({ name: 'Groceries', category: 'expense', icon: 'shopping' }), 'shopping');
  assert.equal(Loans.iconKind({ name: 'Groceries', lender: 'Puregold', category: 'expense' }), 'groceries');
  assert.equal(Loans.iconKind({ name: 'MangPangKoy Allowance', category: 'bill' }), 'family');
  assert.equal(Loans.iconKind({ name: 'Shopee Installments', category: 'bill' }), 'shopping');
  assert.equal(Loans.iconKind({ name: 'CreditCard', lender: 'BPI', category: 'bill' }), 'card');
  assert.equal(Loans.iconKind({ name: 'MayaLoan', category: 'loan' }), 'loan');
  assert.equal(Loans.iconKind({ name: 'MayaLoan', category: 'loan', icon: 'mobile' }), 'mobile');
});

test('payments logged for other months show up so the month adds up', () => {
  // 3 x 1,100 from November; term 2 (December) paid in November; term 1 (November) logged in December.
  const loanO = { id: 'O', name: 'Olango', category: 'loan', termAmount: 1100, terms: 3, firstMonth: '2026-11', dueDay: 30 };
  const st = { loans: [loanO], payments: [{ id: 'x', loanId: 'O', month: '2026-12', terms: 1, amount: 1100 }] };
  // December: the only payment logged is term 1, which is November's.
  let other = Loans.loggedForOtherMonths(st, '2026-12', '2026-12', 5);
  assert.deepEqual(other.map((o) => [o.kind, o.fromTerm, o.fromMonth]), [['earlier', 1, '2026-11']]);
  // Paying December's own term (term 2) is a normal row, not listed here.
  st.payments.push({ id: 'y', loanId: 'O', month: '2026-12', terms: 1, amount: 1100 });
  other = Loans.loggedForOtherMonths(st, '2026-12', '2026-12', 5);
  assert.deepEqual(other.map((o) => o.payment.id), ['x']);
  // Paying January's term in December is "ahead"; a 0-term payment is partial.
  st.payments.push({ id: 'z', loanId: 'O', month: '2026-12', terms: 1, amount: 1100 }, { id: 'w', loanId: 'O', month: '2026-12', terms: 0, amount: 50 });
  other = Loans.loggedForOtherMonths(st, '2026-12', '2026-12', 5);
  assert.deepEqual(other.map((o) => [o.payment.id, o.kind]), [['x', 'earlier'], ['z', 'ahead'], ['w', 'partial']]);
});
