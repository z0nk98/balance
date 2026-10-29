'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Core = require('../lib/core');
const { dueReminders, portalUrl } = require('../scripts/remind');

function shift(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function sampleState() {
  const s = Core.emptyState();
  s.settings.ownerName = 'Morgan';
  s.borrowers.push({
    id: 'b1',
    name: 'Jo',
    code: Core.generateCode(),
    contact: { email: 'jo@example.com', phone: '+15551234567', notifyEmail: true, notifySms: false },
  });
  return s;
}

test('codes are 12 unambiguous characters and normalize loosely', () => {
  const code = Core.generateCode();
  assert.match(code, /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
  assert.ok(Core.isWellFormedCode(code.toLowerCase().replace(/-/g, ' ')));
  assert.ok(!Core.isWellFormedCode('ABCD-EFGH'));
  assert.ok(!Core.isWellFormedCode('ABCD-EFGH-IJK0'), '0 and I are not in the alphabet');
});

test('borrower key/file id depend on both the code and the site salt', async () => {
  const code = Core.generateCode();
  const a = await Core.deriveBorrower(code, 'salt-1');
  const b = await Core.deriveBorrower(code.toLowerCase(), 'salt-1');
  const c = await Core.deriveBorrower(code, 'salt-2');
  assert.strictEqual(a.fileId, b.fileId);
  assert.notStrictEqual(a.fileId, c.fileId);
  assert.match(a.fileId, /^[0-9a-f]{32}$/);

  const file = await Core.encryptJson(a.key, { hello: 'world' });
  assert.ok(!JSON.stringify(file).includes('world'));
  assert.deepStrictEqual(await Core.decryptJson(b.key, file), { hello: 'world' });
  await assert.rejects(Core.decryptJson(c.key, file));
});

test('owner file round-trips and rejects a wrong passphrase', async () => {
  const salt = Core.randomBytes(16);
  const key = await Core.deriveOwnerKey('correct horse battery', salt);
  const state = sampleState();
  const file = await Core.sealOwnerFile(state, key, salt);
  assert.ok(!JSON.stringify(file).includes('Jo'));
  const opened = await Core.openOwnerFile(file, 'correct horse battery');
  assert.deepStrictEqual(opened.data, state);
  await assert.rejects(Core.openOwnerFile(file, 'wrong passphrase!'), /Wrong passphrase/);
});

test('borrower payload holds only their own data, with masked contacts', () => {
  const s = sampleState();
  s.borrowers.push({ id: 'b2', name: 'Other', code: 'X', contact: { email: '', phone: '', notifyEmail: false, notifySms: false } });
  s.installments.push(
    { id: 'i1', borrowerId: 'b1', amount: 10, paid: 0, dueDate: '2026-11-01', note: '' },
    { id: 'i2', borrowerId: 'b2', amount: 99, paid: 0, dueDate: '2026-11-01', note: 'secret' },
  );
  const p = Core.borrowerPayload(s, s.borrowers[0]);
  assert.strictEqual(p.installments.length, 1);
  assert.deepStrictEqual(p.reminders, ['email to j•••@example.com']);
  const text = JSON.stringify(p);
  for (const leak of ['secret', 'Other', 'jo@example.com', '+1555', s.borrowers[0].code]) assert.ok(!text.includes(leak), leak);
});

test('schedule splits evenly with rounding on the last payment', () => {
  const items = Core.splitSchedule(100, 3, '2026-01-31', 'Laptop');
  assert.deepStrictEqual(items.map((i) => i.amount), [33.33, 33.33, 33.34]);
  assert.deepStrictEqual(items.map((i) => i.dueDate), ['2026-01-31', '2026-02-28', '2026-03-31']);
  assert.strictEqual(items[2].note, 'Laptop – 3/3');
});

test('status and totals', () => {
  const s = sampleState();
  s.installments.push(
    { id: 'a', borrowerId: 'b1', amount: 50, paid: 10, dueDate: shift(-2), note: '' },
    { id: 'b', borrowerId: 'b1', amount: 20, paid: 0, dueDate: shift(1), note: '' },
    { id: 'c', borrowerId: 'b1', amount: 30, paid: 0, dueDate: shift(40), note: '' },
  );
  const items = Core.installmentsFor(s, 'b1');
  assert.deepStrictEqual(items.map((i) => i.status), ['overdue', 'due-soon', 'upcoming']);
  const t = Core.totals(items);
  assert.strictEqual(t.remaining, 90);
  assert.strictEqual(t.overdue, 40);
});

test('reminders fire on exactly the right days, only for opted-in channels', () => {
  const s = sampleState();
  for (const [id, d] of [['soon', 3], ['early', 4], ['today', 0], ['late', -1], ['later', -2]]) {
    s.installments.push({ id, borrowerId: 'b1', amount: 25, paid: 0, dueDate: shift(d), note: '' });
  }
  s.installments.push({ id: 'paid', borrowerId: 'b1', amount: 25, paid: 25, dueDate: shift(0), note: '' });

  const out = dueReminders(s, Core.todayISO(), 'https://x.github.io/balance/borrow.html');
  assert.strictEqual(out.length, 3);
  assert.ok(out.every((r) => r.channel === 'email' && r.to === 'jo@example.com'));
  const bodies = out.map((r) => r.body).join('\n');
  assert.match(bodies, /Hi Jo, a payment of \$25\.00 to Morgan is due on .* \(in 3 days\)/);
  assert.match(bodies, /is due today/);
  assert.match(bodies, /overdue/);
  assert.match(bodies, /See your balance: https:\/\/x\.github\.io\/balance\/borrow\.html/);
});

test('portal URL comes from the repository name', () => {
  assert.strictEqual(portalUrl({ GITHUB_REPOSITORY: 'Z0nk98/balance' }), 'https://z0nk98.github.io/balance/borrow.html');
  assert.strictEqual(portalUrl({ PUBLIC_URL: 'https://example.com/b' }), 'https://example.com/b');
});

test('payment frequencies', () => {
  const dates = (first, n, f) => Core.splitSchedule(100, n, first, '', f).map((p) => p.dueDate);
  // Twice a month from the 15th: 15th and 30th, clamped to month end in February.
  assert.deepStrictEqual(dates('2027-01-15', 5, 'semimonthly'), ['2027-01-15', '2027-01-30', '2027-02-15', '2027-02-28', '2027-03-15']);
  // Starting at month end pairs with the 15th.
  assert.deepStrictEqual(dates('2026-11-30', 3, 'semimonthly'), ['2026-11-30', '2026-12-15', '2026-12-30']);
  // Starting on the 5th: 5th and 20th.
  assert.deepStrictEqual(dates('2026-11-05', 3, 'semimonthly'), ['2026-11-05', '2026-11-20', '2026-12-05']);
  assert.deepStrictEqual(dates('2026-12-24', 3, 'biweekly'), ['2026-12-24', '2027-01-07', '2027-01-21']);
  assert.deepStrictEqual(dates('2026-12-31', 3, 'bimonthly'), ['2026-12-31', '2027-02-28', '2027-04-30']);
  assert.deepStrictEqual(dates('2026-01-31', 2, undefined), ['2026-01-31', '2026-02-28'], 'monthly is the default');
  const six = Core.splitSchedule(1000, 6, '2026-11-15', 'Phone', 'semimonthly');
  assert.deepStrictEqual(six.map((p) => p.amount), [166.66, 166.66, 166.66, 166.66, 166.66, 166.7]);
  assert.strictEqual(six[5].note, 'Phone – 6/6');
});
