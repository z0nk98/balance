'use strict';

// Saves borrower updates from ntfy.sh into data/inbox/, run hourly by
// .github/workflows/inbox.yml. ntfy only keeps messages for about 12 hours;
// saved copies wait in the repo until the owner applies or dismisses them.
//
// Messages are stored exactly as received (still encrypted). Like the
// reminder script, this prints only counts because workflow logs are public.

const fs = require('node:fs');
const path = require('node:path');
const Core = require('../lib/core');

const ROOT = path.join(__dirname, '..');
const OWNER_FILE = path.join(ROOT, 'data', 'owner.json');
const INBOX_DIR = path.join(ROOT, 'data', 'inbox');

// Which ntfy messages still need saving.
function newMessages(messages, { done, saved }) {
  return messages.filter((m) =>
    m.event === 'message' &&
    /^[\w-]{1,64}$/.test(m.id) &&
    typeof m.message === 'string' &&
    m.message.includes('ENC:') &&
    !done.has(m.id) &&
    !saved.has(m.id));
}

async function fetchMessages(topic) {
  const res = await fetch(`${Core.NTFY}/${encodeURIComponent(topic)}/json?poll=1&since=all`);
  if (!res.ok) throw new Error(`ntfy returned ${res.status}`);
  return (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function main(env = process.env) {
  if (!fs.existsSync(OWNER_FILE)) return console.log('No data yet; nothing to do.');
  if (!env.OWNER_PASSPHRASE) {
    return console.log('OWNER_PASSPHRASE secret is not set; borrower updates are only kept by ntfy for about 12 hours.');
  }
  const { data: state } = await Core.openOwnerFile(JSON.parse(fs.readFileSync(OWNER_FILE, 'utf8')), env.OWNER_PASSPHRASE);
  if (!state.settings.inbox) return console.log('Inbox not set up yet; open the owner page once.');

  const saved = new Set(fs.existsSync(INBOX_DIR) ? fs.readdirSync(INBOX_DIR).map((f) => f.replace(/\.json$/, '')) : []);
  const fresh = newMessages(await fetchMessages(state.settings.inbox.topic), { done: new Set(state.inboxDone || []), saved });

  if (fresh.length) fs.mkdirSync(INBOX_DIR, { recursive: true });
  for (const m of fresh) {
    fs.writeFileSync(path.join(INBOX_DIR, `${m.id}.json`), JSON.stringify({ id: m.id, time: m.time, message: m.message }));
  }
  console.log(`Saved ${fresh.length} new borrower update${fresh.length === 1 ? '' : 's'}.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.log(`Saving borrower updates failed: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { newMessages };
