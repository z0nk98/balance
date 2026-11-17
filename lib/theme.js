// Light or dark pages. Loaded first on every page (before the stylesheets
// paint) so the chosen colours show straight away, without a flash.
// The choice is Light, Dark or Auto (follow the device), kept per device.
(function () {
  'use strict';

  const KEY = 'balance:theme';
  const root = document.documentElement;
  const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const CHOICES = [
    ['light', 'sun', 'Light theme'],
    ['dark', 'moon', 'Dark theme'],
    ['auto', 'auto', 'Auto: match this device'],
  ];

  function choice() {
    try {
      const v = localStorage.getItem(KEY);
      return v === 'light' || v === 'dark' ? v : 'auto';
    } catch {
      return 'auto';
    }
  }

  function apply() {
    const c = choice();
    const dark = c === 'dark' || (c === 'auto' && media && media.matches);
    root.dataset.theme = dark ? 'dark' : 'light';
    for (const btn of document.querySelectorAll('.theme-switch button')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.choice === c));
    }
  }

  function set(c) {
    try {
      if (c === 'auto') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, c);
    } catch {
      // Not remembered, but applied for this visit.
      root.dataset.theme = c === 'dark' ? 'dark' : 'light';
    }
    apply();
  }

  apply();
  if (media && media.addEventListener) media.addEventListener('change', apply);
  // Changed in another tab.
  window.addEventListener('storage', (ev) => { if (ev.key === KEY) apply(); });

  // The switch goes at the end of the page header.
  document.addEventListener('DOMContentLoaded', () => {
    const bar = document.querySelector('.topbar');
    if (!bar || !window.PayIcons) return;
    const group = document.createElement('div');
    group.className = 'theme-switch';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Page theme');
    for (const [value, icon, label] of CHOICES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.choice = value;
      btn.title = label;
      btn.setAttribute('aria-label', label);
      btn.append(PayIcons.actionIcon(icon));
      btn.addEventListener('click', () => set(value));
      group.append(btn);
    }
    bar.append(group);
    apply();
  });
})();
