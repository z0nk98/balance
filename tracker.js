(() => {
  'use strict';

  // Loans you took and are paying off, term by term. Stored on this device
  // (lib/sync.js copies them to your other devices, like Bills and Expenses).
  const LOANS_KEY = 'personal-loans:v1';
  const EXPENSES_KEY = 'expense-tracker:v1';
  // Above this many terms the term-by-term boxes are left out.
  const MAX_BOXES = 60;
  const STATUS = {
    behind: 'overdue',
    'on-track': 'upcoming',
    ahead: 'paid',
    done: 'paid',
  };

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

  let state = readJson(LOANS_KEY, Loans.emptyState());

  function save() {
    try {
      localStorage.setItem(LOANS_KEY, JSON.stringify(state));
      window.BalanceSync?.changed();
    } catch {
      alert('Couldn’t save on this device (storage is full or blocked).');
    }
  }

  // ---- Helpers ----------------------------------------------------------

  const pad = (n) => String(n).padStart(2, '0');
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  function thisMonth() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  }

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    for (const c of children) if (c) node.append(c);
    return node;
  }

  function money(n) {
    const currency = readJson(EXPENSES_KEY, { currency: 'PHP' }).currency || 'PHP';
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(n);
    } catch {
      return n.toFixed(2);
    }
  }

  function monthLabel(key, short = false) {
    const [y, m] = key.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: short ? 'short' : 'long', year: 'numeric' });
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  function iconButton(kind, label, onclick, extra = '') {
    const btn = el('button', { type: 'button', className: `icon-btn ${extra}`.trim(), title: label, onclick });
    btn.setAttribute('aria-label', label);
    btn.append(PayIcons.actionIcon(kind));
    return btn;
  }

  function field(label, input) {
    return el('label', {}, [document.createTextNode(label), input]);
  }

  // ---- Rendering --------------------------------------------------------

  const openPay = new Set(); // loan ids with the payment form open
  const openHistory = new Set(); // loan ids with the history shown
  let editingId = null;

  function statusText(s) {
    if (s.status === 'done') return 'Paid off';
    if (s.status === 'behind') return `Behind ${plural(s.behind, 'term')}`;
    if (s.status === 'ahead') return `Ahead ${plural(s.ahead, 'term')}`;
    return 'On track';
  }

  function termBoxes(loan, s) {
    if (loan.terms > MAX_BOXES) return '';
    const dueByNow = s.termsPaid + s.behind;
    const boxes = [];
    for (let t = 1; t <= loan.terms; t++) {
      let cls = 'term';
      if (t <= s.termsPaid) cls += ' is-paid';
      else if (t <= dueByNow) cls += ' is-late';
      else if (t === s.nextTerm) cls += ' is-next';
      const box = el('span', { className: cls, textContent: t, title: `Term ${t} · ${monthLabel(Loans.addMonths(loan.firstMonth, t - 1))}` });
      boxes.push(box);
    }
    const wrap = el('div', { className: 'term-boxes' }, boxes);
    wrap.setAttribute('aria-hidden', 'true');
    return wrap;
  }

  function paymentForm(loan, s) {
    const month = el('input', { type: 'month', value: thisMonth(), required: true });
    const terms = el('input', { type: 'number', min: '0', max: String(s.termsLeft), step: '1', value: String(Math.min(Math.max(1, s.behind), s.termsLeft)), required: true, inputMode: 'numeric' });
    const amount = el('input', { type: 'number', min: '0.01', step: '0.01', inputMode: 'decimal' });
    const note = el('input', { maxLength: 120, placeholder: 'Optional', className: 'grow' });
    const hint = el('p', { className: 'hint' });
    let amountEdited = false;
    const update = () => {
      const n = Number(terms.value) || 0;
      if (!amountEdited) amount.value = n ? (Math.round(n * loan.termAmount * 100) / 100).toFixed(2) : '';
      const from = s.termsPaid + 1;
      hint.textContent = n > 0 ? `Covers term${n === 1 ? '' : 's'} ${from}${n > 1 ? `–${Math.min(from + n - 1, loan.terms)}` : ''} of ${loan.terms}.` : 'Enter 0 terms for a partial payment that doesn’t complete a term.';
    };
    terms.addEventListener('input', update);
    amount.addEventListener('input', () => { amountEdited = amount.value !== ''; });
    update();
    const form = el('form', { className: 'inline-form pay-terms-form', autocomplete: 'off' }, [
      field('Month paid', month),
      field('Terms paid', terms),
      field('Amount', amount),
      field('Note', note),
      el('button', { type: 'submit', className: 'primary', textContent: 'Save payment' }),
      el('button', { type: 'button', textContent: 'Cancel', onclick: () => { openPay.delete(loan.id); render(); } }),
      hint,
    ]);
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      try {
        const p = Loans.cleanPayment({ month: month.value, terms: terms.value, amount: amount.value, note: note.value }, loan);
        state.payments.push({ id: newId(), loanId: loan.id, ...p, created: Date.now() });
      } catch (err) {
        alert(err.message);
        return;
      }
      openPay.delete(loan.id);
      save();
      render();
    });
    return form;
  }

  function historyList(loan, s) {
    if (!s.history.length) return el('p', { className: 'hint', textContent: 'No payments recorded yet.' });
    const rows = [...s.history].reverse().map((p) =>
      el('li', {}, [
        el('div', {}, [
          el('div', { className: 'pay-month', textContent: monthLabel(p.month) }),
          el('div', {
            className: 'sub',
            textContent: (p.terms
              ? `${p.terms === 1 ? `Term ${p.fromTerm}` : `Terms ${p.fromTerm}–${p.toTerm}`} (${plural(p.terms, 'term')})`
              : 'Partial payment') + (p.note ? ` · ${p.note}` : ''),
          }),
        ]),
        el('div', { className: 'amt', textContent: money(p.amount) }),
        iconButton('delete', `Delete the ${monthLabel(p.month)} payment`, () => {
          if (!confirm(`Delete the ${money(p.amount)} payment from ${monthLabel(p.month)}?`)) return;
          state.payments = state.payments.filter((x) => x.id !== p.id);
          save();
          render();
        }, 'danger'),
      ]));
    // Months with more than one payment get a total.
    const byMonth = new Map();
    for (const p of s.history) byMonth.set(p.month, (byMonth.get(p.month) || 0) + p.terms);
    const multi = [...byMonth].filter(([, t]) => t > 1);
    const note = multi.length
      ? el('p', { className: 'hint', textContent: `Several terms in one month: ${multi.map(([m, t]) => `${monthLabel(m, true)} (${t})`).join(', ')}.` })
      : '';
    return el('div', {}, [el('ul', { className: 'tracker-history' }, rows), note]);
  }

  function loanCard(loan, s) {
    const meta = [
      `${money(loan.termAmount)} × ${loan.terms} terms = ${money(s.total)}`,
      `${monthLabel(loan.firstMonth, true)} – ${monthLabel(s.lastMonth, true)}`,
      loan.dueDay ? `due on the ${ordinal(loan.dueDay)}` : '',
    ].filter(Boolean).join(' · ');
    const extra = [
      s.interest !== null ? `Borrowed ${money(loan.borrowed)} · interest ${money(s.interest)}` : '',
      loan.note,
    ].filter(Boolean).join(' · ');
    const next = s.nextTerm
      ? `Next: term ${s.nextTerm} · ${monthLabel(s.nextMonth)}${s.behind > 0 ? ` · ${money(s.behind * loan.termAmount)} overdue` : ''}`
      : `Paid off · last payment ${s.history.length ? monthLabel(s.history[s.history.length - 1].month) : ''}`;
    const bar = el('div', { className: 'progress' }, [el('div', { className: 'progress-fill' })]);
    bar.querySelector('.progress-fill').style.width = `${Math.round((s.termsPaid / loan.terms) * 100)}%`;
    bar.setAttribute('aria-hidden', 'true');
    const history = el('details', { className: 'tracker-history-wrap', open: openHistory.has(loan.id) }, [
      el('summary', { textContent: `Payment history (${s.history.length})` }),
      historyList(loan, s),
    ]);
    history.addEventListener('toggle', () => {
      if (history.open) openHistory.add(loan.id);
      else openHistory.delete(loan.id);
    });
    return el('article', { className: `tracker-loan${editingId === loan.id ? ' editing' : ''}` }, [
      el('div', { className: 'tracker-head' }, [
        el('div', {}, [
          el('h3', { textContent: loan.name }),
          loan.lender ? el('div', { className: 'sub', textContent: loan.lender }) : '',
        ]),
        el('span', { className: `badge ${STATUS[s.status]}`, textContent: statusText(s) }),
        el('span', { className: 'loan-actions' }, [
          iconButton('edit', `Edit ${loan.name}`, () => startEdit(loan)),
          iconButton('delete', `Delete ${loan.name}`, () => removeLoan(loan, s), 'danger'),
        ]),
      ]),
      el('div', { className: 'sub', textContent: meta }),
      extra ? el('div', { className: 'sub', textContent: extra }) : '',
      bar,
      el('div', { className: 'tracker-numbers' }, [
        el('strong', { textContent: `${s.termsPaid} of ${loan.terms} terms paid` }),
        el('span', { textContent: `${money(s.paid)} paid · ${money(s.remaining)} left` }),
      ]),
      termBoxes(loan, s),
      el('div', { className: `tracker-next${s.behind ? ' late' : ''}`, textContent: next }),
      s.nextTerm
        ? (openPay.has(loan.id)
          ? paymentForm(loan, s)
          : el('button', { type: 'button', className: 'primary', textContent: 'Record payment', onclick: () => { openPay.add(loan.id); render(); } }))
        : '',
      history,
    ]);
  }

  // ---- Bills that vary each month ------------------------------------------

  function moneyShort(n) {
    const currency = readJson(EXPENSES_KEY, { currency: 'PHP' }).currency || 'PHP';
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);
    } catch {
      return String(Math.round(n));
    }
  }

  function shortMonth(key) {
    const [y, m] = key.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short' });
  }

  const monthList = (months) => months.map((m) => monthLabel(m, true)).join(', ');

  function variableStatus(s, month) {
    if (s.status === 'done') return { text: 'Paid off', cls: 'paid' };
    if (!s.behind) return { text: 'Up to date', cls: 'paid' };
    if (s.behind === 1 && s.unpaid[0] === month) return { text: 'Due this month', cls: 'upcoming' };
    return { text: `${plural(s.behind, 'month')} unpaid`, cls: 'overdue' };
  }

  // One chip per month: green with the amount when paid, red when unpaid.
  function monthChips(bill, s, month) {
    let from;
    let to;
    if (s.lastMonth && bill.months <= MAX_BOXES) {
      from = bill.firstMonth;
      to = s.lastMonth;
    } else {
      const lastPaid = s.history.length ? s.history[s.history.length - 1].month : month;
      to = [month, lastPaid, s.nextMonth || month].sort().pop();
      if (s.lastMonth && to > s.lastMonth) to = s.lastMonth;
      from = Loans.addMonths(to, -11);
      if (from < bill.firstMonth) from = bill.firstMonth;
    }
    const chips = [];
    for (let m = from; m <= to; m = Loans.addMonths(m, 1)) {
      const amount = s.byMonth.get(m);
      let cls = 'term month-chip';
      if (amount !== undefined) cls += ' is-paid';
      else if (m <= month) cls += ' is-late';
      else if (m === s.nextMonth) cls += ' is-next';
      const chip = el('span', { className: cls, title: `${monthLabel(m)}${amount !== undefined ? ` · paid ${money(amount)}` : ''}` }, [
        el('span', { textContent: shortMonth(m) }),
        amount !== undefined ? el('span', { className: 'chip-amt', textContent: moneyShort(amount) }) : '',
      ]);
      chips.push(chip);
    }
    if (!chips.length) return '';
    const wrap = el('div', { className: 'term-boxes' }, chips);
    wrap.setAttribute('aria-hidden', 'true');
    return wrap;
  }

  function variablePaymentForm(bill, s) {
    const month = el('input', { type: 'month', value: s.nextMonth || thisMonth(), min: bill.firstMonth, required: true });
    if (s.lastMonth) month.max = s.lastMonth;
    const amount = el('input', { type: 'number', min: '0.01', step: '0.01', inputMode: 'decimal', required: true, placeholder: s.guess !== null ? `about ${s.guess}` : 'e.g. 2350' });
    const note = el('input', { maxLength: 120, placeholder: 'Optional', className: 'grow' });
    const form = el('form', { className: 'inline-form pay-terms-form', autocomplete: 'off' }, [
      field('Bill month', month),
      field('Amount paid', amount),
      field('Note', note),
      el('button', { type: 'submit', className: 'primary', textContent: 'Save payment' }),
      el('button', { type: 'button', textContent: 'Cancel', onclick: () => { openPay.delete(bill.id); render(); } }),
      el('p', { className: 'hint', textContent: 'Enter the actual amount on this month’s bill.' }),
    ]);
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      let p;
      try {
        p = Loans.cleanVariablePayment({ month: month.value, amount: amount.value, note: note.value }, bill);
      } catch (err) {
        alert(err.message);
        return;
      }
      const already = s.byMonth.get(p.month);
      if (already !== undefined && !confirm(`${monthLabel(p.month)} already has ${money(already)} paid. Add ${money(p.amount)} more?`)) return;
      state.payments.push({ id: newId(), loanId: bill.id, ...p, created: Date.now() });
      openPay.delete(bill.id);
      save();
      render();
    });
    return form;
  }

  function variableHistory(bill, s) {
    if (!s.history.length) return el('p', { className: 'hint', textContent: 'No payments recorded yet.' });
    const rows = [...s.history].reverse().map((p) =>
      el('li', {}, [
        el('div', {}, [
          el('div', { className: 'pay-month', textContent: monthLabel(p.month) }),
          p.note ? el('div', { className: 'sub', textContent: p.note }) : '',
        ]),
        el('div', { className: 'amt', textContent: money(p.amount) }),
        iconButton('delete', `Delete the ${monthLabel(p.month)} payment`, () => {
          if (!confirm(`Delete the ${money(p.amount)} payment for ${monthLabel(p.month)}?`)) return;
          state.payments = state.payments.filter((x) => x.id !== p.id);
          save();
          render();
        }, 'danger'),
      ]));
    return el('ul', { className: 'tracker-history' }, rows);
  }

  function variableCard(bill, s) {
    const month = thisMonth();
    const meta = [
      'Varies each month',
      s.lastMonth
        ? `${monthLabel(bill.firstMonth, true)} – ${monthLabel(s.lastMonth, true)} (${plural(bill.months, 'month')})`
        : `since ${monthLabel(bill.firstMonth, true)}, no end`,
      bill.dueDay ? `due on the ${ordinal(bill.dueDay)}` : '',
    ].join(' · ').replace(/ · $/, '');
    const extra = [
      bill.estimate !== null && bill.estimate !== undefined ? `Usually ${money(bill.estimate)}` : '',
      s.average !== null ? `average ${money(s.average)}` : '',
      s.lastAmount !== null ? `last ${money(s.lastAmount)}` : '',
      bill.note,
    ].filter(Boolean).join(' · ');
    const about = (n) => (n === null ? '' : ` · about ${money(n)}`);
    let next;
    if (s.behind && !(s.behind === 1 && s.unpaid[0] === month)) next = `Not paid: ${monthList(s.unpaid)}${about(s.overdueEstimate)}`;
    else if (s.nextMonth) next = `Next: ${monthLabel(s.nextMonth)}${about(s.guess)}`;
    else next = 'Paid off';
    const st = variableStatus(s, month);
    let bar = '';
    if (s.lastMonth) {
      bar = el('div', { className: 'progress' }, [el('div', { className: 'progress-fill' })]);
      bar.querySelector('.progress-fill').style.width = `${Math.round((s.monthsPaid / bill.months) * 100)}%`;
      bar.setAttribute('aria-hidden', 'true');
    }
    const history = el('details', { className: 'tracker-history-wrap', open: openHistory.has(bill.id) }, [
      el('summary', { textContent: `Payment history (${s.history.length})` }),
      variableHistory(bill, s),
    ]);
    history.addEventListener('toggle', () => {
      if (history.open) openHistory.add(bill.id);
      else openHistory.delete(bill.id);
    });
    return el('article', { className: `tracker-loan${editingId === bill.id ? ' editing' : ''}` }, [
      el('div', { className: 'tracker-head' }, [
        el('div', {}, [
          el('h3', { textContent: bill.name }),
          bill.lender ? el('div', { className: 'sub', textContent: bill.lender }) : '',
        ]),
        el('span', { className: `badge ${st.cls}`, textContent: st.text }),
        el('span', { className: 'loan-actions' }, [
          iconButton('edit', `Edit ${bill.name}`, () => startEdit(bill)),
          iconButton('delete', `Delete ${bill.name}`, () => removeLoan(bill, s), 'danger'),
        ]),
      ]),
      el('div', { className: 'sub', textContent: meta }),
      extra ? el('div', { className: 'sub', textContent: extra }) : '',
      bar,
      el('div', { className: 'tracker-numbers' }, [
        el('strong', { textContent: s.lastMonth ? `${s.monthsPaid} of ${plural(bill.months, 'month')} paid` : `${plural(s.monthsPaid, 'month')} paid` }),
        el('span', { textContent: `${money(s.paid)} paid${s.remainingEstimate !== null ? ` · about ${money(s.remainingEstimate)} left` : ''}` }),
      ]),
      monthChips(bill, s, month),
      el('div', { className: `tracker-next${st.cls === 'overdue' ? ' late' : ''}`, textContent: next }),
      s.nextMonth || s.behind
        ? (openPay.has(bill.id)
          ? variablePaymentForm(bill, s)
          : el('button', { type: 'button', className: 'primary', textContent: 'Record payment', onclick: () => { openPay.add(bill.id); render(); } }))
        : '',
      history,
    ]);
  }

  const card = (r) => (Loans.isVariable(r.loan) ? variableCard(r.loan, r.s) : loanCard(r.loan, r.s));

  function render() {
    const month = thisMonth();
    const rows = state.loans.map((loan) => ({
      loan,
      s: Loans.isVariable(loan) ? Loans.variableSummary(loan, state.payments, month) : Loans.summary(loan, state.payments, month),
    }));
    const active = rows.filter((r) => r.s.status !== 'done');
    const fixed = active.filter((r) => !Loans.isVariable(r.loan));
    const variable = active.filter((r) => Loans.isVariable(r.loan));

    const left = rows.filter((r) => !Loans.isVariable(r.loan)).reduce((t, r) => t + r.s.remaining, 0) +
      variable.reduce((t, r) => t + (r.s.remainingEstimate || 0), 0);
    const leftEstimated = variable.some((r) => r.s.remainingEstimate);
    const due = fixed.reduce((t, r) => t + r.s.behind * r.loan.termAmount, 0) +
      variable.reduce((t, r) => t + (r.s.overdueEstimate || 0), 0);
    const dueEstimated = variable.some((r) => r.s.behind);
    const dueMonths = active.reduce((t, r) => t + r.s.behind, 0);
    const termsToGo = fixed.reduce((t, r) => t + r.s.termsLeft, 0);
    const paid = Loans.paidInMonth(state, month);
    $('sumLeft').textContent = money(left);
    $('sumLeftSub').textContent = [termsToGo ? `${plural(termsToGo, 'term')} to go` : '', leftEstimated ? 'includes estimates' : ''].filter(Boolean).join(' · ');
    $('sumDue').textContent = money(due);
    $('sumDue').classList.toggle('danger', due > 0 || dueMonths > 0);
    $('sumDueSub').textContent = dueMonths ? `${plural(dueMonths, 'payment')} not made yet${dueEstimated ? ' · estimated' : ''}` : 'All caught up';
    $('paidLabel').textContent = `Paid in ${monthLabel(month).split(' ')[0]}`;
    $('sumPaid').textContent = money(paid.amount);
    $('sumPaidSub').textContent = paid.count ? plural(paid.count, 'payment') : '';
    $('sumLoans').textContent = String(active.length);
    $('sumLoansSub').textContent = `active${rows.length > active.length ? ` · ${rows.length - active.length} paid off` : ''}`;

    const shown = active
      // Behind first, then by the next term's month.
      .sort((a, b) => (b.s.behind > 0) - (a.s.behind > 0) || String(a.s.nextMonth || '9999').localeCompare(String(b.s.nextMonth || '9999')) || a.loan.name.localeCompare(b.loan.name));
    $('loanList').replaceChildren(...shown.map(card));
    // Paid-off loans are kept in a collapsed archive, most recent first.
    const lastPaid = (r) => (r.s.history.length ? r.s.history[r.s.history.length - 1].month : '');
    const done = rows.filter((r) => r.s.status === 'done').sort((a, b) => lastPaid(b).localeCompare(lastPaid(a)));
    $('doneList').replaceChildren(...done.map(card));
    $('doneWrap').hidden = done.length === 0;
    $('doneTitle').textContent = `Paid off (${done.length})`;
    $('loanEmpty').hidden = shown.length > 0;
    $('loanEmpty').textContent = rows.length
      ? 'Everything here is paid off.'
      : 'Nothing here yet. Add a bill or loan below: a fixed amount paid over a set number of months, or a bill that varies each month.';
    if (!rows.length) $('loanFormWrap').open = true;
  }

  // ---- Adding / editing bills and loans -------------------------------------

  const form = $('loanForm');
  const inputs = {
    name: $('loanName'),
    lender: $('loanLender'),
    termAmount: $('loanTermAmount'),
    terms: $('loanTerms'),
    estimate: $('billEstimate'),
    months: $('billMonths'),
    firstMonth: $('loanFirstMonth'),
    dueDay: $('loanDueDay'),
    borrowed: $('loanBorrowed'),
    note: $('loanNote'),
  };
  let formKind = 'fixed';

  function setKind(kind) {
    formKind = kind;
    const variable = kind === 'variable';
    for (const b of document.querySelectorAll('#kindToggle button')) b.classList.toggle('active', b.dataset.kind === kind);
    for (const lab of form.querySelectorAll('label[data-kind]')) lab.hidden = lab.dataset.kind !== kind;
    inputs.termAmount.required = !variable;
    inputs.terms.required = !variable;
    $('lenderLabel').textContent = variable ? 'Provider (optional)' : 'Lender (optional)';
    inputs.lender.placeholder = variable ? 'e.g. Meralco, Maynilad, PLDT' : 'e.g. Home Credit, BPI, SSS';
    inputs.name.placeholder = variable ? 'e.g. Electricity' : 'e.g. Phone (Home Credit)';
    updatePreview();
  }

  for (const b of document.querySelectorAll('#kindToggle button')) {
    b.addEventListener('click', () => { if (!b.disabled) setKind(b.dataset.kind); });
  }

  function values() {
    return Object.fromEntries(Object.entries(inputs).map(([k, input]) => [k, input.value]));
  }

  function updatePreview() {
    const v = values();
    if (formKind === 'variable') {
      if (!v.firstMonth) { $('loanPreview').textContent = ''; return; }
      const n = Number(v.months);
      const est = v.estimate === '' ? null : Number(v.estimate);
      const span = v.months !== '' && Number.isInteger(n) && n >= 1
        ? `${n} month${n === 1 ? '' : 's'}, from ${monthLabel(v.firstMonth)} to ${monthLabel(Loans.addMonths(v.firstMonth, n - 1))}`
        : `Every month from ${monthLabel(v.firstMonth)}, no end`;
      const total = est !== null && est >= 0 && v.months !== '' && n >= 1 ? `, about ${money(est * n)} in total` : '';
      $('loanPreview').textContent = `${span}.${est !== null && est >= 0 ? ` About ${money(est)} a month${total}.` : ''} You enter the actual amount each month.`;
      return;
    }
    const per = Number(v.termAmount);
    const n = Number(v.terms);
    if (!(per > 0) || !Number.isInteger(n) || n < 1 || !v.firstMonth) {
      $('loanPreview').textContent = '';
      return;
    }
    const total = Math.round(per * n * 100) / 100;
    const borrowed = Number(v.borrowed);
    $('loanPreview').textContent = `${n} months of ${money(per)} = ${money(total)}, from ${monthLabel(v.firstMonth)} to ${monthLabel(Loans.addMonths(v.firstMonth, n - 1))}.` +
      (v.borrowed !== '' && borrowed >= 0 ? ` Interest: ${money(total - borrowed)}.` : '');
  }
  form.addEventListener('input', updatePreview);

  function lockKind(locked) {
    for (const b of document.querySelectorAll('#kindToggle button')) {
      b.disabled = locked && b.dataset.kind !== formKind;
      b.title = b.disabled ? 'Can’t change the type once payments are recorded' : '';
    }
  }

  function resetForm() {
    form.reset();
    editingId = null;
    inputs.firstMonth.value = thisMonth();
    $('formTitle').textContent = 'Add a bill or loan';
    $('loanSubmit').textContent = 'Add';
    $('loanCancel').hidden = true;
    lockKind(false);
    setKind(formKind);
  }

  function startEdit(loan) {
    editingId = loan.id;
    for (const [k, input] of Object.entries(inputs)) input.value = loan[k] ?? '';
    setKind(Loans.isVariable(loan) ? 'variable' : 'fixed');
    lockKind(state.payments.some((p) => p.loanId === loan.id));
    $('formTitle').textContent = `Edit ${loan.name}`;
    $('loanSubmit').textContent = 'Save changes';
    $('loanCancel').hidden = false;
    $('loanFormWrap').open = true;
    render();
    $('loanFormWrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
    inputs.name.focus({ preventScroll: true });
  }

  function removeLoan(loan, s) {
    const paidNote = s.history.length ? ` Its ${plural(s.history.length, 'recorded payment')} will be deleted too.` : '';
    if (!confirm(`Delete ${loan.name}?${paidNote}`)) return;
    state.loans = state.loans.filter((l) => l.id !== loan.id);
    state.payments = state.payments.filter((p) => p.loanId !== loan.id);
    if (editingId === loan.id) resetForm();
    save();
    render();
  }

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    let loan;
    try {
      loan = formKind === 'variable' ? Loans.cleanVariable(values()) : Loans.cleanLoan(values());
    } catch (err) {
      alert(err.message);
      return;
    }
    if (editingId) {
      const i = state.loans.findIndex((l) => l.id === editingId);
      if (i >= 0) {
        const merged = { ...state.loans[i], ...loan };
        if (formKind === 'fixed') delete merged.kind;
        state.loans[i] = merged;
      }
    } else {
      state.loans.push({ id: newId(), ...loan, created: Date.now() });
    }
    resetForm();
    $('loanFormWrap').open = false;
    save();
    render();
  });

  $('loanCancel').addEventListener('click', () => {
    resetForm();
    render();
  });

  // Another tab, or a sync from another device, changed the data.
  window.addEventListener('storage', (ev) => {
    if (ev.key === LOANS_KEY) state = readJson(LOANS_KEY, Loans.emptyState());
    if (ev.key === LOANS_KEY || ev.key === EXPENSES_KEY) render();
  });

  resetForm();
  render();
})();
