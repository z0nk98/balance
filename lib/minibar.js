// On phones the page header scrolls away. Once it's out of view, this slim
// bar pins to the top with the header's controls as icons: the month arrows
// (where the page has them), the theme, the eye, and Lock / Sign out. Each
// one just presses the real control in the header, so they always agree.
(function () {
  'use strict';

  const PHONE = window.matchMedia('(max-width: 720px)');
  const THEMES = ['light', 'dark', 'auto'];
  const THEME_ICON = { light: 'sun', dark: 'moon', auto: 'auto' };
  const THEME_LABEL = { light: 'Theme: Light (tap for Dark)', dark: 'Theme: Dark (tap for Auto)', auto: 'Theme: Auto (tap for Light)' };

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    for (const c of children) if (c) node.append(c);
    return node;
  }

  function iconButton(label, onclick, extra = '') {
    const b = el('button', { type: 'button', className: `mini-btn ${extra}`.trim(), title: label, onclick });
    b.setAttribute('aria-label', label);
    return b;
  }

  // Keeps a mini control's visibility in step with the real one.
  function mirrorHidden(source, target) {
    const sync = () => { target.hidden = !source || source.hidden || source.closest('[hidden]') !== null; };
    sync();
    if (source) new MutationObserver(sync).observe(source.closest('.month-nav') || source, { attributes: true, attributeFilter: ['hidden'] });
    return sync;
  }

  document.addEventListener('DOMContentLoaded', () => {
    const bar = document.querySelector('.topbar');
    if (!bar || !window.PayIcons) return;
    const icon = (kind) => PayIcons.actionIcon(kind);
    const mini = el('div', { className: 'mini-bar', hidden: true });
    mini.setAttribute('role', 'toolbar');
    mini.setAttribute('aria-label', 'Page controls');

    const title = el('span', { className: 'mini-title', textContent: (bar.querySelector('h1') || {}).textContent || '' });
    mini.append(title);

    // Month arrows and label, if the page has them.
    const prev = document.getElementById('prevMonth');
    const next = document.getElementById('nextMonth');
    const label = document.getElementById('monthLabel');
    if (prev && next && label) {
      const monthLabel = el('span', { className: 'mini-month-label' });
      const syncLabel = () => { monthLabel.textContent = label.textContent.replace(/(\w{3})\w*\s(\d{4})/, '$1 $2'); };
      new MutationObserver(syncLabel).observe(label, { childList: true, characterData: true, subtree: true });
      syncLabel();
      const group = el('span', { className: 'mini-month' }, [
        el('button', { type: 'button', className: 'mini-btn', textContent: '‹', title: 'Previous month', onclick: () => prev.click() }),
        monthLabel,
        el('button', { type: 'button', className: 'mini-btn', textContent: '›', title: 'Next month', onclick: () => next.click() }),
      ]);
      mirrorHidden(prev, group);
      mini.append(group);
    }

    mini.append(el('span', { className: 'mini-spacer' }));

    // Theme: one button that steps Light → Dark → Auto.
    const themeBtn = iconButton('Theme', () => {
      const buttons = [...bar.querySelectorAll('.theme-switch button')];
      const now = buttons.findIndex((b) => b.getAttribute('aria-pressed') === 'true');
      const target = buttons[(now + 1) % buttons.length];
      if (target) target.click();
      syncTheme();
    });
    function syncTheme() {
      const pressed = bar.querySelector('.theme-switch button[aria-pressed="true"]');
      const choice = pressed ? pressed.dataset.choice : 'auto';
      themeBtn.replaceChildren(icon(THEME_ICON[choice] || 'auto'));
      themeBtn.title = THEME_LABEL[choice] || 'Theme';
      themeBtn.setAttribute('aria-label', themeBtn.title);
    }
    if (bar.querySelector('.theme-switch')) {
      syncTheme();
      new MutationObserver(syncTheme).observe(bar.querySelector('.theme-switch'), { attributes: true, subtree: true, attributeFilter: ['aria-pressed'] });
      mini.append(themeBtn);
    }

    // The eye: show or hide amounts.
    if (window.BalancePrivacy) {
      const eye = iconButton('Show amounts', () => window.BalancePrivacy.toggle(), 'mini-eye');
      const syncEye = () => {
        const hidden = window.BalancePrivacy.hidden;
        eye.replaceChildren(icon(hidden ? 'eyeOff' : 'eye'));
        eye.title = hidden ? 'Show amounts' : 'Hide amounts';
        eye.setAttribute('aria-label', eye.title);
        eye.setAttribute('aria-pressed', String(hidden));
      };
      syncEye();
      window.addEventListener('balance:amounts', syncEye);
      mini.append(eye);
    }

    // Lock (Lending) and Sign out (borrower page), when the header shows them.
    for (const [id, kind, text] of [['lock', 'lock', 'Lock'], ['logout', 'logout', 'Sign out']]) {
      const source = document.getElementById(id);
      if (!source) continue;
      const b = iconButton(text, () => source.click());
      b.append(icon(kind));
      mirrorHidden(source, b);
      mini.append(b);
    }

    document.body.append(mini);

    // Shown only on phones, once the real header has scrolled out of view.
    let headerVisible = true;
    const update = () => {
      const show = PHONE.matches && !headerVisible;
      mini.hidden = !show;
      document.body.classList.toggle('has-mini-bar', show);
    };
    new IntersectionObserver(([entry]) => { headerVisible = entry.isIntersecting; update(); }, { threshold: 0 }).observe(bar);
    if (PHONE.addEventListener) PHONE.addEventListener('change', update);
  });
})();
