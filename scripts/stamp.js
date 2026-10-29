'use strict';

// Adds ?v=<fingerprint> to every local script and stylesheet link in the
// HTML pages. GitHub Pages lets browsers reuse files for up to 10 minutes,
// so without this a fresh page can run with an old script. The fingerprint
// is a hash of the files' contents, so it only changes when they do.
//
//   node scripts/stamp.js          # update the pages
//   node scripts/stamp.js --check  # exit 1 if a page is out of date

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const PAGES = ['index.html', 'bills.html', 'lend.html', 'borrow.html'];
const ASSET_REF = /(<(?:script|link)\b[^>]*?\b(?:src|href)=")([\w./-]+\.(?:js|css))(?:\?v=[\w-]*)?(")/g;

function assetsIn(html) {
  return [...html.matchAll(ASSET_REF)].map((m) => m[2]);
}

function fingerprint() {
  const files = [...new Set(PAGES.flatMap((p) => assetsIn(fs.readFileSync(path.join(ROOT, p), 'utf8'))))].sort();
  const hash = crypto.createHash('sha256');
  for (const f of files) hash.update(f).update('\0').update(fs.readFileSync(path.join(ROOT, f)));
  return hash.digest('hex').slice(0, 10);
}

function stamp(html, version) {
  return html.replace(ASSET_REF, (_, before, file, after) => `${before}${file}?v=${version}${after}`);
}

function run({ check = false } = {}) {
  const version = fingerprint();
  const stale = [];
  for (const p of PAGES) {
    const file = path.join(ROOT, p);
    const html = fs.readFileSync(file, 'utf8');
    const next = stamp(html, version);
    if (next !== html) {
      stale.push(p);
      if (!check) fs.writeFileSync(file, next);
    }
  }
  return { version, stale };
}

if (require.main === module) {
  const check = process.argv.includes('--check');
  const { version, stale } = run({ check });
  if (check && stale.length) {
    console.log(`Out of date: ${stale.join(', ')}. Run: node scripts/stamp.js`);
    process.exitCode = 1;
  } else {
    console.log(stale.length ? `Stamped ${stale.join(', ')} with v=${version}` : `Up to date (v=${version})`);
  }
}

module.exports = { run, stamp, assetsIn };
