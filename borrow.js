(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const STATUS_LABEL = { paid: 'Paid', overdue: 'Overdue', 'due-soon': 'Due soon', upcoming: 'Upcoming' };
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

  function session(action, value) {
    try {
      if (action === 'get') return sessionStorage.getItem(SESSION_KEY);
      if (action === 'set') sessionStorage.setItem(SESSION_KEY, value);
      if (action === 'clear') sessionStorage.removeItem(SESSION_KEY);
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

  async function open(code) {
    if (!Core.isWellFormedCode(code)) throw new Error('That code is not valid');
    const config = await fetchJson('config.json');
    if (!config) throw new Error('This site is not set up yet.');
    const { key, fileId } = await Core.deriveBorrower(code, config.siteSalt);
    const file = await fetchJson(`data/b/${fileId}.json`);
    if (!file) throw new Error('That code is not valid');
    return Core.decryptJson(key, file);
  }

  async function signIn(code) {
    const data = await open(code);
    const today = Core.todayISO();
    const items = data.installments
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
      .map((i) => Core.withStatus(i, data.reminderDays, today));
    me = { ...data, items, totals: Core.totals(items) };
    session('set', Core.normalizeCode(code));
    fillFilterOptions();
    $('loginView').hidden = true;
    $('mainView').hidden = false;
    $('logout').hidden = false;
    render();
  }

  // ---- Filters --------------------------------------------------------

  const filters = { status: 'unpaid', loan: '', month: '' };

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

  function matches(i) {
    if (filters.status === 'unpaid' && i.status === 'paid') return false;
    if (!['all', 'unpaid'].includes(filters.status) && i.status !== filters.status) return false;
    if (filters.loan && loanName(i) !== filters.loan) return false;
    if (filters.month && !i.dueDate.startsWith(filters.month)) return false;
    return true;
  }

  function render() {
    const t = me.totals;
    $('greeting').textContent = `Hi ${me.name}` + (me.ownerName ? ` — here's what you owe ${me.ownerName}.` : '.');
    $('remaining').textContent = money(t.remaining);
    $('overdue').textContent = money(t.overdue);
    $('overdue').classList.toggle('danger', t.overdue > 0);
    $('nextDue').textContent = t.nextDue ? money(t.nextDue.remaining) : '—';
    $('nextDueDate').textContent = t.nextDue ? `due ${dateLabel(t.nextDue.dueDate)}` : 'All paid up';

    for (const chip of $('statusFilter').children) {
      chip.classList.toggle('active', chip.dataset.status === filters.status);
      chip.setAttribute('aria-pressed', chip.dataset.status === filters.status);
    }
    $('clearFilters').hidden = filters.status === 'unpaid' && !filters.loan && !filters.month;

    const shown = me.items.filter(matches);
    const st = Core.totals(shown);
    $('filterSummary').textContent = shown.length
      ? `${shown.length} payment${shown.length === 1 ? '' : 's'} · ${money(st.owed)} total · ${money(st.paid)} paid · ${money(st.remaining)} left`
      : '';

    const byMonth = new Map();
    for (const i of shown) {
      const m = i.dueDate.slice(0, 7);
      if (!byMonth.has(m)) byMonth.set(m, []);
      byMonth.get(m).push(i);
    }
    const months = [...byMonth].map(([month, list]) => ({ month, items: list, ...Core.totals(list) }));
    $('months').replaceChildren(
      ...months.map((m) =>
        el('div', { className: 'month-card' }, [
          el('h3', {}, [
            document.createTextNode(monthLabel(m.month)),
            el('span', { textContent: m.remaining > 0 ? `${money(m.remaining)} left` : 'Paid' }),
          ]),
          ...m.items.map((i) =>
            el('div', { className: 'item' }, [
              el('div', {}, [
                el('div', { textContent: dateLabel(i.dueDate) + (i.note ? ` · ${i.note}` : '') }),
                el('div', { className: 'sub', textContent: dueText(i) + (i.paid > 0 && i.remaining > 0 ? ` · ${money(i.paid)} paid so far` : '') }),
              ]),
              el('div', { className: 'amt' }, [
                el('div', { className: 'amt', textContent: money(i.remaining > 0 ? i.remaining : i.amount) }),
                el('span', { className: `badge ${i.status}`, textContent: STATUS_LABEL[i.status] }),
              ]),
            ])
          ),
        ])
      )
    );
    $('monthsEmpty').hidden = months.length > 0;

    const who = me.ownerName || 'the person you owe';
    $('reminderStatus').textContent = me.reminders.length
      ? `Reminders are on: ${me.reminders.join(' and ')}.`
      : `Reminders are off. To get them, send your email address or phone number to ${who}.`;
    $('reminderHint').textContent =
      `Reminders go out ${me.reminderDays} day${me.reminderDays === 1 ? '' : 's'} before a payment is due, ` +
      `on the due date, and the day after if it's still unpaid. To change where they go, contact ${who}.`;
  }

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
  $('clearFilters').addEventListener('click', () => {
    Object.assign(filters, { status: 'unpaid', loan: '', month: '' });
    $('loanFilter').value = '';
    $('monthFilter').value = '';
    render();
  });

  const saved = session('get');
  if (saved) signIn(saved).catch(() => { session('clear'); showLogin(); });
  else showLogin();
})();
