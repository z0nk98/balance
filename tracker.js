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

  let show = 'active';
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

  function render() {
    const month = thisMonth();
    const rows = state.loans.map((loan) => ({ loan, s: Loans.summary(loan, state.payments, month) }));
    const active = rows.filter((r) => r.s.status !== 'done');

    const left = rows.reduce((t, r) => t + r.s.remaining, 0);
    const due = active.reduce((t, r) => t + r.s.behind * r.loan.termAmount, 0);
    const dueTerms = active.reduce((t, r) => t + r.s.behind, 0);
    const paid = Loans.paidInMonth(state, month);
    $('sumLeft').textContent = money(left);
    $('sumLeftSub').textContent = active.length ? plural(active.reduce((t, r) => t + r.s.termsLeft, 0), 'term') + ' to go' : '';
    $('sumDue').textContent = money(due);
    $('sumDue').classList.toggle('danger', due > 0);
    $('sumDueSub').textContent = dueTerms ? `${plural(dueTerms, 'term')} not paid yet` : 'All caught up';
    $('paidLabel').textContent = `Paid in ${monthLabel(month).split(' ')[0]}`;
    $('sumPaid').textContent = money(paid.amount);
    $('sumPaidSub').textContent = paid.count ? plural(paid.terms, 'term') : '';
    $('sumLoans').textContent = String(active.length);
    $('sumLoansSub').textContent = `active${rows.length > active.length ? ` · ${rows.length - active.length} paid off` : ''}`;

    for (const chip of $('loanFilter').children) chip.classList.toggle('active', chip.dataset.show === show);
    const shown = rows
      .filter((r) => show === 'all' || (show === 'done' ? r.s.status === 'done' : r.s.status !== 'done'))
      // Behind first, then by the next term's month.
      .sort((a, b) => (b.s.behind > 0) - (a.s.behind > 0) || String(a.s.nextMonth || '9999').localeCompare(String(b.s.nextMonth || '9999')) || a.loan.name.localeCompare(b.loan.name));
    $('loanList').replaceChildren(...shown.map((r) => loanCard(r.loan, r.s)));
    $('loanEmpty').hidden = shown.length > 0;
    $('loanEmpty').textContent = rows.length
      ? (show === 'done' ? 'No loans paid off yet.' : 'Nothing here.')
      : 'No loans yet. Add one below: the amount per term, how many terms, and when the first one is due.';
    if (!rows.length) $('loanFormWrap').open = true;
  }

  // ---- Adding / editing loans ---------------------------------------------

  const form = $('loanForm');
  const inputs = {
    name: $('loanName'),
    lender: $('loanLender'),
    termAmount: $('loanTermAmount'),
    terms: $('loanTerms'),
    firstMonth: $('loanFirstMonth'),
    dueDay: $('loanDueDay'),
    borrowed: $('loanBorrowed'),
    note: $('loanNote'),
  };

  function values() {
    return Object.fromEntries(Object.entries(inputs).map(([k, input]) => [k, input.value]));
  }

  function updatePreview() {
    const v = values();
    const per = Number(v.termAmount);
    const n = Number(v.terms);
    if (!(per > 0) || !Number.isInteger(n) || n < 1 || !v.firstMonth) {
      $('loanPreview').textContent = '';
      return;
    }
    const total = Math.round(per * n * 100) / 100;
    const borrowed = Number(v.borrowed);
    $('loanPreview').textContent = `${n} terms of ${money(per)} = ${money(total)}, from ${monthLabel(v.firstMonth)} to ${monthLabel(Loans.addMonths(v.firstMonth, n - 1))}.` +
      (v.borrowed !== '' && borrowed >= 0 ? ` Interest: ${money(total - borrowed)}.` : '');
  }
  form.addEventListener('input', updatePreview);

  function resetForm() {
    form.reset();
    editingId = null;
    inputs.firstMonth.value = thisMonth();
    $('formTitle').textContent = 'Add a loan';
    $('loanSubmit').textContent = 'Add loan';
    $('loanCancel').hidden = true;
    updatePreview();
  }

  function startEdit(loan) {
    editingId = loan.id;
    for (const [k, input] of Object.entries(inputs)) input.value = loan[k] ?? '';
    $('formTitle').textContent = `Edit ${loan.name}`;
    $('loanSubmit').textContent = 'Save changes';
    $('loanCancel').hidden = false;
    $('loanFormWrap').open = true;
    updatePreview();
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
      loan = Loans.cleanLoan(values());
    } catch (err) {
      alert(err.message);
      return;
    }
    if (editingId) {
      const i = state.loans.findIndex((l) => l.id === editingId);
      if (i >= 0) state.loans[i] = { ...state.loans[i], ...loan };
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

  $('loanFilter').addEventListener('click', (ev) => {
    const value = ev.target.closest('[data-show]')?.dataset.show;
    if (!value) return;
    show = value;
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
