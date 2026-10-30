(() => {
  'use strict';

  // Entries are kept under `expenses` for compatibility (the Bills page adds
  // to it too). Each has type 'in' (money in) or 'out' (money out); older
  // entries without a type are money out.
  const STORAGE_KEY = 'expense-tracker:v1';
  const BILLS_KEY = 'tracking-bills:v1';
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
  let formType = 'out';

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

  // ---- Bills link ---------------------------------------------------------
  //
  // Paid bills are money out. syncBills() adds any paid bill missing from
  // Expenses; deleting or editing a bill payment here updates the bill too.

  function readBills() {
    try {
      const data = JSON.parse(localStorage.getItem(BILLS_KEY) || 'null');
      return data && Array.isArray(data.bills) ? { ...data, payments: data.payments || {} } : null;
    } catch {
      return null;
    }
  }

  function writeBills(bills) {
    try {
      localStorage.setItem(BILLS_KEY, JSON.stringify(bills));
    } catch {
      // Storage unavailable: the Bills page keeps its own copy.
    }
    window.BalanceSync?.changed();
  }

  function syncBills() {
    const bills = readBills();
    if (!bills || !window.Bills) return;
    const { billsChanged, expensesChanged } = Bills.syncExpenses(bills, state);
    if (expensesChanged) save();
    if (billsChanged) writeBills(bills);
  }

  function billNameFor(e) {
    const bills = readBills();
    const billId = e.billPayment.slice(0, e.billPayment.lastIndexOf(':'));
    return bills?.bills.find((b) => b.id === billId)?.name || 'bill';
  }

  const typeOf = (e) => (e.type === 'in' ? 'in' : 'out');
  const colorOf = (e) => CATEGORIES[typeOf(e)][e.category] || '#9aa0a8';

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
    const outs = items.filter((e) => typeOf(e) === 'out');
    const ins = items.filter((e) => typeOf(e) === 'in');

    renderStats(sum(ins), sum(outs));
    renderBreakdown($('breakdown'), $('breakdownEmpty'), outs);
    renderBreakdown($('breakdownIn'), $('breakdownInEmpty'), ins);
    renderList(items);
    renderBills();
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
      .filter((e) => !cat || e.category === cat)
      .filter((e) => !q || e.note.toLowerCase().includes(q) || e.category.toLowerCase().includes(q))
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
              e.billPayment ? el('span', { className: 'tag', textContent: 'Bill' }) : null,
            ]),
            el('div', { className: 'sub', textContent: dateLabel(e.date) + (e.note ? ' · ' + e.note : '') }),
          ]),
          el('span', { className: `amt ${incoming ? 'money-in' : ''}`, textContent: `${incoming ? '+' : '−'}${money(e.amount)}` }),
          el('div', { className: 'actions' }, [
            el('button', { textContent: 'Edit', onclick: () => startEdit(e.id) }),
            el('button', { className: 'del', textContent: 'Delete', onclick: () => remove(e.id) }),
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
    const groups = type ? [type] : ['out', 'in'];
    $('filterCategory').replaceChildren(
      el('option', { value: '', textContent: 'All categories' }),
      ...groups.flatMap((t) => Object.keys(CATEGORIES[t]).map((c) => el('option', { value: c, textContent: c })))
    );
    $('filterCategory').value = [...$('filterCategory').options].some((o) => o.value === current) ? current : '';
  }

  // A summary of this month's bills from the Bills page (same device).
  function renderBills() {
    let bills = null;
    try {
      bills = JSON.parse(localStorage.getItem(BILLS_KEY) || 'null');
    } catch {
      bills = null;
    }
    const card = $('billsCard');
    if (!bills || !Array.isArray(bills.bills) || !bills.bills.length || !window.Bills) {
      card.hidden = true;
      return;
    }
    const today = todayISO();
    const items = Bills.forMonth({ bills: bills.bills, payments: bills.payments || {} }, viewMonth, today);
    const t = Bills.totals(items);
    card.hidden = false;
    $('billsSummary').textContent = items.length
      ? `${money(t.due)} due · ${money(t.paid)} paid · ${money(t.left)} left` +
        (t.overdue > 0 ? ` · ${money(t.overdue)} overdue` : '') +
        ` (fixed ${money(t.fixed)}, variable ~${money(t.variable)})`
      : `No bills due in ${monthLabel(viewMonth)}.`;
    const unpaid = items.filter((i) => !i.payment);
    $('billsList').replaceChildren(
      ...unpaid.map((i) =>
        el('div', { className: `bill-item compact status-${i.status}` }, [
          PayIcons.billIcon(i.bill.kind),
          el('div', { className: 'bill-main' }, [
            el('div', { className: 'bill-name', textContent: i.bill.name }),
            el('div', { className: 'sub', textContent: (i.anytime ? `Anytime by ${dateLabel(i.dueDate)}` : `Due ${dateLabel(i.dueDate)}`) + ` · ${i.type === 'variable' ? 'Variable' : 'Fixed'}` }),
          ]),
          el('div', { className: 'bill-side' }, [
            el('div', { className: 'amt', textContent: i.amount > 0 ? `${i.type === 'variable' ? '~' : ''}${money(i.amount)}` : 'Varies' }),
            el('span', { className: `badge ${i.status}`, textContent: { overdue: 'Overdue', 'due-soon': 'Due soon', upcoming: 'Upcoming' }[i.status] }),
          ]),
        ]))
    );
    if (items.length && !unpaid.length) $('billsList').replaceChildren(el('p', { className: 'ok', textContent: 'All bills paid for this month.' }));
  }

  // ---- Form -----------------------------------------------------------

  function setFormType(type) {
    formType = type;
    for (const btn of $('typeToggle').children) {
      btn.classList.toggle('active', btn.dataset.type === type);
      btn.setAttribute('aria-pressed', btn.dataset.type === type);
    }
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
    $('formTitle').textContent = 'Add money in or out';
    $('cancelEdit').hidden = true;
    $('typeToggle').classList.remove('locked');
    setFormType(formType);
  }

  function startEdit(id) {
    const e = state.expenses.find((x) => x.id === id);
    if (!e) return;
    $('editId').value = e.id;
    setFormType(typeOf(e));
    $('typeToggle').classList.toggle('locked', Boolean(e.billPayment));
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
    const question = e.billPayment
      ? `This is your ${billNameFor(e)} bill payment (${money(e.amount)}). Deleting it also marks the bill as not paid. Continue?`
      : `Delete ${typeOf(e) === 'in' ? '+' : '−'}${money(e.amount)} (${e.category})?`;
    if (!confirm(question)) return;
    if (e.billPayment) {
      const bills = readBills();
      if (bills && bills.payments[e.billPayment]) {
        delete bills.payments[e.billPayment];
        writeBills(bills);
      }
    }
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
      if (e?.billPayment) {
        // A bill payment stays money out; keep the bill's record in step.
        data.type = 'out';
        const bills = readBills();
        const payment = bills?.payments[e.billPayment];
        if (payment) {
          Object.assign(payment, { amount: data.amount, paidOn: data.date });
          writeBills(bills);
        }
      }
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
    syncBills();
    fillCategoryFilter();
    $('budgetInput').value = state.budget ?? '';
    $('currency').value = state.currency;
    resetForm();

    $('typeToggle').addEventListener('click', (ev) => {
      const type = ev.target.closest('[data-type]')?.dataset.type;
      if (type && !$('typeToggle').classList.contains('locked')) setFormType(type);
    });
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

    // The Bills page can add expenses from another tab: show them.
    window.addEventListener('storage', (ev) => {
      if (ev.key === STORAGE_KEY) Object.assign(state, load());
      if (ev.key === BILLS_KEY) syncBills();
      if (ev.key === STORAGE_KEY || ev.key === BILLS_KEY) render();
    });

    render();
  }

  init();
})();
