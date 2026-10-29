(() => {
  'use strict';

  const STORAGE_KEY = 'expense-tracker:v1';
  const CATEGORIES = {
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
  };

  const $ = (id) => document.getElementById(id);

  // ---- State ----------------------------------------------------------

  const state = load();
  let viewMonth = monthKey(todayISO());

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
    for (const c of children) node.append(c);
    return node;
  }

  function monthExpenses() {
    return state.expenses.filter((e) => monthKey(e.date) === viewMonth);
  }

  // ---- Rendering ------------------------------------------------------

  function render() {
    $('monthLabel').textContent = monthLabel(viewMonth);
    const items = monthExpenses();
    const total = items.reduce((s, e) => s + e.amount, 0);

    renderStats(total);
    renderBreakdown(items, total);
    renderList(items);
  }

  function renderStats(total) {
    $('totalSpent').textContent = money(total);

    const fill = $('budgetFill');
    const remaining = $('remaining');
    fill.className = '';
    remaining.classList.remove('over');

    if (state.budget > 0) {
      const left = state.budget - total;
      const pct = (total / state.budget) * 100;
      remaining.textContent = money(left);
      remaining.classList.toggle('over', left < 0);
      fill.style.width = Math.min(pct, 100) + '%';
      if (pct >= 100) fill.classList.add('over');
      else if (pct >= 80) fill.classList.add('warn');
    } else {
      remaining.textContent = '–';
      fill.style.width = '0';
    }
  }

  function renderBreakdown(items, total) {
    const sums = {};
    for (const e of items) sums[e.category] = (sums[e.category] || 0) + e.amount;
    const rows = Object.entries(sums).sort((a, b) => b[1] - a[1]);

    const list = $('breakdown');
    list.replaceChildren(
      ...rows.map(([cat, sum]) => {
        const pct = total ? (sum / total) * 100 : 0;
        const bar = el('div');
        bar.style.width = pct + '%';
        bar.style.background = CATEGORIES[cat] || CATEGORIES.Other;
        return el('li', {}, [
          el('div', { className: 'row' }, [
            el('span', { textContent: cat }),
            el('span', { textContent: `${money(sum)} · ${pct.toFixed(0)}%` }),
          ]),
          el('div', { className: 'bar' }, [bar]),
        ]);
      })
    );
    $('breakdownEmpty').hidden = rows.length > 0;
  }

  function renderList(items) {
    const cat = $('filterCategory').value;
    const q = $('search').value.trim().toLowerCase();

    const shown = items
      .filter((e) => !cat || e.category === cat)
      .filter((e) => !q || e.note.toLowerCase().includes(q) || e.category.toLowerCase().includes(q))
      .sort((a, b) => b.date.localeCompare(a.date) || b.created - a.created);

    $('expenseList').replaceChildren(
      ...shown.map((e) => {
        const dot = el('span', { className: 'dot' });
        dot.style.background = CATEGORIES[e.category] || CATEGORIES.Other;
        return el('li', {}, [
          dot,
          el('div', { className: 'meta' }, [
            el('div', { className: 'cat', textContent: e.category }),
            el('div', { className: 'sub', textContent: dateLabel(e.date) + (e.note ? ' · ' + e.note : '') }),
          ]),
          el('span', { className: 'amt', textContent: money(e.amount) }),
          el('div', { className: 'actions' }, [
            el('button', { textContent: 'Edit', onclick: () => startEdit(e.id) }),
            el('button', { className: 'del', textContent: 'Delete', onclick: () => remove(e.id) }),
          ]),
        ]);
      })
    );
    $('listEmpty').hidden = shown.length > 0;
  }

  // ---- Actions --------------------------------------------------------

  function resetForm() {
    $('expenseForm').reset();
    $('editId').value = '';
    $('date').value = todayISO();
    $('formTitle').textContent = 'Add expense';
    $('submitBtn').textContent = 'Add';
    $('cancelEdit').hidden = true;
  }

  function startEdit(id) {
    const e = state.expenses.find((x) => x.id === id);
    if (!e) return;
    $('editId').value = e.id;
    $('amount').value = e.amount;
    $('category').value = e.category;
    $('date').value = e.date;
    $('note').value = e.note;
    $('formTitle').textContent = 'Edit expense';
    $('submitBtn').textContent = 'Save';
    $('cancelEdit').hidden = false;
    $('amount').focus();
    $('expenseForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function remove(id) {
    const e = state.expenses.find((x) => x.id === id);
    if (!e || !confirm(`Delete ${money(e.amount)} (${e.category})?`)) return;
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

    // Jump to the month of the saved expense so it's visible.
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
    const rows = [['date', 'category', 'amount', 'note']];
    const sorted = [...state.expenses].sort((a, b) => a.date.localeCompare(b.date));
    for (const e of sorted) rows.push([e.date, e.category, e.amount.toFixed(2), e.note]);
    const csv = rows.map((r) => r.map(csvCell).join(',')).join('\n');

    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = el('a', { href: url, download: `expenses-${todayISO()}.csv` });
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
      const [di, ci, ai, ni] = ['date', 'category', 'amount', 'note'].map(col);
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
        const rawCat = ci >= 0 ? (r[ci] || '').trim() : '';
        const category = Object.keys(CATEGORIES).find((c) => c.toLowerCase() === rawCat.toLowerCase()) || 'Other';
        state.expenses.push({
          id: uid(),
          created: Date.now() + added,
          date,
          amount,
          category,
          note: ni >= 0 ? (r[ni] || '').trim() : '',
        });
        added++;
      }
      save();
      render();
      alert(`Imported ${added} expense${added === 1 ? '' : 's'}` + (skipped ? `, skipped ${skipped} invalid row${skipped === 1 ? '' : 's'}.` : '.'));
    };
    reader.readAsText(file);
  }

  // ---- Init -----------------------------------------------------------

  function init() {
    for (const cat of Object.keys(CATEGORIES)) {
      $('category').append(el('option', { value: cat, textContent: cat }));
      $('filterCategory').append(el('option', { value: cat, textContent: cat }));
    }

    $('budgetInput').value = state.budget ?? '';
    $('currency').value = state.currency;
    resetForm();

    $('expenseForm').addEventListener('submit', onSubmit);
    $('cancelEdit').addEventListener('click', resetForm);
    $('prevMonth').addEventListener('click', () => { viewMonth = shiftMonth(viewMonth, -1); render(); });
    $('nextMonth').addEventListener('click', () => { viewMonth = shiftMonth(viewMonth, 1); render(); });
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

    render();
  }

  init();
})();
