// Simple line icons for payment methods (generic drawings, not brand logos).
(function (root) {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';

  // Each shape is [tag, attributes] on a 24×24 grid.
  const SHAPES = {
    // Phone wallet, for GCash and Maya.
    gcash: [['rect', { x: 6, y: 2.5, width: 12, height: 19, rx: 2.5 }], ['path', { d: 'M10 18.5h4' }], ['path', { d: 'M9.5 8.5h3.2a1.8 1.8 0 0 1 0 3.6H9.5V8.5Zm0 3.6v3.4M8.5 10.3h6' }]],
    maya: [['rect', { x: 6, y: 2.5, width: 12, height: 19, rx: 2.5 }], ['path', { d: 'M10 18.5h4' }], ['path', { d: 'M9 14.5v-6l3 3.5 3-3.5v6' }]],
    bank: [['path', { d: 'M3 9.5 12 4l9 5.5' }], ['path', { d: 'M5 10v8M9.7 10v8M14.3 10v8M19 10v8' }], ['path', { d: 'M3 20h18' }]],
    cash: [['rect', { x: 2.5, y: 6, width: 19, height: 12, rx: 2 }], ['circle', { cx: 12, cy: 12, r: 2.8 }], ['path', { d: 'M6 9.5v.01M18 14.5v.01' }]],
    other: [['rect', { x: 2.5, y: 5, width: 19, height: 14, rx: 2 }], ['path', { d: 'M2.5 10h19M6.5 15h4' }]],
  };

  const BILL_SHAPES = {
    electricity: [['path', { d: 'M13 2.5 5.5 13.5H12l-1 8 7.5-11H12l1-8Z' }]],
    water: [['path', { d: 'M12 3s6 6.6 6 11a6 6 0 0 1-12 0c0-4.4 6-11 6-11Z' }]],
    internet: [['path', { d: 'M3 9a13 13 0 0 1 18 0M6 12.5a8.5 8.5 0 0 1 12 0M9 16a4 4 0 0 1 6 0' }], ['circle', { cx: 12, cy: 19, r: 0.8 }]],
    mobile: [['rect', { x: 7, y: 2.5, width: 10, height: 19, rx: 2 }], ['path', { d: 'M11 18.5h2' }]],
    rent: [['path', { d: 'M3.5 11 12 4l8.5 7' }], ['path', { d: 'M5.5 9.5V20h13V9.5M10 20v-5.5h4V20' }]],
    card: [['rect', { x: 2.5, y: 5, width: 19, height: 14, rx: 2 }], ['path', { d: 'M2.5 10h19M6.5 15h4' }]],
    loan: [['ellipse', { cx: 12, cy: 6.5, rx: 7, ry: 2.5 }], ['path', { d: 'M5 6.5v5c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-5M5 11.5v5c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-5' }]],
    insurance: [['path', { d: 'M12 3 4.5 6v5.5c0 4.6 3.2 8.2 7.5 9.5 4.3-1.3 7.5-4.9 7.5-9.5V6L12 3Z' }], ['path', { d: 'm9 12 2 2 4-4' }]],
    subscription: [['path', { d: 'M20 11a8 8 0 0 0-14.3-4.9M4 13a8 8 0 0 0 14.3 4.9' }], ['path', { d: 'M5 3v4h4M19 21v-4h-4' }]],
    school: [['path', { d: 'M2.5 9 12 4.5 21.5 9 12 13.5 2.5 9Z' }], ['path', { d: 'M6.5 11v4.5c0 1.4 2.5 3 5.5 3s5.5-1.6 5.5-3V11M21.5 9v5' }]],
    other: [['path', { d: 'M6 2.5h12v19l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5-2 1.5v-19Z' }], ['path', { d: 'M9 8h6M9 12h6M9 16h3' }]],
  };

  function draw(className, shapes) {
    const wrap = document.createElement('span');
    wrap.className = className;
    wrap.setAttribute('aria-hidden', 'true');
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    for (const [tag, attrs] of shapes) {
      const node = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
      svg.append(node);
    }
    wrap.append(svg);
    return wrap;
  }

  function paymentIcon(kind) {
    const k = SHAPES[kind] ? kind : 'other';
    return draw(`pay-icon pay-${k}`, SHAPES[k]);
  }

  function billIcon(kind) {
    const k = BILL_SHAPES[kind] ? kind : 'other';
    return draw(`pay-icon bill-${k}`, BILL_SHAPES[k]);
  }

  root.PayIcons = { paymentIcon, billIcon };
})(self);
