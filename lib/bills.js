// Bill schedule logic, shared by bills.js and the tests.
// In the browser it defines `window.Bills`; in Node it is a CommonJS module.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Bills = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const KINDS = {
    electricity: { label: 'Electricity', expense: 'Utilities' },
    water: { label: 'Water', expense: 'Utilities' },
    internet: { label: 'Internet', expense: 'Utilities' },
    mobile: { label: 'Mobile', expense: 'Utilities' },
    rent: { label: 'Rent / Housing', expense: 'Housing' },
    card: { label: 'Credit card', expense: 'Other' },
    loan: { label: 'Loan', expense: 'Other' },
    insurance: { label: 'Insurance', expense: 'Health' },
    subscription: { label: 'Subscription', expense: 'Entertainment' },
    school: { label: 'School / Tuition', expense: 'Other' },
    other: { label: 'Other', expense: 'Other' },
  };

  // Months between repeats; 0 = only once.
  const REPEATS = {
    1: 'Every month',
    2: 'Every 2 months',
    3: 'Every 3 months',
    6: 'Every 6 months',
    12: 'Every year',
    0: 'Once',
  };

  const pad = (n) => String(n).padStart(2, '0');

  function monthIndex(key) {
    const [y, m] = key.split('-').map(Number);
    return y * 12 + (m - 1);
  }

  function shiftMonth(key, delta) {
    const i = monthIndex(key) + delta;
    return `${Math.floor(i / 12)}-${pad((i % 12) + 1)}`;
  }

  // The due date in a month, clamping day 31 to short months.
  function dueDateIn(key, day) {
    const [y, m] = key.split('-').map(Number);
    const last = new Date(y, m, 0).getDate();
    return `${key}-${pad(Math.min(day, last))}`;
  }

  // Is the bill due in this month (YYYY-MM)?
  function isDueIn(bill, key) {
    const diff = monthIndex(key) - monthIndex(bill.startMonth);
    if (diff < 0) return false;
    if (bill.endMonth && monthIndex(key) > monthIndex(bill.endMonth)) return false;
    if (Number(bill.every) === 0) return diff === 0;
    return diff % Number(bill.every) === 0;
  }

  function daysBetween(a, b) {
    const [ay, am, ad] = a.split('-').map(Number);
    const [by, bm, bd] = b.split('-').map(Number);
    return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
  }

  // Older bills had no type: an amount of 0 meant "varies".
  function amountType(b) {
    return b.amountType || (b.amount > 0 ? 'fixed' : 'variable');
  }

  // Bills without a set due date can be paid any time in the month.
  function hasDueDate(b) {
    return b.hasDueDate !== false;
  }

  // Bills due in a month, with their payment record and status.
  function forMonth(state, key, today, soonDays = 5) {
    return state.bills
      .filter((b) => !b.paused && isDueIn(b, key))
      .map((b) => {
        const dueDate = dueDateIn(key, hasDueDate(b) ? b.dueDay : 31);
        const payment = state.payments[`${b.id}:${key}`] || null;
        const days = daysBetween(today, dueDate);
        let status;
        if (payment) status = 'paid';
        else if (days < 0) status = 'overdue';
        else if (days <= soonDays) status = 'due-soon';
        else status = 'upcoming';
        return {
          bill: b, key, dueDate, payment, daysUntilDue: days, status,
          amount: payment ? payment.amount : b.amount,
          type: amountType(b),
          anytime: !hasDueDate(b),
        };
      })
      .sort((a, c) => a.dueDate.localeCompare(c.dueDate) || a.bill.name.localeCompare(c.bill.name));
  }

  // Unpaid bills from earlier months, newest first (looks back a year).
  function overdueBefore(state, key, today) {
    const out = [];
    for (let k = 1; k <= 12; k++) {
      const m = shiftMonth(key, -k);
      for (const item of forMonth(state, m, today)) if (item.status === 'overdue') out.push(item);
    }
    return out;
  }

  function totals(items) {
    const sum = (f) => Math.round(items.reduce((s, i) => s + f(i), 0) * 100) / 100;
    return {
      due: sum((i) => i.amount),
      paid: sum((i) => (i.payment ? i.payment.amount : 0)),
      left: sum((i) => (i.payment ? 0 : i.amount)),
      overdue: sum((i) => (i.status === 'overdue' ? i.amount : 0)),
      fixed: sum((i) => (i.type === 'fixed' ? i.amount : 0)),
      variable: sum((i) => (i.type === 'variable' ? i.amount : 0)),
      count: items.length,
      unpaid: items.filter((i) => !i.payment).length,
    };
  }

  function cleanBill(input) {
    const name = String(input.name ?? '').trim().slice(0, 60);
    if (!name) throw new Error('Give the bill a name');
    const amount = Math.round(Number(input.amount || 0) * 100) / 100;
    if (!Number.isFinite(amount) || amount < 0 || amount > 1e9) throw new Error('Enter a valid amount');
    const type = ['fixed', 'variable'].includes(input.amountType) ? input.amountType : (amount > 0 ? 'fixed' : 'variable');
    if (type === 'fixed' && !(amount > 0)) throw new Error('Enter the bill’s amount (or choose Variable if it changes)');
    const withDueDate = input.hasDueDate !== false;
    const dueDay = withDueDate ? Number(input.dueDay) : 31;
    if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) throw new Error('Due day must be between 1 and 31');
    const every = Number(input.every);
    if (!Object.hasOwn(REPEATS, every)) throw new Error('Pick how often it repeats');
    if (!/^\d{4}-\d{2}$/.test(input.startMonth || '')) throw new Error('Pick the first month it’s due');
    return {
      name,
      kind: Object.hasOwn(KINDS, input.kind) ? input.kind : 'other',
      amount,
      amountType: type,
      hasDueDate: withDueDate,
      dueDay,
      every,
      startMonth: input.startMonth,
      endMonth: /^\d{4}-\d{2}$/.test(input.endMonth || '') ? input.endMonth : '',
      account: String(input.account ?? '').trim().slice(0, 60),
      note: String(input.note ?? '').trim().slice(0, 120),
      autopay: Boolean(input.autopay),
    };
  }

  function emptyState() {
    return { v: 1, bills: [], payments: {} };
  }

  return { KINDS, REPEATS, amountType, hasDueDate, monthIndex, shiftMonth, dueDateIn, isDueIn, forMonth, overdueBefore, totals, cleanBill, emptyState };
});
