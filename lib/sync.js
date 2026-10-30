// Keeps Expenses and Bills the same on every device.
//
// The pages keep working from this device's storage as before. This adds a
// bar at the top of the page; once it's unlocked with the Money lent
// passphrase, the data is merged with an encrypted copy in the site repo
// (data/money.json) after every change and whenever the page is reopened.
(() => {
  'use strict';

  const EXPENSES_KEY = 'expense-tracker:v1';
  const BILLS_KEY = 'tracking-bills:v1';
  // This device's copy as of the last sync, for three-way merging.
  const BASE_KEY = 'balance:sync-base';
  const FILE = 'data/money.json';
  const OWNER_FILE = 'data/owner.json';
  const COMMIT_MESSAGE = 'Update encrypted data';

  let gh = null;
  let pass = null;
  let fileKey = null; // { key, salt } for FILE
  let queue = Promise.resolve();
  let timer = null;
  let lastSynced = null;

  // ---- Storage ----------------------------------------------------------

  function readKey(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function writeKey(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Full or blocked: the next sync tries again.
    }
  }

  const localText = () => {
    try {
      return `${localStorage.getItem(EXPENSES_KEY)}\n${localStorage.getItem(BILLS_KEY)}`;
    } catch {
      return '';
    }
  };

  // Put merged data on this device and let the page redraw.
  function applyLocal(merged, local) {
    for (const [key, value, before] of [[EXPENSES_KEY, merged.expenses, local.expenses], [BILLS_KEY, merged.bills, local.bills]]) {
      if (!value || MoneyMerge.same(value, before)) continue;
      writeKey(key, value);
      window.dispatchEvent(new StorageEvent('storage', { key }));
    }
  }

  // ---- The bar ------------------------------------------------------------

  const bar = document.createElement('section');
  bar.className = 'sync-bar';
  bar.setAttribute('role', 'status');
  document.querySelector('main').prepend(bar);

  function el(tag, props = {}, children = []) {
    const node = Object.assign(document.createElement(tag), props);
    for (const c of [].concat(children)) if (c !== null && c !== undefined && c !== '') node.append(c);
    return node;
  }

  function show(kind, text, extra = []) {
    bar.className = `sync-bar is-${kind}`;
    bar.replaceChildren(el('span', { className: 'sync-text', textContent: text }), ...extra);
  }

  function timeLabel(d) {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  function showSynced() {
    const remembered = Account.passphrase('remembered');
    show('synced', `Synced across your devices · ${timeLabel(lastSynced)}`, [
      el('button', { type: 'button', className: 'linkish', textContent: 'Sync now', onclick: () => syncSoon(0) }),
      remembered
        ? el('button', {
          type: 'button',
          className: 'linkish',
          textContent: 'Forget passphrase',
          title: 'Stop remembering the passphrase on this device',
          onclick: () => {
            Account.passphrase('clear');
            pass = null;
            fileKey = null;
            showLocked('Passphrase forgotten on this device.');
          },
        })
        : '',
    ]);
  }

  // Form for the GitHub key (if this device has none) and the passphrase.
  function unlockForm(needToken) {
    const token = el('input', { type: 'password', placeholder: 'GitHub key (github_pat_…)', autocomplete: 'off', spellcheck: false });
    token.setAttribute('aria-label', 'GitHub key');
    const passIn = el('input', { type: 'password', placeholder: 'Passphrase', autocomplete: 'current-password', required: true });
    passIn.setAttribute('aria-label', 'Passphrase');
    const remember = el('input', { type: 'checkbox' });
    const error = el('p', { className: 'error', hidden: true });
    const btn = el('button', { type: 'submit', className: 'primary', textContent: 'Sync' });
    const label = btn.textContent;
    const form = el('form', { className: 'sync-form', autocomplete: 'off' }, [
      needToken ? token : '',
      passIn,
      el('label', { className: 'check' }, [remember, ' Remember passphrase on this device']),
      btn,
      error,
    ]);
    if (needToken) token.required = true;
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      error.hidden = true;
      btn.disabled = true;
      btn.textContent = 'Checking…';
      try {
        if (needToken) {
          const t = token.value.trim();
          await connect(t);
          Account.token('local', t);
        }
        await unlock(passIn.value, remember.checked);
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
      } finally {
        btn.disabled = false;
        btn.textContent = label;
      }
    });
    return form;
  }

  function showOff() {
    show('off', 'Saved on this device only.', [
      el('button', {
        type: 'button',
        className: 'linkish',
        textContent: 'Sync across devices',
        onclick: () => show('off', 'Use the GitHub key and passphrase from your Money lent page.', [unlockForm(true)]),
      }),
    ]);
  }

  function showLocked(note) {
    show('locked', note || 'Sync is paused on this device. Enter your passphrase to sync.', [unlockForm(false)]);
  }

  function showError(err) {
    show('error', `Not synced: ${err.message}`, [
      el('button', { type: 'button', textContent: 'Try again', onclick: () => syncSoon(0) }),
    ]);
  }

  // ---- Sync -------------------------------------------------------------

  async function connect(token) {
    const config = await Account.loadConfig();
    const g = Account.GitHub(config.repo, token);
    await g.connect();
    gh = g;
  }

  // Throws if the passphrase is wrong; the caller says so.
  async function unlock(p, remember) {
    const text = await gh.readText(FILE);
    if (text) {
      const opened = await Core.openOwnerFile(JSON.parse(text), p);
      fileKey = { key: opened.key, salt: opened.salt };
    } else {
      // First sync anywhere: check the passphrase against the Money lent data.
      const owner = await gh.readText(OWNER_FILE);
      if (!owner) throw new Error('Set up your Money lent page first; sync uses the same passphrase.');
      await Core.openOwnerFile(JSON.parse(owner), p);
      const salt = Core.randomBytes(16);
      fileKey = { key: await Core.deriveOwnerKey(p, salt), salt };
    }
    pass = p;
    if (remember !== undefined) Account.passphrase(remember ? 'local' : 'session', p);
    await syncSoon(0);
  }

  async function readRemote() {
    const text = await gh.readText(FILE);
    if (!text) return null;
    const file = JSON.parse(text);
    if (!fileKey || file.salt !== Core.toB64(fileKey.salt)) {
      const opened = await Core.openOwnerFile(file, pass);
      fileKey = { key: opened.key, salt: opened.salt };
      return opened.data;
    }
    return Core.decryptJson(fileKey.key, file);
  }

  async function syncOnce() {
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = localText();
      const local = { expenses: readKey(EXPENSES_KEY), bills: readKey(BILLS_KEY) };
      const remote = await readRemote();
      const merged = MoneyMerge.merge(readKey(BASE_KEY), local, remote);
      // Changed here while we were fetching: start over with the new data.
      if (localText() !== before) continue;
      applyLocal(merged, local);
      if (!remote || !MoneyMerge.same(merged, remote)) {
        try {
          await gh.commit(COMMIT_MESSAGE, [[FILE, JSON.stringify(await Core.sealOwnerFile(merged, fileKey.key, fileKey.salt))]]);
        } catch (err) {
          if (err.conflict) continue; // another save landed first: merge again
          throw err;
        }
      }
      writeKey(BASE_KEY, merged);
      return;
    }
    throw new Error('Too many changes at once. Try again.');
  }

  function syncSoon(delay = 1200) {
    if (!gh || !pass) return Promise.resolve();
    clearTimeout(timer);
    return new Promise((resolve) => {
      timer = setTimeout(() => {
        show('syncing', 'Syncing…');
        queue = queue
          .then(syncOnce)
          .then(() => {
            lastSynced = new Date();
            showSynced();
          })
          .catch(showError)
          .then(resolve);
      }, delay);
    });
  }

  // The pages call this after saving.
  // `flush` syncs now and resolves when done (used by tests).
  window.BalanceSync = { changed: () => syncSoon(), flush: () => syncSoon(0) };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncSoon(0);
  });

  (async () => {
    const token = Account.token('get');
    if (!token) return showOff();
    show('syncing', 'Connecting…');
    try {
      await connect(token);
    } catch (err) {
      // Key expired or removed: ask for a new one.
      return show('error', `Not synced: ${err.message}`, [unlockForm(true)]);
    }
    const saved = Account.passphrase('get');
    if (!saved) return showLocked();
    show('syncing', 'Syncing…');
    try {
      await unlock(saved);
    } catch (err) {
      // Only forget it when it's actually wrong, not when offline.
      if (err.message === 'Wrong passphrase') {
        Account.passphrase('clear');
        showLocked('The saved passphrase didn’t work. Enter it again to sync.');
      } else {
        showError(err);
      }
    }
  })();
})();
