'use strict';

// Daily payment reminders, run by .github/workflows/reminders.yml.
//
// Reads the encrypted owner data, and for each borrower who has reminders
// turned on sends an email (Resend) and/or text (Twilio) when a payment is
// `reminderDays` away, due today, or one day overdue.
//
// Workflow logs in a public repository are public, so this script only ever
// prints counts — never names, addresses or amounts.

const fs = require('node:fs');
const path = require('node:path');
const Core = require('../lib/core');

const OWNER_FILE = path.join(__dirname, '..', 'data', 'owner.json');

function formatMoney(n, currency) {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}

function portalUrl(env) {
  if (env.PUBLIC_URL) return env.PUBLIC_URL;
  const [owner, repo] = (env.GITHUB_REPOSITORY || '').split('/');
  return owner && repo ? `https://${owner.toLowerCase()}.github.io/${repo}/borrow.html` : '';
}

function buildMessage(borrower, inst, stage, settings, link) {
  const amount = formatMoney(inst.remaining, settings.currency);
  const to = settings.ownerName ? ` to ${settings.ownerName}` : '';
  const days = inst.daysUntilDue;
  const when = {
    soon: `is due on ${inst.dueDate} (in ${days} day${days === 1 ? '' : 's'})`,
    today: `is due today (${inst.dueDate})`,
    overdue: `was due yesterday (${inst.dueDate}) and is now overdue`,
  }[stage];
  return {
    subject: stage === 'overdue' ? `Payment overdue: ${amount}` : `Payment reminder: ${amount} ${stage === 'today' ? 'due today' : 'due soon'}`,
    body: `Hi ${borrower.name}, a payment of ${amount}${to} ${when}.` + (link ? `\n\nSee your balance: ${link}` : ''),
  };
}

// Everything that should go out today: [{ channel, to, subject, body }].
function dueReminders(state, today, link) {
  const out = [];
  for (const b of state.borrowers) {
    const channels = [];
    if (b.contact.notifyEmail && b.contact.email) channels.push(['email', b.contact.email]);
    if (b.contact.notifySms && b.contact.phone) channels.push(['sms', b.contact.phone]);
    if (!channels.length) continue;
    for (const inst of Core.installmentsFor(state, b.id, today)) {
      if (inst.remaining <= 0) continue;
      const stage = Core.reminderStage(inst.daysUntilDue, state.settings.reminderDays);
      if (!stage) continue;
      const msg = buildMessage(b, inst, stage, state.settings, link);
      for (const [channel, to] of channels) out.push({ channel, to, ...msg });
    }
  }
  return out;
}

async function sendEmail(env, to, subject, body) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, text: body }),
  });
  if (!res.ok) throw new Error(`email provider returned ${res.status}`);
}

async function sendSms(env, to, body) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(env.TWILIO_ACCOUNT_SID)}/Messages.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, From: env.TWILIO_FROM, Body: body }),
  });
  if (!res.ok) throw new Error(`SMS provider returned ${res.status}`);
}

async function main(env = process.env) {
  if (!fs.existsSync(OWNER_FILE)) return console.log('No data yet; nothing to do.');
  if (!env.OWNER_PASSPHRASE) {
    return console.log('OWNER_PASSPHRASE secret is not set, so reminders are off. See the README to turn them on.');
  }

  const { data: state } = await Core.openOwnerFile(JSON.parse(fs.readFileSync(OWNER_FILE, 'utf8')), env.OWNER_PASSPHRASE);
  const reminders = dueReminders(state, Core.todayISO(), portalUrl(env));

  const canEmail = Boolean(env.RESEND_API_KEY && env.EMAIL_FROM);
  const canSms = Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM);
  const count = { sent: 0, failed: 0, skipped: 0 };

  for (const r of reminders) {
    const enabled = r.channel === 'email' ? canEmail : canSms;
    if (!enabled) {
      count.skipped++;
      continue;
    }
    try {
      if (r.channel === 'email') await sendEmail(env, r.to, r.subject, r.body);
      else await sendSms(env, r.to, r.body);
      count.sent++;
    } catch (err) {
      count.failed++;
      console.log(`A ${r.channel} reminder failed: ${err.message}`);
    }
  }

  console.log(`Reminders due today: ${reminders.length}. Sent: ${count.sent}. Failed: ${count.failed}.` +
    (count.skipped ? ` Skipped ${count.skipped} because email/SMS isn't set up yet.` : ''));
  if (count.failed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.log(`Reminder run failed: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { dueReminders, buildMessage, portalUrl };
