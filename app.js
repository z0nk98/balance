(() => {
  'use strict';

  // Entries are kept under `expenses` for compatibility. Each has type 'in' (money in) or 'out' (money out); older
  // entries without a type are money out.
  const STORAGE_KEY = 'expense-tracker:v1';
  // Money out is the bills paid in the Personal Bills Tracker (tracker.html).
  // Money-out entries typed in here (or added by the old Bills page) are kept,
  // but not counted.
  const LOANS_KEY = 'personal-loans:v1';
  const BILL_COLORS = ['#e07a5f', '#3d85c6', '#8e6fd1', '#f2a541', '#4fb3bf', '#d65db1', '#81b29a', '#b45f3c', '#6b4fd1', '#9aa0a8'];
  const CATEGORIES = {
    out: {
      Food: '#e07a5f',
      Groceries: '#81b29a',
      Transport: '#3d85c6',
      Housing: '#8e6fd1',
      Utilities: '#f2cc8f',
      Health: '#4fb3bf',
      Entertainment: '#d65db1',
      Shopping: '#f4a259',
      Travel: '#5b8e7d',
      Other: '#9aa0a8',
    },
    in: {
      Salary: '#2f9e5b',
      Business: '#1d6fe8',
      Freelance: '#6b4fd1',
      'Loan repayment': '#b45f3c',
      Gift: '#d14d8b',
      Refund: '#3d7a8a',
      Interest: '#8a6d1d',
      'Other income': '#8a8f98',
    },
  };

  const $ = (id) => document.getElementById(id);

  // ---- State ----------------------------------------------------------

  const state = load();
  let viewMonth = monthKey(todayISO());
  const formType = 'in';

  function load() {
    const fallback = { expenses: [], budget: null, currency: 'USD' };
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
    } catch {
      return fallback;
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Storage unavailable (private mode, quota): keep working in memory.
    }
    window.BalanceSync?.changed();
  }

  const typeOf = (e) => (e.type === 'in' ? 'in' : 'out');
  const colorOf = (e) => e.color || CATEGORIES[typeOf(e)][e.category] || '#9aa0a8';

  // ---- Tracker link -------------------------------------------------------

  function readTracker() {
    try {
      const data = JSON.parse(localStorage.getItem(LOANS_KEY) || 'null');
      return data && Array.isArray(data.loans) ? { loans: data.loans, payments: Array.isArray(data.payments) ? data.payments : [] } : { loans: [], payments: [] };
    } catch {
      return { loans: [], payments: [] };
    }
  }

  // The Tracker's dashboard for the month being viewed.
  function trackerMonth() {
    const tracker = readTracker();
    if (!window.Loans) return null;
    const t = Loans.monthTotals(tracker, viewMonth, monthKey(todayISO()), new Date().getDate());
    // A colour per bill or loan, the same every month.
    const order = tracker.loans.map((l) => l.id);
    const colorFor = (id) => BILL_COLORS[Math.max(0, order.indexOf(id)) % BILL_COLORS.length];
    const dateIn = (month, day) => {
      const [y, m] = month.split('-').map(Number);
      const last = new Date(y, m, 0).getDate();
      return `${month}-${pad(Math.min(day || 1, last))}`;
    };
    // Every payment logged on the Tracker for this month, as a list entry
    // (read-only: change it on the Tracker). Shown on the day it was logged
    // when that's in this month.
    const termsText = (loan, p) => {
      if (!p.terms) return 'Partial payment';
      const h = Loans.summary(loan, tracker.payments, monthKey(todayISO())).history.find((x) => x.id === p.id);
      if (!h || !h.fromTerm) return `${p.terms} term${p.terms === 1 ? '' : 's'}`;
      return (h.terms === 1 ? `Term ${h.fromTerm}` : `Terms ${h.fromTerm}–${h.toTerm}`) + ` of ${loan.terms}`;
    };
    const paid = t.payments.map((p) => {
      const loan = tracker.loans.find((l) => l.id === p.loanId);
      const variable = Loans.isVariable(loan);
      const logged = p.created ? new Date(p.created) : null;
      const loggedIso = logged ? `${logged.getFullYear()}-${pad(logged.getMonth() + 1)}-${pad(logged.getDate())}` : '';
      return {
        id: `tracker:${p.id}`,
        tracker: true,
        type: 'out',
        category: loan.name,
        amount: p.amount,
        date: monthKey(loggedIso) === p.month ? loggedIso : dateIn(p.month, loan.dueDay),
        note: [Loans.categoryLabel(loan), variable ? 'Varies each month' : termsText(loan, p), loan.lender, p.note].filter(Boolean).join(' · '),
        color: colorFor(loan.id),
        created: p.created || 0,
      };
    });
    return { ...t, paidEntries: paid, hasLoans: tracker.loans.length > 0 };
  }

  // ---- Helpers --------------------------------------------------------

  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function monthKey(iso) {
    return iso.slice(0, 7);
  }

  function shiftMonth(key, delta) {
    const [y, m] = key.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  }

  function monthLabel(key) {
    const [y, m] = key.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }

  function dateLabel(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function money(n) {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: state.currency }).format(n);
    } catch {
      return n.toFixed(2);
    }
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    for (const c of children) if (c) node.append(c);
    return node;
  }

  function monthEntries() {
    return state.expenses.filter((e) => monthKey(e.date) === viewMonth);
  }

  const sum = (list) => Math.round(list.reduce((s, e) => s + e.amount, 0) * 100) / 100;

  // ---- Rendering ------------------------------------------------------

  function render() {
    $('monthLabel').textContent = monthLabel(viewMonth);
    const items = monthEntries();
    const ins = items.filter((e) => typeOf(e) === 'in');
    const notCounted = items.filter((e) => typeOf(e) === 'out');
    const t = trackerMonth();
    const billsPaid = t ? t.paidEntries : [];

    renderStats(sum(ins), t ? t.paid : 0);
    renderBreakdown($('breakdown'), $('breakdownEmpty'), billsPaid);
    renderBreakdown($('breakdownIn'), $('breakdownInEmpty'), ins);
    renderList([...ins, ...billsPaid]);
    renderTracker(t);

    const hidden = $('hiddenNote');
    hidden.hidden = notCounted.length === 0;
    hidden.textContent = notCounted.length
      ? `Not counted: ${notCounted.length} older money-out entr${notCounted.length === 1 ? 'y' : 'ies'} this month (${money(sum(notCounted))}), saved before money out came from the Tracker. Only what you pay in the Tracker counts.`
      : '';
  }

  function renderStats(totalIn, totalOut) {
    $('totalIn').textContent = money(totalIn);
    $('totalSpent').textContent = money(totalOut);
    const net = Math.round((totalIn - totalOut) * 100) / 100;
    $('net').textContent = (net > 0 ? '+' : '') + money(net);
    $('net').classList.toggle('money-in', net > 0);
    $('net').classList.toggle('over', net < 0);

    const fill = $('budgetFill');
    const remaining = $('remaining');
    fill.className = '';
    remaining.classList.remove('over');

    if (state.budget > 0) {
      const left = state.budget - totalOut;
      const pct = (totalOut / state.budget) * 100;
      remaining.textContent = left >= 0 ? `${money(left)} left to spend` : `${money(-left)} over budget`;
      remaining.classList.toggle('over', left < 0);
      fill.style.width = Math.min(pct, 100) + '%';
      if (pct >= 100) fill.classList.add('over');
      else if (pct >= 80) fill.classList.add('warn');
    } else {
      remaining.textContent = '';
      fill.style.width = '0';
    }
  }

  function renderBreakdown(list, empty, items) {
    const total = sum(items);
    const sums = {};
    for (const e of items) sums[e.category] = (sums[e.category] || 0) + e.amount;
    const rows = Object.entries(sums).sort((a, b) => b[1] - a[1]);

    list.replaceChildren(
      ...rows.map(([cat, s]) => {
        const pct = total ? (s / total) * 100 : 0;
        const bar = el('div');
        bar.style.width = pct + '%';
        bar.style.background = colorOf(items.find((e) => e.category === cat));
        return el('li', {}, [
          el('div', { className: 'row' }, [
            el('span', { textContent: cat }),
            el('span', { textContent: `${money(s)} · ${pct.toFixed(0)}%` }),
          ]),
          el('div', { className: 'bar' }, [bar]),
        ]);
      })
    );
    empty.hidden = rows.length > 0;
  }

  function renderList(items) {
    const type = $('filterType').value;
    const cat = $('filterCategory').value;
    const q = $('search').value.trim().toLowerCase();

    const shown = items
      .filter((e) => !type || typeOf(e) === type)
      .filter((e) => !cat || (typeOf(e) === 'in' && e.category === cat))
      .filter((e) => !q || (e.note || '').toLowerCase().includes(q) || e.category.toLowerCase().includes(q))
      .sort((a, b) => b.date.localeCompare(a.date) || b.created - a.created);

    $('expenseList').replaceChildren(
      ...shown.map((e) => {
        const dot = el('span', { className: 'dot' });
        dot.style.background = colorOf(e);
        const incoming = typeOf(e) === 'in';
        return el('li', {}, [
          dot,
          el('div', { className: 'meta' }, [
            el('div', { className: 'cat' }, [
              document.createTextNode(e.category),
              e.tracker ? el('span', { className: 'tag', textContent: 'Tracker' }) : null,
            ]),
            el('div', { className: 'sub', textContent: dateLabel(e.date) + (e.note ? ' · ' + e.note : '') }),
          ]),
          el('span', { className: `amt ${incoming ? 'money-in' : ''}`, textContent: `${incoming ? '+' : '−'}${money(e.amount)}` }),
          e.tracker
            ? el('div', { className: 'actions' }, [el('a', { href: 'tracker.html', className: 'linkish', textContent: 'Open', title: 'Change it on the Tracker' })])
            : el('div', { className: 'actions' }, [
            PayIcons.iconButton('edit', `Edit ${e.category}${e.note ? ` (${e.note})` : ''}`, () => startEdit(e.id)),
            PayIcons.iconButton('delete', `Delete ${e.category}${e.note ? ` (${e.note})` : ''}`, () => remove(e.id), 'danger'),
            ]),
        ]);
      })
    );
    $('listEmpty').hidden = shown.length > 0;
  }

  // Category choices follow the type filter (or both groups when showing all).
  function fillCategoryFilter() {
    const type = $('filterType').value;
    const current = $('filterCategory').value;
    const groups = type === 'out' ? [] : ['in'];
    $('filterCategory').replaceChildren(
      el('option', { value: '', textContent: 'All categories' }),
      ...groups.flatMap((t) => Object.keys(CATEGORIES[t]).map((c) => el('option', { value: c, textContent: c })))
    );
    $('filterCategory').value = [...$('filterCategory').options].some((o) => o.value === current) ? current : '';
  }

  // The Tracker's month dashboard, the same numbers as on the Tracker page.
  const STATUS_LABEL = { paid: 'Paid', overdue: 'Overdue', 'due-soon': 'Due this month', upcoming: 'Upcoming' };

  function renderTracker(t) {
    const now = monthKey(todayISO());
    $('trackerTitle').textContent = viewMonth === now ? 'Expenses this month' : `Expenses in ${monthLabel(viewMonth)}`;
    if (!t || !t.hasLoans) {
      for (const id of ['tDue', 'tPaid', 'tLeft', 'tOver']) $(id).textContent = money(0);
      $('trackerNote').textContent = 'Add your expenses (bills, loans and others) on the Tracker; the ones you mark paid count as money out here.';
      $('trackerList').replaceChildren();
      return;
    }
    $('tDue').textContent = money(t.due);
    $('tPaid').textContent = money(t.paid);
    $('tLeft').textContent = money(t.left);
    $('tOver').textContent = money(t.overdue);
    $('tOver').classList.toggle('danger', t.overdueCount > 0);
    $('trackerNote').textContent = !t.items.length
      ? `Nothing due in ${monthLabel(viewMonth)}.`
      : [
        `${t.paidCount} of ${t.items.length} paid`,
        t.payments.length ? `${t.payments.length} payment${t.payments.length === 1 ? '' : 's'} logged (${money(t.paid)})` : '',
        t.estimated ? 'amounts with ~ are estimates' : '',
        t.earlier.length ? `${t.earlier.reduce((n, e) => n + e.months.length, 0)} unpaid from earlier months (in Overdue)` : '',
      ].filter(Boolean).join(' · ');
    $('trackerList').replaceChildren(...t.items.map((i) =>
      el('div', { className: `bill-item compact status-${i.status}` }, [
        PayIcons.billIcon(Loans.iconKind(i.loan)),
        el('div', { className: 'bill-main' }, [
          el('div', { className: 'bill-name', textContent: i.loan.name + (i.variable ? '' : ` · term ${i.termNo} of ${i.loan.terms}`) }),
          el('div', { className: 'sub', textContent: [Loans.categoryLabel(i.loan), i.dueDay ? `Due on the ${ordinal(i.dueDay)}` : 'Due anytime in the month', i.loan.lender].filter(Boolean).join(' · ') }),
        ]),
        el('div', { className: 'bill-side' }, [
          el('div', { className: 'amt', textContent: i.amount === null ? 'Varies' : `${i.estimated ? '~' : ''}${money(i.amount)}` }),
          el('span', { className: `badge ${i.status}`, textContent: STATUS_LABEL[i.status] }),
        ]),
      ])));
  }

  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  // ---- Form -----------------------------------------------------------

  function setFormType(type) {
    const current = $('category').value;
    $('category').replaceChildren(...Object.keys(CATEGORIES[type]).map((c) => el('option', { value: c, textContent: c })));
    if (CATEGORIES[type][current]) $('category').value = current;
    $('submitBtn').textContent = $('editId').value ? 'Save' : type === 'in' ? 'Add money in' : 'Add money out';
    $('expenseForm').classList.toggle('is-in', type === 'in');
  }

  function resetForm() {
    $('expenseForm').reset();
    $('editId').value = '';
    $('date').value = todayISO();
    $('formTitle').textContent = 'Add money in';
    $('cancelEdit').hidden = true;
    setFormType(formType);
  }

  function startEdit(id) {
    const e = state.expenses.find((x) => x.id === id);
    if (!e) return;
    $('editId').value = e.id;
    setFormType(typeOf(e));
    $('amount').value = e.amount;
    $('category').value = e.category;
    $('date').value = e.date;
    $('note').value = e.note;
    $('formTitle').textContent = typeOf(e) === 'in' ? 'Edit money in' : 'Edit money out';
    $('submitBtn').textContent = 'Save';
    $('cancelEdit').hidden = false;
    $('amount').focus();
    $('expenseForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function remove(id) {
    const e = state.expenses.find((x) => x.id === id);
    if (!e) return;
    if (!confirm(`Delete ${typeOf(e) === 'in' ? '+' : '−'}${money(e.amount)} (${e.category})?`)) return;
    state.expenses = state.expenses.filter((x) => x.id !== id);
    if ($('editId').value === id) resetForm();
    save();
    render();
  }

  function onSubmit(ev) {
    ev.preventDefault();
    const amount = Math.round(parseFloat($('amount').value) * 100) / 100;
    if (!(amount > 0)) return;

    const data = {
      type: formType,
      amount,
      category: $('category').value,
      date: $('date').value,
      note: $('note').value.trim(),
    };

    const editId = $('editId').value;
    if (editId) {
      const e = state.expenses.find((x) => x.id === editId);
      if (e) Object.assign(e, data);
    } else {
      state.expenses.push({ id: uid(), created: Date.now(), ...data });
    }

    // Jump to the month of the saved entry so it's visible.
    viewMonth = monthKey(data.date);
    save();
    resetForm();
    render();
  }

  // ---- CSV ------------------------------------------------------------

  function csvCell(v) {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function exportCsv() {
    const rows = [['date', 'type', 'category', 'amount', 'note']];
    const sorted = [...state.expenses].sort((a, b) => a.date.localeCompare(b.date));
    for (const e of sorted) rows.push([e.date, typeOf(e), e.category, e.amount.toFixed(2), e.note]);
    const csv = rows.map((r) => r.map(csvCell).join(',')).join('\n');

    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = el('a', { href: url, download: `money-in-out-${todayISO()}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.some((c) => c.trim()));
  }

  function importCsv(file) {
    const reader = new FileReader();
    reader.onload = () => {
      const rows = parseCsv(String(reader.result));
      const header = (rows.shift() || []).map((h) => h.trim().toLowerCase());
      const col = (name) => header.indexOf(name);
      const [di, ti, ci, ai, ni] = ['date', 'type', 'category', 'amount', 'note'].map(col);
      if (di < 0 || ai < 0) {
        alert('CSV needs at least "date" and "amount" columns.');
        return;
      }

      let added = 0;
      let skipped = 0;
      for (const r of rows) {
        const date = (r[di] || '').trim();
        const amount = Math.round(parseFloat(r[ai]) * 100) / 100;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !(amount > 0)) { skipped++; continue; }
        const rawType = ti >= 0 ? (r[ti] || '').trim().toLowerCase() : '';
        const type = ['in', 'income', 'money in'].includes(rawType) ? 'in' : 'out';
        const rawCat = ci >= 0 ? (r[ci] || '').trim() : '';
        const category = Object.keys(CATEGORIES[type]).find((c) => c.toLowerCase() === rawCat.toLowerCase())
          || (type === 'in' ? 'Other income' : 'Other');
        state.expenses.push({
          id: uid(),
          created: Date.now() + added,
          type,
          date,
          amount,
          category,
          note: ni >= 0 ? (r[ni] || '').trim() : '',
        });
        added++;
      }
      save();
      render();
      alert(`Imported ${added} entr${added === 1 ? 'y' : 'ies'}` + (skipped ? `, skipped ${skipped} invalid row${skipped === 1 ? '' : 's'}.` : '.'));
    };
    reader.readAsText(file);
  }

  // ---- Init -----------------------------------------------------------

  function init() {
    fillCategoryFilter();
    $('budgetInput').value = state.budget ?? '';
    $('currency').value = state.currency;
    resetForm();

    $('expenseForm').addEventListener('submit', onSubmit);
    $('cancelEdit').addEventListener('click', resetForm);
    $('prevMonth').addEventListener('click', () => { viewMonth = shiftMonth(viewMonth, -1); render(); });
    $('nextMonth').addEventListener('click', () => { viewMonth = shiftMonth(viewMonth, 1); render(); });
    $('filterType').addEventListener('change', () => { fillCategoryFilter(); render(); });
    $('filterCategory').addEventListener('change', render);
    $('search').addEventListener('input', render);
    $('budgetInput').addEventListener('input', (ev) => {
      const v = parseFloat(ev.target.value);
      state.budget = v > 0 ? v : null;
      save();
      render();
    });
    $('currency').addEventListener('change', (ev) => {
      state.currency = ev.target.value;
      save();
      render();
    });
    $('exportCsv').addEventListener('click', exportCsv);
    $('importCsv').addEventListener('change', (ev) => {
      const file = ev.target.files[0];
      if (file) importCsv(file);
      ev.target.value = '';
    });

    // Another tab, or a sync, changed money in or the Tracker: show it.
    // Amounts shown or hidden (the eye button in the header).
  window.addEventListener('balance:amounts', () => render());

  window.addEventListener('storage', (ev) => {
      if (ev.key === STORAGE_KEY) Object.assign(state, load());
      if (ev.key === STORAGE_KEY || ev.key === LOANS_KEY) render();
    });

    render();
  }

  init();
})();
