// Loans you are paying off (the Tracker page), shared with the tests.
// In the browser it defines `window.Loans`; in Node it is a CommonJS module.
//
// A loan is paid in equal terms, one due each month from its first month.
// A payment records the month it was paid in and how many terms it covered,
// so paying three terms at once in November counts three terms paid.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Loans = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const round = (n) => Math.round(n * 100) / 100;

  function emptyState() {
    return { v: 1, loans: [], payments: [] };
  }

  // 'YYYY-MM' plus n months.
  function addMonths(month, n) {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(y, m - 1 + n, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  function monthsBetween(from, to) {
    const [fy, fm] = from.split('-').map(Number);
    const [ty, tm] = to.split('-').map(Number);
    return (ty - fy) * 12 + (tm - fm);
  }

  function cleanLoan(raw) {
    const name = String(raw.name || '').trim().slice(0, 60);
    const termAmount = round(Number(raw.termAmount));
    const terms = Number(raw.terms);
    const borrowed = raw.borrowed === '' || raw.borrowed == null ? null : round(Number(raw.borrowed));
    if (!name) throw new Error('Give the loan a name');
    if (!(termAmount > 0)) throw new Error('Enter the amount per term');
    if (!Number.isInteger(terms) || terms < 1 || terms > 360) throw new Error('Number of terms must be between 1 and 360');
    if (!/^\d{4}-\d{2}$/.test(raw.firstMonth || '')) throw new Error('Pick the month the first term is due');
    if (borrowed !== null && !(borrowed >= 0)) throw new Error('Amount borrowed can’t be negative');
    const dueDay = raw.dueDay === '' || raw.dueDay == null ? null : Number(raw.dueDay);
    if (dueDay !== null && (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31)) throw new Error('Due day must be between 1 and 31');
    return {
      name,
      lender: String(raw.lender || '').trim().slice(0, 60),
      termAmount,
      terms,
      firstMonth: raw.firstMonth,
      dueDay,
      borrowed,
      note: String(raw.note || '').trim().slice(0, 120),
    };
  }

  function cleanPayment(raw, loan) {
    const terms = Number(raw.terms);
    if (!Number.isInteger(terms) || terms < 0 || terms > loan.terms) throw new Error(`Terms paid must be between 0 and ${loan.terms}`);
    const amount = raw.amount === '' || raw.amount == null ? round(terms * loan.termAmount) : round(Number(raw.amount));
    if (!(amount > 0)) throw new Error('Enter the amount paid');
    if (!/^\d{4}-\d{2}$/.test(raw.month || '')) throw new Error('Pick the month you paid');
    return { terms, amount, month: raw.month, note: String(raw.note || '').trim().slice(0, 120) };
  }

  // Where a loan stands. thisMonth is 'YYYY-MM'.
  function summary(loan, payments, thisMonth) {
    const mine = payments.filter((p) => p.loanId === loan.id).sort((a, b) => a.month.localeCompare(b.month) || String(a.id).localeCompare(String(b.id)));
    const total = round(loan.termAmount * loan.terms);
    const paid = round(mine.reduce((s, p) => s + p.amount, 0));
    const termsPaid = Math.min(loan.terms, mine.reduce((s, p) => s + p.terms, 0));
    const done = termsPaid >= loan.terms;
    // Terms that should be paid by the end of this month.
    const dueByNow = Math.max(0, Math.min(loan.terms, monthsBetween(loan.firstMonth, thisMonth) + 1));
    const behind = Math.max(0, dueByNow - termsPaid);
    const ahead = Math.max(0, termsPaid - dueByNow);
    const nextTerm = done ? null : termsPaid + 1;
    // Which term numbers each payment covered, in order.
    let n = 0;
    const history = mine.map((p) => {
      const from = n + 1;
      n += p.terms;
      return { ...p, fromTerm: p.terms ? from : null, toTerm: p.terms ? Math.min(n, loan.terms) : null };
    });
    let status = 'on-track';
    if (done) status = 'done';
    else if (behind > 0) status = 'behind';
    else if (ahead > 0) status = 'ahead';
    return {
      total,
      paid,
      remaining: round(Math.max(0, total - paid)),
      termsPaid,
      termsLeft: loan.terms - termsPaid,
      behind,
      ahead,
      nextTerm,
      nextMonth: nextTerm ? addMonths(loan.firstMonth, nextTerm - 1) : null,
      lastMonth: addMonths(loan.firstMonth, loan.terms - 1),
      interest: loan.borrowed !== null && loan.borrowed !== undefined ? round(total - loan.borrowed) : null,
      status,
      history,
    };
  }

  // Payments made in a month, across all loans.
  function paidInMonth(state, month) {
    const items = state.payments.filter((p) => p.month === month);
    return { amount: round(items.reduce((s, p) => s + p.amount, 0)), terms: items.reduce((s, p) => s + p.terms, 0), count: items.length };
  }

  return { emptyState, addMonths, monthsBetween, cleanLoan, cleanPayment, summary, paidInMonth };
});
