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

  function paymentIcon(kind) {
    const wrap = document.createElement('span');
    wrap.className = `pay-icon pay-${SHAPES[kind] ? kind : 'other'}`;
    wrap.setAttribute('aria-hidden', 'true');
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    for (const [tag, attrs] of SHAPES[kind] || SHAPES.other) {
      const node = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
      svg.append(node);
    }
    wrap.append(svg);
    return wrap;
  }

  root.PayIcons = { paymentIcon };
})(self);
