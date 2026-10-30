(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const STATUS_LABEL = { paid: 'Paid', overdue: 'Overdue', 'due-soon': 'Due soon', upcoming: 'Upcoming' };
  // "Due today" reads better than "Due soon" for a payment due today.
  const statusLabel = (i) => (i.status === 'due-soon' && i.daysUntilDue === 0 ? 'Due today' : STATUS_LABEL[i.status]);
  const SESSION_KEY = 'balance:code';
  let me = null;

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    for (const c of children) node.append(c);
    return node;
  }

  function money(n) {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: me.currency }).format(n);
    } catch {
      return n.toFixed(2);
    }
  }

  function dateLabel(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }

  function monthLabel(key) {
    const [y, m] = key.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }

  function dueText(i) {
    if (i.status === 'paid') return 'Paid';
    const d = i.daysUntilDue;
    if (d === 0) return 'Due today';
    if (d > 0) return `Due in ${d} day${d === 1 ? '' : 's'}`;
    return `${-d} day${d === -1 ? '' : 's'} overdue`;
  }

  // The code is kept for this tab only, or on this device if the borrower
  // ticks "Remember my code". Signing out forgets it either way.
  function session(action, value) {
    try {
      if (action === 'get') return localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY);
      if (action === 'clear') {
        localStorage.removeItem(SESSION_KEY);
        sessionStorage.removeItem(SESSION_KEY);
      }
      if (action === 'set') {
        const remember = $('rememberCode').checked;
        (remember ? localStorage : sessionStorage).setItem(SESSION_KEY, value);
        (remember ? sessionStorage : localStorage).removeItem(SESSION_KEY);
      }
    } catch {
      // Storage unavailable: the borrower just re-enters the code.
    }
    return null;
  }

  function showLogin() {
    $('loginView').hidden = false;
    $('mainView').hidden = true;
    $('logout').hidden = true;
    $('code').focus();
  }

  async function fetchJson(url) {
    // The query string sidesteps GitHub Pages' CDN cache after updates.
    const res = await fetch(`${url}?v=${Date.now()}`, { cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('Could not load your balance. Please try again.');
    return res.json();
  }

  // Codes may be exact (case and symbols count) or loose (older and
  // generated codes: case, spaces and dashes ignored). Try exact first.
  async function open(code) {
    const tries = [];
    if (Core.isExactCodeShape(code)) tries.push(true);
    if (Core.isWellFormedCode(code)) tries.push(false);
    if (!tries.length) throw new Error('That code is not valid');
    const config = await fetchJson('config.json');
    if (!config) throw new Error('This site is not set up yet.');
    for (const exact of tries) {
      const { key, fileId } = await Core.deriveBorrower(code, config.siteSalt, exact);
      const file = await fetchJson(`data/b/${fileId}.json`);
      if (file) return Core.decryptJson(key, file);
    }
    throw new Error('That code is not valid. Check capitals, small letters and symbols.');
  }

  async function signIn(code) {
    const data = await open(code);
    const today = Core.todayISO();
    const items = data.installments
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
      .map((i) => Core.withStatus(i, data.reminderDays, today));
    me = { ...data, items, totals: Core.totals(items) };
    filters.status = defaultStatus();
    session('set', code.trim());
    fillFilterOptions();
    $('loginView').hidden = true;
    $('mainView').hidden = false;
    $('logout').hidden = false;
    render();
  }

  // ---- Filters --------------------------------------------------------

  const filters = { status: 'unpaid', loan: '', month: '', text: '' };

  // Open on "Due soon"; if nothing is due soon, show everything unpaid instead.
  function defaultStatus() {
    return me && me.items.some((i) => i.status === 'due-soon') ? 'due-soon' : 'unpaid';
  }

  function loanName(i) {
    return Core.loanName(i.note);
  }

  function fillFilterOptions() {
    const loans = [...new Set(me.items.map(loanName))].sort();
    $('loanFilter').replaceChildren(
      el('option', { value: '', textContent: 'All loans' }),
      ...loans.map((l) => el('option', { value: l, textContent: l }))
    );
    $('loanFilterWrap').hidden = loans.length < 2;

    const months = [...new Set(me.items.map((i) => i.dueDate.slice(0, 7)))];
    $('monthFilter').replaceChildren(
      el('option', { value: '', textContent: 'All months' }),
      ...months.map((m) => el('option', { value: m, textContent: monthLabel(m) }))
    );

    // Keep choices that still exist after a reload.
    if (!loans.includes(filters.loan)) filters.loan = '';
    if (!months.includes(filters.month)) filters.month = '';
    $('loanFilter').value = filters.loan;
    $('monthFilter').value = filters.month;
  }

  // ---- Sorting ----------------------------------------------------------

  const SORT_KEY = 'balance:sort';
  let sortBy = 'date';
  try {
    sortBy = localStorage.getItem(SORT_KEY) || 'date';
  } catch {
    // Keep the default.
  }
  const byText = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

  // Groups of payments to show: by month (due date order), or by loan/note
  // (A–Z or Z–A), with each loan's payments in due-date order.
  function groupPayments(items) {
    const groups = new Map();
    const byNote = sortBy !== 'date';
    for (const i of items) {
      const key = byNote ? loanName(i) : i.dueDate.slice(0, 7);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(i);
    }
    let keys = [...groups.keys()];
    if (byNote) {
      keys.sort(byText.compare);
      if (sortBy === 'note-desc') keys.reverse();
    }
    return keys.map((key) => {
      const list = groups.get(key).sort((a, b) => a.dueDate.localeCompare(b.dueDate) || byText.compare(a.note, b.note));
      return { title: byNote ? key : monthLabel(key), items: list, ...Core.totals(list) };
    });
  }

  function matches(i) {
    return Core.matchesFilter(i, filters);
  }

  async function copy(text, button) {
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = 'Copied!';
      setTimeout(() => { button.textContent = 'Copy'; }, 1500);
    } catch {
      prompt('Copy this:', text);
    }
  }

  const qrUrls = new Map(); // QR file id -> object URL

  async function qrUrl(fileId) {
    if (!qrUrls.has(fileId)) {
      qrUrls.set(fileId, (async () => {
        const file = await fetchJson(`data/pay/${fileId}.json`);
        if (!file || !me.paymentsKey) return null;
        const { type, data } = await Core.decryptJson(await Core.importSharedKey(me.paymentsKey), file);
        return URL.createObjectURL(new Blob([Core.fromB64(data)], { type }));
      })());
    }
    return qrUrls.get(fileId);
  }

  function qrBlock(m) {
    const img = el('img', { className: 'qr-img', alt: `${m.label} QR code` });
    const save = el('a', { className: 'qr-save', textContent: 'Save QR', download: `${m.label.replace(/[^\w-]+/g, '-')}-QR.png` });
    const wrap = el('div', { className: 'qr-wrap' }, [
      el('button', { type: 'button', className: 'qr-open', title: 'Tap to enlarge' }, [img]),
      el('div', { className: 'hint', textContent: 'Tap to enlarge' }),
      save,
    ]);
    save.hidden = true;
    wrap.querySelector('.qr-open').addEventListener('click', () => { if (img.src) openQr(img.src, m.label); });
    qrUrl(m.qrFile)
      .then((url) => {
        if (!url) throw new Error('missing');
        img.src = url;
        save.href = url;
        save.hidden = false;
      })
      .catch(() => { wrap.replaceChildren(el('div', { className: 'hint', textContent: 'QR code couldn’t load. Please refresh.' })); });
    return wrap;
  }

  function openQr(src, label) {
    const overlay = el('div', { className: 'qr-overlay', role: 'dialog', ariaLabel: `${label} QR code` }, [
      el('div', { className: 'qr-overlay-title', textContent: label }),
      el('img', { src, alt: `${label} QR code` }),
      el('button', { type: 'button', className: 'primary', textContent: 'Close' }),
    ]);
    const close = () => overlay.remove();
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay || ev.target.tagName === 'BUTTON') close(); });
    document.addEventListener('keydown', function onKey(ev) {
      if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
    });
    document.body.append(overlay);
  }

  function renderPayMethods() {
    const methods = me.paymentMethods || [];
    $('paySection').hidden = methods.length === 0;
    $('payMethods').replaceChildren(
      ...methods.map((m) => {
        const lines = [el('div', { className: 'pay-label', textContent: m.label })];
        if (m.accountName) lines.push(el('div', { className: 'sub', textContent: m.accountName }));
        if (m.accountNumber) {
          const btn = el('button', { type: 'button', className: 'copy-btn', textContent: 'Copy' });
          btn.addEventListener('click', () => copy(m.accountNumber, btn));
          lines.push(el('div', { className: 'pay-number' }, [el('span', { textContent: m.accountNumber }), btn]));
        }
        if (m.details) lines.push(el('div', { className: 'sub', textContent: m.details }));
        if (m.qrFile) lines.push(qrBlock(m));
        return el('div', { className: 'pay-item' }, [PayIcons.paymentIcon(m.kind), el('div', { className: 'pay-body' }, lines)]);
      })
    );
  }

  // ---- Hide / show the totals (eye button) ----------------------------

  const HIDE_KEY = 'balance:borrower-hide-amounts';
  let amountsHidden = false;
  try { amountsHidden = localStorage.getItem(HIDE_KEY) === '1'; } catch { /* storage blocked */ }

  function maskedMoney(n) {
    return amountsHidden ? '•••••' : money(n);
  }

  function renderAmountsToggle() {
    const btn = $('toggleAmounts');
    const label = amountsHidden ? 'Show amounts' : 'Hide amounts';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-pressed', String(amountsHidden));
    btn.replaceChildren(PayIcons.actionIcon(amountsHidden ? 'eyeOff' : 'eye'));
  }

  $('toggleAmounts').addEventListener('click', () => {
    amountsHidden = !amountsHidden;
    try { localStorage.setItem(HIDE_KEY, amountsHidden ? '1' : '0'); } catch { /* storage blocked */ }
    render();
  });

  // One line per loan: what was lent, the interest, and what each payment is.
  function renderLoans() {
    const loans = new Map();
    for (const i of me.items) {
      const name = Core.loanName(i.note);
      if (!loans.has(name)) loans.set(name, []);
      loans.get(name).push(i);
    }
    $('loanList').replaceChildren(...[...loans].map(([name, items]) => {
      const b = Core.loanBreakdown(items);
      const left = items.reduce((s, i) => s + i.remaining, 0);
      const amounts = new Set(items.map((i) => i.amount));
      const per = amounts.size === 1 ? `${maskedMoney(items[0].amount)} × ${items.length}` : `${items.length} payments`;
      const perInterest = b.interest > 0 && items.length > 1 ? ` (${maskedMoney(b.interest / items.length)} interest each)` : '';
      return el('div', { className: 'loan-summary' }, [
        el('div', { className: 'loan-summary-name', textContent: name }),
        el('dl', {}, [
          ['Initial amount', maskedMoney(b.principal)],
          ['Interest', b.interest > 0 ? maskedMoney(b.interest) : 'None'],
          ['Total to pay', maskedMoney(b.total)],
          ['Payments', per + perInterest],
          ['Left to pay', left > 0 ? maskedMoney(left) : 'Paid in full'],
        ].map(([k, v]) => el('div', {}, [el('dt', { textContent: k }), el('dd', { textContent: v })]))),
      ]);
    }));
    $('loansSection').hidden = loans.size === 0;
  }

  function render() {
    renderPayMethods();
    const t = me.totals;
    $('greeting').textContent = `Hi ${me.name}! Here's your payment summary` + (me.ownerName ? ` with ${me.ownerName}.` : '.');
    $('remaining').textContent = maskedMoney(t.remaining);
    $('overdue').textContent = maskedMoney(t.overdue);
    $('overdue').classList.toggle('danger', !amountsHidden && t.overdue > 0);
    $('dueSoon').textContent = maskedMoney(t.dueSoon);
    $('dueSoon').classList.toggle('warn', !amountsHidden && t.dueSoon > 0);
    $('dueSoonLabel').textContent = Core.dueSoonLabel(me.items, me.reminderDays);
    $('nextDue').textContent = t.nextDue ? maskedMoney(t.nextDue.remaining) : '—';
    renderAmountsToggle();
    $('nextDueDate').textContent = t.nextDue ? `due ${dateLabel(t.nextDue.dueDate)}` : 'All paid up';

    for (const chip of $('statusFilter').children) {
      chip.classList.toggle('active', chip.dataset.status === filters.status);
      chip.setAttribute('aria-pressed', chip.dataset.status === filters.status);
    }
    $('clearFilters').hidden = filters.status === defaultStatus() && !filters.loan && !filters.month && !filters.text.trim();

    const shown = me.items.filter(matches);
    const st = Core.totals(shown);
    $('filterSummary').textContent = shown.length
      ? `${shown.length} payment${shown.length === 1 ? '' : 's'} · ${maskedMoney(st.owed)} total · ${maskedMoney(st.paid)} paid · ${maskedMoney(st.remaining)} left`
      : '';

    renderLoans();

    const months = groupPayments(shown);
    $('months').replaceChildren(
      ...months.map((m) =>
        el('div', { className: 'month-card' }, [
          el('h3', {}, [
            document.createTextNode(m.title),
            el('span', { textContent: m.remaining > 0 ? `${money(m.remaining)} left` : 'Paid' }),
          ]),
          ...m.items.map((i) =>
            el('div', { className: 'item' }, [
              el('div', {}, [
                el('div', { textContent: dateLabel(i.dueDate) + (i.note ? ` · ${i.note}` : '') }),
                el('div', { className: 'sub', textContent: dueText(i) + (i.paid > 0 && i.remaining > 0 ? ` · ${money(i.paid)} paid so far` : '') }),
                i.interest > 0 ? el('div', { className: 'sub', textContent: `${money(i.amount)} = ${money(i.amount - i.interest)} + ${money(i.interest)} interest` }) : '',
              ]),
              el('div', { className: 'amt' }, [
                el('div', { className: 'amt', textContent: money(i.remaining > 0 ? i.remaining : i.amount) }),
                el('span', { className: `badge ${i.status}`, textContent: statusLabel(i) }),
              ]),
            ])
          ),
        ])
      )
    );
    $('monthsEmpty').hidden = months.length > 0;

    const who = me.ownerName || 'your lender';
    const canSend = Boolean(me.inbox && me.id);
    $('reminderStatus').textContent = me.reminders.length
      ? `Reminders are on: ${me.reminders.join(' and ')}.`
      : canSend
        ? 'Reminders are off. Add your email or mobile number below to get them.'
        : `Reminders are off. To get them, send your email address or phone number to ${who}.`;
    $('reminderHint').textContent =
      `Reminders go out ${me.reminderDays} day${me.reminderDays === 1 ? '' : 's'} before a payment is due, ` +
      `on the due date, and the day after if it's still unpaid.` +
      (canSend ? ` Your details are sent privately to ${who}, who turns the reminders on.` : ` To change where they go, contact ${who}.`);
    $('contactForm').hidden = !canSend;
    $('contactOwner').textContent = me.ownerName || 'lender';
  }

  // ---- Sending contact details ------------------------------------------

  async function sendContact() {
    const contact = Core.cleanContactUpdate({
      email: $('contactEmail').value,
      phone: $('contactPhone').value,
      notifyEmail: $('wantEmail').checked,
      notifySms: $('wantSms').checked,
    });
    const text = await Core.sealForOwner(me.inbox.publicKey, {
      type: 'contact',
      borrowerId: me.id,
      name: me.name,
      ...contact,
      at: new Date().toISOString(),
    });
    // Plain-text body with query options keeps this a "simple" request (no preflight).
    const url = `${Core.NTFY}/${encodeURIComponent(me.inbox.topic)}?title=${encodeURIComponent('New contact details from a borrower')}&tags=bell`;
    const res = await fetch(url, { method: 'POST', body: text, headers: { 'Content-Type': 'text/plain' } });
    if (!res.ok) throw new Error('Couldn’t send right now. Please try again in a minute.');
    return contact;
  }

  $('contactForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const msg = $('contactMsg');
    $('contactSend').disabled = true;
    try {
      const c = await sendContact();
      msg.className = 'ok';
      msg.textContent = `Sent! ${me.ownerName || 'Your lender'} will turn on reminders${c.notifyEmail || c.notifySms ? '' : ' if you ask'} — you’ll see it here once they do.`;
      $('contactForm').reset();
    } catch (err) {
      msg.className = 'error';
      msg.textContent = err.message === 'Failed to fetch' ? 'Couldn’t send. Check your internet connection and try again.' : err.message;
    } finally {
      $('contactSend').disabled = false;
    }
    msg.hidden = false;
  });

  $('loginForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    $('loginError').hidden = true;
    $('loginBtn').disabled = true;
    $('loginBtn').textContent = 'Checking…';
    try {
      await signIn($('code').value);
      $('code').value = '';
    } catch (err) {
      // A decryption failure means the file didn't match this code.
      $('loginError').textContent = err.name === 'OperationError' ? 'That code is not valid' : err.message;
      $('loginError').hidden = false;
    } finally {
      $('loginBtn').disabled = false;
      $('loginBtn').textContent = 'View my balance';
    }
  });

  $('logout').addEventListener('click', () => {
    session('clear');
    me = null;
    showLogin();
  });

  $('statusFilter').addEventListener('click', (ev) => {
    const status = ev.target.closest('[data-status]')?.dataset.status;
    if (!status) return;
    filters.status = status;
    render();
  });
  $('loanFilter').addEventListener('change', (ev) => { filters.loan = ev.target.value; render(); });
  $('monthFilter').addEventListener('change', (ev) => { filters.month = ev.target.value; render(); });
  $('sortBy').value = sortBy;
  $('sortBy').addEventListener('change', (ev) => {
    sortBy = ev.target.value;
    try {
      localStorage.setItem(SORT_KEY, sortBy);
    } catch {
      // Not remembered, but still applied.
    }
    render();
  });
  $('noteSearch').addEventListener('input', (ev) => { filters.text = ev.target.value; render(); });
  $('clearFilters').addEventListener('click', () => {
    Object.assign(filters, { status: defaultStatus(), loan: '', month: '', text: '' });
    $('loanFilter').value = '';
    $('monthFilter').value = '';
    $('noteSearch').value = '';
    render();
  });

  try {
    // Reflect where a saved code lives, so re-saving it keeps it there.
    $('rememberCode').checked = !sessionStorage.getItem(SESSION_KEY);
  } catch {
    // Keep the default.
  }
  const saved = session('get');
  if (saved) signIn(saved).catch(() => { session('clear'); showLogin(); });
  else showLogin();
})();
