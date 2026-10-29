(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
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

  async function derive(code) {
    if (!derived.has(code)) derived.set(code, await Core.deriveBorrower(code, config.siteSalt));
    return derived.get(code);
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
      const d = await derive(b.code);
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
    files.push([OWNER_FILE, JSON.stringify(await Core.sealOwnerFile(state, ownerKey, ownerSalt))]);

    await gh.commit(COMMIT_MESSAGE, files);

    for (const [id, text] of written) published.set(id, text);
    for (const id of deletes) {
      pendingDeletes.delete(id);
      published.delete(id);
    }
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

  function render() {
    const today = Core.todayISO();
    const rows = state.borrowers.map((b) => {
      const installments = Core.installmentsFor(state, b.id, today);
      return { b, installments, totals: Core.totals(installments) };
    });

    const sum = (k) => rows.reduce((s, r) => s + r.totals[k], 0);
    $('sumRemaining').textContent = money(sum('remaining'));
    $('sumOverdue').textContent = money(sum('overdue'));
    $('sumOverdue').classList.toggle('danger', sum('overdue') > 0);
    $('sumPaid').textContent = money(sum('paid'));
    $('sumBorrowers').textContent = rows.length;

    $('borrowers').replaceChildren(...rows.map(borrowerCard));
    $('borrowersEmpty').hidden = rows.length > 0;

    if (document.activeElement?.form !== $('settingsForm')) {
      $('ownerName').value = state.settings.ownerName;
      $('currencyCode').value = state.settings.currency;
      $('reminderDays').value = state.settings.reminderDays;
    }
  }

  function borrowerCard({ b, installments, totals: t }) {
    const c = b.contact;
    const reminders = [c.notifyEmail && `email ${c.email}`, c.notifySms && `text ${c.phone}`].filter(Boolean);
    const summary = [
      `${money(t.remaining)} outstanding`,
      t.overdue > 0 ? `${money(t.overdue)} overdue` : null,
      t.nextDue ? `next ${money(t.nextDue.remaining)} on ${dateLabel(t.nextDue.dueDate)}` : 'nothing due',
    ].filter(Boolean).join(' · ');

    const details = el('details', { open: openPanels.has(b.id) }, [
      el('summary', { textContent: `Payments & reminders (${installments.length})` }),
      scheduleForm(b),
      installmentForm(b),
      installmentTable(installments),
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
        el('div', { className: 'btn-row' }, [
          el('button', { textContent: 'Show code', onclick: () => showCode(b) }),
          el('button', { textContent: 'New code', onclick: () => newCode(b) }),
          el('button', { textContent: 'Rename', onclick: () => rename(b) }),
          el('button', { className: 'danger', textContent: 'Delete', onclick: () => removeBorrower(b) }),
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
    const count = el('input', { type: 'number', min: '1', max: '120', value: '1', required: true });
    const frequency = el('select', {}, Object.entries(Core.FREQUENCIES).map(([value, label]) => el('option', { value, textContent: label })));
    const first = el('input', { type: 'date', value: Core.todayISO(), required: true });
    const note = el('input', { maxLength: 100, placeholder: 'e.g. Car repair', className: 'grow' });
    const preview = el('div', { className: 'hint schedule-preview' });

    // Show what the schedule will look like before it's added.
    function updatePreview() {
      const amount = Number(total.value);
      const n = Number(count.value);
      if (!(amount > 0) || !Number.isInteger(n) || n < 1 || n > 120 || !Core.isValidISO(first.value)) {
        preview.textContent = '';
        return;
      }
      const items = Core.splitSchedule(amount, n, first.value, '', frequency.value);
      const shown = items.slice(0, 4).map((p) => `${dateLabel(p.dueDate)}: ${money(p.amount)}`);
      if (items.length > 4) shown.push(`… last on ${dateLabel(items[items.length - 1].dueDate)}`);
      preview.textContent = `${n} payment${n === 1 ? '' : 's'} — ${shown.join(' · ')}`;
    }
    for (const input of [total, count, frequency, first]) input.addEventListener('input', updatePreview);

    const form = el('form', { className: 'inline-form' }, [
      field('Amount lent', total),
      field('Number of payments', count),
      field('How often', frequency),
      field('First due date', first),
      field('Note', note),
      el('button', { type: 'submit', className: 'primary', textContent: 'Add loan' }),
    ]);
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      openPanels.add(b.id);
      change(() => {
        const amount = Core.money(total.value, 'Amount');
        const n = Number(count.value);
        if (amount <= 0) throw new Error('Amount must be more than zero');
        if (!Number.isInteger(n) || n < 1 || n > 120) throw new Error('Number of payments must be between 1 and 120');
        if (!Core.isValidISO(first.value)) throw new Error('Pick a first due date');
        for (const p of Core.splitSchedule(amount, n, first.value, note.value.trim().slice(0, 100), frequency.value)) {
          state.installments.push({ id: Core.newId(), borrowerId: b.id, paid: 0, ...p });
        }
      });
    });
    return el('div', {}, [el('div', { className: 'hint', textContent: 'New loan, split into equal payments:' }), form, preview]);
  }

  function installmentForm(b) {
    const amount = el('input', { type: 'number', min: '0.01', step: '0.01', required: true });
    const due = el('input', { type: 'date', value: Core.todayISO(), required: true });
    const note = el('input', { maxLength: 120, className: 'grow' });
    const form = el('form', { className: 'inline-form' }, [
      field('Amount', amount),
      field('Due date', due),
      field('Note', note),
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

  function installmentTable(items) {
    if (!items.length) return el('p', { className: 'empty', textContent: 'No payments yet.' });
    const head = el('tr', {}, ['Due', 'Note', 'Amount', 'Paid', 'Left', 'Status', ''].map((h, i) =>
      el('th', { className: i >= 2 && i <= 4 ? 'num' : '', textContent: h })));
    const rows = items.map((i) =>
      el('tr', {}, [
        el('td', { textContent: dateLabel(i.dueDate) }),
        el('td', { textContent: i.note }),
        el('td', { className: 'num', textContent: money(i.amount) }),
        el('td', { className: 'num', textContent: money(i.paid) }),
        el('td', { className: 'num', textContent: money(i.remaining) }),
        el('td', {}, [el('span', { className: `badge ${i.status}`, textContent: STATUS_LABEL[i.status] })]),
        el('td', {}, [
          el('div', { className: 'btn-row' }, [
            i.remaining > 0
              ? el('button', { textContent: 'Mark paid', onclick: () => change(() => { findInstallment(i.id).paid = i.amount; }) })
              : el('button', { textContent: 'Undo paid', onclick: () => change(() => { findInstallment(i.id).paid = 0; }) }),
            el('button', { textContent: 'Record payment', hidden: i.remaining <= 0, onclick: () => recordPayment(i) }),
            el('button', { textContent: 'Edit', onclick: () => editInstallment(i) }),
            el('button', { className: 'danger', textContent: 'Delete', onclick: () => {
              if (confirm(`Delete the ${money(i.amount)} payment due ${dateLabel(i.dueDate)}?`)) {
                change(() => { state.installments = state.installments.filter((x) => x.id !== i.id); });
              }
            } }),
          ]),
        ]),
      ])
    );
    return el('div', { className: 'table-wrap' }, [el('table', {}, [el('thead', {}, [head]), el('tbody', {}, rows)])]);
  }

  function contactForm(b) {
    const c = b.contact;
    const email = el('input', { type: 'email', maxLength: 254, value: c.email, placeholder: 'name@example.com', className: 'grow' });
    const phone = el('input', { type: 'tel', maxLength: 20, value: c.phone, placeholder: '+15551234567' });
    const byEmail = el('input', { type: 'checkbox', checked: c.notifyEmail });
    const bySms = el('input', { type: 'checkbox', checked: c.notifySms });
    const form = el('form', { className: 'inline-form' }, [
      field('Their email', email),
      field('Their phone (with country code)', phone),
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
    return el('div', { className: 'contact-block' }, [el('div', { className: 'hint', textContent: 'Reminders (borrowers send you their details):' }), form]);
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

  function newCode(b) {
    if (!confirm(`Create a new code for ${b.name}? Their old code will stop working.`)) return;
    change(() => {
      if (b.fileId) pendingDeletes.add(b.fileId);
      b.code = Core.generateCode();
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
    const note = prompt('Note', i.note);
    if (note === null) return;
    change(() => {
      const a = Core.money(amount, 'Amount');
      if (a <= 0) throw new Error('Amount must be more than zero');
      if (!Core.isValidISO(dueDate)) throw new Error('Due date must look like 2026-12-31');
      const inst = findInstallment(i.id);
      Object.assign(inst, { amount: a, dueDate, note: note.trim().slice(0, 120), paid: Math.min(inst.paid, a) });
    });
  }

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
      if (setupMode) {
        setupMode = false;
        persist();
      } else {
        setStatus('saved', 'All changes are saved.');
      }
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
    const b = {
      id: Core.newId(),
      name,
      code: Core.generateCode(),
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
    const text = `See what you owe and when it's due at ${$('portalUrl').textContent}\nYour access code: ${$('codeValue').textContent}`;
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
      state.settings = { ownerName: $('ownerName').value.trim().slice(0, 40), currency, reminderDays: days };
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
