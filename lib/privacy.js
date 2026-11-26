// Hide or show amounts: the eye button in the header of every page.
// Loaded in <head> on every page, before the page's own scripts.
//
// Every page shows money through Intl.NumberFormat with style 'currency', so
// while amounts are hidden that formatter returns "₱•••••" (the currency sign,
// with the number masked to a fixed length so its size doesn't show). Amount
// boxes in forms are masked too until you tap into them.
//
// Privacy mode: every page opens private (amounts hidden, detail sections
// collapsed). One tap on the eye shows everything; another hides it all. Once
// shown, moving between pages keeps it shown for a while (REVEAL_MS since the
// last tap), after which pages open private again. Your own pages and the
// borrower page keep separate settings. Pages redraw on 'balance:amounts'.
(function () {
  'use strict';

  const KEY = /borrow\.html$/.test(location.pathname) ? 'balance:borrower-revealed' : 'balance:revealed';
  const REVEAL_MS = 15 * 60 * 1000;
  const MASK = '•••••';
  const root = document.documentElement;

  // Hidden unless shown in this browser tab within the last REVEAL_MS.
  function read() {
    try {
      const at = Number(sessionStorage.getItem(KEY));
      return !(at && Date.now() - at < REVEAL_MS);
    } catch {
      return true;
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
      if (hidden) sessionStorage.removeItem(KEY);
      else sessionStorage.setItem(KEY, String(Date.now()));
    } catch {
      // Not remembered, but applied for this visit.
    }
    apply();
    window.dispatchEvent(new Event('balance:amounts'));
  }

  apply();

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
    set,
    toggle: () => set(!hidden),
  };
})();
