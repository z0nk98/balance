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
  // Long, distinctive strings only: short ones like "Jo" turn up in random ciphertext.
  const sealed = JSON.stringify(file);
  for (const secret of ['jo@example.com', '+15551234567', state.borrowers[0].code]) assert.ok(!sealed.includes(secret), secret);
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

test('loan names come from notes and can be renamed keeping the part number', () => {
  assert.strictEqual(Core.loanName('Phone – 2/6'), 'Phone');
  assert.strictEqual(Core.loanName('Car repair'), 'Car repair');
  assert.strictEqual(Core.loanName('3/4'), 'Other');
  assert.strictEqual(Core.loanName(''), 'Other');
  assert.strictEqual(Core.renameLoanNote('Phone – 2/6', 'iPhone 15'), 'iPhone 15 – 2/6');
  assert.strictEqual(Core.renameLoanNote('3/4', 'Laptop'), 'Laptop – 3/4');
  assert.strictEqual(Core.renameLoanNote('Car repair', 'Car'), 'Car');
  assert.strictEqual(Core.renameLoanNote('Phone – 2/6', ''), '2/6');
  assert.strictEqual(Core.renameLoanNote('', 'Laptop'), 'Laptop');
  // Extra words after the part number stay with the same loan.
  assert.strictEqual(Core.loanName('Phone – 2/6 (paid late)'), 'Phone');
  assert.strictEqual(Core.renameLoanNote('Phone – 2/6 (paid late)', 'iPhone'), 'iPhone – 2/6 (paid late)');
});

test('due-soon total counts unpaid payments within the reminder window', () => {
  const s = sampleState(); // reminderDays = 3
  s.installments.push(
    { id: 'a', borrowerId: 'b1', amount: 100, paid: 0, dueDate: shift(0), note: '' },
    { id: 'b', borrowerId: 'b1', amount: 50, paid: 20, dueDate: shift(3), note: '' },
    { id: 'c', borrowerId: 'b1', amount: 70, paid: 0, dueDate: shift(4), note: '' },
    { id: 'd', borrowerId: 'b1', amount: 40, paid: 0, dueDate: shift(-1), note: '' },
    { id: 'e', borrowerId: 'b1', amount: 60, paid: 60, dueDate: shift(1), note: '' },
  );
  const t = Core.totals(Core.installmentsFor(s, 'b1'));
  assert.strictEqual(t.dueSoon, 130);
  assert.strictEqual(t.overdue, 40);
});

test('pages load the current version of every script and stylesheet', () => {
  const { run } = require('../scripts/stamp');
  const { stale } = run({ check: true });
  assert.deepStrictEqual(stale, [], 'run `node scripts/stamp.js` after changing a .js or .css file');
});

test('payment methods are validated and shared only inside borrower files', () => {
  assert.deepStrictEqual(
    Core.cleanPaymentMethod({ kind: 'gcash', accountName: ' Juan D. ', accountNumber: '0917 123 4567' }),
    { kind: 'gcash', label: 'GCash', accountName: 'Juan D.', accountNumber: '0917 123 4567', details: '' },
  );
  assert.strictEqual(Core.cleanPaymentMethod({ kind: 'weird', details: 'PayPal me' }).kind, 'other');
  assert.strictEqual(Core.cleanPaymentMethod({ kind: 'cash' }).label, 'Cash');
  assert.throws(() => Core.cleanPaymentMethod({ kind: 'bank', label: 'BDO' }), /account number/);

  const s = sampleState();
  s.settings.paymentMethods = [{ id: 'p1', ...Core.cleanPaymentMethod({ kind: 'maya', accountNumber: '0918 000 0000' }) }];
  const p = Core.borrowerPayload(s, s.borrowers[0]);
  assert.deepStrictEqual(p.paymentMethods, [{ kind: 'maya', label: 'Maya', accountName: '', accountNumber: '0918 000 0000', details: '' }]);
  // Older data without the field still works.
  delete s.settings.paymentMethods;
  assert.deepStrictEqual(Core.borrowerPayload(s, s.borrowers[0]).paymentMethods, []);
});

test('QR codes: shared key is sent to borrowers only when a method has one', async () => {
  const s = sampleState();
  s.settings.paymentsKey = Core.newSharedKey();
  s.settings.paymentMethods = [{ id: 'p1', ...Core.cleanPaymentMethod({ kind: 'maya', hasQr: true }) }];
  assert.strictEqual(Core.borrowerPayload(s, s.borrowers[0]).paymentsKey, undefined);
  s.settings.paymentMethods[0].qrFile = 'abc';
  const p = Core.borrowerPayload(s, s.borrowers[0]);
  assert.strictEqual(p.paymentsKey, s.settings.paymentsKey);
  assert.strictEqual(p.paymentMethods[0].qrFile, 'abc');

  // A borrower can open a QR file with the key from their payload.
  const key = await Core.importSharedKey(p.paymentsKey);
  const file = await Core.encryptJson(key, { type: 'image/png', data: 'iVBORw0KGgo=' });
  assert.deepStrictEqual(await Core.decryptJson(await Core.importSharedKey(s.settings.paymentsKey), file), { type: 'image/png', data: 'iVBORw0KGgo=' });
});

test('borrower updates: encrypted to the owner, validated, local PH numbers accepted', async () => {
  assert.strictEqual(Core.cleanPhone('0917 123 4567'), '+639171234567');
  assert.strictEqual(Core.cleanPhone('+63 917-123-4567'), '+639171234567');
  assert.throws(() => Core.cleanPhone('12345'), /country code/);
  assert.throws(() => Core.cleanContactUpdate({}), /email address or a phone/);
  assert.throws(() => Core.cleanContactUpdate({ phone: '09171234567', notifyEmail: true }), /email address/);
  assert.deepStrictEqual(Core.cleanContactUpdate({ email: ' jo@example.com ', phone: '09171234567', notifySms: 1 }),
    { email: 'jo@example.com', phone: '+639171234567', notifyEmail: false, notifySms: true });

  const inbox = await Core.newInbox();
  const s = sampleState();
  s.settings.inbox = inbox;
  const p = Core.borrowerPayload(s, s.borrowers[0]);
  assert.strictEqual(p.id, 'b1');
  assert.deepStrictEqual(p.inbox, { topic: inbox.topic, publicKey: inbox.publicKey });
  assert.ok(!JSON.stringify(p).includes(inbox.privateKey.d), 'private key never leaves the owner');

  const text = await Core.sealForOwner(p.inbox.publicKey, { type: 'contact', borrowerId: 'b1', email: 'jo@example.com' });
  assert.ok(!text.includes('jo@example.com'));
  assert.ok(text.length < 4096, 'fits in one ntfy message');
  assert.deepStrictEqual(await Core.openFromBorrower(inbox.privateKey, text), { type: 'contact', borrowerId: 'b1', email: 'jo@example.com' });
  assert.strictEqual(await Core.openFromBorrower((await Core.newInbox()).privateKey, text), null);
  assert.strictEqual(await Core.openFromBorrower(inbox.privateKey, 'hello'), null);
});

test('inbox job saves only new encrypted messages', () => {
  const { newMessages } = require('../scripts/inbox');
  const msgs = [
    { event: 'open', id: 'x' },
    { event: 'message', id: 'a1', message: 'hi\n\nENC:abc' },
    { event: 'message', id: 'a2', message: 'ENC:def' },
    { event: 'message', id: 'a3', message: 'spam without payload' },
    { event: 'message', id: '../evil', message: 'ENC:x' },
    { event: 'message', id: 'a4', message: 'ENC:ghi' },
  ];
  const fresh = newMessages(msgs, { done: new Set(['a2']), saved: new Set(['a4']) });
  assert.deepStrictEqual(fresh.map((m) => m.id), ['a1']);
});

test('note search matches every word, in any order and case', () => {
  const i = { status: 'upcoming', note: 'Car repair – 2/3 (paid late)', dueDate: '2026-11-30' };
  assert.ok(Core.matchesFilter(i, { text: 'repair' }));
  assert.ok(Core.matchesFilter(i, { text: '  LATE car ' }));
  assert.ok(Core.matchesFilter(i, { text: '2/3' }));
  assert.ok(!Core.matchesFilter(i, { text: 'phone' }));
  assert.ok(!Core.matchesFilter(i, { text: 'car phone' }));
  assert.ok(!Core.matchesFilter(i, { text: 'repair', status: 'paid' }), 'combines with other filters');
  assert.ok(!Core.matchesFilter({ status: 'upcoming', note: '', dueDate: '2026-11-30' }, { text: 'x' }));
});
