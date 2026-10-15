// Consistency checks. Every finding: {status: PASS|FAIL|UNSURE, group, check, message, target, where, testId, depths, points}
import { THRESH, STATUS_ORDER, GAMMA_W } from "./config.js";
import { num, fin, median, mean, min, max, haversine, columns } from "./util.js";
import { cptDerived, vsFromCpt, bi2014, lpi, vsLayers, vs30, vsAvgTo, uscsGroup, uscsFromText,
  fcRangeForUscs, consistencyClass, nClass } from "./geotech.js";

export const worst = (fs) => (fs.length ? fs.map((f) => f.status).sort((a, b) => STATUS_ORDER[a] - STATUS_ORDER[b])[0] : "UNSURE");

const PARENT_OF = { SCPT: "SCPG", ISPT: "BORH", STRA: "BORH", DETL: "BORH", WATR: "BORH", SWVG: "GSWG",
  SWVD: "SWVG", GSWD: "SWVG", SAMP: "BORH" };
const KIND_BY_TYPE = { SCPG: "CPT", SCPT: "CPT", CPT: "CPT", BORH: "Borehole", TEPT: "Test pit", GSWG: "Vs",
  SWVG: "Vs", GINV: "Invasive Vs", OTHF: "Other" };

export function fmtDepths(depths, maxItems = 8) {
  const d = [...new Set(depths.filter(fin).map((x) => Math.round(x * 100) / 100))].sort((a, b) => a - b);
  if (!d.length) return "";
  const r = []; let s = d[0], p = d[0];
  for (const x of d.slice(1)) { if (x - p > 0.3) { r.push([s, p]); s = x; } p = x; }
  r.push([s, p]);
  const txt = r.slice(0, maxItems).map(([a, b]) => (a === b ? `${a.toFixed(2)} m` : `${a.toFixed(2)}–${b.toFixed(2)} m`));
  return "depth " + txt.join(", ") + (r.length > maxItems ? ` (+${r.length - maxItems} more)` : "");
}

// ------------------------------------------------------------------ context
export class SiteContext {
  constructor(bundle, R) {
    this.b = bundle; this.R = R;
    const S = this.t("SITE");
    this.site = S[0] || {};
    this.siteLat = R.first("SITE", S, "lat", true);
    this.siteLon = R.first("SITE", S, "lon", true);
    this.siteName = R.first("SITE", S, "name") ?? "?";
    this.tests = this._buildTests();
    this._gwt = null;
  }
  t(table) { return Array.isArray(this.b[table]) ? this.b[table] : []; }

  _buildTests() {
    const T = this.t("TEST"), R = this.R;
    return T.map((r) => {
      const one = [r];
      const t = { testId: num(r.TEST_ID), type: String(R.first("TEST", one, "type") ?? ""),
        name: String(R.first("TEST", one, "name") ?? r.TEST_ID), lat: R.first("TEST", one, "lat", true),
        lon: R.first("TEST", one, "lon", true) };
      let k = KIND_BY_TYPE[t.type.toUpperCase().trim()];
      if (!k) {
        if (this.rows("SCPT", t.testId).length) k = "CPT";
        else if (this.rows("ISPT", t.testId).length || this.rows("STRA", t.testId).length) k = "Borehole";
        else if (this.rows("SWVD", t.testId).length) k = "Vs";
        else k = t.type || "Other";
      }
      t.kind = k;
      return t;
    });
  }
  test(tid) { return this.tests.find((t) => t.testId === tid); }
  label(tid) { const t = this.test(tid); return t ? `${t.kind} ${t.name} (TEST_ID ${tid})` : `TEST ${tid}`; }

  idsFor(table, tid) {
    return new Set(this.rows(table, tid).map((r) => num(r[table + "_ID"])).filter(fin));
  }
  rows(table, tid) {
    const rows = this.t(table);
    if (!rows.length || tid === null || tid === undefined) return [];
    const cols = columns(rows);
    if (cols.includes("TEST_ID")) return rows.filter((r) => num(r.TEST_ID) === tid);
    const parent = PARENT_OF[table];
    if (parent && cols.includes(parent + "_ID")) {
      const p = this.idsFor(parent, tid);
      return rows.filter((r) => p.has(num(r[parent + "_ID"])));
    }
    return [];
  }

  gwtSources() {
    if (this._gwt) return this._gwt;
    const out = [];
    for (const t of this.tests) {
      for (const table of ["SCPG", "BORH"]) {
        const v = this.R.get(table, this.rows(table, t.testId), "gwt", true);
        (v || []).filter(fin).forEach((d) => out.push({ source: table, testId: t.testId, depth: d }));
      }
      const w = this.R.get("WATR", this.rows("WATR", t.testId), "depth", true);
      (w || []).filter(fin).forEach((d) => out.push({ source: "WATR", testId: t.testId, depth: d }));
    }
    return (this._gwt = out);
  }
  gwtFor(tid) {
    const own = this.gwtSources().filter((g) => g.testId === tid);
    if (own.length) return { gwt: median(own.map((g) => g.depth)), src: "own" };
    const all = this.gwtSources();
    if (all.length) return { gwt: median(all.map((g) => g.depth)), src: "site" };
    return { gwt: null, src: null };
  }
}

function adder(out, group, target, testId) {
  return (status, check, message, where = "", depths = null, points = null) =>
    out.push({ status, group, check, message, target, where, testId, depths: depths || [], points: points || [] });
}

// ------------------------------------------------------------------ CPT
export function cptData(ctx, tid) {
  const R = ctx.R, raw = ctx.rows("SCPT", tid);
  if (!raw.length) return { df: null, meta: {} };
  const get = (k) => R.get("SCPT", raw, k, true) || raw.map(() => NaN);
  const df = { depth: get("depth"), qc: get("qc"), fs: get("fs"), u2: get("u2"), qt: get("qt"), ic: get("ic") };
  const g = ctx.rows("SCPG", tid);
  const car = R.first("SCPG", g, "car", true);
  const { gwt, src } = ctx.gwtFor(tid);
  const cols = Object.fromEntries(["depth", "qc", "fs", "u2", "qt", "ic"].map((k) => [k, R.col("SCPT", raw, k)]));
  return { df, meta: { car: fin(car) ? car : null, gwt, gwtSrc: src, cols } };
}

function sortDedup(df) {
  const idx = [...df.depth.keys()].filter((i) => fin(df.depth[i])).sort((i, j) => df.depth[i] - df.depth[j]);
  const keep = idx.filter((i, k) => k === 0 || df.depth[i] !== df.depth[idx[k - 1]]);
  return Object.fromEntries(Object.entries(df).map(([k, v]) => [k, keep.map((i) => v[i])]));
}

export function checkCpt(ctx, tid) {
  const out = [], add = adder(out, "CPT", ctx.label(tid), tid);
  const { df: raw0, meta } = cptData(ctx, tid);
  if (!raw0) { add("FAIL", "Data present", "Test is a CPT but no cone penetration data rows (SCPT) were found."); return { findings: out, der: null, meta, raw: null }; }
  const missing = ["depth", "qc", "fs"].filter((k) => !meta.cols[k]);
  if (missing.length) { add("UNSURE", "Field mapping", `Could not find columns for ${missing.join(", ")}; fix on the Schema page.`); return { findings: out, der: null, meta, raw: null }; }

  // 1 depth order
  const d0 = raw0.depth, bad = [];
  for (let i = 1; i < d0.length; i++) if (!(d0[i] > d0[i - 1])) bad.push(d0[i]);
  if (bad.length) add("FAIL", "Depth order", `${bad.length} rows where depth does not increase (duplicates or out of order).`, fmtDepths(bad), bad);
  else add("PASS", "Depth order", `${d0.length} readings, depth strictly increasing (${min(d0).toFixed(2)}–${max(d0).toFixed(2)} m).`);
  const df = sortDedup(raw0);
  const d = df.depth, qc = df.qc, fs = df.fs, u2 = df.u2, n = d.length;

  // 2 gaps
  const steps = d.slice(1).map((x, i) => x - d[i]);
  const step = median(steps);
  const gapLim = Math.max(THRESH.cpt_gap_m, fin(step) ? 10 * step : 0);
  const gaps = steps.map((s, i) => [s, i]).filter(([s]) => s > gapLim).map(([, i]) => i);
  if (gaps.length) add("UNSURE", "Data gaps", `${gaps.length} gap(s) larger than ${gapLim.toFixed(2)} m (typical spacing ${(step * 100).toFixed(1)} cm). Could be predrilling or obstructions – check the source log.`,
    "depth " + gaps.slice(0, 6).map((i) => `${d[i].toFixed(2)}–${d[i + 1].toFixed(2)} m`).join(", "), gaps.flatMap((i) => [d[i], d[i + 1]]));
  if (d[0] > 1.5) add("UNSURE", "Start depth", `First reading at ${d[0].toFixed(2)} m. Predrilled? Confirm in the reference.`, `depth 0–${d[0].toFixed(2)} m`, [d[0]]);

  // 3 units
  const rf = qc.map((q, i) => (fs[i] / (q * 1000)) * 100);
  const pos = qc.map((q, i) => i).filter((i) => qc[i] > 0);
  const medRf = median(pos.map((i) => rf[i])), medQc = median(pos.map((i) => qc[i]));
  let unitOk = true;
  if (medQc > 200) { unitOk = false; add("FAIL", "Units", `Median qc = ${medQc.toFixed(0)}; expected MPa (typically 0.5–50). qc looks like it was entered in kPa.`, "whole sounding"); }
  if (fin(medRf)) {
    if (medRf > 30) { unitOk = false; add("FAIL", "Units", `Median Rf = ${medRf.toFixed(0)}% (expected 0.2–8%). fs appears ~1000× too large or qc too small.`, "whole sounding"); }
    else if (medRf < 0.03) { unitOk = false; add("FAIL", "Units", `Median Rf = ${medRf.toFixed(3)}% (expected 0.2–8%). fs appears to be in MPa instead of kPa.`, "whole sounding"); }
  }
  const lq = qc.map((q) => Math.log10(Math.max(q, 1e-4)));
  const jumps = [];
  for (let i = 1; i < n; i++) if (Math.abs(lq[i] - lq[i - 1]) > 2.3) jumps.push(d[i]);
  if (jumps.length) { unitOk = false; add("FAIL", "Unit jump", `qc changes by >200× between consecutive readings at ${jumps.length} point(s) – likely a block entered in different units.`, fmtDepths(jumps), jumps); }
  if (unitOk) add("PASS", "Units", `Median qc = ${medQc.toFixed(2)} MPa, median Rf = ${medRf.toFixed(2)}% – consistent with MPa / kPa.`);

  // 4 ranges
  const badq = d.filter((z, i) => qc[i] <= 0 || qc[i] > THRESH.qc_max_mpa);
  if (badq.length) add("FAIL", "qc range", `${badq.length} readings with qc ≤ 0 or > ${THRESH.qc_max_mpa} MPa.`, fmtDepths(badq), badq);
  const neg = d.filter((z, i) => fs[i] < -2);
  if (neg.length) add("FAIL", "fs range", `${neg.length} readings with fs < −2 kPa.`, fmtDepths(neg), neg);
  const sneg = d.filter((z, i) => fs[i] < 0 && fs[i] >= -2);
  if (sneg.length) add("UNSURE", "fs range", `${sneg.length} slightly negative fs values (zero drift?).`, fmtDepths(sneg), sneg);
  const hiRf = d.filter((z, i) => rf[i] > THRESH.rf_max_pct);
  if (hiRf.length && unitOk) add("UNSURE", "Friction ratio", `${hiRf.length} readings with Rf > ${THRESH.rf_max_pct}% (possible sleeve/tip depth offset).`, fmtDepths(hiRf), hiRf);
  if (!badq.length && !neg.length && !(hiRf.length && unitOk)) add("PASS", "Value ranges", "qc, fs and Rf within physical ranges.");

  // 5 spikes
  const spikes = [];
  for (let i = 0; i < n; i++) {
    const w = lq.slice(Math.max(0, i - 2), i + 3);
    if (w.length >= 3 && Math.abs(lq[i] - median(w)) > Math.log10(5)) spikes.push(d[i]);
  }
  if (spikes.length) add("UNSURE", "Spikes", `${spikes.length} isolated qc spikes (>5× local median). Could be thin layers or digitising errors.`, fmtDepths(spikes), spikes);

  // 6 cone area ratio
  const car = meta.car;
  if (car === null) add("UNSURE", "Cone area ratio", "Cone area ratio not reported; a = 0.8 assumed for qt.");
  else if (car < 0.5 || car > 0.9) add("FAIL", "Cone area ratio", `a = ${car} is outside 0.5–0.9.`);
  else add("PASS", "Cone area ratio", `a = ${car}.`);

  const gwt = meta.gwt;
  const hasU2 = u2.some(fin);
  const der = cptDerived(d, qc, fs, hasU2 ? u2 : null, car ?? 0.8, gwt);

  // 7 GWT from u2
  if (!hasU2) add("UNSURE", "Pore pressure", "No u2 data – GWT cannot be cross-checked from pore pressure.");
  else if (gwt === null) add("UNSURE", "Pore pressure", "u2 present but no GWT reported for this site.");
  else {
    const sand = d.map((z, i) => i).filter((i) => der.Ic[i] < 2.05 && d[i] > gwt + 0.5 && fin(u2[i]));
    if (sand.length >= 5) {
      const zw = median(sand.map((i) => d[i] - u2[i] / GAMMA_W));
      const rel = median(sand.map((i) => Math.abs(u2[i] - der.u0[i]) / Math.max(der.u0[i], 10)));
      const diff = Math.abs(zw - gwt);
      const [p, u] = THRESH.gwt_diff_m;
      let st = diff <= p ? "PASS" : diff <= u ? "UNSURE" : "FAIL", msg;
      if (median(sand.map((i) => Math.abs(u2[i]))) < 5) { st = "FAIL"; msg = `u2 ≈ 0 in sands below the reported GWT (${gwt.toFixed(2)} m). Pore pressure not recorded, filter not saturated, or wrong units.`; }
      else msg = `In clean-sand layers u2 implies GWT ≈ ${zw.toFixed(2)} m vs reported ${gwt.toFixed(2)} m (Δ = ${diff.toFixed(2)} m; median |u2−u0|/u0 = ${(rel * 100).toFixed(0)}%).`;
      const lo = Math.min(gwt, fin(zw) ? zw : gwt), hi = Math.max(gwt, fin(zw) ? zw : gwt);
      const band = []; for (let z = lo; z <= hi + 1e-6; z += 0.1) band.push(z);
      add(st, "GWT vs u2", msg, `reported ${gwt.toFixed(2)} m vs u2-implied ${fmtNum(zw)} m`, st === "PASS" ? null : band);
    } else add("UNSURE", "GWT vs u2", "Too few clean-sand readings below the GWT to infer the GWT from u2.");
  }

  // 8 stored Ic / qt
  if (df.ic.filter(fin).length > 5) {
    const dif = df.ic.map((x, i) => Math.abs(x - der.Ic[i]));
    const badI = d.filter((z, i) => dif[i] > THRESH.ic_diff);
    const frac = badI.length / df.ic.filter(fin).length;
    const st = frac < 0.1 ? "PASS" : frac < 0.3 ? "UNSURE" : "FAIL";
    add(st, "Stored Ic", `Stored Ic differs from recomputed (Robertson 2009) by >${THRESH.ic_diff} at ${(frac * 100).toFixed(0)}% of depths.`, st === "PASS" ? "" : fmtDepths(badI), st === "PASS" ? null : badI);
  }
  if (df.qt.filter(fin).length > 5) {
    const badT = d.filter((z, i) => Math.abs(df.qt[i] - der.qt_mpa[i]) / Math.max(der.qt_mpa[i], 0.05) > 0.05);
    const frac = badT.length / df.qt.filter(fin).length;
    add(frac < 0.1 ? "PASS" : frac < 0.3 ? "UNSURE" : "FAIL", "Stored qt", `Stored qt differs from qc + u2(1−a) by >5% at ${(frac * 100).toFixed(0)}% of depths.`);
  }
  if (d[n - 1] > 60) add("UNSURE", "Total depth", `Sounding reaches ${d[n - 1].toFixed(1)} m – unusually deep; check units (ft?).`);

  // 10 vs nearby boring logs
  out.push(...cptVsBoreholes(ctx, tid, der));
  return { findings: out, der, meta, raw: df };
}
const fmtNum = (x) => (fin(x) ? x.toFixed(2) : "?");

function cptVsBoreholes(ctx, tid, der) {
  const res = [], me = ctx.test(tid);
  if (!me) return res;
  for (const bh of ctx.tests.filter((t) => t.kind === "Borehole")) {
    const dist = [me.lat, me.lon, bh.lat, bh.lon].every(fin) ? haversine(me.lat, me.lon, bh.lat, bh.lon) : NaN;
    if (!(dist <= 50)) continue;
    const lay = layerData(ctx, bh.testId);
    if (!lay) continue;
    let agree = 0, total = 0; const bad = [];
    for (const L of lay) {
      const g = uscsGroup(L.uscs);
      if (g !== "coarse" && g !== "fine") continue;
      const ics = der.depth.map((z, i) => (z >= L.top && z < L.base ? der.Ic[i] : NaN)).filter(fin);
      if (ics.length < 3) continue;
      const icm = median(ics), cg = icm < 2.6 ? "coarse" : "fine";
      total++;
      if (cg === g) agree++; else bad.push([L.top, L.base, L.uscs, icm]);
    }
    if (!total) continue;
    res.push({ status: agree / total >= 0.7 ? "PASS" : "UNSURE", group: "CPT", check: "CPT vs boring log",
      message: `Soil type agrees with ${ctx.label(bh.testId)} (${dist.toFixed(0)} m away) in ${agree}/${total} layers. Disagreement can be spatial variability – not marked as inconsistent automatically.`,
      target: ctx.label(tid), where: bad.slice(0, 5).map(([a, b, c, ic]) => `${a.toFixed(1)}–${b.toFixed(1)} m: log ${c}, CPT Ic=${ic.toFixed(2)}`).join("; "),
      testId: tid, depths: bad.flatMap(([a, b]) => [a, b]), points: [] });
  }
  return res;
}

// ------------------------------------------------------------------ Borehole
export function sptData(ctx, tid) {
  const raw = ctx.rows("ISPT", tid), R = ctx.R;
  if (!raw.length) return null;
  const top = R.get("ISPT", raw, "top", true);
  if (!top) return null;
  const g = (k) => R.get("ISPT", raw, k, true) || raw.map(() => NaN);
  const rows = top.map((z, i) => ({ depth: z, n: g("n")[i], er: g("er")[i], n60: g("n60")[i] }));
  return rows.sort((a, b) => a.depth - b.depth);
}
export function layerData(ctx, tid) {
  const R = ctx.R;
  for (const tbl of ["STRA", "DETL"]) {
    const raw = ctx.rows(tbl, tid);
    if (!raw.length) continue;
    const top = R.get(tbl, raw, "top", true);
    if (!top) continue;
    const base = R.get(tbl, raw, "base", true), desc = R.get(tbl, raw, "desc"), code = R.get(tbl, raw, "uscs");
    return top.map((t, i) => {
      const dsc = desc ? String(desc[i] ?? "") : "";
      const c = code && typeof code[i] === "string" && code[i].trim() ? code[i].trim() : uscsFromText(dsc);
      return { top: t, base: base ? base[i] : NaN, desc: dsc, uscs: c, table: tbl };
    }).sort((a, b) => a.top - b.top);
  }
  return null;
}
export function sampleData(ctx, tid) {
  const R = ctx.R;
  let S = ctx.rows("SAMP", tid);
  const J = ctx.t("SAMP_TEST");
  if (J.length && "SAMP_ID" in J[0]) {
    const sids = new Set(J.filter((r) => num(r.TEST_ID) === tid).map((r) => num(r.SAMP_ID)));
    const extra = ctx.t("SAMP").filter((r) => sids.has(num(r.SAMP_ID)) && !S.includes(r));
    S = S.concat(extra);
  }
  if (!S.length) return null;
  const top = R.get("SAMP", S, "top", true), base = R.get("SAMP", S, "base", true), us = R.get("SAMP", S, "uscs");
  const out = S.map((r, i) => ({ sampId: num(r.SAMP_ID), top: top ? top[i] : NaN, base: base ? base[i] : NaN,
    uscs: us ? us[i] : null, fines: NaN, ll: NaN, pl: NaN, pi: NaN }));
  for (const [tbl, keys] of [["GRAG", ["fines"]], ["PLAS", ["ll", "pl", "pi"]]]) {
    const L = ctx.t(tbl);
    if (!L.length) continue;
    for (const k of keys) {
      const v = R.get(tbl, L, k, true);
      if (!v) continue;
      const m = new Map(L.map((r, i) => [num(r.SAMP_ID), v[i]]));
      out.forEach((s) => { if (m.has(s.sampId)) s[k] = m.get(s.sampId); });
    }
  }
  return out;
}

export function checkBorehole(ctx, tid) {
  const out = [], add = adder(out, "Borehole/SPT", ctx.label(tid), tid);
  const spt = sptData(ctx, tid), lay = layerData(ctx, tid), samp = sampleData(ctx, tid);
  const bhd = ctx.R.first("BORH", ctx.rows("BORH", tid), "depth", true);
  const bhDepth = fin(bhd) ? bhd : null;
  const data = { spt, layers: lay, samples: samp, depth: bhDepth };
  if (!spt && !lay) { add("FAIL", "Data present", "Borehole has neither SPT results nor layer descriptions."); return { findings: out, data }; }

  if (!spt || !spt.length) add("UNSURE", "SPT", "No SPT blow counts for this borehole.");
  else {
    const d = spt.map((s) => s.depth);
    const raw = ctx.R.get("ISPT", ctx.rows("ISPT", tid), "top", true);
    const dup = d.filter((z, i) => i > 0 && z === d[i - 1]);
    const ooo = raw.filter((z, i) => i > 0 && z < raw[i - 1]);
    if (dup.length || ooo.length) add("FAIL", "SPT depth order", `${dup.length + ooo.length} SPT depths duplicated or out of order.`, fmtDepths(dup.concat(ooo)), dup.concat(ooo));
    else add("PASS", "SPT depth order", `${d.length} SPT tests, depths increasing.`);
    if (bhDepth !== null) {
      const deep = d.filter((z) => z > bhDepth + 0.5);
      if (deep.length) add("FAIL", "SPT within hole", `SPT below the borehole final depth (${bhDepth} m).`, fmtDepths(deep), deep);
    }
    const N = spt.map((s) => s.n);
    if (!N.some(fin)) add("FAIL", "SPT N", "SPT rows present but no N values.");
    else {
      const negs = d.filter((z, i) => N[i] < 0), his = d.filter((z, i) => N[i] > 100);
      if (negs.length) add("FAIL", "SPT N", "Negative N values.", fmtDepths(negs), negs);
      if (his.length) add("UNSURE", "SPT N", `${his.length} N > 100 – refusal? Confirm against the log.`, fmtDepths(his), his);
      if (!negs.length && !his.length) add("PASS", "SPT N", `N between ${min(N)} and ${max(N)}.`);
    }
    const ER = spt.map((s) => s.er);
    if (!ER.some(fin)) add("UNSURE", "Energy ratio", "Hammer energy ratio not reported (needed for N60).");
    else {
      const b = d.filter((z, i) => ER[i] < 40 || ER[i] > 100);
      add(b.length ? "FAIL" : "PASS", "Energy ratio", b.length ? `ER outside 40–100% at ${b.length} test(s).` : `ER ${min(ER)}–${max(ER)}%.`, fmtDepths(b), b);
      const N60 = spt.map((s) => s.n60);
      if (N60.some(fin)) {
        const bb = d.filter((z, i) => Math.abs(N60[i] - (N[i] * ER[i]) / 60) > Math.max(1, (0.1 * N[i] * ER[i]) / 60));
        add(bb.length ? "FAIL" : "PASS", "N60", bb.length ? `Stored N60 ≠ N·ER/60 at ${bb.length} test(s).` : "Stored N60 = N·ER/60.", fmtDepths(bb), bb);
      }
    }
  }

  if (!lay || !lay.length) add("UNSURE", "Layers", "No layer descriptions (STRA/DETL).");
  else {
    const inv = lay.filter((L) => fin(L.base) && L.base <= L.top).map((L) => L.top);
    if (inv.length) add("FAIL", "Layer geometry", "Layer base ≤ top.", fmtDepths(inv), inv);
    const gaps = [], ovl = [];
    for (let i = 0; i < lay.length - 1; i++) {
      const b = lay[i].base, t = lay[i + 1].top;
      if (!fin(b)) continue;
      if (t - b > 0.05) gaps.push([b, t]); else if (b - t > 0.05) ovl.push([t, b]);
    }
    if (ovl.length) add("FAIL", "Layer overlaps", `${ovl.length} overlapping layers.`, ovl.map(([a, b]) => `${a.toFixed(2)}–${b.toFixed(2)} m`).join("; "), ovl.flat());
    if (gaps.length) add("UNSURE", "Layer gaps", `${gaps.length} undescribed interval(s) between layers.`, gaps.map(([a, b]) => `${a.toFixed(2)}–${b.toFixed(2)} m`).join("; "), gaps.flat());
    const maxB = max(lay.map((L) => L.base));
    if (!inv.length && !ovl.length && !gaps.length) add("PASS", "Layer geometry", `${lay.length} contiguous layers, 0–${fmtNum(maxB)} m.`);
    if (bhDepth !== null && fin(maxB) && Math.abs(maxB - bhDepth) > 0.5) add("UNSURE", "Log vs hole depth", `Deepest layer base ${maxB.toFixed(2)} m vs borehole depth ${bhDepth.toFixed(2)} m.`);
  }

  // N vs description
  if (spt && lay && spt.length) {
    const [ok, uns] = THRESH.spt_class_offset;
    let pass = 0; const U = [], F = [];
    for (const s of spt) {
      if (!fin(s.n)) continue;
      const L = lay.find((l) => l.top <= s.depth && (!fin(l.base) || l.base > s.depth));
      if (!L) continue;
      const cc = consistencyClass(L.desc);
      if (!cc) continue;
      const off = Math.abs(nClass(cc.scale, s.n) - cc.idx), term = cc.scale[cc.idx][0];
      if (off <= ok) pass++; else if (off <= uns) U.push([s.depth, s.n, term]); else F.push([s.depth, s.n, term]);
    }
    for (const [st, arr] of [["FAIL", F], ["UNSURE", U]]) {
      if (arr.length) add(st, "N vs description", `${arr.length} SPT N value(s) ${st === "FAIL" ? "far " : ""}outside the range implied by the logged density/consistency term.`,
        arr.slice(0, 6).map(([z, n, t]) => `${z.toFixed(1)} m: N=${n} but '${t}'`).join("; "), arr.map((a) => a[0]));
    }
    if (pass && !F.length && !U.length) add("PASS", "N vs description", `All ${pass} N values match the logged density/consistency terms.`);
  }

  // lab vs classification
  if (samp && samp.length) {
    let nChk = 0; const iF = [], iU = [];
    for (const s of samp) {
      const z = s.top;
      let code = typeof s.uscs === "string" && s.uscs.trim() ? s.uscs : null;
      if (!code && lay && fin(z)) { const L = lay.find((l) => l.top <= z && (!fin(l.base) || l.base > z)); code = L ? L.uscs : null; }
      const rng = fcRangeForUscs(code), tol = THRESH.uscs_fc_tol;
      if (rng && fin(s.fines)) {
        nChk++;
        if (s.fines < rng[0] - tol || s.fines > rng[1] + tol) {
          const far = s.fines < rng[0] - 3 * tol || s.fines > rng[1] + 3 * tol;
          ((far && !String(code).endsWith("?")) ? iF : iU).push([z, `${code} but FC=${s.fines.toFixed(0)}% (expected ${rng[0]}–${rng[1]}%)`]);
        }
      }
      if (fin(s.ll) && fin(s.pl)) {
        nChk++;
        if (s.pl > s.ll) iF.push([z, `PL=${s.pl} > LL=${s.ll}`]);
        if (fin(s.pi) && Math.abs(s.pi - (s.ll - s.pl)) > 1.5) iF.push([z, `PI=${s.pi} ≠ LL−PL=${s.ll - s.pl}`]);
        const pi = fin(s.pi) ? s.pi : s.ll - s.pl;
        if (uscsGroup(code) === "fine") {
          const aline = 0.73 * (s.ll - 20), c0 = code.toUpperCase().slice(0, 2);
          if ((["CL", "CH"].includes(c0) && pi < aline - 4) || (["ML", "MH"].includes(c0) && pi > aline + 4)) iU.push([z, `${code} but PI=${pi}, LL=${s.ll} plots on the other side of the A-line`]);
          if ((["CL", "ML"].includes(c0) && s.ll > 52) || (["CH", "MH"].includes(c0) && s.ll < 48)) iU.push([z, `${code} but LL=${s.ll}`]);
        }
      }
    }
    if (nChk) {
      for (const [st, arr] of [["FAIL", iF], ["UNSURE", iU]]) {
        if (arr.length) add(st, "Lab vs classification", `${arr.length} lab result(s) conflict with the soil classification.`,
          arr.slice(0, 6).map(([z, t]) => (fin(z) ? `${z.toFixed(1)} m: ${t}` : t)).join("; "), arr.map((a) => a[0]).filter(fin));
      }
      if (!iF.length && !iU.length) add("PASS", "Lab vs classification", `${nChk} lab checks consistent with the USCS classification.`);
    }
    if (bhDepth !== null) {
      const deep = samp.map((s) => s.top).filter((z) => z > bhDepth + 0.5);
      if (deep.length) add("FAIL", "Samples within hole", "Sample depth below the borehole final depth.", fmtDepths(deep), deep);
    }
  }
  return { findings: out, data };
}

// ------------------------------------------------------------------ Vs
export function vsData(ctx, tid) {
  const R = ctx.R, raw = ctx.rows("SWVD", tid);
  const profiles = [];
  if (raw.length) {
    const groups = new Map();
    raw.forEach((r) => { const k = "SWVG_ID" in r ? r.SWVG_ID : tid; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
    for (const [pid, g] of groups) {
      const top = R.get("SWVD", g, "top", true), vs = R.get("SWVD", g, "vs", true);
      if (!top || !vs) continue;
      const thk = R.get("SWVD", g, "thk", true), vp = R.get("SWVD", g, "vp", true);
      const L = vsLayers(top, thk, vs);
      profiles.push({ id: pid, top: L.top, base: L.base, vs: L.vs, vp: vp ? L.order.map((i) => vp[i]) : L.top.map(() => NaN),
        thkGiven: !!thk, rawTop: top, thk: thk ? L.order.map((i) => thk[i]) : null });
    }
  }
  let disp = null;
  const D = ctx.rows("GSWD", tid);
  if (D.length) {
    const f = R.get("GSWD", D, "freq", true), v = R.get("GSWD", D, "vel", true), w = R.get("GSWD", D, "wavelength", true);
    if (v && (f || w)) disp = v.map((vel, i) => ({ freq: f ? f[i] : NaN, vel, wavelength: w ? w[i] : vel / f[i] }));
  }
  return { profiles, disp };
}

export function checkVs(ctx, tid, cptDers) {
  const out = [], add = adder(out, "Vs", ctx.label(tid), tid);
  const { profiles, disp } = vsData(ctx, tid);
  if (!profiles.length) { add("FAIL", "Data present", "Vs test without a layered velocity profile (SWVD)."); return { findings: out, data: { profiles, disp } }; }
  const { gwt } = ctx.gwtFor(tid);
  for (const p of profiles) {
    const lab = `profile ${p.id}`, { top: t, base: b, vs: v, vp } = p;
    if (new Set(p.rawTop).size !== p.rawTop.length) add("FAIL", "Layer geometry", `${lab}: duplicate layer tops.`);
    if (t[0] > 0.01) add("FAIL", "Layer geometry", `${lab}: first layer starts at ${t[0].toFixed(2)} m, not at the surface.`);
    if (p.thkGiven) {
      const mism = [];
      for (let i = 0; i < t.length - 1; i++) { const be = t[i] + p.thk[i]; if (fin(be) && Math.abs(be - t[i + 1]) > 0.05) mism.push(t[i + 1]); }
      if (mism.length) add("FAIL", "Layer geometry", `${lab}: top + thickness ≠ next layer top.`, fmtDepths(mism), mism);
    }
    const bad = t.filter((z, i) => !(v[i] >= 30 && v[i] <= 3500));
    if (bad.length) add("FAIL", "Vs range", `${lab}: Vs outside 30–3500 m/s.`, fmtDepths(bad), bad);
    if (vp.some(fin)) {
      const bp = t.filter((z, i) => fin(vp[i]) && vp[i] <= v[i]);
      if (bp.length) add("FAIL", "Vp > Vs", `${lab}: Vp ≤ Vs.`, fmtDepths(bp), bp);
      if (gwt !== null) {
        const lp = t.filter((z, i) => fin(vp[i]) && z > gwt + 1 && vp[i] < 1300);
        if (lp.length) add("UNSURE", "Vp below GWT", `${lab}: Vp < 1300 m/s below the GWT (${gwt.toFixed(1)} m) – unsaturated, or GWT wrong?`, fmtDepths(lp), lp);
      }
    }
    const drops = t.slice(1).filter((z, i) => v[i + 1] < 0.6 * v[i]);
    if (drops.length) add("UNSURE", "Velocity reversal", `${lab}: Vs drops by >40% with depth.`, fmtDepths(drops), drops);
    const calc = vs30(t, b, v);
    if (!bad.length && !drops.length) add("PASS", "Vs profile", `${lab}: ${t.length} layers, Vs ${min(v)}–${max(v)} m/s, VS30 = ${calc.toFixed(0)} m/s.`);
    const s30 = ctx.R.first("SWVG", ctx.rows("SWVG", tid), "vs30", true);
    if (fin(s30)) add(Math.abs(s30 - calc) / calc <= 0.05 ? "PASS" : "FAIL", "VS30", `Stored VS30 = ${s30.toFixed(0)} vs computed ${calc.toFixed(0)} m/s.`);

    if (disp && disp.length > 3) {
      const ratios = [];
      for (const r of disp) {
        const z = r.wavelength / 2.5;
        if (!(z > 0) || !fin(r.vel)) continue;
        const pred = 0.92 * vsAvgTo(t, b, v, Math.min(z, max(t) + 20));
        if (pred > 0) ratios.push(r.vel / pred);
      }
      if (ratios.length) {
        const m = median(ratios);
        add(m >= 0.8 && m <= 1.25 ? "PASS" : "UNSURE", "Dispersion vs profile", `Measured phase velocity / approximate profile prediction (λ/2.5 rule): median ${m.toFixed(2)}. Approximate check only.`);
      }
    }
    const me = ctx.test(tid);
    for (const [cidS, der] of Object.entries(cptDers || {})) {
      const cid = Number(cidS), c = ctx.test(cid);
      if (!der || !c) continue;
      const dist = [me.lat, me.lon, c.lat, c.lon].every(fin) ? haversine(me.lat, me.lon, c.lat, c.lon) : NaN;
      if (fin(dist) && dist > 100) continue;
      const vc = vsFromCpt(der), rat = [];
      for (let i = 0; i < t.length; i++) {
        const sel = der.depth.map((z, k) => (z >= t[i] && z < b[i] ? vc[k] : NaN)).filter(fin);
        if (sel.length >= 5) rat.push(v[i] / median(sel));
      }
      if (!rat.length) continue;
      const r = median(rat), rr = Math.max(r, 1 / r), [p_, u_] = THRESH.vs_cpt_ratio;
      add(rr <= p_ ? "PASS" : rr <= u_ ? "UNSURE" : "FAIL", "Vs vs CPT correlation",
        `Measured Vs / CPT-based Vs (Robertson 2009) for ${ctx.label(cid)} (${fin(dist) ? dist.toFixed(0) + " m away" : "distance unknown"}): median ratio ${r.toFixed(2)}. The correlation scatter is large; only gross mismatches (e.g. ft/s vs m/s) are marked inconsistent.`);
    }
  }
  return { findings: out, data: { profiles, disp } };
}

// ------------------------------------------------------------------ Field observations
export function obsData(ctx, fid) {
  const R = ctx.R;
  const row = ctx.t("FLDO").filter((r) => num(r.FLDO_ID) === fid);
  const info = { id: fid, lat: R.first("FLDO", row, "lat", true), lon: R.first("FLDO", row, "lon", true),
    date: R.first("FLDO", row, "date"), manif: R.first("FLDO", row, "manif"), event: R.first("FLDO", row, "event") };
  const er = ctx.t("EVNT").filter((r) => num(r.EVNT_ID) === num(info.event));
  info.evnt = er.length ? { name: R.first("EVNT", er, "name"), date: R.first("EVNT", er, "date"), mag: R.first("EVNT", er, "mag", true),
    lat: R.first("EVNT", er, "lat", true), lon: R.first("EVNT", er, "lon", true) } : null;
  const sub = (t) => ctx.t(t).filter((r) => num(r.FLDO_ID) === fid);
  const D = sub("FLDD");
  info.vectors = D.length ? (() => {
    const g = (k) => R.get("FLDD", D, k, true) || D.map(() => NaN);
    const lat = g("lat"), lon = g("lon"), de = g("de"), dn = g("dn"), mag = g("mag"), az = g("azim");
    return D.map((_, i) => {
      const e = fin(de[i]) ? de[i] : mag[i] * Math.sin((az[i] || 0) * Math.PI / 180);
      const nn = fin(dn[i]) ? dn[i] : mag[i] * Math.cos((az[i] || 0) * Math.PI / 180);
      return { lat: lat[i], lon: lon[i], de: e, dn: nn, mag: mag[i], hasComp: fin(de[i]) && fin(dn[i]) };
    });
  })() : null;
  const M = sub("FLDM");
  info.manifest = M.length ? M.map((r, i) => ({ lat: (R.get("FLDM", M, "lat", true) || [])[i], lon: (R.get("FLDM", M, "lon", true) || [])[i],
    type: (R.get("FLDM", M, "type") || [])[i] ?? "", severity: (R.get("FLDM", M, "severity") || [])[i] ?? "" })) : null;
  const GM = sub("GMIM");
  info.pga = null;
  const tc = R.col("GMIM", GM, "type"), vc = R.col("GMIM", GM, "value");
  if (GM.length && tc && vc) {
    const p = GM.filter((r) => String(r[tc]).toUpperCase().includes("PGA")).map((r) => num(r[vc]));
    if (p.length) info.pga = median(p);
  }
  return info;
}
const yes = (x) => {
  if (x === null || x === undefined || (typeof x === "number" && !fin(x))) return null;
  const s = String(x).trim().toLowerCase();
  if (["1", "true", "yes", "y"].includes(s)) return true;
  if (["0", "false", "no", "n", "none"].includes(s)) return false;
  return null;
};

export function checkObs(ctx, fid, cptDers) {
  const out = [], info = obsData(ctx, fid);
  const ev = info.evnt;
  const add = adder(out, "Field observation", `Observation FLDO_ID ${fid}` + (ev?.name ? ` – ${ev.name}` : ""), null);
  const [p, u] = THRESH.test_site_dist_m;
  if (fin(info.lat) && fin(ctx.siteLat)) {
    const dist = haversine(ctx.siteLat, ctx.siteLon, info.lat, info.lon);
    add(dist <= p ? "PASS" : dist <= u ? "UNSURE" : "FAIL", "Location", `Observation is ${dist.toFixed(0)} m from the site coordinates.`,
      `(${info.lat.toFixed(5)}, ${info.lon.toFixed(5)})`, null, [[info.lat, info.lon]]);
  }
  if (!ev) add("FAIL", "Event", "Observation is not linked to an event (EVNT).");
  else {
    if (!fin(ev.mag)) add("UNSURE", "Event magnitude", "Event has no magnitude.");
    if (fin(ev.lat) && fin(ctx.siteLat)) {
      const de = haversine(ctx.siteLat, ctx.siteLon, ev.lat, ev.lon) / 1000, m = fin(ev.mag) ? ev.mag : 7;
      const lim = m < 6 ? 50 : m < 7 ? 150 : 400;
      add(de <= lim ? "PASS" : "UNSURE", "Event distance", `Epicentral distance ${de.toFixed(0)} km for M${m}.` + (de <= lim ? "" : " Unusually far for liquefaction – check the event link or coordinates."));
    }
    if (info.date && ev.date) {
      const od = new Date(info.date), ed = new Date(ev.date);
      if (!isNaN(od) && !isNaN(ed)) {
        if (od < ed - 86400000) add("FAIL", "Dates", `Observation date ${info.date} is before the event (${ev.date}).`);
        else add("PASS", "Dates", `Observation ${info.date} is after the event ${ev.date}.`);
      }
    }
  }
  const pga = info.pga;
  if (pga === null || !fin(pga)) add("UNSURE", "PGA", "No PGA ground-motion intensity for this observation.");
  else if (pga < 0.005 || pga > 2.5) add("FAIL", "PGA", `PGA = ${pga} g is outside 0.005–2.5 g (units cm/s²?).`);
  else add("PASS", "PGA", `PGA = ${pga.toFixed(3)} g.`);

  const V = info.vectors;
  if (V && V.length) {
    const withMag = V.filter((v) => v.hasComp && fin(v.mag));
    if (withMag.length) {
      const bad = withMag.filter((v) => Math.abs(Math.hypot(v.de, v.dn) - v.mag) > Math.max(0.02, 0.05 * v.mag));
      add(bad.length ? "FAIL" : "PASS", "Vector magnitude", bad.length ? `${bad.length} vector(s) where the stored magnitude ≠ √(E²+N²).` : "Stored magnitudes match the components.",
        bad.map((v) => `(${v.lat.toFixed(5)}, ${v.lon.toFixed(5)})`).slice(0, 5).join("; "), null, bad.map((v) => [v.lat, v.lon]));
    }
    const big = V.filter((v) => Math.hypot(v.de, v.dn) > THRESH.disp_mag_m);
    if (big.length) add("UNSURE", "Vector size", `${big.length} displacement(s) > ${THRESH.disp_mag_m} m – units (cm?).`, "", null, big.map((v) => [v.lat, v.lon]));
    if (V.length >= 5 && V.every((v) => fin(v.lat))) {
      const outl = [];
      V.forEach((r) => {
        if (Math.hypot(r.de, r.dn) < 0.1) return;
        const nb = V.filter((o) => o !== r && haversine(r.lat, r.lon, o.lat, o.lon) < 200);
        if (nb.length < 3) return;
        const me = Math.atan2(r.de, r.dn) * 180 / Math.PI;
        const md = Math.atan2(median(nb.map((o) => o.de)), median(nb.map((o) => o.dn))) * 180 / Math.PI;
        const dang = Math.abs((((me - md + 180) % 360) + 360) % 360 - 180);
        if (dang > 90) outl.push(r);
      });
      if (outl.length) add("UNSURE", "Vector direction", `${outl.length} vector(s) point >90° away from their neighbours (within 200 m). Possible sign or component swap.`,
        outl.slice(0, 5).map((v) => `(${v.lat.toFixed(5)}, ${v.lon.toFixed(5)})`).join("; "), null, outl.map((v) => [v.lat, v.lon]));
      else add("PASS", "Vector direction", "Displacement directions are spatially coherent.");
    }
  }
  let manif = yes(info.manif);
  if (manif === null && info.manifest) manif = info.manifest.length > 0;
  if (cptDers && fin(pga) && ev && fin(ev.mag) && manif !== null) {
    const lp = {};
    for (const [cid, der] of Object.entries(cptDers)) {
      if (!der || !der.u0.some((x) => x > 0)) continue;
      const r = bi2014(der, pga, ev.mag);
      lp[cid] = lpi(r.depth, r.FS);
    }
    const vals = Object.values(lp).filter(fin);
    if (vals.length) {
      const m = median(vals);
      let st = "PASS", msg = "Observed manifestation agrees with the CPT-based prediction.";
      if (manif && m < 5) { st = "UNSURE"; msg = "Manifestation reported but the CPTs predict little (median LPI < 5)."; }
      else if (!manif && m > 15) { st = "UNSURE"; msg = "No manifestation reported but the CPTs predict severe (median LPI > 15)."; }
      add(st, "Manifestation vs CPT (BI2014/LPI)", msg + " LPI: " + Object.entries(lp).map(([k, v]) => `TEST ${k}: ${v.toFixed(1)}`).join(", ") +
        ` (PGA ${pga.toFixed(2)} g, M${ev.mag}). Model-based; a misprediction is not a data error.`);
    }
  }
  return { findings: out, info };
}

// ------------------------------------------------------------------ Site
export function checkSite(ctx) {
  const out = [], add = adder(out, "Site", `Site ${ctx.siteName}`, null);
  if (!fin(ctx.siteLat) || !fin(ctx.siteLon)) add("FAIL", "Site coordinates", "Site latitude/longitude missing.");
  else {
    if (Math.abs(ctx.siteLat) > 90 || Math.abs(ctx.siteLon) > 180) add("FAIL", "Site coordinates", "Coordinates out of range.");
    const [p, u] = THRESH.test_site_dist_m;
    let ok = 0, flagged = 0;
    for (const t of ctx.tests) {
      if (!fin(t.lat) || !fin(t.lon)) { out.push({ status: "UNSURE", group: "Site", check: "Test location", message: `${ctx.label(t.testId)} has no coordinates.`, target: `Site ${ctx.siteName}`, where: "", testId: t.testId, depths: [], points: [] }); flagged++; continue; }
      const d = haversine(ctx.siteLat, ctx.siteLon, t.lat, t.lon);
      if (d <= p) { ok++; continue; }
      flagged++;
      out.push({ status: d <= u ? "UNSURE" : "FAIL", group: "Site", check: "Test location", message: `${ctx.label(t.testId)} is ${d.toFixed(0)} m from the site coordinates.`,
        target: `Site ${ctx.siteName}`, where: `(${t.lat.toFixed(5)}, ${t.lon.toFixed(5)})`, testId: t.testId, depths: [], points: [[t.lat, t.lon]] });
    }
    if (ok && !flagged) add("PASS", "Test locations", `All ${ok} tests are within ${p} m of the site.`);
    const T = ctx.tests.filter((t) => fin(t.lat) && fin(t.lon));
    for (let i = 0; i < T.length; i++) for (let j = i + 1; j < T.length; j++) {
      if (T[i].kind === T[j].kind && haversine(T[i].lat, T[i].lon, T[j].lat, T[j].lon) < 1)
        add("UNSURE", "Possible duplicate", `${ctx.label(T[i].testId)} and ${ctx.label(T[j].testId)} are at the same location.`);
    }
  }
  const g = ctx.gwtSources();
  if (g.length >= 2) {
    const ds = g.map((x) => x.depth), sp = max(ds) - min(ds), [p, u] = THRESH.gwt_diff_m;
    add(sp <= p ? "PASS" : sp <= u ? "UNSURE" : "FAIL", "GWT agreement", `Reported GWT depths range ${min(ds).toFixed(2)}–${max(ds).toFixed(2)} m across ${g.length} sources (spread ${sp.toFixed(2)} m). Seasonal variation is possible.`,
      g.slice(0, 8).map((x) => `${x.source} TEST ${x.testId}: ${x.depth.toFixed(2)} m`).join("; "));
  } else if (!g.length) add("UNSURE", "GWT", "No groundwater depth reported anywhere at the site.");
  if (!ctx.tests.length) add("FAIL", "Tests", "Site has no field tests.");
  return out;
}

// ------------------------------------------------------------------ run all
export function runAll(bundle, R) {
  const ctx = new SiteContext(bundle, R);
  const findings = [...checkSite(ctx)];
  const perTest = {}, cptDers = {};
  for (const t of ctx.tests.filter((t) => t.kind === "CPT")) {
    const r = checkCpt(ctx, t.testId);
    cptDers[t.testId] = r.der;
    perTest[t.testId] = { kind: "CPT", ...r };
    findings.push(...r.findings);
  }
  for (const t of ctx.tests.filter((t) => t.kind !== "CPT")) {
    let r;
    if (t.kind === "Borehole" || t.kind === "Test pit") r = { kind: t.kind, ...checkBorehole(ctx, t.testId) };
    else if (t.kind === "Vs" || t.kind === "Invasive Vs") r = { kind: "Vs", ...checkVs(ctx, t.testId, cptDers) };
    else r = { kind: t.kind, findings: [{ status: "UNSURE", group: "Other", check: "Not checked", message: `No automatic checks for test type '${t.type}'.`, target: ctx.label(t.testId), where: "", testId: t.testId, depths: [], points: [] }] };
    perTest[t.testId] = r;
    findings.push(...r.findings);
  }
  const obs = {};
  for (const r of ctx.t("FLDO")) {
    const fid = num(r.FLDO_ID);
    if (!fin(fid)) continue;
    obs[fid] = checkObs(ctx, fid, cptDers);
    findings.push(...obs[fid].findings);
  }
  Object.values(perTest).forEach((r) => (r.status = worst(r.findings)));
  Object.values(obs).forEach((r) => (r.status = worst(r.findings)));
  return { ctx, findings, perTest, obs, cptDers };
}

export const sortFindings = (fs) => [...fs].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.group.localeCompare(b.group));
export { mean };
