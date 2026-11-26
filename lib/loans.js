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

  // Whether an expense is a bill or a loan (chosen when adding it). Ones saved
  // before there was a choice: fixed amount = loan, varies each month = bill.
  function categoryOf(item) {
    if (item && (item.category === 'bill' || item.category === 'loan')) return item.category;
    return item && item.kind === 'variable' ? 'bill' : 'loan';
  }
  const cleanCategory = (raw, fallback) => (raw === 'bill' || raw === 'loan' ? raw : fallback);

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
      category: cleanCategory(raw.category, 'loan'),
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
    // Paid off when every term is paid, or when what's been paid covers the
    // total (e.g. paid in advance in one go): then every term counts as paid.
    const paidOff = paid >= total - 0.005;
    const termsPaid = paidOff ? loan.terms : Math.min(loan.terms, mine.reduce((s, p) => s + p.terms, 0));
    const done = termsPaid >= loan.terms;
    const lastMonth = addMonths(loan.firstMonth, loan.terms - 1);
    const paidOffIn = done && mine.length ? mine[mine.length - 1].month : null;
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
      lastMonth,
      // The month of the last payment once paid off, and whether that was
      // before the last term was due.
      paidOffIn,
      early: !!paidOffIn && paidOffIn < lastMonth,
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

  // ---- Variable bills -----------------------------------------------------
  // A bill due every month whose amount changes (electricity, water...).
  // It lives in the same `loans` list with kind: 'variable', so it syncs the
  // same way. `months` is how many months it runs (null = no end). Each of its
  // payments records the bill month it pays (`month`) and the actual amount;
  // `terms` is always 0 so term counts elsewhere aren't affected.

  const isVariable = (item) => item && item.kind === 'variable';

  function cleanVariable(raw) {
    const name = String(raw.name || '').trim().slice(0, 60);
    if (!name) throw new Error('Give the bill a name');
    if (!/^\d{4}-\d{2}$/.test(raw.firstMonth || '')) throw new Error('Pick the first month it’s due');
    const estimate = raw.estimate === '' || raw.estimate == null ? null : round(Number(raw.estimate));
    if (estimate !== null && !(estimate >= 0)) throw new Error('Usual amount can’t be negative');
    const months = raw.months === '' || raw.months == null ? null : Number(raw.months);
    if (months !== null && (!Number.isInteger(months) || months < 1 || months > 360)) throw new Error('Number of months must be between 1 and 360, or blank for no end');
    const dueDay = raw.dueDay === '' || raw.dueDay == null ? null : Number(raw.dueDay);
    if (dueDay !== null && (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31)) throw new Error('Due day must be between 1 and 31');
    return {
      kind: 'variable',
      category: cleanCategory(raw.category, 'bill'),
      name,
      lender: String(raw.lender || '').trim().slice(0, 60),
      estimate,
      months,
      firstMonth: raw.firstMonth,
      dueDay,
      note: String(raw.note || '').trim().slice(0, 120),
    };
  }

  const variableLastMonth = (bill) => (bill.months ? addMonths(bill.firstMonth, bill.months - 1) : null);

  function cleanVariablePayment(raw, bill) {
    const amount = round(Number(raw.amount));
    if (!(amount > 0)) throw new Error('Enter the amount paid');
    if (!/^\d{4}-\d{2}$/.test(raw.month || '')) throw new Error('Pick the bill month');
    if (raw.month < bill.firstMonth) throw new Error('That’s before this bill starts');
    const last = variableLastMonth(bill);
    if (last && raw.month > last) throw new Error('That’s after this bill ends');
    return { terms: 0, amount, month: raw.month, note: String(raw.note || '').trim().slice(0, 120) };
  }

  // Where a variable bill stands. thisMonth is 'YYYY-MM'.
  function variableSummary(bill, payments, thisMonth) {
    const mine = payments.filter((p) => p.loanId === bill.id).sort((a, b) => a.month.localeCompare(b.month) || String(a.id).localeCompare(String(b.id)));
    const byMonth = new Map();
    for (const p of mine) byMonth.set(p.month, round((byMonth.get(p.month) || 0) + p.amount));
    const lastMonth = variableLastMonth(bill);
    // Months due up to and including this month.
    const upTo = lastMonth && lastMonth < thisMonth ? lastMonth : thisMonth;
    const dueMonths = [];
    for (let m = bill.firstMonth; m <= upTo; m = addMonths(m, 1)) dueMonths.push(m);
    const unpaid = dueMonths.filter((m) => !byMonth.has(m));
    const paid = round(mine.reduce((s, p) => s + p.amount, 0));
    const monthsPaid = byMonth.size;
    const average = monthsPaid ? round(paid / monthsPaid) : null;
    const lastAmount = mine.length ? byMonth.get(mine[mine.length - 1].month) : null;
    // Best guess for a month not yet paid.
    const guess = bill.estimate ?? average;
    let nextMonth = null;
    if (unpaid.length) nextMonth = unpaid[0];
    else {
      let m = upTo < bill.firstMonth ? bill.firstMonth : addMonths(upTo, 1);
      while (byMonth.has(m)) m = addMonths(m, 1);
      if (!lastMonth || m <= lastMonth) nextMonth = m;
    }
    const done = !!lastMonth && nextMonth === null;
    const monthsLeft = lastMonth ? Math.max(0, bill.months - monthsPaid) : null;
    return {
      lastMonth,
      byMonth,
      history: mine,
      paid,
      monthsPaid,
      monthsLeft,
      average,
      lastAmount,
      guess,
      unpaid,
      behind: unpaid.length,
      // Estimated amounts; null when there's nothing to estimate from.
      overdueEstimate: guess === null ? null : round(unpaid.length * guess),
      remainingEstimate: monthsLeft === null || guess === null ? null : round(monthsLeft * guess),
      nextMonth,
      status: done ? 'done' : unpaid.length ? 'behind' : 'on-track',
    };
  }

  // Which bill icon fits: loans get the loan icon, bills a guess from the name.
  function iconKind(loan) {
    if (categoryOf(loan) === 'loan') return 'loan';
    const t = `${loan.name} ${loan.lender || ''}`.toLowerCase();
    const guess = [
      ['electricity', /electric|meralco|veco|davao light|power|kuryente/],
      ['water', /water|maynilad|tubig/],
      ['internet', /internet|wifi|wi-fi|pldt|converge|globe at home|sky ?cable|fiber|broadband/],
      ['mobile', /mobile|phone|postpaid|load|smart|globe|dito/],
      ['rent', /rent|upa|condo|apartment|dues/],
      ['card', /credit card|card/],
      ['insurance', /insurance|philhealth|pag-?ibig|sss/],
      ['subscription', /netflix|spotify|youtube|disney|subscription/],
      ['school', /school|tuition/],
    ].find(([, re]) => re.test(t));
    return guess ? guess[0] : 'other';
  }

  // ---- Month view -----------------------------------------------------------
  // What's due in `month` across every loan and bill. `thisMonth` is the
  // current 'YYYY-MM' and `todayDay` today's day of the month, for "overdue".
  //
  // Fixed: the term that falls in that month. Terms are paid in order, so
  // paying it also covers any earlier unpaid terms (`cover` says how many).
  // Variable: the bill for that month, with the actual amount once paid, or
  // an estimate (`estimated`) until then.
  function monthItems(state, month, thisMonth, todayDay) {
    const items = [];
    const statusFor = (paid, dueDay) => {
      if (paid) return 'paid';
      if (month < thisMonth) return 'overdue';
      if (month > thisMonth) return 'upcoming';
      return dueDay && todayDay > dueDay ? 'overdue' : 'due-soon';
    };
    for (const loan of state.loans) {
      if (isVariable(loan)) {
        const s = variableSummary(loan, state.payments, thisMonth);
        if (month < loan.firstMonth || (s.lastMonth && month > s.lastMonth)) continue;
        const paidAmount = s.byMonth.get(month);
        const paid = paidAmount !== undefined;
        items.push({
          loan, variable: true, month,
          amount: paid ? paidAmount : s.guess,
          estimated: !paid,
          paid,
          status: statusFor(paid, loan.dueDay),
          dueDay: loan.dueDay,
        });
      } else {
        const termNo = monthsBetween(loan.firstMonth, month) + 1;
        if (termNo < 1 || termNo > loan.terms) continue;
        const s = summary(loan, state.payments, thisMonth);
        // Paid off early: nothing is due in the months after.
        if (s.early && month > s.paidOffIn) continue;
        const paid = s.termsPaid >= termNo;
        // A paid term counts what was actually paid for it: its payment's
        // amount shared over the terms that payment covered.
        const by = paid ? s.history.find((h) => h.fromTerm && h.fromTerm <= termNo && h.toTerm >= termNo) : null;
        items.push({
          loan, variable: false, month, termNo,
          amount: by ? round(by.amount / by.terms) : loan.termAmount,
          estimated: false,
          paid,
          status: statusFor(paid, loan.dueDay),
          dueDay: loan.dueDay,
          cover: paid ? 0 : termNo - s.termsPaid,
          // The term's payment, when one payment record covers it.
          paidIn: by ? by.month : null,
        });
      }
    }
    const rank = { overdue: 0, 'due-soon': 1, upcoming: 2, paid: 3 };
    return items.sort((a, b) => rank[a.status] - rank[b.status] || (a.dueDay || 32) - (b.dueDay || 32) || a.loan.name.localeCompare(b.loan.name));
  }

  // The month's dashboard, shared by the Tracker and Expenses pages so they
  // always agree. `paid` is what you logged on the Tracker for that month: the
  // full amount of every payment saved under it (a fixed payment covering four
  // terms counts all four, in the month you logged it). `due` and `left` are
  // about the bills and loans due that month.
  function monthTotals(state, month, thisMonth, todayDay) {
    const items = monthItems(state, month, thisMonth, todayDay);
    const earlier = month === thisMonth ? unpaidBefore(state, month, thisMonth) : [];
    const add = (list) => round(list.reduce((t, i) => t + (i.amount || 0), 0));
    const ids = new Set(state.loans.map((l) => l.id));
    const payments = state.payments.filter((p) => p.month === month && ids.has(p.loanId));
    const paidItems = items.filter((i) => i.paid);
    const unpaidItems = items.filter((i) => !i.paid);
    const overdueItems = items.filter((i) => i.status === 'overdue');
    return {
      items,
      earlier,
      payments,
      paid: round(payments.reduce((t, p) => t + p.amount, 0)),
      left: add(unpaidItems),
      due: add(items),
      overdue: round(add(overdueItems) + earlier.reduce((t, e) => t + (e.amount || 0), 0)),
      overdueCount: overdueItems.length + earlier.reduce((t, e) => t + e.months.length, 0),
      paidCount: paidItems.length,
      unpaidCount: unpaidItems.length,
      estimated: unpaidItems.some((i) => i.estimated),
    };
  }

  // Still unpaid from months before `month` (up to the current month).
  function unpaidBefore(state, month, thisMonth) {
    const out = [];
    const until = month < thisMonth ? month : thisMonth;
    for (const loan of state.loans) {
      if (isVariable(loan)) {
        const s = variableSummary(loan, state.payments, thisMonth);
        const months = s.unpaid.filter((m) => m < until);
        if (months.length) out.push({ loan, variable: true, months, amount: s.guess === null ? null : round(months.length * s.guess), estimated: true });
      } else {
        const s = summary(loan, state.payments, thisMonth);
        const dueBefore = Math.max(0, Math.min(loan.terms, monthsBetween(loan.firstMonth, until)));
        const count = dueBefore - s.termsPaid;
        if (count > 0) {
          const months = [];
          for (let t = s.termsPaid + 1; t <= dueBefore; t++) months.push(addMonths(loan.firstMonth, t - 1));
          out.push({ loan, variable: false, months, amount: round(count * loan.termAmount), estimated: false });
        }
      }
    }
    return out.sort((a, b) => a.months[0].localeCompare(b.months[0]) || a.loan.name.localeCompare(b.loan.name));
  }

  return {
    emptyState, addMonths, monthsBetween, cleanLoan, cleanPayment, summary, paidInMonth,
    isVariable, cleanVariable, cleanVariablePayment, variableSummary, monthItems, unpaidBefore, monthTotals, iconKind, categoryOf,
  };
});
