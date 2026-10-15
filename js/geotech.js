// Geotechnical calculations (Robertson 2009, Boulanger & Idriss 2014, LPI, Vs30, USCS helpers).
import { GAMMA_W, PA } from "./config.js";
import { fin, clamp } from "./util.js";

const log10 = Math.log10;

// CPT normalisation. depth [m], qc [MPa], fs [kPa], u2 [kPa]. Returns arrays (kPa except qt_mpa).
export function cptDerived(depth, qcMpa, fsKpa, u2Kpa, a = 0.8, gwt = null) {
  const n = depth.length;
  if (!fin(a)) a = 0.8;
  const gw = gwt === null || !fin(gwt) ? 999 : gwt;
  const qt = [], rf = [], gam = [];
  for (let i = 0; i < n; i++) {
    const u2 = u2Kpa && fin(u2Kpa[i]) ? u2Kpa[i] : 0;
    qt[i] = qcMpa[i] * 1000 + u2 * (1 - a);
    rf[i] = qt[i] > 0 ? (fsKpa[i] / qt[i]) * 100 : NaN;
    // Robertson & Cabal (2010) unit weight
    let g = GAMMA_W * (0.27 * log10(Math.max(rf[i], 0.1)) + 0.36 * log10(Math.max(qt[i] / PA, 1)) + 1.236);
    gam[i] = fin(g) ? clamp(g, 14, 22) : 18;
  }
  const order = [...depth.keys()].sort((i, j) => depth[i] - depth[j]);
  const sv = new Array(n);
  let acc = 0, prev = 0;
  for (const i of order) { acc += gam[i] * (depth[i] - prev); prev = depth[i]; sv[i] = acc; }
  const u0 = depth.map((z) => Math.max(z - gw, 0) * GAMMA_W);
  const svp = sv.map((s, i) => Math.max(s - u0[i], 1));
  const fr = qt.map((q, i) => (q - sv[i] > 0 ? (fsKpa[i] / (q - sv[i])) * 100 : NaN));
  const Ic = new Array(n), Qtn = new Array(n), nn = new Array(n);
  for (let i = 0; i < n; i++) {
    let ne = 1, ic = 2.5, q = NaN;
    for (let k = 0; k < 30; k++) {
      q = Math.max((qt[i] - sv[i]) / PA, 1e-3) * (PA / svp[i]) ** ne;
      const icn = Math.sqrt((3.47 - log10(q)) ** 2 + (log10(Math.max(fr[i], 1e-3)) + 1.22) ** 2);
      const nNew = clamp(0.381 * icn + 0.05 * svp[i] / PA - 0.15, 0.5, 1.0);
      ic = icn;
      if (Math.abs(nNew - ne) < 1e-3) { ne = nNew; break; }
      ne = nNew;
    }
    Ic[i] = fin(fr[i]) ? ic : NaN; Qtn[i] = q; nn[i] = ne;
  }
  return { depth: [...depth], qt_mpa: qt.map((x) => x / 1000), rf, gamma: gam, sv, u0, svp, Qtn, Fr: fr, Ic, n: nn };
}

export function vsFromCpt(der) {
  return der.Ic.map((ic, i) => Math.sqrt(Math.max((10 ** (0.55 * ic + 1.68) * (der.qt_mpa[i] * 1000 - der.sv[i])) / PA, 0)));
}

// Boulanger & Idriss (2014) CPT triggering
export function bi2014(der, pga, mw, cfc = 0) {
  const out = { depth: der.depth, FS: [], qc1Ncs: [] };
  for (let i = 0; i < der.depth.length; i++) {
    const z = der.depth[i], qt = der.qt_mpa[i] * 1000, svp = der.svp[i], sv = der.sv[i], ic = der.Ic[i];
    const fc = clamp(80 * (ic + cfc) - 137, 0, 100);
    let q = 100;
    for (let k = 0; k < 30; k++) {
      const m = 1.338 - 0.249 * clamp(q, 21, 254) ** 0.264;
      const cn = Math.min((PA / svp) ** m, 1.7);
      const qc1n = (cn * qt) / PA;
      const dq = (11.9 + qc1n / 14.6) * Math.exp(1.63 - 9.7 / (fc + 2) - (15.7 / (fc + 2)) ** 2);
      const nq = qc1n + dq;
      if (Math.abs(nq - q) < 0.01) { q = nq; break; }
      q = nq;
    }
    const qq = clamp(q, 0, 211);
    const crr = Math.exp(qq / 113 + (qq / 1000) ** 2 - (qq / 140) ** 3 + (qq / 137) ** 4 - 2.8);
    const msfmax = Math.min(1.09 + (qq / 180) ** 3, 2.2);
    const msf = 1 + (msfmax - 1) * (8.64 * Math.exp(-mw / 4) - 1.325);
    const csig = Math.min(1 / (37.3 - 8.27 * qq ** 0.264), 0.3);
    const ksig = Math.min(1 - csig * Math.log(svp / PA), 1.1);
    const al = -1.012 - 1.126 * Math.sin(z / 11.73 + 5.133), be = 0.106 + 0.118 * Math.sin(z / 11.28 + 5.142);
    const rd = Math.exp(al + be * mw);
    const csr = 0.65 * (sv / svp) * pga * rd;
    let fs = clamp((crr * msf * ksig) / csr, 0, 2);
    if (!(ic <= 2.6) || der.u0[i] <= 0) fs = 2;
    out.FS.push(fs); out.qc1Ncs.push(q);
  }
  return out;
}

export function lpi(depth, fs) {
  const p = depth.map((z, i) => [z, fs[i]]).filter(([z]) => z <= 20).sort((a, b) => a[0] - b[0]);
  if (p.length < 2) return NaN;
  let s = 0;
  const f = ([z, F]) => (F < 1 ? 1 - F : 0) * Math.max(10 - 0.5 * z, 0);
  for (let i = 1; i < p.length; i++) s += 0.5 * (f(p[i]) + f(p[i - 1])) * (p[i][0] - p[i - 1][0]);
  return s;
}

// --- Vs
export function vsLayers(top, thk, vs) {
  const idx = [...top.keys()].sort((i, j) => top[i] - top[j]);
  const t = idx.map((i) => top[i]), v = idx.map((i) => vs[i]);
  let b;
  if (thk) b = idx.map((i) => top[i] + (fin(thk[i]) ? thk[i] : 0));
  else b = t.slice(1).concat([NaN]);
  b = b.map((x, i) => (fin(x) && x > t[i] ? x : Infinity));
  if (b.length) b[b.length - 1] = Infinity;
  return { top: t, base: b, vs: v, order: idx };
}
export function vsAvgTo(top, base, vs, z) {
  let tt = 0;
  for (let i = 0; i < top.length; i++) {
    if (top[i] >= z || !(vs[i] > 0)) continue;
    tt += (Math.min(base[i], z) - top[i]) / vs[i];
  }
  return tt > 0 ? z / tt : NaN;
}
export const vs30 = (t, b, v) => vsAvgTo(t, b, v, 30);

// --- soils
export function uscsGroup(code) {
  if (typeof code !== "string" || !code.trim()) return null;
  const c = code.trim().toUpperCase();
  if (/^(PT|OL|OH)/.test(c)) return "organic";
  if ("SG".includes(c[0])) return "coarse";
  if ("MC".includes(c[0])) return "fine";
  return null;
}
export function uscsFromText(text) {
  if (typeof text !== "string") return null;
  const m = text.toUpperCase().match(/\b(GW|GP|GM|GC|SW|SP|SM|SC|ML|CL|MH|CH|OL|OH|PT)(?:-(GM|GC|SM|SC|ML|CL))?\b/);
  if (m) return m[0];
  const t = text.toLowerCase();
  if (t.includes("silty sand")) return "SM?";
  if (t.includes("clayey sand")) return "SC?";
  if (t.includes("sand")) return "SP?";
  if (t.includes("clay")) return "CL?";
  if (t.includes("silt")) return "ML?";
  return null;
}
export function fcRangeForUscs(code) {
  if (typeof code !== "string") return null;
  const c = code.toUpperCase().replace("?", "");
  if (c.includes("-")) return [5, 12];
  if (["SW", "SP", "GW", "GP"].includes(c)) return [0, 5];
  if (["SM", "SC", "GM", "GC"].includes(c)) return [12, 50];
  if (["ML", "CL", "MH", "CH", "OL", "OH"].includes(c)) return [50, 100];
  return null;
}
export const SPT_COARSE = [["very loose", 0, 4], ["loose", 4, 10], ["medium dense", 10, 30], ["dense", 30, 50], ["very dense", 50, 999]];
export const SPT_FINE = [["very soft", 0, 2], ["soft", 2, 4], ["medium stiff", 4, 8], ["stiff", 8, 15], ["very stiff", 15, 30], ["hard", 30, 999]];

export function consistencyClass(text) {
  if (typeof text !== "string") return null;
  const t = text.toLowerCase();
  for (const scale of [SPT_COARSE, SPT_FINE]) {
    const order = scale.map((s, i) => [s[0], i]).sort((a, b) => b[0].length - a[0].length);
    for (const [term, i] of order) {
      if (!new RegExp("\\b" + term + "\\b").test(t)) continue;
      if (term === "dense" && /(medium|very) dense/.test(t)) continue;
      if (term === "stiff" && /(medium|very) stiff/.test(t)) continue;
      if (term === "soft" && /very soft/.test(t)) continue;
      if (term === "loose" && /very loose/.test(t)) continue;
      return { scale, idx: i };
    }
  }
  return null;
}
export function nClass(scale, n) {
  const i = scale.findIndex(([, lo, hi]) => n >= lo && n < hi);
  return i < 0 ? scale.length - 1 : i;
}
