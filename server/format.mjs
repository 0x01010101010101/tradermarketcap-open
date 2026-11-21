// Number and text helpers for pages (US English, Central Time).
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function usd(x) {
  if (x == null || !isFinite(x)) return '—';
  const a = Math.abs(x);
  if (a >= 1000) return '$' + x.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (a >= 1) return '$' + x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (a === 0) return '$0';
  return '$' + x.toPrecision(4).replace(/0+$/, '').replace(/\.$/, '');
}

export function big(x) {
  if (x == null || !isFinite(x)) return '—';
  const a = Math.abs(x);
  if (a >= 1e12) return '$' + (x / 1e12).toFixed(2) + 'T';
  if (a >= 1e9) return '$' + (x / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return '$' + (x / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return '$' + (x / 1e3).toFixed(1) + 'k';
  return '$' + x.toFixed(0);
}

export function count(x) {
  if (x == null || !isFinite(x)) return '—';
  const a = Math.abs(x);
  if (a >= 1e9) return (x / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (x / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (x / 1e3).toFixed(1) + 'k';
  return x.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export function pct(x) {
  if (x == null || !isFinite(x)) return '<span class="grey">—</span>';
  if (Math.abs(x) < 0.05) return '0.0%';
  const cls = x > 0 ? 'up' : 'dn';
  const s = (x > 0 ? '+' : '−') + Math.abs(x).toFixed(1) + '%';
  return cls ? `<span class="${cls}">${s}</span>` : s;
}

export const host = u => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return 'source'; } };
