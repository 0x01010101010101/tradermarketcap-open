// Keeps prices fresh without reloading the page. One small cached request every 15 seconds.
(function () {
  var cells = document.querySelectorAll('[data-p],[data-c]');
  var clock = document.getElementById('clock');
  function usd(x) {
    if (x == null || !isFinite(x)) return '—';
    var a = Math.abs(x);
    if (a >= 1000) return '$' + x.toLocaleString('en-US', { maximumFractionDigits: 0 });
    if (a >= 1) return '$' + x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (a === 0) return '$0';
    return '$' + x.toPrecision(4).replace(/0+$/, '').replace(/\.$/, '');
  }
  function pct(el, x) {
    if (x == null || !isFinite(x)) return;
    if (Math.abs(x) < 0.05) { el.textContent = '0.0%'; return; }
    var s = (x > 0 ? '+' : '−') + Math.abs(x).toFixed(1) + '%';
    el.innerHTML = '';
    var span = document.createElement('span');
    span.className = x > 0 ? 'up' : 'dn';
    span.textContent = s;
    el.appendChild(span);
  }
  function tick() {
    if (document.hidden || !cells.length) return;
    fetch('/v1/prices').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d) return;
      cells.forEach(function (el) {
        var id = el.getAttribute('data-p') || el.getAttribute('data-c'), p = d.prices[id];
        if (!p) return;
        if (el.hasAttribute('data-p')) el.textContent = usd(p[0]); else pct(el, p[1]);
      });
      if (clock) clock.textContent = new Date(d.at).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' });
    }).catch(function () {});
  }
  setTimeout(tick, 3000);   // one early refresh, so short visits still get fresh prices
  setInterval(tick, 15000);
})();
