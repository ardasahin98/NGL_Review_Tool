// Small numeric / table helpers (tables are arrays of row objects).
export const num = (v) => {
  if (v === null || v === undefined || v === "") return NaN;
  const x = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(x) ? x : NaN;
};
export const fin = (x) => Number.isFinite(x);
export const finite = (arr) => arr.filter(fin);
export const median = (arr) => {
  const a = finite(arr).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
export const mean = (arr) => { const a = finite(arr); return a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN; };
export const min = (arr) => { const a = finite(arr); return a.length ? Math.min(...a) : NaN; };
export const max = (arr) => { const a = finite(arr); return a.length ? Math.max(...a) : NaN; };
export const clamp = (x, lo, hi) => Math.min(Math.max(x, lo ?? -Infinity), hi ?? Infinity);
export const columns = (rows) => {
  const s = new Set();
  (rows || []).slice(0, 50).forEach((r) => Object.keys(r).forEach((k) => s.add(k)));
  return [...s];
};
export const uniq = (arr) => [...new Set(arr)];
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const fmt = (x, d = 2) => (fin(x) ? x.toFixed(d) : "—");

export function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, r = Math.PI / 180;
  const dphi = (lat2 - lat1) * r, dl = (lon2 - lon1) * r;
  const a = Math.sin(dphi / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Seeded RNG (for the demo data)
export function rng(seed) {
  let s = seed >>> 0;
  const u = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  return { uniform: (a, b) => a + (b - a) * u(), normal: (m = 0, sd = 1) => {
    const x = Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u()); return m + sd * x; } };
}
