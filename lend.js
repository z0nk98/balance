(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  // Version stamp this script was loaded with (see scripts/stamp.js).
  const LOADED_VERSION = new URL(document.currentScript.src).searchParams.get('v');
  const STATUS_LABEL = { paid: 'Paid', overdue: 'Overdue', 'due-soon': 'Due soon', upcoming: 'Upcoming' };
  const TOKEN_KEY = 'balance:github-token';
  const OWNER_FILE = 'data/owner.json';
  // Commit messages are public, so they never mention names or amounts.
  const COMMIT_MESSAGE = 'Update encrypted data';

  let config = null; // { repo, siteSalt }
  let gh = null;
  let state = null; // decrypted owner data
  let ownerKey = null;
  let ownerSalt = null;
  let setupMode = false;
  const derived = new Map(); // code -> { key, fileId }
  const published = new Map(); // fileId -> payload JSON last written this session
  const pendingDeletes = new Set(); // borrower files to remove on next save
  const pendingQr = new Map(); // QR file id -> encrypted content, or null to delete
  const pendingPathDeletes = new Set(); // other files to delete on next save (saved borrower updates)
  const openPanels = new Set();

  // ---- Helpers --------------------------------------------------------

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    for (const c of children) node.append(c);
    return node;
  }

  function money(n) {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: state.settings.currency }).format(n);
    } catch {
      return n.toFixed(2);
    }
  }

  function dateLabel(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function dueSoonLabel(days) {
    return `Due soon (next ${days} day${days === 1 ? '' : 's'})`;
  }

  function show(view) {
    for (const v of ['connectView', 'unlockView', 'mainView']) $(v).hidden = v !== view;
    $('lock').hidden = view !== 'mainView';
  }

  function storage(action, value) {
    try {
      if (action === 'get') return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY);
      if (action === 'clear') {
        localStorage.removeItem(TOKEN_KEY);
        sessionStorage.removeItem(TOKEN_KEY);
      }
      if (action === 'local') localStorage.setItem(TOKEN_KEY, value);
      if (action === 'session') sessionStorage.setItem(TOKEN_KEY, value);
    } catch {
      // Storage unavailable: the key is kept in memory for this visit only.
    }
    return null;
  }

  async function derive(b) {
    const key = `${b.codeExact ? 'exact' : 'loose'}:${b.code}`;
    if (!derived.has(key)) derived.set(key, await Core.deriveBorrower(b.code, config.siteSalt, Boolean(b.codeExact)));
    return derived.get(key);
  }

  // ---- GitHub ---------------------------------------------------------

  function GitHub(repo, token) {
    const base = `https://api.github.com/repos/${repo}`;
    let branch = 'main';

    async function req(method, path, body, accept = 'application/vnd.github+json') {
      const res = await fetch(base + path, {
        method,
        cache: 'no-store',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: accept,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return res;
    }

    async function json(method, path, body) {
      const res = await req(method, path, body);
      if (!res.ok) {
        const err = new Error(`GitHub error ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    }

    return {
      async connect() {
        const res = await req('GET', '');
        if (res.status === 401) throw new Error('GitHub didn’t accept that key. Check that you copied all of it and that it hasn’t expired.');
        if (res.status === 404) throw new Error(`That key can’t see ${repo}. Give it access to this repository.`);
        if (!res.ok) throw new Error(`GitHub error ${res.status}. Try again.`);
        const info = await res.json();
        if (info.permissions && !info.permissions.push) {
          throw new Error('That key can only read. Give it “Contents: Read and write” permission.');
        }
        branch = info.default_branch || 'main';
      },

      async readText(path) {
        const res = await req('GET', `/contents/${path}?ref=${encodeURIComponent(branch)}`, null, 'application/vnd.github.raw+json');
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`Couldn’t load ${path} (GitHub error ${res.status})`);
        return res.text();
      },

      async listDir(path) {
        const res = await req('GET', `/contents/${path}?ref=${encodeURIComponent(branch)}`);
        if (res.status === 404) return [];
        if (!res.ok) throw new Error(`Couldn’t list ${path} (GitHub error ${res.status})`);
        const items = await res.json();
        return Array.isArray(items) ? items.filter((i) => i.type === 'file').map((i) => i.name) : [];
      },

      // One commit with all changes; `content: null` deletes the file.
      async commit(message, files) {
        const ref = await json('GET', `/git/ref/heads/${branch}`);
        const parent = await json('GET', `/git/commits/${ref.object.sha}`);
        const tree = await json('POST', '/git/trees', {
          base_tree: parent.tree.sha,
          tree: files.map(([path, content]) =>
            content === null
              ? { path, mode: '100644', type: 'blob', sha: null }
              : { path, mode: '100644', type: 'blob', content }),
        });
        const commit = await json('POST', '/git/commits', { message, tree: tree.sha, parents: [ref.object.sha] });
        const res = await req('PATCH', `/git/refs/heads/${branch}`, { sha: commit.sha, force: false });
        if (res.status === 422) {
          const err = new Error('Your data was changed somewhere else (another device or tab). Reload this page to get the latest, then redo your last change.');
          err.conflict = true;
          throw err;
        }
        if (!res.ok) throw new Error(`GitHub error ${res.status} while saving`);
      },
    };
  }

  // ---- Saving ---------------------------------------------------------

  let queue = Promise.resolve();
  let saveFailed = false;

  function setStatus(kind, text) {
    const s = $('saveStatus');
    s.className = `save-status ${kind}`;
    s.replaceChildren(document.createTextNode(text));
    if (kind === 'error' && !text.includes('Reload')) {
      s.append(' ', el('button', { textContent: 'Try again', onclick: () => persist() }));
    }
  }

  function persist() {
    setStatus('saving', 'Saving…');
    queue = queue
      .then(save)
      .then(() => {
        saveFailed = false;
        setStatus('saved', 'Saved. Borrowers will see changes in about a minute.');
      })
      .catch((err) => {
        saveFailed = true;
        setStatus('error', `Not saved: ${err.message}`);
      });
    return queue;
  }

  async function save() {
    const files = [];
    const written = [];
    for (const b of state.borrowers) {
      const d = await derive(b);
      b.fileId = d.fileId;
      const payload = Core.borrowerPayload(state, b);
      const text = JSON.stringify(payload);
      if (published.get(d.fileId) !== text) {
        files.push([`data/b/${d.fileId}.json`, JSON.stringify(await Core.encryptJson(d.key, payload))]);
        written.push([d.fileId, text]);
      }
    }
    const deletes = [...pendingDeletes];
    for (const id of deletes) files.push([`data/b/${id}.json`, null]);
    const pathDeletes = [...pendingPathDeletes];
    for (const p of pathDeletes) files.push([p, null]);
    const qrChanges = [...pendingQr];
    for (const [id, content] of qrChanges) files.push([`data/pay/${id}.json`, content]);
    files.push([OWNER_FILE, JSON.stringify(await Core.sealOwnerFile(state, ownerKey, ownerSalt))]);

    await gh.commit(COMMIT_MESSAGE, files);

    for (const [id, text] of written) published.set(id, text);
    for (const id of deletes) {
      pendingDeletes.delete(id);
      published.delete(id);
    }
    for (const [id, content] of qrChanges) {
      if (pendingQr.get(id) === content) pendingQr.delete(id);
    }
    for (const p of pathDeletes) pendingPathDeletes.delete(p);
  }

  // Apply a change, redraw, and publish it.
  function change(fn) {
    try {
      fn();
    } catch (err) {
      alert(err.message);
      return;
    }
    render();
    persist();
  }

  // ---- Rendering ------------------------------------------------------

  // ---- Hide / show the totals (eye button) ----------------------------

  const HIDE_KEY = 'balance:hide-amounts';
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

  function render() {
    const today = Core.todayISO();
    const rows = state.borrowers.map((b) => {
      const installments = Core.installmentsFor(state, b.id, today);
      return { b, installments, totals: Core.totals(installments) };
    });

    const sum = (k) => rows.reduce((s, r) => s + r.totals[k], 0);
    $('sumRemaining').textContent = maskedMoney(sum('remaining'));
    $('sumOverdue').textContent = maskedMoney(sum('overdue'));
    $('sumOverdue').classList.toggle('danger', !amountsHidden && sum('overdue') > 0);
    $('sumDueSoon').textContent = maskedMoney(sum('dueSoon'));
    $('sumDueSoon').classList.toggle('warn', !amountsHidden && sum('dueSoon') > 0);
    $('dueSoonLabel').textContent = dueSoonLabel(state.settings.reminderDays);
    $('sumPaid').textContent = maskedMoney(sum('paid'));
    renderAmountsToggle();
    $('sumBorrowers').textContent = rows.length;

    renderOwnerFilters(rows);
    const active = filtersActive();
    const shownRows = rows
      .filter((r) => !ownerFilters.borrower || r.b.id === ownerFilters.borrower)
      .map((r) => ({ ...r, shown: r.installments.filter((i) => Core.matchesFilter(i, ownerFilters)) }))
      .filter((r) => !active || r.shown.length > 0 || ownerFilters.borrower === r.b.id);
    const all = shownRows.flatMap((r) => r.shown);
    const ft = Core.totals(all);
    $('ownerFilterSummary').textContent = all.length
      ? `${active ? 'Showing ' : ''}${all.length} payment${all.length === 1 ? '' : 's'} · ${maskedMoney(ft.owed)} total · ${maskedMoney(ft.paid)} paid · ${maskedMoney(ft.remaining)} left` +
        (ft.overdue > 0 ? ` · ${maskedMoney(ft.overdue)} overdue` : '')
      : active ? 'No payments match these filters.' : '';

    $('borrowers').replaceChildren(...shownRows.map((r) => borrowerCard(r, active)));
    $('borrowersEmpty').hidden = rows.length > 0;
    $('viewFilters').hidden = rows.length === 0;
    renderPayMethods();
    renderInbox();
    renderNotifySetup();

    if (document.activeElement?.form !== $('settingsForm')) {
      $('ownerName').value = state.settings.ownerName;
      $('currencyCode').value = state.settings.currency;
      $('reminderDays').value = state.settings.reminderDays;
    }
  }

  // ---- Owner filters ----------------------------------------------------

  const FILTER_KEY = 'balance:owner-filters';
  const ownerFilters = { status: 'all', borrower: '', loan: '', month: '', sort: 'date' };
  try {
    Object.assign(ownerFilters, JSON.parse(localStorage.getItem(FILTER_KEY) || '{}'));
  } catch {
    // Storage unavailable: start with no filters.
  }

  function filtersActive() {
    return ownerFilters.status !== 'all' || Boolean(ownerFilters.borrower || ownerFilters.loan || ownerFilters.month);
  }

  function setOwnerFilter(changes) {
    Object.assign(ownerFilters, changes);
    try {
      localStorage.setItem(FILTER_KEY, JSON.stringify(ownerFilters));
    } catch {
      // Not remembered, but still applied.
    }
    render();
  }

  // Sorting is kept with the filters but isn't a filter itself ("Clear filters" leaves it).
  const STATUS_ORDER = { overdue: 0, 'due-soon': 1, upcoming: 2, paid: 3 };
  const sortText = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const byDate = (a, b) => a.dueDate.localeCompare(b.dueDate);
  const byLoan = (a, b) => sortText.compare(Core.loanName(a.note), Core.loanName(b.note)) || byDate(a, b);
  const SORTS = {
    date: byDate,
    'date-desc': (a, b) => byDate(b, a),
    'loan-asc': byLoan,
    'loan-desc': (a, b) => sortText.compare(Core.loanName(b.note), Core.loanName(a.note)) || byDate(a, b),
    'left-desc': (a, b) => b.remaining - a.remaining || byDate(a, b),
    'amount-desc': (a, b) => b.amount - a.amount || byDate(a, b),
    status: (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || byDate(a, b),
  };

  function sortPayments(items) {
    return [...items].sort(SORTS[ownerFilters.sort] || byDate);
  }

  function fillSelect(select, allLabel, options, current) {
    select.replaceChildren(
      el('option', { value: '', textContent: allLabel }),
      ...options.map(([value, label]) => el('option', { value, textContent: label }))
    );
    select.value = options.some(([v]) => v === current) ? current : '';
    return select.value;
  }

  function renderOwnerFilters(rows) {
    // Drop choices that no longer exist (deleted borrower, renamed loan…).
    ownerFilters.borrower = fillSelect($('ownerBorrowerFilter'), 'All borrowers',
      rows.map((r) => [r.b.id, r.b.name]), ownerFilters.borrower);
    // Loans and months offered are only those of the chosen borrower (and loan).
    const items = rows.filter((r) => !ownerFilters.borrower || r.b.id === ownerFilters.borrower).flatMap((r) => r.installments);
    const byText = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    ownerFilters.loan = fillSelect($('ownerLoanFilter'), 'All loans',
      [...new Set(items.map((i) => Core.loanName(i.note)))].sort(byText.compare).map((l) => [l, l]), ownerFilters.loan);
    const loanItems = items.filter((i) => !ownerFilters.loan || Core.loanName(i.note) === ownerFilters.loan);
    ownerFilters.month = fillSelect($('ownerMonthFilter'), 'All months',
      [...new Set(loanItems.map((i) => i.dueDate.slice(0, 7)))].sort().map((m) => {
        const [y, mo] = m.split('-').map(Number);
        return [m, new Date(y, mo - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })];
      }), ownerFilters.month);
    for (const chip of $('ownerStatusFilter').children) {
      chip.classList.toggle('active', chip.dataset.status === ownerFilters.status);
      chip.setAttribute('aria-pressed', chip.dataset.status === ownerFilters.status);
    }
    if (!SORTS[ownerFilters.sort]) ownerFilters.sort = 'date';
    $('ownerSort').value = ownerFilters.sort;
    $('ownerClearFilters').hidden = !filtersActive();
  }

  $('ownerStatusFilter').addEventListener('click', (ev) => {
    const status = ev.target.closest('[data-status]')?.dataset.status;
    if (status) setOwnerFilter({ status });
  });
  $('ownerBorrowerFilter').addEventListener('change', (ev) => setOwnerFilter({ borrower: ev.target.value }));
  $('ownerLoanFilter').addEventListener('change', (ev) => setOwnerFilter({ loan: ev.target.value }));
  $('ownerMonthFilter').addEventListener('change', (ev) => setOwnerFilter({ month: ev.target.value }));
  $('ownerSort').addEventListener('change', (ev) => setOwnerFilter({ sort: ev.target.value }));
  $('ownerClearFilters').addEventListener('click', () => setOwnerFilter({ status: 'all', borrower: '', loan: '', month: '' }));

  function borrowerCard({ b, installments, totals: t, shown }, filtered) {
    const c = b.contact;
    const reminders = [c.notifyEmail && `email ${c.email}`, c.notifySms && `text ${c.phone}`].filter(Boolean);
    const summary = [
      `${maskedMoney(t.remaining)} outstanding`,
      t.overdue > 0 ? `${maskedMoney(t.overdue)} overdue` : null,
      t.dueSoon > 0 ? `${maskedMoney(t.dueSoon)} due soon` : null,
      t.nextDue ? `next ${maskedMoney(t.nextDue.remaining)} on ${dateLabel(t.nextDue.dueDate)}` : 'nothing due',
    ].filter(Boolean).join(' · ');

    // With a filter on, show only matching payments and open the list.
    const ft = filtered ? Core.totals(shown) : null;
    const details = el('details', { open: filtered || openPanels.has(b.id) }, [
      el('summary', { textContent: filtered
        ? `Payments & reminders (showing ${shown.length} of ${installments.length})`
        : `Payments & reminders (${installments.length})` }),
      scheduleForm(b),
      installmentForm(b),
      loansRow(b, installments),
      filtered ? el('div', { className: 'filter-summary', textContent: `Filtered: ${maskedMoney(ft.owed)} total · ${maskedMoney(ft.paid)} paid · ${maskedMoney(ft.remaining)} left` }) : '',
      installmentTable(sortPayments(filtered ? shown : installments)),
      contactForm(b),
    ]);
    details.addEventListener('toggle', () => {
      if (details.open) openPanels.add(b.id);
      else openPanels.delete(b.id);
    });

    return el('section', { className: 'card' }, [
      el('div', { className: 'borrower-head' }, [
        el('div', {}, [
          el('h3', { textContent: b.name }),
          el('div', { className: 'sub', textContent: summary }),
          el('div', { className: 'sub', textContent: reminders.length ? `Reminders: ${reminders.join(', ')}` : 'Reminders: off (add their email or phone below)' }),
        ]),
        el('div', { className: 'btn-row row-actions' }, [
          iconButton('key', `Show code for ${b.name}`, () => showCode(b)),
          iconButton('newKey', `Change code for ${b.name}`, () => newCode(b)),
          iconButton('edit', `Rename ${b.name}`, () => rename(b)),
          iconButton('delete', `Delete ${b.name}`, () => removeBorrower(b), 'danger'),
        ]),
      ]),
      details,
    ]);
  }

  function field(label, input) {
    return el('label', {}, [document.createTextNode(label), input]);
  }

  function scheduleForm(b) {
    const total = el('input', { type: 'number', min: '0.01', step: '0.01', required: true });
    const interest = el('input', { type: 'number', min: '0', step: '0.01', placeholder: '0' });
    const count = el('input', { type: 'number', min: '1', max: '120', value: '1', required: true });
    const frequency = el('select', {}, Object.entries(Core.FREQUENCIES).map(([value, label]) => el('option', { value, textContent: label })));
    const first = el('input', { type: 'date', value: Core.todayISO(), required: true });
    const note = el('input', { maxLength: 100, placeholder: 'e.g. Car repair', className: 'grow' });
    const preview = el('div', { className: 'hint schedule-preview' });

    // Show what the schedule will look like before it's added.
    function updatePreview() {
      const amount = Number(total.value);
      const extra = Number(interest.value || 0);
      const n = Number(count.value);
      if (!(amount > 0) || !(extra >= 0) || !Number.isInteger(n) || n < 1 || n > 120 || !Core.isValidISO(first.value)) {
        preview.textContent = '';
        return;
      }
      const items = Core.splitSchedule(amount, n, first.value, '', frequency.value, extra);
      preview.textContent = schedulePreview(items, `${n} payment${n === 1 ? '' : 's'}`);
    }
    for (const input of [total, interest, count, frequency, first]) input.addEventListener('input', updatePreview);

    const form = el('form', { className: 'inline-form' }, [
      field('Initial amount', total),
      field('Total interest', interest),
      field('Number of payments', count),
      field('How often', frequency),
      field('First due date', first),
      field('Loan name', note),
      el('button', { type: 'submit', className: 'primary', textContent: 'Add loan' }),
    ]);
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      openPanels.add(b.id);
      change(() => {
        const amount = Core.money(total.value, 'Initial amount');
        const extra = interest.value ? Core.money(interest.value, 'Total interest') : 0;
        const n = Number(count.value);
        if (amount <= 0) throw new Error('Initial amount must be more than zero');
        if (extra < 0) throw new Error('Interest can’t be negative');
        if (!Number.isInteger(n) || n < 1 || n > 120) throw new Error('Number of payments must be between 1 and 120');
        if (!Core.isValidISO(first.value)) throw new Error('Pick a first due date');
        for (const p of Core.splitSchedule(amount, n, first.value, note.value.trim().slice(0, 100), frequency.value, extra)) {
          state.installments.push({ id: Core.newId(), borrowerId: b.id, paid: 0, ...p });
        }
      });
    });
    return el('div', {}, [el('div', { className: 'hint', textContent: 'New loan, split into equal payments:' }), form, preview]);
  }

  // "6 payments of ₱1,833.33 (₱1,666.67 + ₱166.67 interest) — Nov 15: … · …"
  function schedulePreview(items, lead) {
    const { principal, interest, total } = Core.loanBreakdown(items);
    const first = items[0];
    const per = interest > 0
      ? `${money(first.amount)} each (${money(first.amount - first.interest)} + ${money(first.interest)} interest)`
      : `${money(first.amount)} each`;
    const shown = items.slice(0, 4).map((p) => `${dateLabel(p.dueDate)}: ${money(p.amount)}`);
    if (items.length > 4) shown.push(`… last on ${dateLabel(items[items.length - 1].dueDate)}`);
    const sums = interest > 0 ? ` Total ${money(total)} = ${money(principal)} lent + ${money(interest)} interest.` : '';
    return `${lead}, ${per} — ${shown.join(' · ')}.${sums}`;
  }

  function installmentForm(b) {
    const amount = el('input', { type: 'number', min: '0.01', step: '0.01', required: true });
    const due = el('input', { type: 'date', value: Core.todayISO(), required: true });
    const note = el('input', { maxLength: 120, className: 'grow', placeholder: 'e.g. Car repair' });
    const form = el('form', { className: 'inline-form' }, [
      field('Amount', amount),
      field('Due date', due),
      field('Loan name', note),
      el('button', { type: 'submit', textContent: 'Add single payment' }),
    ]);
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      openPanels.add(b.id);
      change(() => {
        const a = Core.money(amount.value, 'Amount');
        if (a <= 0) throw new Error('Amount must be more than zero');
        if (!Core.isValidISO(due.value)) throw new Error('Pick a due date');
        state.installments.push({ id: Core.newId(), borrowerId: b.id, amount: a, paid: 0, dueDate: due.value, note: note.value.trim().slice(0, 120) });
      });
    });
    return el('div', { className: 'hint' }, [document.createTextNode('Or add one payment due:'), form]);
  }

  function findInstallment(id) {
    return state.installments.find((x) => x.id === id);
  }

  function iconButton(kind, label, onclick, extra = '') {
    const btn = el('button', { type: 'button', className: `icon-btn ${extra}`.trim(), title: label, onclick });
    btn.setAttribute('aria-label', label);
    btn.append(PayIcons.actionIcon(kind));
    return btn;
  }

  // One entry per loan, with a button to rename all of its payments at once.
  function loansRow(b, items) {
    const loans = new Map();
    for (const i of items) {
      const name = Core.loanName(i.note);
      loans.set(name, (loans.get(name) || 0) + 1);
    }
    if (!loans.size) return el('div');
    const editing = editingLoan?.borrowerId === b.id && loans.has(editingLoan.name) ? editingLoan.name : null;
    return el('div', {}, [
      el('div', { className: 'loans-row' }, [
        el('span', { className: 'hint', textContent: 'Loans:' }),
        ...[...loans].map(([name, count]) =>
          el('span', { className: `loan-tag${editing === name ? ' editing' : ''}` }, [
            document.createTextNode(`${name} (${count} payment${count === 1 ? '' : 's'})`),
            el('span', { className: 'loan-actions' }, [
              iconButton('edit', `Edit loan ${name}`, () => { editingLoan = { borrowerId: b.id, name }; render(); }),
              iconButton('rename', `Rename loan ${name}`, () => renameLoan(b, name)),
              iconButton('delete', `Delete loan ${name}`, () => deleteLoan(b, name), 'danger'),
            ]),
          ])),
      ]),
      editing ? loanEditor(b, editing) : '',
    ]);
  }

  // ---- Whole-loan edit / delete ---------------------------------------

  let editingLoan = null; // { borrowerId, name }

  function loanItems(b, name) {
    return state.installments
      .filter((i) => i.borrowerId === b.id && Core.loanName(i.note) === name)
      .sort((x, y) => x.dueDate.localeCompare(y.dueDate));
  }

  function deleteLoan(b, name) {
    const items = loanItems(b, name);
    const paid = items.reduce((s, i) => s + i.paid, 0);
    const total = items.reduce((s, i) => s + i.amount, 0);
    const extra = paid > 0 ? `\n\n${money(paid)} is recorded as already paid on it; that record will be removed too.` : '';
    if (!confirm(`Delete the whole "${name}" loan for ${b.name}: ${items.length} payment${items.length === 1 ? '' : 's'}, ${money(total)} in total?${extra}`)) return;
    if (editingLoan?.borrowerId === b.id && editingLoan.name === name) editingLoan = null;
    const ids = new Set(items.map((i) => i.id));
    change(() => { state.installments = state.installments.filter((i) => !ids.has(i.id)); });
  }

  function loanEditor(b, name) {
    const items = loanItems(b, name);
    const before = Core.loanBreakdown(items);
    const total0 = before.total;
    const nameIn = el('input', { value: name === 'Other' ? '' : name, maxLength: 90, className: 'grow', placeholder: 'e.g. Laptop' });
    const total = el('input', { type: 'number', min: '0.01', step: '0.01', value: before.principal, required: true });
    const interest = el('input', { type: 'number', min: '0', step: '0.01', value: before.interest || '', placeholder: '0' });
    const count = el('input', { type: 'number', min: '1', max: '120', value: items.length, required: true });
    const frequency = el('select', {}, Object.entries(Core.FREQUENCIES).map(([value, label]) => el('option', { value, textContent: label })));
    frequency.value = Core.guessFrequency(items.map((i) => i.dueDate));
    const first = el('input', { type: 'date', value: items[0].dueDate, required: true });
    const preview = el('div', { className: 'hint schedule-preview' });

    function values() {
      return {
        name: nameIn.value.trim().slice(0, 90),
        total: Core.money(total.value, 'Initial amount'),
        interest: interest.value ? Core.money(interest.value, 'Total interest') : 0,
        count: Number(count.value),
        firstDue: first.value,
        frequency: frequency.value,
      };
    }

    function updatePreview() {
      try {
        const v = values();
        if (!(v.total > 0) || !(v.interest >= 0) || !Number.isInteger(v.count) || v.count < 1 || v.count > 120 || !Core.isValidISO(v.firstDue)) throw new Error();
        const { items: next } = Core.rebuildLoan(items, v);
        preview.textContent = schedulePreview(next, `Will become ${next.length} payment${next.length === 1 ? '' : 's'}`);
      } catch {
        preview.textContent = '';
      }
    }
    for (const input of [total, interest, count, frequency, first]) input.addEventListener('input', updatePreview);
    updatePreview();

    const form = el('form', { className: 'inline-form' }, [
      field('Loan name', nameIn),
      field('Initial amount', total),
      field('Total interest', interest),
      field('Number of payments', count),
      field('How often', frequency),
      field('First due date', first),
      el('button', { type: 'submit', className: 'primary', textContent: 'Save loan' }),
      el('button', { type: 'button', textContent: 'Cancel', onclick: () => { editingLoan = null; render(); } }),
    ]);
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      let v;
      try {
        v = values();
        if (!(v.total > 0)) throw new Error('Initial amount must be more than zero');
        if (v.interest < 0) throw new Error('Interest can’t be negative');
        if (!Number.isInteger(v.count) || v.count < 1 || v.count > 120) throw new Error('Number of payments must be between 1 and 120');
        if (!Core.isValidISO(v.firstDue)) throw new Error('Pick a first due date');
      } catch (err) {
        alert(err.message);
        return;
      }
      const { items: next, lostPaid } = Core.rebuildLoan(items, v);
      if (lostPaid > 0 && !confirm(`${money(lostPaid)} recorded as paid on this loan doesn't fit the new payments and will be dropped. Save anyway?`)) return;
      const oldIds = new Set(items.map((i) => i.id));
      editingLoan = null;
      change(() => {
        state.installments = state.installments.filter((i) => !oldIds.has(i.id));
        for (const p of next) state.installments.push({ id: p.id || Core.newId(), borrowerId: b.id, amount: p.amount, ...(p.interest ? { interest: p.interest } : {}), paid: p.paid, dueDate: p.dueDate, note: p.note });
      });
    });

    return el('div', { className: 'loan-editor' }, [
      el('div', { className: 'loan-editor-title', textContent: `Edit the whole "${name}" loan (${items.length} payments, ${money(total0)}${before.interest > 0 ? ` incl. ${money(before.interest)} interest` : ''})` }),
      form,
      preview,
      el('div', { className: 'hint', textContent: 'Saving replaces all of this loan’s payments. Amounts already marked paid are kept, in order.' }),
    ]);
  }

  function renameLoan(b, oldName) {
    const input = prompt(`New name for "${oldName}" (changes the note on all of its payments)`, oldName === 'Other' ? '' : oldName);
    if (input === null) return;
    const name = input.trim().slice(0, 90);
    if (name === oldName) return;
    change(() => {
      for (const i of state.installments) {
        if (i.borrowerId === b.id && Core.loanName(i.note) === oldName) i.note = Core.renameLoanNote(i.note, name);
      }
    });
  }

  function installmentTable(items) {
    if (!items.length) return el('p', { className: 'empty', textContent: 'No payments yet.' });
    const head = el('tr', {}, ['Due', 'Loan', 'Amount', 'Paid', 'Left', 'Status', ''].map((h, i) =>
      el('th', { className: i >= 2 && i <= 4 ? 'num' : '', textContent: h })));
    const rows = items.map((i) =>
      el('tr', {}, [
        el('td', { textContent: dateLabel(i.dueDate) }),
        el('td', { textContent: i.note }),
        el('td', { className: 'num' }, [
          document.createTextNode(money(i.amount)),
          i.interest > 0 ? el('div', { className: 'sub', textContent: `incl. ${money(i.interest)} interest` }) : '',
        ]),
        el('td', { className: 'num', textContent: money(i.paid) }),
        el('td', { className: 'num', textContent: money(i.remaining) }),
        el('td', {}, [el('span', { className: `badge ${i.status}`, textContent: STATUS_LABEL[i.status] })]),
        el('td', {}, [
          el('div', { className: 'btn-row row-actions' }, [
            i.remaining > 0
              ? iconButton('paid', 'Mark paid', () => change(() => { findInstallment(i.id).paid = i.amount; }), 'good')
              : iconButton('undo', 'Undo paid', () => change(() => { findInstallment(i.id).paid = 0; })),
            i.remaining > 0 ? iconButton('record', 'Record payment', () => recordPayment(i)) : '',
            iconButton('edit', 'Edit payment', () => editInstallment(i)),
            iconButton('delete', 'Delete payment', () => {
              if (confirm(`Delete the ${money(i.amount)} payment due ${dateLabel(i.dueDate)}?`)) {
                change(() => { state.installments = state.installments.filter((x) => x.id !== i.id); });
              }
            }, 'danger'),
          ]),
        ]),
      ])
    );
    return el('div', { className: 'table-wrap' }, [el('table', {}, [el('thead', {}, [head]), el('tbody', {}, rows)])]);
  }

  function contactForm(b) {
    const c = b.contact;
    const email = el('input', { type: 'email', maxLength: 254, value: c.email, placeholder: 'name@example.com', className: 'grow' });
    const phone = el('input', { type: 'tel', maxLength: 20, value: c.phone, placeholder: '0917 123 4567' });
    const byEmail = el('input', { type: 'checkbox', checked: c.notifyEmail });
    const bySms = el('input', { type: 'checkbox', checked: c.notifySms });
    const form = el('form', { className: 'inline-form' }, [
      field('Their email', email),
      field('Their mobile number', phone),
      el('label', { className: 'check' }, [byEmail, document.createTextNode('Email reminders')]),
      el('label', { className: 'check' }, [bySms, document.createTextNode('Text reminders')]),
      el('button', { type: 'submit', textContent: 'Save reminders' }),
    ]);
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      change(() => {
        const next = {
          email: Core.cleanEmail(email.value),
          phone: Core.cleanPhone(phone.value),
          notifyEmail: byEmail.checked,
          notifySms: bySms.checked,
        };
        if (next.notifyEmail && !next.email) throw new Error('Add an email address for email reminders');
        if (next.notifySms && !next.phone) throw new Error('Add a phone number for text reminders');
        b.contact = next;
      });
    });
    return el('div', { className: 'contact-block' }, [el('div', { className: 'hint', textContent: 'Reminders (borrowers can send these from their page; you apply them):' }), form]);
  }

  // ---- Actions --------------------------------------------------------

  function portalUrl() {
    return new URL('borrow.html', location.href).href;
  }

  function showCode(b) {
    $('codeFor').textContent = `Access code for ${b.name}:`;
    $('codeValue').textContent = b.code;
    $('portalUrl').textContent = portalUrl();
    $('codeBanner').hidden = false;
    $('codeBanner').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // Ask for an owner-chosen code. Returns the code, '' for a random one, or
  // null if cancelled.
  function askForCode(name, exceptId) {
    const taken = state.borrowers.filter((x) => x.id !== exceptId && x.codeExact).map((x) => x.code);
    for (;;) {
      const input = prompt(`Type a code for ${name}: at least 8 characters with letters and numbers. Small letters, capitals and symbols (like ! @ # .) all count, so it must be typed exactly.\nOr leave it blank for a strong random code.`, '');
      if (input === null) return null;
      if (!input.trim()) return '';
      try {
        const { code, warnings } = Core.checkCustomCode(input, { name, taken });
        if (warnings.length && !confirm(`This code is easy to guess (${warnings.join(', ')}). Anyone who guesses it can see ${name}'s balance. Use it anyway?`)) continue;
        return code;
      } catch (err) {
        alert(err.message);
      }
    }
  }

  function newCode(b) {
    const chosen = askForCode(b.name, b.id);
    if (chosen === null) return;
    if (!confirm(`Change ${b.name}'s code? Their old code will stop working.`)) return;
    change(() => {
      if (b.fileId) pendingDeletes.add(b.fileId);
      b.code = chosen || Core.generateCode();
      b.codeExact = Boolean(chosen);
      b.fileId = null;
    });
    showCode(b);
  }

  function rename(b) {
    const name = prompt('New name', b.name);
    if (name && name.trim() && name.trim() !== b.name) change(() => { b.name = name.trim().slice(0, 60); });
  }

  function removeBorrower(b) {
    if (!confirm(`Delete ${b.name} and all of their payment records? This can't be undone.`)) return;
    change(() => {
      if (b.fileId) pendingDeletes.add(b.fileId);
      state.borrowers = state.borrowers.filter((x) => x.id !== b.id);
      state.installments = state.installments.filter((i) => i.borrowerId !== b.id);
    });
  }

  function recordPayment(i) {
    const v = prompt(`Amount received (${money(i.remaining)} left)`, i.remaining);
    if (v === null) return;
    const amt = parseFloat(v);
    if (!(amt > 0)) return alert('Enter an amount greater than zero.');
    change(() => {
      const inst = findInstallment(i.id);
      inst.paid = Math.min(inst.amount, Math.round((inst.paid + amt) * 100) / 100);
    });
  }

  function editInstallment(i) {
    const amount = prompt('Amount due', i.amount);
    if (amount === null) return;
    const dueDate = prompt('Due date (YYYY-MM-DD)', i.dueDate);
    if (dueDate === null) return;
    const note = prompt('Loan name for this payment', i.note);
    if (note === null) return;
    change(() => {
      const a = Core.money(amount, 'Amount');
      if (a <= 0) throw new Error('Amount must be more than zero');
      if (!Core.isValidISO(dueDate)) throw new Error('Due date must look like 2026-12-31');
      const inst = findInstallment(i.id);
      Object.assign(inst, { amount: a, dueDate, note: note.trim().slice(0, 120), paid: Math.min(inst.paid, a) });
      if (inst.interest > a) inst.interest = a;
    });
  }

  // ---- Payment methods ------------------------------------------------

  let editingPayId = null;
  let chosenQr = null; // { blob, url } picked in the form, not yet saved
  const qrUrls = new Map(); // QR file id -> object URL for display

  function payMethods() {
    if (!state.settings.paymentMethods) state.settings.paymentMethods = [];
    return state.settings.paymentMethods;
  }

  // Shrink a photo or screenshot of a QR code to a small, still scannable image.
  async function prepareQr(file) {
    if (!file.type.startsWith('image/')) throw new Error('Choose an image file for the QR code');
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 900 / Math.max(bmp.width, bmp.height));
    const canvas = el('canvas', { width: Math.round(bmp.width * scale), height: Math.round(bmp.height * scale) });
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const toBlob = (type, q) => new Promise((resolve) => canvas.toBlob(resolve, type, q));
    let blob = await toBlob('image/png');
    if (blob.size > 350000) blob = await toBlob('image/jpeg', 0.92);
    if (blob.size > 900000) throw new Error('That image is too large. Try a tighter screenshot of just the QR code.');
    return blob;
  }

  async function sharedKey() {
    if (!state.settings.paymentsKey) state.settings.paymentsKey = Core.newSharedKey();
    return Core.importSharedKey(state.settings.paymentsKey);
  }

  async function sealQr(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return JSON.stringify(await Core.encryptJson(await sharedKey(), { type: blob.type, data: Core.toB64(bytes) }));
  }

  function dropQr(fileId) {
    if (!fileId) return;
    // Never committed yet: just forget it. Otherwise delete it on next save.
    if (pendingQr.has(fileId) && pendingQr.get(fileId) !== null) pendingQr.delete(fileId);
    else pendingQr.set(fileId, null);
    if (qrUrls.has(fileId)) URL.revokeObjectURL(qrUrls.get(fileId));
    qrUrls.delete(fileId);
  }

  async function qrUrl(fileId) {
    if (qrUrls.has(fileId)) return qrUrls.get(fileId);
    const text = await gh.readText(`data/pay/${fileId}.json`);
    if (!text) return null;
    const { type, data } = await Core.decryptJson(await sharedKey(), JSON.parse(text));
    const url = URL.createObjectURL(new Blob([Core.fromB64(data)], { type }));
    qrUrls.set(fileId, url);
    return url;
  }

  function qrThumb(fileId) {
    const img = el('img', { className: 'qr-thumb', alt: 'QR code' });
    qrUrl(fileId).then((url) => { if (url) img.src = url; }).catch(() => { img.alt = 'QR code (couldn’t load)'; });
    return img;
  }

  function renderPayMethods() {
    const list = payMethods();
    $('payMethodsList').replaceChildren(
      ...list.map((m, idx) =>
        el('div', { className: 'pay-item' }, [
          PayIcons.paymentIcon(m.kind),
          el('div', { className: 'pay-body' }, [
            el('div', { className: 'pay-label', textContent: m.label }),
            el('div', { className: 'sub', textContent: [m.accountName, m.accountNumber].filter(Boolean).join(' · ') }),
            m.details ? el('div', { className: 'sub', textContent: m.details }) : '',
            m.qrFile ? qrThumb(m.qrFile) : '',
          ]),
          el('div', { className: 'btn-row' }, [
            el('button', { textContent: '↑', title: 'Move up', disabled: idx === 0, onclick: () => change(() => {
              list.splice(idx - 1, 0, list.splice(idx, 1)[0]);
            }) }),
            el('button', { textContent: 'Edit', onclick: () => startEditPay(m) }),
            m.qrFile ? el('button', { textContent: 'Remove QR', onclick: () => {
              if (confirm(`Remove the QR code from ${m.label}?`)) change(() => { dropQr(m.qrFile); delete m.qrFile; });
            } }) : '',
            el('button', { className: 'danger', textContent: 'Remove', onclick: () => {
              if (confirm(`Remove ${m.label}?`)) change(() => {
                dropQr(m.qrFile);
                state.settings.paymentMethods = list.filter((x) => x.id !== m.id);
              });
            } }),
          ]),
        ]))
    );
    $('payMethodsEmpty').hidden = list.length > 0;
  }

  function showChosenQr(url) {
    $('payQrPreview').replaceChildren(...(url ? [el('img', { className: 'qr-thumb', src: url, alt: 'QR code preview' })] : []));
    $('payQrPreview').hidden = !url;
  }

  function resetPayForm() {
    editingPayId = null;
    if (chosenQr) URL.revokeObjectURL(chosenQr.url);
    chosenQr = null;
    showChosenQr(null);
    $('payForm').reset();
    $('payKind').value = 'gcash';
    updatePayPlaceholder();
    $('paySubmit').textContent = 'Add';
    $('payCancel').hidden = true;
  }

  function updatePayPlaceholder() {
    const kind = $('payKind').value;
    $('payLabel').placeholder = kind === 'bank' ? 'e.g. BDO Savings' : Core.PAYMENT_KINDS[kind];
    $('payAccountNumber').placeholder = kind === 'bank' ? 'Account number' : kind === 'cash' ? '' : 'e.g. 0917 123 4567';
    $('payDetails').placeholder = kind === 'cash' ? 'e.g. Hand it to me on payday' : 'e.g. Send a screenshot after paying';
  }

  function startEditPay(m) {
    editingPayId = m.id;
    $('payKind').value = m.kind;
    updatePayPlaceholder();
    $('payLabel').value = m.label;
    $('payAccountName').value = m.accountName;
    $('payAccountNumber').value = m.accountNumber;
    $('payDetails').value = m.details;
    $('paySubmit').textContent = 'Save';
    $('payCancel').hidden = false;
    $('payLabel').focus();
  }

  for (const [value, label] of Object.entries(Core.PAYMENT_KINDS)) {
    $('payKind').append(el('option', { value, textContent: label }));
  }
  $('payKind').addEventListener('change', updatePayPlaceholder);
  $('payCancel').addEventListener('click', resetPayForm);
  $('payQr').addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    if (chosenQr) URL.revokeObjectURL(chosenQr.url);
    chosenQr = null;
    showChosenQr(null);
    if (!file) return;
    try {
      const blob = await prepareQr(file);
      chosenQr = { blob, url: URL.createObjectURL(blob) };
      showChosenQr(chosenQr.url);
    } catch (err) {
      ev.target.value = '';
      alert(err.message);
    }
  });
  $('payForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const id = editingPayId;
    const existing = id && payMethods().find((x) => x.id === id);
    let method;
    try {
      method = Core.cleanPaymentMethod({
        kind: $('payKind').value,
        label: $('payLabel').value,
        accountName: $('payAccountName').value,
        accountNumber: $('payAccountNumber').value,
        details: $('payDetails').value,
        hasQr: Boolean(chosenQr || existing?.qrFile),
      });
    } catch (err) {
      alert(err.message);
      return;
    }
    // Encrypt a newly chosen QR before applying the change.
    let qr = null;
    if (chosenQr) {
      $('paySubmit').disabled = true;
      try {
        qr = { fileId: Core.newId() + Core.newId(), content: await sealQr(chosenQr.blob), url: chosenQr.url };
      } catch (err) {
        alert(`Couldn’t add the QR code: ${err.message}`);
        return;
      } finally {
        $('paySubmit').disabled = false;
      }
      chosenQr = null; // its URL now belongs to qrUrls
    }
    change(() => {
      const target = existing || { id: Core.newId() };
      Object.assign(target, method);
      if (qr) {
        dropQr(target.qrFile);
        pendingQr.set(qr.fileId, qr.content);
        qrUrls.set(qr.fileId, qr.url);
        target.qrFile = qr.fileId;
      }
      if (!existing) payMethods().push(target);
    });
    resetPayForm();
  });
  resetPayForm();

  // ---- Updates from borrowers -------------------------------------------
  //
  // Borrowers post encrypted contact details to a private ntfy.sh topic.
  // ntfy keeps messages for about 12 hours; the hourly "Save borrower
  // updates" workflow copies them into data/inbox/ so none are lost.

  let inboxItems = []; // { id, fromRepo, value }
  let inboxTimer = null;

  // Older data has no inbox yet: create one (borrower files then include it).
  async function ensureInbox() {
    if (state.settings.inbox) return false;
    state.settings.inbox = await Core.newInbox();
    return true;
  }

  function inboxDone() {
    if (!state.inboxDone) state.inboxDone = [];
    return state.inboxDone;
  }

  async function fetchNtfy(topic) {
    try {
      const res = await fetch(`${Core.NTFY}/${encodeURIComponent(topic)}/json?poll=1&since=all`, { cache: 'no-store' });
      if (!res.ok) return [];
      return (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.event === 'message');
    } catch {
      return []; // ntfy unreachable: saved updates still show
    }
  }

  async function loadInbox() {
    if (!state?.settings.inbox) return;
    const { topic, privateKey } = state.settings.inbox;
    const done = new Set(inboxDone());
    const raw = new Map(); // id -> { text, fromRepo }

    const [saved, live] = await Promise.all([
      gh.listDir('data/inbox').catch(() => []),
      fetchNtfy(topic),
    ]);
    for (const name of saved) {
      const id = name.replace(/\.json$/, '');
      if (done.has(id)) {
        pendingPathDeletes.add(`data/inbox/${name}`); // already handled: tidy up
        continue;
      }
      const text = await gh.readText(`data/inbox/${name}`).catch(() => null);
      if (text) raw.set(id, { text: JSON.parse(text).message, fromRepo: true });
    }
    for (const m of live) {
      if (!done.has(m.id) && !raw.has(m.id)) raw.set(m.id, { text: m.message, fromRepo: false });
    }

    const items = [];
    for (const [id, { text, fromRepo }] of raw) {
      const value = await Core.openFromBorrower(privateKey, text);
      if (value?.type === 'contact') items.push({ id, fromRepo, value });
    }
    items.sort((a, b) => String(a.value.at).localeCompare(String(b.value.at)));
    inboxItems = items;
    renderInbox();
  }

  function finishInboxItem(item, apply) {
    change(() => {
      if (apply) {
        const b = state.borrowers.find((x) => x.id === item.value.borrowerId);
        if (!b) throw new Error('That borrower no longer exists.');
        b.contact = Core.cleanContactUpdate(item.value);
      }
      const done = inboxDone();
      done.push(item.id);
      if (done.length > 500) done.splice(0, done.length - 500);
      if (item.fromRepo) pendingPathDeletes.add(`data/inbox/${item.id}.json`);
      inboxItems = inboxItems.filter((x) => x !== item);
    });
  }

  function renderInbox() {
    $('inboxCard').hidden = inboxItems.length === 0;
    $('inboxList').replaceChildren(
      ...inboxItems.map((item) => {
        const v = item.value;
        const b = state.borrowers.find((x) => x.id === v.borrowerId);
        const wants = [v.notifyEmail && 'email', v.notifySms && 'text'].filter(Boolean);
        const when = v.at ? new Date(v.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
        return el('div', { className: 'inbox-item' }, [
          el('div', {}, [
            el('strong', { textContent: b ? b.name : `${v.name || 'Unknown'} (no longer a borrower)` }),
            el('div', { textContent: [v.email, v.phone].filter(Boolean).join(' · ') }),
            el('div', { className: 'sub', textContent: `${wants.length ? `Wants ${wants.join(' and ')} reminders` : 'No reminders chosen'} · sent ${when}` }),
          ]),
          el('div', { className: 'btn-row' }, [
            b ? el('button', { className: 'primary', textContent: 'Apply', onclick: () => finishInboxItem(item, true) }) : '',
            el('button', { textContent: 'Dismiss', onclick: () => finishInboxItem(item, false) }),
          ]),
        ]);
      })
    );
  }

  function renderNotifySetup() {
    const box = $('notifySetup');
    const topic = state.settings.inbox?.topic;
    if (!topic) return box.replaceChildren();
    const copyBtn = el('button', { type: 'button', textContent: 'Copy' });
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(topic);
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
      } catch {
        prompt('Copy this:', topic);
      }
    });
    box.replaceChildren(
      el('strong', { textContent: 'Get notified when a borrower sends their details: ' }),
      document.createTextNode('install the free ntfy app (App Store / Google Play), tap +, and subscribe to this topic. Keep it private.'),
      el('div', { className: 'btn-row' }, [el('code', { textContent: topic }), copyBtn]),
      el('div', { className: 'btn-row inbox-check' }, [
        el('button', { type: 'button', id: 'inboxCheck', textContent: 'Check for borrower updates', onclick: async (ev) => {
          const btn = ev.currentTarget;
          btn.disabled = true;
          btn.textContent = 'Checking…';
          await loadInbox().catch(() => {});
          btn.disabled = false;
          btn.textContent = inboxItems.length ? `${inboxItems.length} update${inboxItems.length === 1 ? '' : 's'} — see top of page` : 'No new updates';
          setTimeout(() => { btn.textContent = 'Check for borrower updates'; }, 3000);
          if (inboxItems.length) $('inboxCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
        } }),
      ]),
    );
  }

  $('inboxRefresh').addEventListener('click', () => loadInbox());
  // Check for new updates while the page is open.
  inboxTimer = setInterval(() => { if (state && !document.hidden) loadInbox(); }, 60000);

  // ---- New version check ---------------------------------------------
  //
  // This page is often left open for hours. If a newer version is published,
  // offer a reload so it doesn't keep running old code.

  async function checkForUpdate() {
    if (!LOADED_VERSION) return;
    try {
      const res = await fetch(`lend.html?check=${Date.now()}`, { cache: 'no-store' });
      const live = (await res.text()).match(/lend\.js\?v=([\w-]+)/)?.[1];
      if (live && live !== LOADED_VERSION) $('updateBanner').hidden = false;
    } catch {
      // Offline: try again later.
    }
  }

  $('reloadNow').addEventListener('click', async () => {
    await queue;
    if (saveFailed && !confirm('Your last change wasn’t saved. Reload anyway and lose it?')) return;
    location.reload();
  });
  setInterval(() => { if (!document.hidden) checkForUpdate(); }, 5 * 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForUpdate(); });
  checkForUpdate();
  document.addEventListener('visibilitychange', () => { if (state && !document.hidden) loadInbox(); });

  // ---- Start-up -------------------------------------------------------

  async function loadConfig() {
    const res = await fetch(`config.json?v=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error('config.json is missing');
    config = await res.json();
    $('repoName').textContent = config.repo;
    $('actionsLink').href = `https://github.com/${config.repo}/actions`;
  }

  async function connect(token) {
    gh = GitHub(config.repo, token);
    await gh.connect();
    const text = await gh.readText(OWNER_FILE);
    setupMode = text === null;
    $('unlockForm').dataset.file = text || '';
    $('unlockTitle').textContent = setupMode ? 'Choose a passphrase' : 'Unlock';
    $('unlockIntro').textContent = setupMode
      ? 'This passphrase encrypts all your loan records. Use at least 12 characters — a few random words works well. Write it down: if it’s lost, the data can’t be recovered.'
      : 'Enter your passphrase to open your loan records.';
    $('passphrase2').hidden = !setupMode;
    $('passphrase2').required = setupMode;
    $('unlockBtn').textContent = setupMode ? 'Create' : 'Unlock';
    show('unlockView');
    $('passphrase').focus();
  }

  $('connectForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    $('connectError').hidden = true;
    $('connectBtn').disabled = true;
    const token = $('token').value.trim();
    try {
      await connect(token);
      storage($('rememberToken').checked ? 'local' : 'session', token);
      $('token').value = '';
    } catch (err) {
      $('connectError').textContent = err.message;
      $('connectError').hidden = false;
    } finally {
      $('connectBtn').disabled = false;
    }
  });

  $('unlockForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const err = $('unlockError');
    err.hidden = true;
    const pass = $('passphrase').value;
    $('unlockBtn').disabled = true;
    try {
      if (setupMode) {
        if (pass.length < 12) throw new Error('Use at least 12 characters.');
        if (pass !== $('passphrase2').value) throw new Error('The two passphrases don’t match.');
        ownerSalt = Core.randomBytes(16);
        ownerKey = await Core.deriveOwnerKey(pass, ownerSalt);
        state = Core.emptyState();
      } else {
        const opened = await Core.openOwnerFile(JSON.parse($('unlockForm').dataset.file), pass);
        ({ data: state, key: ownerKey, salt: ownerSalt } = opened);
      }
      $('passphrase').value = '';
      $('passphrase2').value = '';
      show('mainView');
      render();
      const addedInbox = await ensureInbox();
      if (setupMode || addedInbox) {
        setupMode = false;
        render();
        persist();
      } else {
        setStatus('saved', 'All changes are saved.');
      }
      loadInbox();
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    } finally {
      $('unlockBtn').disabled = false;
    }
  });

  $('forgetToken').addEventListener('click', () => {
    storage('clear');
    gh = null;
    show('connectView');
  });

  $('lock').addEventListener('click', async () => {
    await queue;
    if (saveFailed && !confirm('Your last change wasn’t saved. Lock anyway and lose it?')) return;
    state = null;
    ownerKey = null;
    published.clear();
    derived.clear();
    location.reload();
  });

  $('addBorrower').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const name = $('borrowerName').value.trim().slice(0, 60);
    if (!name) return;
    let code = Core.generateCode();
    let exact = false;
    if ($('customCode').checked) {
      const chosen = askForCode(name, null);
      if (chosen === null) return;
      if (chosen) code = chosen;
      exact = Boolean(chosen);
    }
    const b = {
      id: Core.newId(),
      name,
      code,
      codeExact: exact,
      fileId: null,
      contact: { email: '', phone: '', notifyEmail: false, notifySms: false },
      createdAt: new Date().toISOString(),
    };
    openPanels.add(b.id);
    change(() => { state.borrowers.push(b); });
    $('borrowerName').value = '';
    showCode(b);
  });

  $('copyInvite').addEventListener('click', async () => {
    const text = `See your payment schedule and due dates at ${$('portalUrl').textContent}\nYour access code: ${$('codeValue').textContent}`;
    try {
      await navigator.clipboard.writeText(text);
      $('copyInvite').textContent = 'Copied!';
      setTimeout(() => { $('copyInvite').textContent = 'Copy invite'; }, 1500);
    } catch {
      prompt('Copy this:', text);
    }
  });

  $('dismissCode').addEventListener('click', () => {
    $('codeBanner').hidden = true;
    $('codeValue').textContent = '';
  });

  $('settingsForm').addEventListener('submit', (ev) => {
    ev.preventDefault();
    change(() => {
      const currency = $('currencyCode').value.trim().toUpperCase();
      const days = Number($('reminderDays').value);
      if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Currency must be a 3-letter code, like USD');
      if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error('Reminder days must be between 1 and 30');
      Object.assign(state.settings, { ownerName: $('ownerName').value.trim().slice(0, 40), currency, reminderDays: days });
    });
    document.activeElement.blur();
  });

  $('downloadBackup').addEventListener('click', () => {
    if (!confirm('The backup is NOT encrypted: it contains names, amounts and access codes. Keep it somewhere private.')) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }));
    const a = el('a', { href: url, download: `money-lent-backup-${Core.todayISO()}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  window.addEventListener('beforeunload', (ev) => {
    if (saveFailed || $('saveStatus').classList.contains('saving')) ev.preventDefault();
  });

  (async () => {
    try {
      await loadConfig();
    } catch (err) {
      show('connectView');
      $('connectError').textContent = `This site isn’t set up yet: ${err.message}.`;
      $('connectError').hidden = false;
      return;
    }
    const token = storage('get');
    if (!token) return show('connectView');
    try {
      await connect(token);
    } catch (err) {
      show('connectView');
      $('connectError').textContent = err.message;
      $('connectError').hidden = false;
    }
  })();
})();
