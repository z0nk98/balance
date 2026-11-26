// Figures for the Insights section of the Expenses Dashboard, shared with the
// tests. In the browser it defines `window.Insights` (needs `window.Loans`);
// in Node it is a CommonJS module.
//
// Money in comes from the Expenses Dashboard's entries; expenses paid are the
// payments logged on the Tracker, counted in the month they were logged under
// (the same rule as the rest of the dashboard).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./loans.js'));
  else root.Insights = factory(root.Loans);
})(typeof self !== 'undefined' ? self : this, (Loans) => {
  'use strict';

  const round = (n) => Math.round(n * 100) / 100;
  const sum = (list) => round(list.reduce((t, n) => t + n, 0));
  const mean = (list) => (list.length ? sum(list) / list.length : null);
  const pad = (n) => String(n).padStart(2, '0');

  function moneyIn(expenses, month) {
    return sum(expenses.filter((e) => e.type === 'in' && String(e.date || '').slice(0, 7) === month).map((e) => e.amount));
  }

  // Payments logged under a month, each with its expense.
  function paymentsIn(tracker, month) {
    const byId = new Map(tracker.loans.map((l) => [l.id, l]));
    return tracker.payments.filter((p) => p.month === month && byId.has(p.loanId)).map((p) => ({ p, loan: byId.get(p.loanId) }));
  }

  const paidIn = (tracker, month) => sum(paymentsIn(tracker, month).map((x) => x.p.amount));

  // Money in, expenses paid and net for `count` months ending at endMonth.
  function trend(expenses, tracker, endMonth, count = 6) {
    const out = [];
    for (let k = count - 1; k >= 0; k--) {
      const month = Loans.addMonths(endMonth, -k);
      const inn = moneyIn(expenses, month);
      const paid = paidIn(tracker, month);
      out.push({ month, in: inn, out: paid, net: round(inn - paid) });
    }
    return out;
  }

  // The headline figures for a month.
  function headline(expenses, tracker, month) {
    const inn = moneyIn(expenses, month);
    const items = paymentsIn(tracker, month);
    const out = sum(items.map((x) => x.p.amount));
    // Average spending over the three months before, counting only months with any data.
    const before = [1, 2, 3].map((k) => Loans.addMonths(month, -k))
      .filter((m) => paidIn(tracker, m) > 0 || moneyIn(expenses, m) > 0);
    const average = before.length ? round(mean(before.map((m) => paidIn(tracker, m)))) : null;
    const loanPaid = sum(items.filter((x) => Loans.categoryOf(x.loan) === 'loan').map((x) => x.p.amount));
    const fixedPaid = sum(items.filter((x) => !Loans.isVariable(x.loan)).map((x) => x.p.amount));
    return {
      in: inn,
      out,
      net: round(inn - out),
      average,
      averageMonths: before.length,
      change: average ? (out - average) / average : null,
      savingsRate: inn > 0 ? (inn - out) / inn : null,
      loanPaid,
      loanShare: inn > 0 ? loanPaid / inn : null,
      fixedPaid,
      varyingPaid: round(out - fixedPaid),
      fixedShare: out > 0 ? fixedPaid / out : null,
    };
  }

  // Loan payments as a share of money in: under 30% is fine, 30-40% worth
  // watching, over 40% high.
  function loanLevel(share) {
    if (share === null) return null;
    if (share > 0.4) return 'high';
    if (share >= 0.3) return 'watch';
    return 'ok';
  }

  // Each expense whose amount varies, with what was paid in each of the last
  // `count` months, its average, lowest and highest month, and a flag when the
  // month shown is more than 20% above its other months' average.
  function varyingBills(tracker, month, count = 6) {
    const out = [];
    for (const loan of tracker.loans) {
      if (!Loans.isVariable(loan)) continue;
      const s = Loans.variableSummary(loan, tracker.payments, month);
      const history = [...s.byMonth].filter(([m]) => m <= month);
      if (!history.length) continue;
      const months = [];
      for (let k = count - 1; k >= 0; k--) {
        const m = Loans.addMonths(month, -k);
        if (m >= loan.firstMonth) months.push({ month: m, amount: s.byMonth.has(m) ? s.byMonth.get(m) : null });
      }
      const values = history.map(([, v]) => v);
      const current = s.byMonth.has(month) ? s.byMonth.get(month) : null;
      const others = history.filter(([m]) => m !== month).map(([, v]) => v);
      const othersAverage = others.length >= 2 ? mean(others) : null;
      const above = current !== null && othersAverage ? (current - othersAverage) / othersAverage : null;
      out.push({
        loan,
        months,
        average: round(mean(values)),
        min: Math.min(...values),
        max: Math.max(...values),
        current,
        above,
        flagged: above !== null && above > 0.2,
      });
    }
    return out.sort((a, b) => (b.flagged - a.flagged) || (b.average - a.average));
  }

  // Paying on time: each payment's logged date against its due date (the bill
  // month's due day, or for fixed terms the first term it covered). Only
  // payments with a due day and a logged date count; partial payments don't.
  function onTime(tracker) {
    const entries = [];
    const summaries = new Map();
    for (const p of tracker.payments) {
      const loan = tracker.loans.find((l) => l.id === p.loanId);
      if (!loan || !loan.dueDay || !p.created) continue;
      let dueMonth;
      if (Loans.isVariable(loan)) dueMonth = p.month;
      else {
        if (!p.terms) continue;
        if (!summaries.has(loan.id)) summaries.set(loan.id, Loans.summary(loan, tracker.payments, p.month));
        const h = summaries.get(loan.id).history.find((x) => x.id === p.id);
        if (!h || !h.fromTerm) continue;
        dueMonth = Loans.addMonths(loan.firstMonth, h.fromTerm - 1);
      }
      const [y, m] = dueMonth.split('-').map(Number);
      const lastDay = new Date(y, m, 0).getDate();
      const due = new Date(y, m - 1, Math.min(loan.dueDay, lastDay));
      const logged = new Date(p.created);
      const paidDay = new Date(logged.getFullYear(), logged.getMonth(), logged.getDate());
      const days = Math.round((due - paidDay) / 86400000); // positive = early
      entries.push({ loan, payment: p, due: `${y}-${pad(m)}-${pad(due.getDate())}`, days, onTime: days >= 0, created: p.created });
    }
    entries.sort((a, b) => a.created - b.created);
    let streak = 0;
    for (let i = entries.length - 1; i >= 0 && entries[i].onTime; i--) streak++;
    const onTimeCount = entries.filter((e) => e.onTime).length;
    const late = entries.filter((e) => !e.onTime);
    return {
      count: entries.length,
      onTimeCount,
      rate: entries.length ? onTimeCount / entries.length : null,
      averageDays: entries.length ? Math.round(mean(entries.map((e) => e.days)) * 10) / 10 : null,
      averageLateDays: late.length ? Math.round(mean(late.map((e) => -e.days)) * 10) / 10 : null,
      lateCount: late.length,
      streak,
      entries,
    };
  }

  return { moneyIn, paymentsIn, trend, headline, loanLevel, varyingBills, onTime };
});
