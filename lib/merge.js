// Three-way merge of Expenses and Bills data between devices.
// In the browser it defines `window.MoneyMerge`; in Node it is a CommonJS module.
//
// Each device keeps the copy it last synced ("base"). Comparing the device's
// copy and the online copy against that base tells which side added, changed
// or deleted each entry, so changes made on different devices all survive.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MoneyMerge = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  // JSON with sorted keys, so equal data compares equal whatever the key order.
  function stable(value) {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value === undefined ? null : value);
  }

  const same = (a, b) => stable(a) === stable(b);

  // One value: a change on this device wins, otherwise take the online one.
  // An edit beats a delete; with no base (first sync) both sides are kept.
  function pick(base, local, remote, hasBase) {
    if (!hasBase) return local !== undefined ? local : remote;
    const localChanged = !same(local, base);
    const remoteChanged = !same(remote, base);
    if (local === undefined) return remoteChanged ? remote : undefined;
    if (remote === undefined) return localChanged ? local : undefined;
    return localChanged ? local : remote;
  }

  // Maps of id -> entry. `hasBase` is per entry: was it known at the last sync.
  function mergeMap(base, local, remote, firstSync) {
    const out = {};
    const keys = [...new Set([...Object.keys(local), ...Object.keys(remote)])];
    for (const k of keys) {
      const hasBase = !firstSync && Object.prototype.hasOwnProperty.call(base, k);
      const v = pick(base[k], local[k], remote[k], hasBase);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }

  // Lists of { id, ... }. Keeps this device's order, then new online entries.
  function mergeList(base, local, remote, firstSync) {
    const byId = (list) => Object.fromEntries((list || []).filter((x) => x && x.id != null).map((x) => [String(x.id), x]));
    const merged = mergeMap(byId(base), byId(local), byId(remote), firstSync);
    const order = [...(local || []), ...(remote || [])].map((x) => String(x && x.id));
    return [...new Set(order)].filter((id) => merged[id]).map((id) => merged[id]);
  }

  function mergeScalar(base, local, remote, firstSync) {
    if (firstSync) return local !== undefined && local !== null ? local : remote;
    return same(local, base) ? remote : local;
  }

  // An object whose `listKey` field is a list of entries and whose
  // `mapKey` field (if any) is a map; other fields merge as single values.
  function mergeRecord(base, local, remote, { listKey, mapKey }, firstSync) {
    if (!remote) return local;
    if (!local) return remote;
    const b = base || {};
    const out = {};
    for (const k of new Set([...Object.keys(local), ...Object.keys(remote)])) {
      if (k === listKey) out[k] = mergeList(b[k], local[k], remote[k], firstSync);
      else if (k === mapKey) out[k] = mergeMap(b[k] || {}, local[k] || {}, remote[k] || {}, firstSync);
      else out[k] = mergeScalar(b[k], local[k], remote[k], firstSync);
    }
    return out;
  }

  // data: { expenses: <Expenses page state>, bills: <Bills page state> }.
  // base is null on a device's first sync: everything from both sides is kept.
  function merge(base, local, remote) {
    const firstSync = !base;
    const b = base || {};
    return {
      v: 1,
      expenses: mergeRecord(b.expenses, local.expenses, remote && remote.expenses, { listKey: 'expenses' }, firstSync),
      bills: mergeRecord(b.bills, local.bills, remote && remote.bills, { listKey: 'bills', mapKey: 'payments' }, firstSync),
    };
  }

  return { merge, same };
});
