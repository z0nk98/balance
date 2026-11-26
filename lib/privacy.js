// Hide or show amounts: the eye button in the header of every page.
// Loaded in <head> on every page, before the page's own scripts.
//
// Every page shows money through Intl.NumberFormat with style 'currency', so
// while amounts are hidden that formatter returns "₱•••••" (the currency sign,
// with the number masked to a fixed length so its size doesn't show). Amount
// boxes in forms are masked too until you tap into them.
//
// The choice is kept per device: one setting for your own pages, a separate
// one for the borrower page (borrowers use it on their own devices).
// Pages redraw on the 'balance:amounts' event.
(function () {
  'use strict';

  const KEY = /borrow\.html$/.test(location.pathname) ? 'balance:borrower-hide-amounts' : 'balance:hide-amounts';
  const MASK = '•••••';
  const root = document.documentElement;

  function read() {
    try {
      return localStorage.getItem(KEY) === '1';
    } catch {
      return false;
    }
  }

  let hidden = read();

  // ---- Masking currency amounts --------------------------------------------

  const Original = Intl.NumberFormat;
  const NUMBER_PARTS = new Set(['integer', 'group', 'decimal', 'fraction', 'minusSign', 'plusSign']);

  function mask(nf, n) {
    let out = '';
    let masked = false;
    for (const part of nf.formatToParts(n)) {
      if (!NUMBER_PARTS.has(part.type)) out += part.value;
      else if (!masked && part.type !== 'minusSign' && part.type !== 'plusSign') {
        out += MASK;
        masked = true;
      }
    }
    return out.trim() || MASK;
  }

  function NumberFormat(locales, options) {
    const nf = new Original(locales, options);
    if (!options || options.style !== 'currency') return nf;
    return {
      format: (n) => (hidden ? mask(nf, n) : nf.format(n)),
      formatToParts: (n) => nf.formatToParts(n),
      resolvedOptions: () => nf.resolvedOptions(),
    };
  }
  NumberFormat.supportedLocalesOf = Original.supportedLocalesOf.bind(Original);
  NumberFormat.prototype = Original.prototype;
  Intl.NumberFormat = NumberFormat;

  // ---- The eye button --------------------------------------------------------

  function updateButton() {
    const btn = document.getElementById('amountsToggle');
    if (!btn) return;
    const label = hidden ? 'Show amounts' : 'Hide amounts';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-pressed', String(hidden));
    if (window.PayIcons) btn.replaceChildren(PayIcons.actionIcon(hidden ? 'eyeOff' : 'eye'));
  }

  function apply() {
    root.classList.toggle('hide-amounts', hidden);
    updateButton();
  }

  function set(value) {
    hidden = value;
    try {
      localStorage.setItem(KEY, hidden ? '1' : '0');
    } catch {
      // Not remembered, but applied for this visit.
    }
    apply();
    window.dispatchEvent(new Event('balance:amounts'));
  }

  apply();

  // Changed in another tab.
  window.addEventListener('storage', (ev) => {
    if (ev.key !== KEY) return;
    hidden = read();
    apply();
    window.dispatchEvent(new Event('balance:amounts'));
  });

  // The button goes in the page header, next to the theme switch.
  document.addEventListener('DOMContentLoaded', () => {
    const bar = document.querySelector('.topbar');
    if (!bar) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'amountsToggle';
    btn.className = 'icon-btn amounts-toggle';
    btn.addEventListener('click', () => set(!hidden));
    const theme = bar.querySelector('.theme-switch');
    if (theme) theme.after(btn);
    else bar.append(btn);
    updateButton();
  });

  window.BalancePrivacy = {
    get hidden() {
      return hidden;
    },
  };
})();
