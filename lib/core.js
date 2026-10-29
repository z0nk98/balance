// Shared logic for the browser pages and the reminder script (Node 18+).
// In the browser it defines `window.Core`; in Node it is a CommonJS module.
//
// Encryption: AES-256-GCM with keys from PBKDF2-SHA256 (600,000 rounds).
// - Owner data is encrypted with the owner's passphrase.
// - Each borrower's data is encrypted with a key derived from their access
//   code. The same derivation gives the file name, so the code alone is
//   enough to find and open a borrower's file, and nothing else is.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Core = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const webcrypto = globalThis.crypto || require('node:crypto').webcrypto;
  const subtle = webcrypto.subtle;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const ITERATIONS = 600000;
  // Unambiguous characters only (no 0/O, 1/I/L).
  const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const CODE_LENGTH = 12;

  // ---- Encoding -------------------------------------------------------

  function toB64(bytes) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  }

  function fromB64(s) {
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  }

  function toHex(bytes) {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function randomBytes(n) {
    return webcrypto.getRandomValues(new Uint8Array(n));
  }

  function newId() {
    return toHex(randomBytes(8));
  }

  // ---- Codes ----------------------------------------------------------

  function normalizeCode(code) {
    return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  function formatCode(code) {
    return normalizeCode(code).match(/.{1,4}/g)?.join('-') || '';
  }

  function generateCode() {
    let s = '';
    while (s.length < CODE_LENGTH) {
      // Rejection sampling keeps every character equally likely.
      for (const b of randomBytes(16)) {
        if (b < 248 && s.length < CODE_LENGTH) s += CODE_ALPHABET[b % 31];
      }
    }
    return formatCode(s);
  }

  function isWellFormedCode(code) {
    const n = normalizeCode(code);
    return n.length === CODE_LENGTH && [...n].every((c) => CODE_ALPHABET.includes(c));
  }

  // ---- Keys & encryption ----------------------------------------------

  async function pbkdf2(secret, salt, bits) {
    const base = await subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveBits']);
    const out = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, base, bits);
    return new Uint8Array(out);
  }

  function aesKey(raw) {
    return subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }

  async function deriveBorrower(code, siteSalt) {
    const bits = await pbkdf2(normalizeCode(code), enc.encode(`borrower:${siteSalt}`), 384);
    return { key: await aesKey(bits.slice(0, 32)), fileId: toHex(bits.slice(32, 48)) };
  }

  // A random key shared with all borrowers, for files every borrower may
  // read (payment QR codes).
  function newSharedKey() {
    return toB64(randomBytes(32));
  }

  function importSharedKey(b64) {
    return aesKey(fromB64(b64));
  }

  async function deriveOwnerKey(passphrase, salt) {
    return aesKey(await pbkdf2(passphrase, salt, 256));
  }

  async function encryptJson(key, value, extra = {}) {
    const iv = randomBytes(12);
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(value)));
    return { v: 1, ...extra, iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
  }

  async function decryptJson(key, file) {
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(file.iv) }, key, fromB64(file.ct));
    return JSON.parse(dec.decode(pt));
  }

  // Owner file: { v, salt, iv, ct }. Throws if the passphrase is wrong.
  async function openOwnerFile(file, passphrase) {
    const salt = fromB64(file.salt);
    const key = await deriveOwnerKey(passphrase, salt);
    try {
      return { data: await decryptJson(key, file), key, salt };
    } catch {
      throw new Error('Wrong passphrase');
    }
  }

  async function sealOwnerFile(data, key, salt) {
    return encryptJson(key, data, { salt: toB64(salt) });
  }

  // ---- Dates (local 'YYYY-MM-DD' strings) ------------------------------

  const pad = (n) => String(n).padStart(2, '0');

  function toISO(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function todayISO() {
    return toISO(new Date());
  }

  function isValidISO(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
  }

  function daysBetween(a, b) {
    const [ay, am, ad] = a.split('-').map(Number);
    const [by, bm, bd] = b.split('-').map(Number);
    return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
  }

  // Same day-of-month, `n` months later, clamped to the month's last day.
  function addMonths(iso, n) {
    const [y, m, d] = iso.split('-').map(Number);
    const last = new Date(y, m - 1 + n + 1, 0).getDate();
    return toISO(new Date(y, m - 1 + n, Math.min(d, last)));
  }

  function addDays(iso, n) {
    const [y, m, d] = iso.split('-').map(Number);
    return toISO(new Date(y, m - 1, d + n));
  }

  function dayInMonth(y, m, day) {
    return toISO(new Date(y, m, Math.min(day, new Date(y, m + 1, 0).getDate())));
  }

  // Twice a month on two days 15 apart, starting from `first`: the 15th
  // gives the 15th and end of month (30th, or 28th/29th in February); the
  // 5th gives the 5th and 20th.
  function semiMonthlyDates(first, count) {
    const [y, m, d] = first.split('-').map(Number);
    const a = d > 15 ? d - 15 : d;
    const b = a + 15;
    const out = [];
    for (let k = 0; out.length < count; k++) {
      for (const day of [a, b]) {
        const iso = dayInMonth(y, m - 1 + k, day);
        if (iso >= first && out.length < count) out.push(iso);
      }
    }
    return out;
  }

  const FREQUENCIES = {
    monthly: 'Monthly',
    semimonthly: 'Twice a month',
    biweekly: 'Every 2 weeks',
    bimonthly: 'Every 2 months',
  };

  function dueDates(first, count, frequency) {
    if (frequency === 'semimonthly') return semiMonthlyDates(first, count);
    return Array.from({ length: count }, (_, k) => {
      if (frequency === 'biweekly') return addDays(first, 14 * k);
      if (frequency === 'bimonthly') return addMonths(first, 2 * k);
      return addMonths(first, k);
    });
  }

  // ---- Validation -----------------------------------------------------

  function money(v, field) {
    const n = Math.round(Number(v) * 100) / 100;
    if (!Number.isFinite(n) || n < 0 || n > 1e9) throw new Error(`${field} must be a valid amount`);
    return n;
  }

  function cleanEmail(v) {
    const s = String(v ?? '').trim();
    if (s && (s.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s))) throw new Error('Enter a valid email address');
    return s;
  }

  function cleanPhone(v) {
    let s = String(v ?? '').replace(/[\s().-]/g, '');
    // Philippine mobile numbers are often written locally: 0917… → +63917…
    if (/^09\d{9}$/.test(s)) s = `+63${s.slice(1)}`;
    if (s && !/^\+[1-9]\d{6,14}$/.test(s)) throw new Error('Enter the phone number with country code, e.g. +63 917 123 4567');
    return s;
  }

  // ---- Borrower updates (inbox) ----------------------------------------
  //
  // Borrowers send contact details through ntfy.sh, a free relay. Each
  // message is encrypted to the owner's public key (ECDH P-256 + AES-GCM),
  // so only the owner page can read it.

  const NTFY = 'https://ntfy.sh';
  const INBOX_MARK = 'ENC:';
  const ECDH = { name: 'ECDH', namedCurve: 'P-256' };

  async function newInbox() {
    const pair = await subtle.generateKey(ECDH, true, ['deriveKey']);
    return {
      topic: `tracking-${toHex(randomBytes(12))}`,
      publicKey: await subtle.exportKey('jwk', pair.publicKey),
      privateKey: await subtle.exportKey('jwk', pair.privateKey),
    };
  }

  function sharedAes(privateKey, publicKey, usage) {
    return subtle.deriveKey({ name: 'ECDH', public: publicKey }, privateKey, { name: 'AES-GCM', length: 256 }, false, [usage]);
  }

  // Returns the text to post: a readable line for the notification, then the
  // encrypted details on their own line.
  async function sealForOwner(ownerPublicJwk, value) {
    const ownerKey = await subtle.importKey('jwk', ownerPublicJwk, ECDH, false, []);
    const eph = await subtle.generateKey(ECDH, true, ['deriveKey']);
    const key = await sharedAes(eph.privateKey, ownerKey, 'encrypt');
    const sealed = await encryptJson(key, value, { epk: toB64(new Uint8Array(await subtle.exportKey('raw', eph.publicKey))) });
    return `A borrower sent new contact details. Open your owner page to review them.\n\n${INBOX_MARK}${btoa(JSON.stringify(sealed))}`;
  }

  // Returns the decrypted value, or null if the text isn't a valid message.
  async function openFromBorrower(ownerPrivateJwk, text) {
    const line = String(text || '').split('\n').find((l) => l.startsWith(INBOX_MARK));
    if (!line) return null;
    try {
      const sealed = JSON.parse(atob(line.slice(INBOX_MARK.length)));
      const priv = await subtle.importKey('jwk', ownerPrivateJwk, ECDH, false, ['deriveKey']);
      const epk = await subtle.importKey('raw', fromB64(sealed.epk), ECDH, false, []);
      return await decryptJson(await sharedAes(priv, epk, 'decrypt'), sealed);
    } catch {
      return null;
    }
  }

  // The contact details a borrower may send, cleaned and validated.
  function cleanContactUpdate(input) {
    const c = {
      email: cleanEmail(input.email),
      phone: cleanPhone(input.phone),
      notifyEmail: Boolean(input.notifyEmail),
      notifySms: Boolean(input.notifySms),
    };
    if (!c.email && !c.phone) throw new Error('Enter an email address or a phone number');
    if (c.notifyEmail && !c.email) throw new Error('Add an email address to get email reminders');
    if (c.notifySms && !c.phone) throw new Error('Add a phone number to get text reminders');
    return c;
  }

  // ---- Payment methods ------------------------------------------------

  const PAYMENT_KINDS = {
    gcash: 'GCash',
    maya: 'Maya',
    bank: 'Bank transfer',
    cash: 'Cash',
    other: 'Other',
  };

  function cleanPaymentMethod(input) {
    const kind = Object.hasOwn(PAYMENT_KINDS, input.kind) ? input.kind : 'other';
    const text = (v, max) => String(v ?? '').trim().slice(0, max);
    const m = {
      kind,
      label: text(input.label, 40) || PAYMENT_KINDS[kind],
      accountName: text(input.accountName, 60),
      accountNumber: text(input.accountNumber, 40),
      details: text(input.details, 200),
    };
    if (kind !== 'cash' && !m.accountNumber && !m.details && !input.hasQr) {
      throw new Error('Add an account number, a QR code, or a note on how to pay');
    }
    return m;
  }

  // ---- Loans ----------------------------------------------------------

  // Split a loan into equal payments; rounding goes on the last.
  function splitSchedule(total, count, firstDue, note, frequency = 'monthly') {
    const cents = Math.round(total * 100);
    const each = Math.floor(cents / count);
    return dueDates(firstDue, count, frequency).map((dueDate, k) => ({
      amount: (k === count - 1 ? cents - each * (count - 1) : each) / 100,
      dueDate,
      note: count > 1 ? `${note ? note + ' – ' : ''}${k + 1}/${count}` : note,
    }));
  }

  // Payments from one loan share a note like "Phone – 2/6"; the loan is
  // "Phone". Anything added after the part number ("Phone – 2/6 paid late")
  // still belongs to the same loan.
  const PART = /(?:^|\s+–\s+)(\d+\/\d+.*)$/;

  function loanName(note) {
    return String(note || '').replace(PART, '').trim() || 'Other';
  }

  // Give a payment's note a new loan name, keeping its "2/6" part and extras.
  function renameLoanNote(note, name) {
    const part = String(note || '').match(PART)?.[1];
    if (!name) return part || '';
    return part ? `${name} – ${part}` : name;
  }

  function withStatus(inst, reminderDays, today = todayISO()) {
    const remaining = Math.round((inst.amount - inst.paid) * 100) / 100;
    const days = daysBetween(today, inst.dueDate);
    let status;
    if (remaining <= 0) status = 'paid';
    else if (days < 0) status = 'overdue';
    else if (days <= reminderDays) status = 'due-soon';
    else status = 'upcoming';
    return { ...inst, remaining, daysUntilDue: days, status };
  }

  function totals(items) {
    const sum = (f) => Math.round(items.reduce((s, i) => s + f(i), 0) * 100) / 100;
    const next = items.find((i) => i.remaining > 0);
    return {
      owed: sum((i) => i.amount),
      paid: sum((i) => i.paid),
      remaining: sum((i) => i.remaining),
      overdue: sum((i) => (i.status === 'overdue' ? i.remaining : 0)),
      dueSoon: sum((i) => (i.status === 'due-soon' ? i.remaining : 0)),
      nextDue: next ? { dueDate: next.dueDate, remaining: next.remaining } : null,
    };
  }

  function installmentsFor(state, borrowerId, today) {
    return state.installments
      .filter((i) => i.borrowerId === borrowerId)
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
      .map((i) => withStatus(i, state.settings.reminderDays, today));
  }

  function maskEmail(e) {
    const [user, domain] = e.split('@');
    return `${user[0]}•••@${domain}`;
  }

  function maskPhone(p) {
    return `•••${p.slice(-4)}`;
  }

  // What a borrower's file contains: only their own payments.
  function borrowerPayload(state, b) {
    const c = b.contact;
    const reminders = [];
    if (c.notifyEmail && c.email) reminders.push(`email to ${maskEmail(c.email)}`);
    if (c.notifySms && c.phone) reminders.push(`text to ${maskPhone(c.phone)}`);
    return {
      id: b.id,
      name: b.name,
      ownerName: state.settings.ownerName,
      // Where the borrower can send their contact details (encrypted to the owner).
      inbox: state.settings.inbox ? { topic: state.settings.inbox.topic, publicKey: state.settings.inbox.publicKey } : undefined,
      currency: state.settings.currency,
      reminderDays: state.settings.reminderDays,
      reminders,
      paymentMethods: (state.settings.paymentMethods || []).map(({ id, ...m }) => m),
      // Lets the borrower open payment QR codes; only sent when there are any.
      paymentsKey: (state.settings.paymentMethods || []).some((m) => m.qrFile) ? state.settings.paymentsKey : undefined,
      installments: state.installments
        .filter((i) => i.borrowerId === b.id)
        .map(({ amount, paid, dueDate, note }) => ({ amount, paid, dueDate, note })),
    };
  }

  // Reminders run once a day, so each stage matches exactly one day.
  function reminderStage(daysUntilDue, reminderDays) {
    if (daysUntilDue === reminderDays && reminderDays > 0) return 'soon';
    if (daysUntilDue === 0) return 'today';
    if (daysUntilDue === -1) return 'overdue';
    return null;
  }

  function emptyState() {
    return {
      v: 1,
      settings: { ownerName: '', currency: 'USD', reminderDays: 3, paymentMethods: [] },
      borrowers: [],
      installments: [],
    };
  }

  return {
    ITERATIONS,
    newId,
    randomBytes,
    toB64,
    fromB64,
    newSharedKey,
    importSharedKey,
    normalizeCode,
    formatCode,
    generateCode,
    isWellFormedCode,
    deriveBorrower,
    deriveOwnerKey,
    encryptJson,
    decryptJson,
    openOwnerFile,
    sealOwnerFile,
    todayISO,
    isValidISO,
    daysBetween,
    addMonths,
    addDays,
    FREQUENCIES,
    dueDates,
    money,
    cleanEmail,
    cleanPhone,
    splitSchedule,
    loanName,
    renameLoanNote,
    PAYMENT_KINDS,
    cleanPaymentMethod,
    NTFY,
    newInbox,
    sealForOwner,
    openFromBorrower,
    cleanContactUpdate,
    withStatus,
    totals,
    installmentsFor,
    borrowerPayload,
    reminderStage,
    emptyState,
  };
});
