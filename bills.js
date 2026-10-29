(() => {
  'use strict';

  // Bills are stored on this device, like expenses. Paying a bill can add
  // it to the expense tracker, which uses EXPENSES_KEY (see app.js).
  const BILLS_KEY = 'tracking-bills:v1';
  const EXPENSES_KEY = 'expense-tracker:v1';
  const SOON_DAYS = 5;
  const STATUS_LABEL = { paid: 'Paid', overdue: 'Overdue', 'due-soon': 'Due soon', upcoming: 'Upcoming' };

  const $ = (id) => document.getElementById(id);

  // ---- Storage ----------------------------------------------------------

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
    } catch {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      alert('Couldn’t save on this device (storage is full or blocked).');
      return false;
    }
  }

  let state = readJson(BILLS_KEY, { ...Bills.emptyState(), addToExpenses: true });
  const save = () => writeJson(BILLS_KEY, state);
  const expenses = () => readJson(EXPENSES_KEY, { expenses: [], budget: null, currency: 'USD' });

  // ---- Helpers ----------------------------------------------------------

  const pad = (n) => String(n).padStart(2, '0');

  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  const thisMonth = () => todayISO().slice(0, 7);
  let viewMonth = thisMonth();
  let statusFilter = 'all';
  let editingId = null;

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    for (const c of children) if (c) node.append(c);
    return node;
  }

  function money(n) {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: expenses().currency }).format(n);
    } catch {
      return n.toFixed(2);
    }
  }

  function monthLabel(key) {
    const [y, m] = key.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }

  function dateLabel(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function dueText(item) {
    if (item.payment) return `Paid ${dateLabel(item.payment.paidOn)}`;
    const d = item.daysUntilDue;
    if (item.anytime) {
      if (d < 0) return `Not paid in ${monthLabel(item.key)} · ${-d} day${d === -1 ? '' : 's'} overdue`;
      return `Pay anytime in ${monthLabel(item.key).split(' ')[0]} · by ${dateLabel(item.dueDate)}`;
    }
    if (d === 0) return 'Due today';
    if (d > 0) return `Due ${dateLabel(item.dueDate)} · in ${d} day${d === 1 ? '' : 's'}`;
    return `Was due ${dateLabel(item.dueDate)} · ${-d} day${d === -1 ? '' : 's'} overdue`;
  }

  // ---- Paying -----------------------------------------------------------

  function markPaid(item) {
    const b = item.bill;
    const suggested = item.amount > 0 ? item.amount : '';
    const ask = item.type === 'variable'
      ? `How much was ${b.name} this time (${monthLabel(item.key)})?${item.amount > 0 ? ` Estimate: ${money(item.amount)}` : ''}`
      : `Amount paid for ${b.name} (${monthLabel(item.key)})`;
    const input = prompt(ask, suggested);
    if (input === null) return;
    const amount = Math.round(parseFloat(input) * 100) / 100;
    if (!(amount > 0)) return alert('Enter the amount you paid.');

    const payment = { amount, paidOn: todayISO() };
    if (state.addToExpenses) {
      const ex = expenses();
      const id = `bill-${b.id}-${item.key}-${Date.now().toString(36)}`;
      ex.expenses.push({
        id,
        created: Date.now(),
        amount,
        category: Bills.KINDS[b.kind].expense,
        date: payment.paidOn,
        note: `Bill: ${b.name} (${monthLabel(item.key)})`,
      });
      if (writeJson(EXPENSES_KEY, ex)) payment.expenseId = id;
    }
    state.payments[`${b.id}:${item.key}`] = payment;
    save();
    render();
  }

  function undoPaid(item) {
    if (!confirm(`Mark ${item.bill.name} for ${monthLabel(item.key)} as not paid?`)) return;
    const id = item.payment.expenseId;
    if (id) {
      const ex = expenses();
      ex.expenses = ex.expenses.filter((e) => e.id !== id);
      writeJson(EXPENSES_KEY, ex);
    }
    delete state.payments[`${item.bill.id}:${item.key}`];
    save();
    render();
  }

  // ---- Rendering --------------------------------------------------------

  function typeLabel(type) {
    return type === 'variable' ? 'Variable' : 'Fixed';
  }

  // Variable bills show their estimate with "~" until paid.
  function amountText(amount, type, paid) {
    if (!(amount > 0)) return 'Varies';
    return type === 'variable' && !paid ? `~${money(amount)}` : money(amount);
  }

  function billRow(item, { showMonth = false } = {}) {
    const b = item.bill;
    const sub = [typeLabel(item.type), b.account && `Acct ${b.account}`, b.autopay && 'Auto-debit', b.note].filter(Boolean).join(' · ');
    return el('div', { className: `bill-item status-${item.status}` }, [
      PayIcons.billIcon(b.kind),
      el('div', { className: 'bill-main' }, [
        el('div', { className: 'bill-name', textContent: b.name + (showMonth ? ` · ${monthLabel(item.key)}` : '') }),
        el('div', { className: 'sub', textContent: dueText(item) }),
        sub ? el('div', { className: 'sub', textContent: sub }) : null,
      ]),
      el('div', { className: 'bill-side' }, [
        el('div', { className: 'amt', textContent: amountText(item.amount, item.type, Boolean(item.payment)) }),
        el('span', { className: `badge ${item.status}`, textContent: STATUS_LABEL[item.status] }),
        item.payment
          ? el('button', { type: 'button', textContent: 'Undo', onclick: () => undoPaid(item) })
          : el('button', { type: 'button', className: 'primary', textContent: 'Mark paid', onclick: () => markPaid(item) }),
      ]),
    ]);
  }

  function renderAlerts(today) {
    const current = Bills.forMonth(state, thisMonth(), today, SOON_DAYS);
    const next = Bills.forMonth(state, Bills.shiftMonth(thisMonth(), 1), today, SOON_DAYS);
    const soon = [...current, ...next].filter((i) => i.status === 'due-soon');
    const late = [...Bills.overdueBefore(state, thisMonth(), today), ...current.filter((i) => i.status === 'overdue')];
    const boxes = [];
    if (late.length) {
      boxes.push(el('section', { className: 'card alert-card overdue' }, [
        el('h2', { textContent: `Overdue (${late.length})` }),
        el('div', { className: 'bill-list' }, late.map((i) => billRow(i, { showMonth: true }))),
      ]));
    }
    if (soon.length) {
      boxes.push(el('section', { className: 'card alert-card soon' }, [
        el('h2', { textContent: `Due in the next ${SOON_DAYS} days (${soon.length}) · ${money(Bills.totals(soon).left)}` }),
        el('div', { className: 'bill-list' }, soon.map((i) => billRow(i, { showMonth: i.key !== thisMonth() }))),
      ]));
    }
    $('alerts').replaceChildren(...boxes);
  }

  function render() {
    const today = todayISO();
    $('monthLabel').textContent = monthLabel(viewMonth);
    $('monthTitle').textContent = viewMonth === thisMonth() ? 'This month' : monthLabel(viewMonth);
    $('todayBtn').hidden = viewMonth === thisMonth();

    const items = Bills.forMonth(state, viewMonth, today, SOON_DAYS);
    const t = Bills.totals(items);
    $('sumDue').textContent = money(t.due);
    $('sumCount').textContent = `${t.count} bill${t.count === 1 ? '' : 's'}${t.unpaid ? ` · ${t.unpaid} unpaid` : ''}`;
    $('sumSplit').textContent = t.count ? `Fixed ${money(t.fixed)} · Variable ~${money(t.variable)}` : '';
    $('sumPaid').textContent = money(t.paid);
    $('sumLeft').textContent = money(t.left);
    $('sumOverdue').textContent = money(t.overdue);
    $('sumOverdue').classList.toggle('danger', t.overdue > 0);

    for (const chip of $('statusFilter').children) {
      chip.classList.toggle('active', chip.dataset.status === statusFilter);
      chip.setAttribute('aria-pressed', chip.dataset.status === statusFilter);
    }
    const shown = items.filter((i) => statusFilter === 'all' || (statusFilter === 'unpaid' ? !i.payment : i.status === statusFilter));
    $('monthList').replaceChildren(...shown.map((i) => billRow(i)));
    $('monthEmpty').hidden = shown.length > 0;
    $('monthEmpty').textContent = state.bills.length
      ? (items.length ? 'No bills match this filter.' : `No bills due in ${monthLabel(viewMonth)}.`)
      : 'Add your bills below to see what’s due each month.';

    renderAlerts(today);
    renderAllBills();
    $('addToExpenses').checked = state.addToExpenses !== false;
    $('currencyHint').textContent = `Currency: ${expenses().currency} (change it on the Expenses page).`;
  }

  function repeatText(b) {
    const base = Bills.REPEATS[b.every];
    const day = !Bills.hasDueDate(b)
      ? 'no set due date'
      : b.every === 0 ? `due ${b.startMonth}-${pad(b.dueDay)}` : `on day ${b.dueDay}`;
    return `${base} ${day}` + (b.endMonth ? ` until ${monthLabel(b.endMonth)}` : '');
  }

  function allBillRow(b) {
    return el('div', { className: `bill-item${b.paused ? ' paused' : ''}` }, [
      PayIcons.billIcon(b.kind),
      el('div', { className: 'bill-main' }, [
        el('div', { className: 'bill-name', textContent: b.name + (b.paused ? ' (paused)' : '') }),
        el('div', { className: 'sub', textContent: `${Bills.KINDS[b.kind].label} · ${repeatText(b)}` }),
      ]),
      el('div', { className: 'bill-side' }, [
        el('div', { className: 'amt', textContent: amountText(b.amount, Bills.amountType(b), false) }),
        el('div', { className: 'btn-row' }, [
          el('button', { type: 'button', textContent: 'Edit', onclick: () => startEdit(b) }),
          el('button', { type: 'button', textContent: b.paused ? 'Resume' : 'Pause', onclick: () => { b.paused = !b.paused; save(); render(); } }),
          el('button', { type: 'button', className: 'danger', textContent: 'Delete', onclick: () => removeBill(b) }),
        ]),
      ]),
    ]);
  }

  // All bills in two groups, Fixed and Variable, ordered by due day
  // (bills without a set due date last).
  function renderAllBills() {
    const order = (b) => (Bills.hasDueDate(b) ? b.dueDay : 99);
    const list = [...state.bills].sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
    for (const type of ['fixed', 'variable']) {
      const group = list.filter((b) => Bills.amountType(b) === type);
      $(`${type}Bills`).replaceChildren(...group.map(allBillRow));
      $(`${type}Empty`).hidden = group.length > 0;
      const monthly = group.filter((b) => !b.paused && b.every === 1).reduce((s, b) => s + b.amount, 0);
      $(`${type}Total`).textContent = group.length
        ? `· ${group.length} bill${group.length === 1 ? '' : 's'}${monthly ? ` · ${type === 'variable' ? '~' : ''}${money(monthly)}/month` : ''}`
        : '';
    }
  }

  // ---- Bill form --------------------------------------------------------

  function resetForm() {
    editingId = null;
    $('billForm').reset();
    $('billKind').value = 'electricity';
    setAmountType('variable');
    $('billNoDueDate').checked = false;
    syncDueDay();
    $('billEvery').value = '1';
    $('billStart').value = viewMonth;
    $('formTitle').textContent = 'Add a bill';
    $('billSubmit').textContent = 'Add bill';
    $('billCancel').hidden = true;
  }

  function startEdit(b) {
    editingId = b.id;
    $('billKind').value = b.kind;
    $('billName').value = b.name;
    setAmountType(Bills.amountType(b));
    $('billAmount').value = b.amount || '';
    $('billNoDueDate').checked = !Bills.hasDueDate(b);
    $('billDueDay').value = Bills.hasDueDate(b) ? b.dueDay : '';
    syncDueDay();
    $('billEvery').value = String(b.every);
    $('billStart').value = b.startMonth;
    $('billEnd').value = b.endMonth;
    $('billAccount').value = b.account;
    $('billNote').value = b.note;
    $('billAutopay').checked = b.autopay;
    $('formTitle').textContent = `Edit ${b.name}`;
    $('billSubmit').textContent = 'Save';
    $('billCancel').hidden = false;
    $('billForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('billName').focus();
  }

  let amountType = 'fixed';

  function setAmountType(type) {
    amountType = type;
    for (const btn of $('amountTypeToggle').children) {
      btn.classList.toggle('active', btn.dataset.type === type);
      btn.setAttribute('aria-pressed', btn.dataset.type === type);
    }
    $('billAmountLabel').textContent = type === 'variable' ? 'Estimated amount (optional)' : 'Amount';
    $('billAmount').placeholder = type === 'variable' ? 'e.g. 2500' : 'e.g. 1699';
  }

  function syncDueDay() {
    const none = $('billNoDueDate').checked;
    $('billDueDay').disabled = none;
    if (none) $('billDueDay').value = '';
  }

  $('amountTypeToggle').addEventListener('click', (ev) => {
    const type = ev.target.closest('[data-type]')?.dataset.type;
    if (type) setAmountType(type);
  });
  $('billNoDueDate').addEventListener('change', syncDueDay);

  function removeBill(b) {
    const paid = Object.keys(state.payments).filter((k) => k.startsWith(`${b.id}:`)).length;
    const extra = paid ? ` Its ${paid} payment record${paid === 1 ? '' : 's'} will be removed (expenses already added stay).` : '';
    if (!confirm(`Delete ${b.name}?${extra}`)) return;
    state.bills = state.bills.filter((x) => x.id !== b.id);
    for (const k of Object.keys(state.payments)) if (k.startsWith(`${b.id}:`)) delete state.payments[k];
    if (editingId === b.id) resetForm();
    save();
    render();
  }

  $('billForm').addEventListener('submit', (ev) => {
    ev.preventDefault();
    let bill;
    try {
      bill = Bills.cleanBill({
        kind: $('billKind').value,
        name: $('billName').value,
        amount: $('billAmount').value,
        amountType,
        hasDueDate: !$('billNoDueDate').checked,
        dueDay: $('billDueDay').value,
        every: $('billEvery').value,
        startMonth: $('billStart').value,
        endMonth: $('billEnd').value,
        account: $('billAccount').value,
        note: $('billNote').value,
        autopay: $('billAutopay').checked,
      });
      if (bill.endMonth && bill.endMonth < bill.startMonth) throw new Error('The last month can’t be before the first month');
    } catch (err) {
      alert(err.message);
      return;
    }
    const existing = editingId && state.bills.find((b) => b.id === editingId);
    if (existing) Object.assign(existing, bill);
    else state.bills.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), ...bill });
    save();
    resetForm();
    render();
  });

  // Suggest a name from the type while the name is still empty or a default.
  $('billKind').addEventListener('change', () => {
    // Usage-based bills usually change month to month.
    if (!editingId) setAmountType(['electricity', 'water'].includes($('billKind').value) ? 'variable' : 'fixed');
    const labels = Object.values(Bills.KINDS).map((k) => k.label);
    if (!$('billName').value || labels.includes($('billName').value)) $('billName').value = Bills.KINDS[$('billKind').value].label;
  });

  // ---- Wiring -----------------------------------------------------------

  for (const [value, k] of Object.entries(Bills.KINDS)) $('billKind').append(el('option', { value, textContent: k.label }));
  for (const every of [1, 2, 3, 6, 12, 0]) $('billEvery').append(el('option', { value: String(every), textContent: Bills.REPEATS[every] }));

  $('statusFilter').addEventListener('click', (ev) => {
    const s = ev.target.closest('[data-status]')?.dataset.status;
    if (s) { statusFilter = s; render(); }
  });
  $('prevMonth').addEventListener('click', () => { viewMonth = Bills.shiftMonth(viewMonth, -1); render(); });
  $('nextMonth').addEventListener('click', () => { viewMonth = Bills.shiftMonth(viewMonth, 1); render(); });
  $('todayBtn').addEventListener('click', () => { viewMonth = thisMonth(); render(); });
  $('billCancel').addEventListener('click', resetForm);
  $('addToExpenses').addEventListener('change', (ev) => { state.addToExpenses = ev.target.checked; save(); });

  $('backupBtn').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }));
    const a = el('a', { href: url, download: `bills-backup-${todayISO()}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  $('restoreFile').addEventListener('change', (ev) => {
    const file = ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));
        if (!Array.isArray(data.bills) || typeof data.payments !== 'object') throw new Error('not a bills backup');
        const bills = data.bills.map((b) => ({ id: String(b.id), paused: Boolean(b.paused), ...Bills.cleanBill(b) }));
        if (!confirm(`Replace your ${state.bills.length} bill(s) with the ${bills.length} in this backup?`)) return;
        state = { ...Bills.emptyState(), addToExpenses: data.addToExpenses !== false, bills, payments: data.payments };
        save();
        render();
      } catch (err) {
        alert(`That file couldn’t be restored: ${err.message}`);
      }
    };
    reader.readAsText(file);
  });

  // Another tab (bills or expenses) changed the data: show the latest.
  window.addEventListener('storage', (ev) => {
    if (ev.key === BILLS_KEY) state = readJson(BILLS_KEY, { ...Bills.emptyState(), addToExpenses: true });
    if (ev.key === BILLS_KEY || ev.key === EXPENSES_KEY) render();
  });

  resetForm();
  render();
})();
