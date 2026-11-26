// Keeps open pages on the newest version. GitHub Pages lets browsers reuse a
// page for up to 10 minutes, so right after an update a page can load the old
// version. This checks version.json (written by scripts/stamp.js) when the
// page opens and whenever you come back to it; if a newer version is out, the
// page reloads once. While you're typing in a form it shows a Reload button
// instead, so nothing you typed is lost.
(function () {
  'use strict';

  const me = (document.currentScript && /[?&]v=([\w-]+)/.exec(document.currentScript.src) || [])[1];
  if (!me) return;
  const GUARD = 'balance:reloaded-for';

  // True once you've typed into a form (not a search box) since it was last
  // saved or cleared. Values the page fills in itself don't count.
  let dirty = false;
  document.addEventListener('input', (ev) => {
    const t = ev.target;
    if (ev.isTrusted && t && t.form && t.type !== 'search') dirty = true;
  }, true);
  document.addEventListener('submit', () => { dirty = false; }, true);
  document.addEventListener('reset', () => { dirty = false; }, true);

  function typing() {
    const a = document.activeElement;
    const focused = a && /^(INPUT|TEXTAREA)$/.test(a.tagName) && a.type !== 'search' && a.type !== 'button';
    return dirty || Boolean(focused && a.value);
  }

  function offerReload() {
    if (document.getElementById('updateBar')) return;
    const bar = document.createElement('div');
    bar.id = 'updateBar';
    bar.className = 'update-bar';
    bar.setAttribute('role', 'status');
    bar.append('New version available ');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Reload';
    btn.addEventListener('click', () => location.reload());
    bar.append(btn);
    document.body.append(bar);
  }

  async function check() {
    let latest;
    try {
      const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return;
      latest = (await res.json()).v;
    } catch {
      return; // offline or blocked: try again next time
    }
    if (!latest || latest === me) return;
    let already = null;
    try { already = sessionStorage.getItem(GUARD); } catch { /* storage blocked */ }
    // Reloaded for this version once already and still old (cache not caught up): just offer it.
    if (already === latest || typing()) { offerReload(); return; }
    try { sessionStorage.setItem(GUARD, latest); } catch { /* storage blocked */ }
    location.reload();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', check);
  else check();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
})();
