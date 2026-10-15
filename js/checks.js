// Consistency checks for one NGL site (schema sjbrande_ngl_db).
// Every finding: {status: PASS|FAIL|UNSURE, group, check, message, target, where, testId,
//                 depths: [m], points: [[lat,lon]], sampIds: [SAMP_ID]}
import { THRESH, STATUS_ORDER, GAMMA_W, SCALE } from "./config.js";
import { num, fin, median, mean, min, max, haversine, columns } from "./util.js";
import { cptDerived, vsFromCpt, bi2014, lpi, vsLayers, vs30, vsAvgTo, uscsGroup, uscsFromText,
  fcRangeForUscs, consistencyClass, nClass } from "./geotech.js";

export const worst = (fs) => (fs.length ? fs.map((f) => f.status).sort((a, b) => STATUS_ORDER[a] - STATUS_ORDER[b])[0] : "UNSURE");

// child table -> parent table (the child holds PARENT_ID); SAMP is reached through SAMP_TEST
const PARENT_OF = { SCPT: "SCPG", ISPT: "SAMP", SPEC: "SAMP", GRAG: "SPEC", GRAT: "GRAG", PLAS: "SPEC", INDX: "SPEC",
  RDEN: "SPEC", SWVG: "GSWG", SWVD: "SWVG", GSWD: "GSWG", GIND: "GINV" };
const KIND_BY_TYPE = { SCPG: "CPT", SCPT: "CPT", CPT: "CPT", BORH: "Borehole", TEPT: "Test pit", GSWG: "Vs",
  SWVG: "Vs", GINV: "Vs", OTHF: "Other" };
const USCS_RE = /^((GW|GP|GM|GC|SW|SP|SM|SC|ML|CL|OL|MH|CH|OH|PT)([-/](GW|GP|GM|GC|SW|SP|SM|SC|ML|CL|OL|MH|CH|OH|PT))?)$/;

export function fmtDepths(depths, maxItems = 8) {
  const d = [...new Set(depths.filter(fin).map((x) => Math.round(x * 100) / 100))].sort((a, b) => a - b);
  if (!d.length) return "";
  const r = []; let s = d[0], p = d[0];
  for (const x of d.slice(1)) { if (x - p > 0.3) { r.push([s, p]); s = x; } p = x; }
  r.push([s, p]);
  const txt = r.slice(0, maxItems).map(([a, b]) => (a === b ? `${a.toFixed(2)} m` : `${a.toFixed(2)}–${b.toFixed(2)} m`));
  return "depth " + txt.join(", ") + (r.length > maxItems ? ` (+${r.length - maxItems} more)` : "");
}
const fmtNum = (x, d = 2) => (fin(x) ? x.toFixed(d) : "?");

// ------------------------------------------------------------------ context
export class SiteContext {
  constructor(bundle, R) {
    this.b = bundle; this.R = R;
    const S = this.t("SITE");
    this.site = S[0] || {};
    this.siteLat = R.first("SITE", S, "lat", true);
    this.siteLon = R.first("SITE", S, "lon", true);
    this.siteName = R.first("SITE", S, "name") ?? "?";
    this._cache = new Map();
    this.tests = this._buildTests();
  }
  t(table) { return Array.isArray(this.b[table]) ? this.b[table] : []; }

  _buildTests() {
    const R = this.R;
    return this.t("TEST").map((r) => {
      const one = [r];
      const t = { testId: num(r.TEST_ID), type: String(R.first("TEST", one, "type") ?? "").trim(),
        name: String(R.first("TEST", one, "name") ?? r.TEST_ID), lat: R.first("TEST", one, "lat", true),
        lon: R.first("TEST", one, "lon", true), stat: R.first("TEST", one, "stat", true), revw: R.first("TEST", one, "revw", true) };
      let k = KIND_BY_TYPE[t.type.toUpperCase()];
      if (!k) {
        if (this.rows("SCPT", t.testId).length) k = "CPT";
        else if (this.rows("STRA", t.testId).length || this.rows("ISPT", t.testId).length) k = "Borehole";
        else if (this.rows("SWVD", t.testId).length || this.rows("GIND", t.testId).length) k = "Vs";
        else k = t.type || "Other";
      }
      t.kind = k;
      return t;
    });
  }
  test(tid) { return this.tests.find((t) => t.testId === tid); }
  label(tid) { const t = this.test(tid); return t ? `${t.kind} ${t.name} (TEST_ID ${tid})` : `TEST ${tid}`; }

  idsFor(table, tid) { return new Set(this.rows(table, tid).map((r) => num(r[table + "_ID"])).filter(fin)); }

  // rows of `table` that belong to test `tid`, following the parent chain
  rows(table, tid) {
    const key = table + "|" + tid;
    if (this._cache.has(key)) return this._cache.get(key);
    let res = [];
    const rows = this.t(table);
    if (rows.length && tid !== null && tid !== undefined) {
      const cols = columns(rows);
      if (cols.includes("TEST_ID")) res = rows.filter((r) => num(r.TEST_ID) === tid);
      else if (table === "SAMP") {
        const ids = new Set(this.t("SAMP_TEST").filter((r) => num(r.TEST_ID) === tid).map((r) => num(r.SAMP_ID)));
        res = rows.filter((r) => ids.has(num(r.SAMP_ID)));
      } else {
        const parent = PARENT_OF[table];
        if (parent && cols.includes(parent + "_ID")) {
          const p = this.idsFor(parent, tid);
          res = rows.filter((r) => p.has(num(r[parent + "_ID"])));
        }
      }
    }
    this._cache.set(key, res);
    return res;
  }

  gwtSources() {
    if (this._gwt) return this._gwt;
    const out = [];
    for (const t of this.tests) {
      const W = this.rows("WATR", t.testId);
      const d = this.R.get("WATR", W, "depth", true) || [];
      const dt = this.R.get("WATR", W, "date") || [];
      d.forEach((x, i) => { if (fin(x)) out.push({ source: "WATR", testId: t.testId, depth: x, date: dt[i] ?? "" }); });
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
  return (status, check, message, where = "", depths = null, points = null, sampIds = null) =>
    out.push({ status, group, check, message, target, where, testId, depths: depths || [], points: points || [], sampIds: sampIds || [] });
}

// ------------------------------------------------------------------ CPT
// NGL stores qc, fs and u in MPa (SCPT_RES / SCPT_FRES / SCPT_PWP); converted here to
// qc [MPa], fs [kPa], u [kPa].
export function cptData(ctx, tid) {
  const R = ctx.R, raw = ctx.rows("SCPT", tid);
  if (!raw.length) return { df: null, meta: {} };
  const sc = SCALE.SCPT;
  const get = (k) => (R.get("SCPT", raw, k, true) || raw.map(() => NaN)).map((v) => v * (sc[k] ?? 1));
  const df = { depth: get("depth"), qc: get("qc"), fs: get("fs"), u2: get("u2") };
  const g = ctx.rows("SCPG", tid);
  const car = R.first("SCPG", g, "car", true);
  const { gwt, src } = ctx.gwtFor(tid);
  const cols = Object.fromEntries(["depth", "qc", "fs", "u2"].map((k) => [k, R.col("SCPT", raw, k)]));
  return { df, meta: { car: fin(car) ? car : null, area: R.first("SCPG", g, "area", true), pwp: R.first("SCPG", g, "pwp"), gwt, gwtSrc: src, cols } };
}

function sortDedup(df) {
  const idx = [...df.depth.keys()].filter((i) => fin(df.depth[i])).sort((i, j) => df.depth[i] - df.depth[j]);
  const keep = idx.filter((i, k) => k === 0 || df.depth[i] !== df.depth[idx[k - 1]]);
  return Object.fromEntries(Object.entries(df).map(([k, v]) => [k, keep.map((i) => v[i])]));
}

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
      testId: tid, depths: bad.flatMap(([a, b]) => [a, b]), points: [], sampIds: [] });
  }
  return res;
}

// ------------------------------------------------------------------ Borehole data
export function layerData(ctx, tid) {
  const R = ctx.R, raw = ctx.rows("STRA", tid);
  if (!raw.length) return null;
  const top = R.get("STRA", raw, "top", true), base = R.get("STRA", raw, "base", true);
  const desc = R.get("STRA", raw, "desc") || [], code = R.get("STRA", raw, "uscs") || [];
  return raw.map((_, i) => {
    const dsc = String(desc[i] ?? "");
    const c = typeof code[i] === "string" && code[i].trim() ? code[i].trim().toUpperCase() : null;
    return { top: top[i], base: base ? base[i] : NaN, desc: dsc, uscsRaw: c, uscs: c || uscsFromText(dsc) };
  }).sort((a, b) => a.top - b.top);
}
export function detlData(ctx, tid) {
  const R = ctx.R, raw = ctx.rows("DETL", tid);
  const d = R.get("DETL", raw, "depth", true) || [], t = R.get("DETL", raw, "desc") || [];
  return raw.map((_, i) => ({ depth: d[i], desc: String(t[i] ?? "") })).sort((a, b) => a.depth - b.depth);
}
// Fines content from a gradation curve: % passing at 0.075 mm (log-size interpolation)
export function finesFromGrat(rows) {
  const p = rows.filter((r) => fin(r.size) && fin(r.perp) && r.size > 0).sort((a, b) => a.size - b.size);
  if (!p.length) return NaN;
  const exact = p.find((r) => Math.abs(r.size - 0.075) < 0.002);
  if (exact) return exact.perp;
  for (let i = 1; i < p.length; i++) {
    if (p[i - 1].size <= 0.075 && p[i].size >= 0.075) {
      const t = (Math.log(0.075) - Math.log(p[i - 1].size)) / (Math.log(p[i].size) - Math.log(p[i - 1].size));
      return p[i - 1].perp + t * (p[i].perp - p[i - 1].perp);
    }
  }
  return NaN;
}
// samples of a test, with SPT results and lab results of their specimens
export function sampleData(ctx, tid) {
  const R = ctx.R, S = ctx.rows("SAMP", tid);
  if (!S.length) return [];
  const g = (t, rows, k, n = true) => R.get(t, rows, k, n) || rows.map(() => (n ? NaN : null));
  const sTop = g("SAMP", S, "top"), sBase = g("SAMP", S, "base"), sName = g("SAMP", S, "name", false),
    sType = g("SAMP", S, "type", false), sDesc = g("SAMP", S, "desc", false);
  const I = ctx.t("ISPT"), SP = ctx.t("SPEC"), GG = ctx.t("GRAG"), GT = ctx.t("GRAT"), PL = ctx.t("PLAS"), IX = ctx.t("INDX");
  return S.map((r, i) => {
    const id = num(r.SAMP_ID);
    const ispt = I.filter((x) => num(x.SAMP_ID) === id);
    const specs = SP.filter((x) => num(x.SAMP_ID) === id).map((sp) => {
      const sid = num(sp.SPEC_ID), one = [sp];
      const grag = GG.filter((x) => num(x.SPEC_ID) === sid);
      const gids = new Set(grag.map((x) => num(x.GRAG_ID)));
      const grat = GT.filter((x) => gids.has(num(x.GRAG_ID)));
      const curve = grat.map((x) => ({ grag: num(x.GRAG_ID), size: num(x.GRAT_SIZE), perp: num(x.GRAT_PERP) }));
      const pl = PL.filter((x) => num(x.SPEC_ID) === sid), ix = IX.filter((x) => num(x.SPEC_ID) === sid);
      return { specId: sid, ref: sp.SPEC_REF ?? "", top: R.first("SPEC", one, "top", true), base: R.first("SPEC", one, "base", true),
        curve, fcGrat: finesFromGrat(curve), fcIndx: R.first("INDX", ix, "fines", true), wc: R.first("INDX", ix, "wc", true),
        gs: R.first("INDX", ix, "gs", true), bden: R.first("INDX", ix, "bden", true),
        ll: R.first("PLAS", pl, "ll", true), pl: R.first("PLAS", pl, "pl", true), plasRows: pl.length };
    });
    return { sampId: id, name: sName[i] ?? "", type: sType[i] ?? "", desc: sDesc[i] ?? "", top: sTop[i], base: sBase[i],
      spt: ispt.map((x) => { const one = [x]; return { top: R.first("ISPT", one, "top", true), n: R.first("ISPT", one, "n", true),
        er: R.first("ISPT", one, "er", true), tpen: R.first("ISPT", one, "tpen", true), rem: R.first("ISPT", one, "rem") ?? "" }; }),
      specs };
  }).sort((a, b) => a.top - b.top);
}
export function sptRows(samples) {
  return samples.flatMap((s) => s.spt.map((x) => ({ ...x, depth: fin(x.top) ? x.top : s.top, sampId: s.sampId, sampName: s.name }))).sort((a, b) => a.depth - b.depth);
}
const layerAt = (lay, z) => (lay || []).find((l) => l.top <= z + 1e-6 && (!fin(l.base) || l.base > z));

// ------------------------------------------------------------------ Borehole checks
export function checkBorehole(ctx, tid) {
  const out = [], add = adder(out, "Borehole/SPT", ctx.label(tid), tid);
  const addLab = adder(out, "Lab", ctx.label(tid), tid);
  const lay = layerData(ctx, tid), detl = detlData(ctx, tid), samples = sampleData(ctx, tid), spt = sptRows(samples);
  const { gwt } = ctx.gwtFor(tid);
  const maxLog = Math.max(max((lay || []).map((l) => l.base)), max(samples.map((s) => s.base)), max(spt.map((s) => s.depth)));
  const data = { layers: lay, detl, samples, spt, gwt, depth: fin(maxLog) ? maxLog : null };
  if (!lay && !samples.length) { add("FAIL", "Data present", "Boring has neither layer descriptions (STRA) nor samples (SAMP)."); return { findings: out, data }; }
  if (!ctx.rows("BORH", tid).length) add("UNSURE", "Boring header", "No general boring record (BORH: type, hammer, crew) for this test.");

  // ---- strata
  if (!lay) add("FAIL", "Layers", "No stratigraphic layers (STRA) for this boring.");
  else {
    const inv = lay.filter((l) => fin(l.base) && l.base <= l.top).map((l) => l.top);
    if (inv.length) add("FAIL", "Layer geometry", "Layer base ≤ top.", fmtDepths(inv), inv);
    const nob = lay.filter((l) => !fin(l.base)).map((l) => l.top);
    if (nob.length) add("FAIL", "Layer geometry", `${nob.length} layer(s) without a base depth.`, fmtDepths(nob), nob);
    if (lay[0].top > 0.05) add("UNSURE", "Layer geometry", `First layer starts at ${lay[0].top.toFixed(2)} m, not at the ground surface.`, `0–${lay[0].top.toFixed(2)} m`, [0, lay[0].top]);
    const gaps = [], ovl = [];
    for (let i = 0; i < lay.length - 1; i++) {
      const b = lay[i].base, t = lay[i + 1].top;
      if (!fin(b)) continue;
      if (t - b > 0.05) gaps.push([b, t]); else if (b - t > 0.05) ovl.push([t, b]);
    }
    if (ovl.length) add("FAIL", "Layer overlaps", `${ovl.length} overlapping layers.`, ovl.map(([a, b]) => `${a.toFixed(2)}–${b.toFixed(2)} m`).join("; "), ovl.flat());
    if (gaps.length) add("UNSURE", "Layer gaps", `${gaps.length} undescribed interval(s) between layers.`, gaps.map(([a, b]) => `${a.toFixed(2)}–${b.toFixed(2)} m`).join("; "), gaps.flat());
    if (!inv.length && !nob.length && !ovl.length && !gaps.length) add("PASS", "Layer geometry", `${lay.length} contiguous layers, 0–${fmtNum(max(lay.map((l) => l.base)))} m.`);
    // USCS symbol validity and agreement with the description
    const badCode = lay.filter((l) => l.uscsRaw && !USCS_RE.test(l.uscsRaw));
    if (badCode.length) add("FAIL", "USCS symbol", `${badCode.length} layer(s) with an invalid USCS symbol.`, badCode.map((l) => `${l.top.toFixed(1)} m: "${l.uscsRaw}"`).join("; "), badCode.map((l) => l.top));
    const noCode = lay.filter((l) => !l.uscsRaw);
    if (noCode.length) add("UNSURE", "USCS symbol", `${noCode.length} layer(s) without STRA_USCS${noCode.some((l) => l.uscs) ? " (symbol inferred from the description)" : ""}.`, fmtDepths(noCode.map((l) => l.top)), noCode.map((l) => l.top));
    const descMis = lay.filter((l) => l.uscsRaw && USCS_RE.test(l.uscsRaw)).filter((l) => {
      const fromDesc = uscsFromText(l.desc);
      return fromDesc && uscsGroup(fromDesc) && uscsGroup(l.uscsRaw) && uscsGroup(fromDesc) !== uscsGroup(l.uscsRaw);
    });
    if (descMis.length) add("UNSURE", "USCS vs description", `${descMis.length} layer(s) where the USCS symbol and the description disagree (coarse vs fine).`,
      descMis.slice(0, 5).map((l) => `${l.top.toFixed(1)} m: ${l.uscsRaw} vs "${l.desc.slice(0, 40)}"`).join("; "), descMis.flatMap((l) => [l.top, l.base]));
    const noDesc = lay.filter((l) => !l.desc.trim());
    if (noDesc.length) add("UNSURE", "Descriptions", `${noDesc.length} layer(s) without a description.`, fmtDepths(noDesc.map((l) => l.top)), noDesc.map((l) => l.top));
    const detlOut = detl.filter((d) => !layerAt(lay, d.depth));
    if (detlOut.length) add("UNSURE", "Depth notes", `${detlOut.length} within-layer description(s) (DETL) outside the logged layers.`, fmtDepths(detlOut.map((d) => d.depth)), detlOut.map((d) => d.depth));
  }

  // ---- samples (names, intervals)
  if (!samples.length) add("UNSURE", "Samples", "No samples linked to this boring (SAMP via SAMP_TEST).");
  else {
    const badI = samples.filter((s) => !(fin(s.top) && fin(s.base) && s.base > s.top));
    if (badI.length) add("FAIL", "Sample intervals", `${badI.length} sample(s) with missing or inverted top/base.`, badI.map((s) => `${s.name || s.sampId}: ${fmtNum(s.top)}–${fmtNum(s.base)} m`).join("; "), badI.map((s) => s.top), null, badI.map((s) => s.sampId));
    const ov = [];
    for (let i = 1; i < samples.length; i++) if (fin(samples[i - 1].base) && samples[i].top < samples[i - 1].base - 0.02) ov.push([samples[i - 1], samples[i]]);
    if (ov.length) add("UNSURE", "Sample overlaps", `${ov.length} pair(s) of overlapping samples.`, ov.map(([a, b]) => `${a.name || a.sampId} / ${b.name || b.sampId} at ${b.top.toFixed(2)} m`).join("; "), ov.map(([, b]) => b.top), null, ov.flatMap(([a, b]) => [a.sampId, b.sampId]));
    const names = samples.map((s) => String(s.name).trim()).filter(Boolean);
    const dup = names.filter((n, i) => names.indexOf(n) !== i);
    if (dup.length) add("FAIL", "Sample names", `Duplicate sample names: ${[...new Set(dup)].join(", ")}.`, "", null, null, samples.filter((s) => dup.includes(String(s.name).trim())).map((s) => s.sampId));
    const unnamed = samples.filter((s) => !String(s.name).trim());
    if (unnamed.length) add("UNSURE", "Sample names", `${unnamed.length} sample(s) without a name.`, fmtDepths(unnamed.map((s) => s.top)), unnamed.map((s) => s.top), null, unnamed.map((s) => s.sampId));
    if (lay) {
      const deep = samples.filter((s) => fin(s.top) && s.top > max(lay.map((l) => l.base)) + 0.1);
      if (deep.length) add("UNSURE", "Samples vs log", `${deep.length} sample(s) below the deepest logged layer.`, fmtDepths(deep.map((s) => s.top)), deep.map((s) => s.top), null, deep.map((s) => s.sampId));
    }
    if (!badI.length && !ov.length && !dup.length) add("PASS", "Samples", `${samples.length} samples with valid, non-overlapping intervals and unique names.`);
  }

  // ---- SPT
  if (!spt.length) add("UNSURE", "SPT", "No SPT results (ISPT) for this boring.");
  else {
    const sampBy = new Map(samples.map((s) => [s.sampId, s]));
    const outside = spt.filter((x) => { const s = sampBy.get(x.sampId); return fin(x.top) && s && fin(s.top) && (x.top < s.top - 0.15 || (fin(s.base) && x.top > s.base + 0.15)); });
    if (outside.length) add("FAIL", "SPT vs sample depth", `${outside.length} SPT depth(s) (ISPT_TOP) outside their sample interval.`, outside.map((x) => `${x.sampName || x.sampId}: SPT ${x.top} m`).join("; "), outside.map((x) => x.depth), null, outside.map((x) => x.sampId));
    const wrongType = spt.filter((x) => { const t = String(sampBy.get(x.sampId)?.type || ""); return t && !/spt|split/i.test(t); });
    if (wrongType.length) add("UNSURE", "SPT sampler type", `${wrongType.length} SPT result(s) on samples whose type is not split-barrel/SPT.`, wrongType.map((x) => `${x.sampName}: ${sampBy.get(x.sampId).type}`).slice(0, 5).join("; "), wrongType.map((x) => x.depth), null, wrongType.map((x) => x.sampId));
    const dups = spt.filter((x, i) => i > 0 && Math.abs(x.depth - spt[i - 1].depth) < 1e-3);
    if (dups.length) add("FAIL", "SPT depth order", `${dups.length} duplicated SPT depth(s).`, fmtDepths(dups.map((x) => x.depth)), dups.map((x) => x.depth), null, dups.map((x) => x.sampId));
    const N = spt.map((x) => x.n);
    if (!N.some(fin)) add("FAIL", "SPT N", "SPT rows present but no blow counts (ISPT_NVAL).");
    else {
      const neg = spt.filter((x) => x.n < 0), hi = spt.filter((x) => x.n > 100), miss = spt.filter((x) => !fin(x.n));
      if (neg.length) add("FAIL", "SPT N", "Negative blow counts.", fmtDepths(neg.map((x) => x.depth)), neg.map((x) => x.depth), null, neg.map((x) => x.sampId));
      if (miss.length) add("UNSURE", "SPT N", `${miss.length} SPT row(s) without a blow count.`, fmtDepths(miss.map((x) => x.depth)), miss.map((x) => x.depth), null, miss.map((x) => x.sampId));
      if (hi.length) add("UNSURE", "SPT N", `${hi.length} N > 100 – refusal? Check ISPT_TPEN and the log.`, fmtDepths(hi.map((x) => x.depth)), hi.map((x) => x.depth), null, hi.map((x) => x.sampId));
      const part = spt.filter((x) => fin(x.tpen) && x.tpen < 29 && x.n < 50);
      if (part.length) add("UNSURE", "SPT penetration", `${part.length} SPT(s) with partial penetration (ISPT_TPEN < 30 cm) but N < 50 – N may not be per 30 cm.`, part.map((x) => `${x.depth} m: N=${x.n} over ${x.tpen} cm`).join("; "), part.map((x) => x.depth), null, part.map((x) => x.sampId));
      if (!neg.length && !hi.length && !miss.length) add("PASS", "SPT N", `${spt.length} blow counts between ${min(N)} and ${max(N)}.`);
    }
    const ER = spt.map((x) => x.er);
    if (!ER.some(fin)) add("UNSURE", "Energy ratio", "Hammer energy ratio (ISPT_ERAT) not reported – needed for N60.");
    else {
      const b = spt.filter((x) => fin(x.er) && (x.er < 40 || x.er > 100)), miss = spt.filter((x) => !fin(x.er));
      if (b.length) add("FAIL", "Energy ratio", `ER outside 40–100% at ${b.length} test(s).`, fmtDepths(b.map((x) => x.depth)), b.map((x) => x.depth), null, b.map((x) => x.sampId));
      if (miss.length) add("UNSURE", "Energy ratio", `ER missing for ${miss.length} of ${spt.length} SPTs.`, fmtDepths(miss.map((x) => x.depth)), miss.map((x) => x.depth), null, miss.map((x) => x.sampId));
      if (!b.length && !miss.length) add("PASS", "Energy ratio", `ER ${min(ER)}–${max(ER)}%.`);
    }
    // N vs density / consistency term in the layer (or nearby DETL) description
    if (lay) {
      const [ok, uns] = THRESH.spt_class_offset;
      let pass = 0; const U = [], F = [];
      for (const x of spt) {
        if (!fin(x.n)) continue;
        const L = layerAt(lay, x.depth);
        const near = detl.find((d) => Math.abs(d.depth - x.depth) <= 0.75 && consistencyClass(d.desc));
        const cc = consistencyClass(near?.desc) || (L && consistencyClass(L.desc));
        if (!cc) continue;
        const off = Math.abs(nClass(cc.scale, x.n) - cc.idx), term = cc.scale[cc.idx][0];
        if (off <= ok) pass++; else (off <= uns ? U : F).push([x, term]);
      }
      for (const [st, arr] of [["FAIL", F], ["UNSURE", U]]) if (arr.length)
        add(st, "N vs description", `${arr.length} SPT N value(s) ${st === "FAIL" ? "far " : ""}outside the range implied by the logged density/consistency term.`,
          arr.slice(0, 6).map(([x, t]) => `${x.depth.toFixed(1)} m: N=${x.n} but '${t}'`).join("; "), arr.map(([x]) => x.depth), null, arr.map(([x]) => x.sampId));
      if (pass && !F.length && !U.length) add("PASS", "N vs description", `All ${pass} N values match the logged density/consistency terms.`);
    }
  }

  // ---- lab (specimens)
  const specs = samples.flatMap((s) => s.specs.map((sp) => ({ ...sp, samp: s, depth: fin(sp.top) ? sp.top : s.top })));
  if (specs.length) {
    const iF = [], iU = []; let nChk = 0;
    const push = (arr, sp, msg) => arr.push({ z: sp.depth, msg: `${sp.samp.name || "sample " + sp.samp.sampId}${sp.ref ? "/" + sp.ref : ""} @ ${fmtNum(sp.depth, 1)} m: ${msg}`, sampId: sp.samp.sampId });
    for (const sp of specs) {
      const s = sp.samp;
      if (fin(sp.top) && fin(s.top) && fin(s.base) && (sp.top < s.top - 0.1 || (fin(sp.base) ? sp.base : sp.top) > s.base + 0.1)) push(iF, sp, `specimen ${fmtNum(sp.top)}–${fmtNum(sp.base)} m outside its sample ${fmtNum(s.top)}–${fmtNum(s.base)} m`);
      // gradation curve
      for (const gid of [...new Set(sp.curve.map((c) => c.grag))]) {
        const c = sp.curve.filter((x) => x.grag === gid && fin(x.size) && fin(x.perp)).sort((a, b) => b.size - a.size);
        if (!c.length) continue;
        nChk++;
        if (c.some((x) => x.perp < -0.5 || x.perp > 100.5)) push(iF, sp, "% passing outside 0–100");
        const bumps = c.filter((x, i) => i > 0 && x.perp > c[i - 1].perp + 0.5);
        if (bumps.length) push(iF, sp, `gradation curve not monotonic (% passing increases as size decreases at ${bumps.map((b) => b.size + " mm").join(", ")})`);
        if (!c.some((x) => x.size <= 0.08)) push(iU, sp, "gradation curve does not reach the No. 200 sieve (0.075 mm) – fines content cannot be read");
      }
      const fcG = sp.fcGrat, fcI = sp.fcIndx;
      if (fin(fcG) && fin(fcI)) { nChk++; if (Math.abs(fcG - fcI) > 5) push(Math.abs(fcG - fcI) > 10 ? iF : iU, sp, `INDX_FINE = ${fcI.toFixed(0)}% but gradation curve gives ${fcG.toFixed(0)}% passing 0.075 mm`); }
      const fc = fin(fcI) ? fcI : fcG;
      const L = layerAt(lay, sp.depth);
      const code = uscsFromText(s.desc) && !String(uscsFromText(s.desc)).endsWith("?") ? uscsFromText(s.desc) : L?.uscs;
      const rng = fcRangeForUscs(code), tol = THRESH.uscs_fc_tol;
      if (rng && fin(fc)) {
        nChk++;
        if (fc < rng[0] - tol || fc > rng[1] + tol) {
          const far = fc < rng[0] - 3 * tol || fc > rng[1] + 3 * tol;
          push(far && !String(code).endsWith("?") ? iF : iU, sp, `${code} but FC = ${fc.toFixed(0)}% (expected ${rng[0]}–${rng[1]}%)`);
        }
      }
      if (fin(sp.ll) || fin(sp.pl)) {
        nChk++;
        if (fin(sp.ll) && (sp.ll < 10 || sp.ll > 300)) push(iF, sp, `LL = ${sp.ll} outside 10–300`);
        if (fin(sp.ll) && fin(sp.pl) && sp.pl > sp.ll) push(iF, sp, `PL = ${sp.pl} > LL = ${sp.ll}`);
        if (fin(sp.ll) !== fin(sp.pl)) push(iU, sp, "only one of LL / PL reported");
        if (sp.plasRows > 1) push(iU, sp, `${sp.plasRows} Atterberg-limit records for one specimen`);
        const pi = sp.ll - sp.pl;
        if (fin(pi) && uscsGroup(code) === "fine") {
          const aline = 0.73 * (sp.ll - 20), c0 = String(code).toUpperCase().slice(0, 2);
          if ((["CL", "CH"].includes(c0) && pi < aline - 4) || (["ML", "MH"].includes(c0) && pi > aline + 4)) push(iU, sp, `${code} but PI = ${pi.toFixed(0)}, LL = ${sp.ll} plots on the other side of the A-line`);
          if ((["CL", "ML"].includes(c0) && sp.ll > 52) || (["CH", "MH"].includes(c0) && sp.ll < 48)) push(iU, sp, `${code} but LL = ${sp.ll}`);
        }
        if (fin(pi) && uscsGroup(code) === "coarse" && fin(fc) && fc < 12) push(iU, sp, `clean ${code} (FC ${fc.toFixed(0)}%) but Atterberg limits reported`);
        if (fin(sp.wc) && fin(sp.ll) && sp.wc > 1.5 * sp.ll) push(iU, sp, `water content ${sp.wc}% > 1.5·LL – very sensitive soil, or wc/LL mixed up`);
      }
      if (fin(sp.gs) && (sp.gs < 2.4 || sp.gs > 3.0)) { nChk++; push(iU, sp, `Gs = ${sp.gs} outside 2.4–3.0`); }
      if (fin(sp.bden) && (sp.bden < 1.2 || sp.bden > 2.4)) { nChk++; push(iU, sp, `total density ${sp.bden} g/cm³ outside 1.2–2.4`); }
      if (fin(sp.wc) && (sp.wc < 0 || sp.wc > 300)) { nChk++; push(iF, sp, `water content ${sp.wc}% outside 0–300`); }
    }
    // one finding per problem so each can be followed (and confirmed) on its own
    for (const [st, arr] of [["FAIL", iF], ["UNSURE", iU]])
      for (const x of arr) addLab(st, "Lab results", x.msg.split(": ").slice(1).join(": "), x.msg.split(": ")[0], [x.z], null, [x.sampId]);
    if (!iF.length && !iU.length) addLab("PASS", "Lab results", `${specs.length} specimens, ${nChk} lab checks consistent (gradation, fines, Atterberg limits, index properties vs USCS).`);
  }

  // ---- groundwater
  if (!ctx.rows("WATR", tid).length) add("UNSURE", "Groundwater", "No groundwater reading (WATR) for this boring.");
  else if (gwt !== null && fin(maxLog) && gwt > maxLog + 1) add("UNSURE", "Groundwater", `Groundwater at ${gwt.toFixed(2)} m is below the bottom of the boring (${maxLog.toFixed(2)} m).`);
  return { findings: out, data };
}

export function checkCpt(ctx, tid) {
  const out = [], add = adder(out, "CPT", ctx.label(tid), tid);
  const { df: raw0, meta } = cptData(ctx, tid);
  const sg = ctx.rows("SCPG", tid);
  if (!sg.length) add("FAIL", "CPT header", "No general CPT record (SCPG) for this test.");
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
  if (medQc > 200) { unitOk = false; add("FAIL", "Units", `Median qc = ${medQc.toFixed(0)} MPa (typically 0.5–50). SCPT_RES looks like it was entered in kPa instead of MPa.`, "whole sounding"); }
  else if (medQc < 0.05 && medQc > 0) { unitOk = false; add("FAIL", "Units", `Median qc = ${medQc.toFixed(4)} MPa – far too small; entered in a wrong unit?`, "whole sounding"); }
  if (fin(medRf)) {
    if (medRf > 30) { unitOk = false; add("FAIL", "Units", `Median Rf = ${medRf.toFixed(0)}% (expected 0.2–8%). SCPT_FRES looks ~1000× too large – entered in kPa instead of MPa?`, "whole sounding"); }
    else if (medRf < 0.03) { unitOk = false; add("FAIL", "Units", `Median Rf = ${medRf.toFixed(3)}% (expected 0.2–8%). SCPT_FRES looks ~1000× too small.`, "whole sounding"); }
  }
  const lq = qc.map((q) => Math.log10(Math.max(q, 1e-4)));
  const jumps = [];
  for (let i = 1; i < n; i++) if (Math.abs(lq[i] - lq[i - 1]) > 2.3) jumps.push(d[i]);
  if (jumps.length) { unitOk = false; add("FAIL", "Unit jump", `qc changes by >200× between consecutive readings at ${jumps.length} point(s) – likely a block entered in different units.`, fmtDepths(jumps), jumps); }
  if (unitOk) add("PASS", "Units", `Median qc = ${medQc.toFixed(2)} MPa, median Rf = ${medRf.toFixed(2)}% – consistent with qc and fs both stored in MPa.`);

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

  // 6 cone metadata (SCPG)
  const car = meta.car;
  if (car !== null && (car < 0.5 || car > 0.9)) add("FAIL", "Cone area ratio", `a = ${car} is outside 0.5–0.9.`);
  if (fin(meta.area) && ![10, 15].some((a) => Math.abs(meta.area - a) < 0.6)) add("UNSURE", "Cone size", `SCPG_CSA = ${meta.area} cm² (standard cones are 10 or 15 cm²).`);
  if (meta.pwp && !/u\s*2/i.test(meta.pwp) && u2.some(fin)) add("UNSURE", "Pore pressure position", `SCPG_PWP = "${meta.pwp}" – pore pressure not at the u2 position, so qt = qc + u(1−a) and the GWT check below are approximate.`);
  if (!meta.pwp && u2.some(fin)) add("UNSURE", "Pore pressure position", "Pore pressure recorded but SCPG_PWP (filter position) is empty; u2 assumed.");

  const gwt = meta.gwt;
  const hasU2 = u2.some(fin);
  const der = cptDerived(d, qc, fs, hasU2 ? u2 : null, car ?? 0.8, gwt); // a = 0.8 assumed (not stored in NGL)

  // 7 GWT from u2
  if (!hasU2) add("UNSURE", "Pore pressure", "No u2 data – GWT cannot be cross-checked from pore pressure.");
  else if (gwt === null) add("UNSURE", "Pore pressure", "u2 present but no groundwater depth (WATR) for this test or site.");
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

  // 8 negative pore pressure far below hydrostatic in sands (sign / unit error)
  if (hasU2 && gwt !== null) {
    const negU = d.filter((z, i) => fin(u2[i]) && u2[i] < -100);
    if (negU.length > 5) add("UNSURE", "Pore pressure", `${negU.length} readings with u < −100 kPa (dilation in dense sand/OC clay, or sign/unit error).`, fmtDepths(negU), negU);
  }
  if (d[n - 1] > 60) add("UNSURE", "Total depth", `Sounding reaches ${d[n - 1].toFixed(1)} m – unusually deep; check units (ft?).`);

  // 10 vs nearby boring logs
  out.push(...cptVsBoreholes(ctx, tid, der));
  return { findings: out, der, meta, raw: df };
}

// ------------------------------------------------------------------ Vs (surface wave and invasive)
export function vsData(ctx, tid) {
  const R = ctx.R, profiles = [];
  const raw = ctx.rows("SWVD", tid);
  const groups = new Map();
  raw.forEach((r) => { const k = r.SWVG_ID ?? "1"; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
  const names = new Map(ctx.t("SWVG").map((r) => [String(r.SWVG_ID), R.first("SWVG", [r], "name")]));
  for (const [pid, g] of groups) {
    const top = R.get("SWVD", g, "top", true), vs = R.get("SWVD", g, "vs", true);
    if (!top || !vs) continue;
    const base = R.get("SWVD", g, "base", true), vp = R.get("SWVD", g, "vp", true);
    const thk = base ? base.map((b, i) => b - top[i]) : null;
    const L = vsLayers(top, thk, vs);
    profiles.push({ id: names.get(String(pid)) || `SWVG ${pid}`, source: "SWVD", top: L.top, base: L.base, vs: L.vs,
      vp: vp ? L.order.map((i) => vp[i]) : L.top.map(() => NaN), rawTop: top, rawBase: base ? L.order.map((i) => base[i]) : null });
  }
  const gi = ctx.rows("GIND", tid);
  if (gi.length) {
    const d = R.get("GIND", gi, "depth", true), v = R.get("GIND", gi, "vs", true), vp = R.get("GIND", gi, "vp", true);
    if (d && v) {
      const idx = d.map((_, i) => i).filter((i) => fin(d[i])).sort((a, b) => d[a] - d[b]);
      const t = idx.map((i) => d[i]);
      profiles.push({ id: "invasive (GIND)", source: "GIND", top: t, base: t.slice(1).concat([Infinity]), vs: idx.map((i) => v[i]),
        vp: vp ? idx.map((i) => vp[i]) : t.map(() => NaN), rawTop: t, rawBase: null, points: true });
    }
  }
  let disp = null;
  const D = ctx.rows("GSWD", tid);
  if (D.length) {
    const f = R.get("GSWD", D, "freq", true), v = R.get("GSWD", D, "vel", true);
    if (f && v) disp = f.map((fr, i) => ({ freq: fr, vel: v[i], wavelength: v[i] / fr })).sort((a, b) => a.freq - b.freq);
  }
  return { profiles, disp };
}

export function checkVs(ctx, tid, cptDers) {
  const out = [], add = adder(out, "Vs", ctx.label(tid), tid);
  const { profiles, disp } = vsData(ctx, tid);
  if (!profiles.length) { add("FAIL", "Data present", "Vs test without a velocity profile (SWVD layers or GIND measurements)."); return { findings: out, data: { profiles, disp } }; }
  const { gwt } = ctx.gwtFor(tid);
  for (const p of profiles) {
    const lab = p.id, { top: t, base: b, vs: v, vp } = p;
    if (new Set(p.rawTop).size !== p.rawTop.length) add("FAIL", "Layer geometry", `${lab}: duplicate depths.`);
    if (!p.points) {
      if (t[0] > 0.01) add("FAIL", "Layer geometry", `${lab}: first layer starts at ${t[0].toFixed(2)} m, not at the surface.`, "", [0, t[0]]);
      if (p.rawBase) {
        const mism = [];
        for (let i = 0; i < t.length - 1; i++) if (fin(p.rawBase[i]) && Math.abs(p.rawBase[i] - t[i + 1]) > 0.05) mism.push(t[i + 1]);
        if (mism.length) add("FAIL", "Layer geometry", `${lab}: layer bottom (SWVD_BTTM) ≠ next layer top.`, fmtDepths(mism), mism);
        const inv = t.filter((z, i) => fin(p.rawBase[i]) && p.rawBase[i] <= z);
        if (inv.length) add("FAIL", "Layer geometry", `${lab}: layer bottom ≤ top.`, fmtDepths(inv), inv);
      }
    }
    if (p.points && disp) add("UNSURE", "Dispersion", "Dispersion data exist but the profile is from invasive measurements.");
    const bad = t.filter((z, i) => !(v[i] >= 30 && v[i] <= 3500));
    if (bad.length) add("FAIL", "Vs range", `${lab}: Vs outside 30–3500 m/s (ft/s?).`, fmtDepths(bad), bad);
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
    if (!bad.length && !drops.length) add("PASS", "Vs profile", `${lab}: ${t.length} ${p.points ? "measurements" : "layers"}, Vs ${min(v)}–${max(v)} m/s, VS30 ≈ ${fmtNum(calc, 0)} m/s${max(t) < 30 ? " (extrapolated)" : ""}.`);

    if (!p.points && disp && disp.length > 3) {
      const ratios = [];
      for (const r of disp) {
        const z = r.wavelength / 2.5;
        if (!(z > 0) || !fin(r.vel)) continue;
        const pred = 0.92 * vsAvgTo(t, b, v, Math.min(z, max(t) + 20));
        if (pred > 0) ratios.push(r.vel / pred);
      }
      if (ratios.length) {
        const m = median(ratios);
        add(m >= 0.8 && m <= 1.25 ? "PASS" : "UNSURE", "Dispersion vs profile", `Measured phase velocity / approximate prediction from the profile (λ/2.5 rule): median ${m.toFixed(2)}. Approximate check only.`);
      }
      const badD = disp.filter((r) => !(r.freq > 0) || !(r.vel > 0));
      if (badD.length) add("FAIL", "Dispersion", `${badD.length} dispersion point(s) with non-positive frequency or velocity.`);
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
        `${lab}: measured Vs / CPT-based Vs (Robertson 2009) for ${ctx.label(cid)} (${fin(dist) ? dist.toFixed(0) + " m away" : "distance unknown"}): median ratio ${r.toFixed(2)}. Correlation scatter is large; only gross mismatches (e.g. ft/s vs m/s) are marked inconsistent.`);
    }
  }
  return { findings: out, data: { profiles, disp } };
}

// ------------------------------------------------------------------ Field observations
export function obsData(ctx, fid) {
  const R = ctx.R;
  const row = ctx.t("FLDO").filter((r) => num(r.FLDO_ID) === fid);
  const sub = (t) => ctx.t(t).filter((r) => num(r.FLDO_ID) === fid);
  const ev = ctx.t("EVNT").filter((r) => num(r.EVNT_ID) === num(row[0]?.EVNT_ID));
  const info = { id: fid, desc: R.first("FLDO", row, "desc") ?? "", stat: R.first("FLDO", row, "stat", true), revw: R.first("FLDO", row, "revw", true) };
  info.evnt = ev.length ? { name: R.first("EVNT", ev, "name"), year: R.first("EVNT", ev, "year", true), md: R.first("EVNT", ev, "md", true),
    mag: R.first("EVNT", ev, "mag", true), lat: R.first("EVNT", ev, "lat", true), lon: R.first("EVNT", ev, "lon", true) } : null;
  if (info.evnt) { const md = String(info.evnt.md ?? "").padStart(4, "0"); info.evnt.date = fin(info.evnt.year) ? `${info.evnt.year}-${md.slice(0, 2)}-${md.slice(2)}` : ""; }
  const D = sub("FLDD");
  info.vectors = D.length ? D.map((r) => {
    const o = [r], az = R.first("FLDD", o, "azim", true), h = R.first("FLDD", o, "hdis", true);
    return { lat: R.first("FLDD", o, "lat", true), lon: R.first("FLDD", o, "lon", true), azim: az, mag: h, vdis: R.first("FLDD", o, "vdis", true),
      de: h * Math.sin((az || 0) * Math.PI / 180), dn: h * Math.cos((az || 0) * Math.PI / 180) };
  }) : null;
  const M = sub("FLDM");
  info.manifest = M.length ? M.map((r) => {
    const o = [r], f = (k) => R.first("FLDM", o, k, true);
    const kinds = [["snbl", "sand boil"], ["ltsp", "lateral spread"], ["sttl", "settlement"]].filter(([k]) => f(k) === 1).map(([, l]) => l);
    return { lat: f("lat"), lon: f("lon"), sfev: f("sfev"), snbl: f("snbl"), ltsp: f("ltsp"), sttl: f("sttl"),
      type: kinds.join(", ") || (f("sfev") === 1 ? "surface evidence" : f("sfev") === 0 ? "no surface evidence" : ""), severity: "", desc: R.first("FLDM", o, "desc") ?? "" };
  }) : null;
  const GM = sub("GMIM");
  info.gm = GM.map((r) => ({ type: String(R.first("GMIM", [r], "type") ?? ""), value: R.first("GMIM", [r], "value", true), unit: String(R.first("GMIM", [r], "unit") ?? "") }));
  const pg = info.gm.filter((g) => /^PGA$/i.test(g.type.trim()));
  info.pgaRaw = pg.length ? pg[0] : null;
  info.pga = null;
  if (pg.length) {
    const u = pg[0].unit.toLowerCase();
    const k = /cm\/s|gal/.test(u) ? 1 / 981 : /m\/s/.test(u) ? 1 / 9.81 : 1;
    info.pga = median(pg.map((g) => g.value * k));
  }
  const pts = [...(info.manifest || []), ...(info.vectors || [])].filter((p) => fin(p.lat) && fin(p.lon));
  info.lat = pts.length ? median(pts.map((p) => p.lat)) : NaN;
  info.lon = pts.length ? median(pts.map((p) => p.lon)) : NaN;
  info.manif = info.manifest ? info.manifest.some((m) => m.sfev === 1) : null;
  return info;
}

export function checkObs(ctx, fid, cptDers) {
  const out = [], info = obsData(ctx, fid), ev = info.evnt;
  const add = adder(out, "Field observation", `Observation FLDO_ID ${fid}` + (ev?.name ? ` – ${ev.name}` : ""), null);
  const [p, u] = THRESH.test_site_dist_m;
  if (!info.desc.trim()) add("UNSURE", "Description", "FLDO_DESC (liquefaction manifestation description) is empty.");
  const pts = [...(info.manifest || []), ...(info.vectors || [])].filter((x) => fin(x.lat) && fin(x.lon));
  if (fin(ctx.siteLat) && pts.length) {
    const far = pts.map((x) => [x, haversine(ctx.siteLat, ctx.siteLon, x.lat, x.lon)]);
    const dmax = max(far.map(([, d]) => d));
    const ff = far.filter(([, d]) => d > u), uu = far.filter(([, d]) => d > p && d <= u);
    add(ff.length ? "FAIL" : uu.length ? "UNSURE" : "PASS", "Location", ff.length || uu.length ? `${ff.length + uu.length} manifestation/vector point(s) more than ${p} m from the site (max ${dmax.toFixed(0)} m).` : `All ${pts.length} points within ${p} m of the site.`,
      "", null, [...ff, ...uu].map(([x]) => [x.lat, x.lon]));
  }
  if (!ev) add("FAIL", "Event", "Observation not linked to an event (EVNT).");
  else {
    if (!fin(ev.mag)) add("UNSURE", "Event magnitude", "Event has no magnitude.");
    if (fin(ev.lat) && fin(ctx.siteLat)) {
      const de = haversine(ctx.siteLat, ctx.siteLon, ev.lat, ev.lon) / 1000, m = fin(ev.mag) ? ev.mag : 7;
      const lim = m < 6 ? 50 : m < 7 ? 150 : 400;
      add(de <= lim ? "PASS" : "UNSURE", "Event distance", `Epicentral distance ${de.toFixed(0)} km for M${m}.` + (de <= lim ? "" : " Unusually far for liquefaction – check the event link or coordinates."));
    }
  }
  if (!info.gm.length) add("UNSURE", "Ground motion", "No ground-motion intensity (GMIM) for this observation.");
  else if (info.pga === null) add("UNSURE", "PGA", `No PGA among the ground-motion values (${[...new Set(info.gm.map((g) => g.type))].join(", ")}).`);
  else {
    if (!info.pgaRaw.unit) add("UNSURE", "PGA units", `GMIM_UNIT is empty; PGA = ${info.pgaRaw.value} assumed to be in g.`);
    if (info.pga < 0.005 || info.pga > 2.5) add("FAIL", "PGA", `PGA = ${info.pgaRaw.value} ${info.pgaRaw.unit} (= ${fmtNum(info.pga, 3)} g) is outside 0.005–2.5 g – check units.`);
    else add("PASS", "PGA", `PGA = ${fmtNum(info.pga, 3)} g.`);
  }
  // manifestation flags
  const M = info.manifest || [];
  const contra = M.filter((m) => m.sfev === 0 && (m.snbl === 1 || m.ltsp === 1));
  if (contra.length) add("FAIL", "Manifestation flags", `${contra.length} point(s) say no surface evidence (FLDM_SFEV = 0) but report a sand boil or lateral spread.`, "", null, contra.map((m) => [m.lat, m.lon]));
  const V = info.vectors || [];
  if (V.length) {
    const badAz = V.filter((v) => !(v.azim >= 0 && v.azim <= 360));
    if (badAz.length) add("FAIL", "Vector azimuth", `${badAz.length} displacement vector(s) with azimuth outside 0–360°.`, badAz.map((v) => `(${fmtNum(v.lat, 5)}, ${fmtNum(v.lon, 5)}): ${v.azim}°`).slice(0, 5).join("; "), null, badAz.map((v) => [v.lat, v.lon]));
    const neg = V.filter((v) => v.mag < 0);
    if (neg.length) add("FAIL", "Vector magnitude", `${neg.length} negative horizontal displacement(s) (FLDD_HDIS).`, "", null, neg.map((v) => [v.lat, v.lon]));
    const big = V.filter((v) => v.mag > THRESH.disp_mag_m);
    if (big.length) add("UNSURE", "Vector size", `${big.length} displacement(s) > ${THRESH.disp_mag_m} m – units (cm?).`, "", null, big.map((v) => [v.lat, v.lon]));
    if (!badAz.length && !neg.length && !big.length) add("PASS", "Displacement vectors", `${V.length} vectors, ${fmtNum(min(V.map((v) => v.mag)))}–${fmtNum(max(V.map((v) => v.mag)))} m.`);
    if (V.length >= 5 && V.every((v) => fin(v.lat))) {
      const outl = V.filter((r) => {
        if (!(r.mag >= 0.1) || !(r.azim >= 0 && r.azim <= 360)) return false;
        const nb = V.filter((o) => o !== r && o.azim >= 0 && o.azim <= 360 && haversine(r.lat, r.lon, o.lat, o.lon) < 200);
        if (nb.length < 3) return false;
        const md = Math.atan2(median(nb.map((o) => o.de)), median(nb.map((o) => o.dn))) * 180 / Math.PI;
        return Math.abs((((r.azim - md + 180) % 360) + 360) % 360 - 180) > 90;
      });
      if (outl.length) add("UNSURE", "Vector direction", `${outl.length} vector(s) point >90° away from their neighbours (within 200 m) – azimuth convention or sign error?`,
        outl.slice(0, 5).map((v) => `(${fmtNum(v.lat, 5)}, ${fmtNum(v.lon, 5)})`).join("; "), null, outl.map((v) => [v.lat, v.lon]));
      else add("PASS", "Vector direction", "Displacement directions are spatially coherent.");
    }
    const lsFlag = M.some((m) => m.ltsp === 1);
    if (M.length && !lsFlag && V.some((v) => v.mag > 0.3)) add("UNSURE", "Lateral spread flag", "Displacement vectors > 0.3 m but no manifestation point is flagged as lateral spread (FLDM_LTSP).");
  }
  // manifestation vs CPT (model check, never inconsistent)
  const manif = info.manif;
  if (cptDers && fin(info.pga) && ev && fin(ev.mag) && manif !== null) {
    const lp = {};
    for (const [cid, der] of Object.entries(cptDers)) {
      if (!der || !der.u0.some((x) => x > 0)) continue;
      const r = bi2014(der, info.pga, ev.mag);
      lp[cid] = lpi(r.depth, r.FS);
    }
    const vals = Object.values(lp).filter(fin);
    if (vals.length) {
      const m = median(vals);
      let st = "PASS", msg = "Observed manifestation agrees with the CPT-based prediction.";
      if (manif && m < 5) { st = "UNSURE"; msg = "Surface manifestation reported but the CPTs predict little (median LPI < 5)."; }
      else if (!manif && m > 15) { st = "UNSURE"; msg = "No surface manifestation reported but the CPTs predict severe (median LPI > 15)."; }
      add(st, "Manifestation vs CPT (BI2014/LPI)", msg + " LPI: " + Object.entries(lp).map(([k, v]) => `TEST ${k}: ${v.toFixed(1)}`).join(", ") +
        ` (PGA ${info.pga.toFixed(2)} g, M${ev.mag}). Model-based; a misprediction is not a data error.`);
    }
  }
  return { findings: out, info };
}

// ------------------------------------------------------------------ Site
export function checkSite(ctx) {
  const out = [], add = adder(out, "Site", `Site ${ctx.siteName}`, null);
  if (!fin(ctx.siteLat) || !fin(ctx.siteLon)) add("FAIL", "Site coordinates", "Site latitude/longitude missing.");
  else if (Math.abs(ctx.siteLat) > 90 || Math.abs(ctx.siteLon) > 180) add("FAIL", "Site coordinates", "Coordinates out of range.");
  const [p, u] = THRESH.test_site_dist_m;
  let ok = 0, flagged = 0;
  for (const t of ctx.tests) {
    if (!fin(t.lat) || !fin(t.lon)) { out.push({ status: "UNSURE", group: "Site", check: "Test location", message: `${ctx.label(t.testId)} has no coordinates.`, target: `Site ${ctx.siteName}`, where: "", testId: t.testId, depths: [], points: [], sampIds: [] }); flagged++; continue; }
    if (!fin(ctx.siteLat)) continue;
    const d = haversine(ctx.siteLat, ctx.siteLon, t.lat, t.lon);
    if (d <= p) { ok++; continue; }
    flagged++;
    out.push({ status: d <= u ? "UNSURE" : "FAIL", group: "Site", check: "Test location", message: `${ctx.label(t.testId)} is ${d.toFixed(0)} m from the site coordinates${Math.abs(t.lat - ctx.siteLon) < 1 && Math.abs(t.lon - ctx.siteLat) < 1 ? " (latitude/longitude swapped?)" : ""}.`,
      target: `Site ${ctx.siteName}`, where: `(${t.lat.toFixed(5)}, ${t.lon.toFixed(5)})`, testId: t.testId, depths: [], points: [[t.lat, t.lon]], sampIds: [] });
  }
  if (ok && !flagged) add("PASS", "Test locations", `All ${ok} tests are within ${p} m of the site.`);
  // names
  const names = ctx.tests.map((t) => t.name.trim().toUpperCase());
  const dupN = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  if (dupN.length) add("FAIL", "Test names", `Duplicate test names at this site: ${dupN.join(", ")}.`);
  const pref = { CPT: /^(S?CPTU?|CPT)/i, Borehole: /^(B|BH|BOR|SPT|RW|HSA|EB|DH)/i, Vs: /^(SASW|MASW|SCPT|DH|CH|PS|VS|SW|REMI|INV)/i };
  const odd = ctx.tests.filter((t) => pref[t.kind] && /^[A-Z]{1,6}[-_ ]?\d/i.test(t.name) && Object.entries(pref).some(([k, re]) => k !== t.kind && re.test(t.name) && !pref[t.kind].test(t.name)));
  if (odd.length) add("UNSURE", "Test names", `${odd.length} test name(s) look like a different test type: ` + odd.map((t) => `${t.name} is ${t.type}`).join(", ") + ".");
  if (!dupN.length && !odd.length && ctx.tests.length) add("PASS", "Test names", `${ctx.tests.length} unique test names, consistent with their test types.`);
  const T = ctx.tests.filter((t) => fin(t.lat) && fin(t.lon));
  for (let i = 0; i < T.length; i++) for (let j = i + 1; j < T.length; j++)
    if (T[i].kind === T[j].kind && haversine(T[i].lat, T[i].lon, T[j].lat, T[j].lon) < 1)
      add("UNSURE", "Possible duplicate", `${ctx.label(T[i].testId)} and ${ctx.label(T[j].testId)} are at the same location.`);
  // tests without data
  for (const t of ctx.tests) {
    const has = { CPT: ctx.rows("SCPT", t.testId).length, Borehole: ctx.rows("STRA", t.testId).length + ctx.rows("SAMP", t.testId).length,
      Vs: ctx.rows("SWVD", t.testId).length + ctx.rows("GIND", t.testId).length }[t.kind];
    if (has === 0) add("FAIL", "Empty test", `${ctx.label(t.testId)} has no data rows.`);
  }
  // groundwater across the site
  const g = ctx.gwtSources();
  if (g.length >= 2) {
    const ds = g.map((x) => x.depth), sp = max(ds) - min(ds), [p2, u2] = THRESH.gwt_diff_m;
    add(sp <= p2 ? "PASS" : sp <= u2 ? "UNSURE" : "FAIL", "GWT agreement", `Groundwater depths range ${min(ds).toFixed(2)}–${max(ds).toFixed(2)} m across ${g.length} readings (spread ${sp.toFixed(2)} m). Seasonal variation is possible – check the dates.`,
      g.slice(0, 8).map((x) => `${ctx.test(x.testId)?.name ?? x.testId}: ${x.depth.toFixed(2)} m${x.date ? " (" + String(x.date).slice(0, 10) + ")" : ""}`).join("; "));
  } else if (!g.length) add("UNSURE", "GWT", "No groundwater depth (WATR) anywhere at the site.");
  const negG = g.filter((x) => x.depth < 0);
  if (negG.length) add("UNSURE", "GWT", `${negG.length} negative groundwater depth(s) (artesian / above ground?).`);
  // references
  if (!(ctx.t("SITP").length || ctx.t("TESP").length || ctx.t("FLDP").length)) add("UNSURE", "References", "No citation linked to the site, its tests or observations.");
  if (!ctx.tests.length) add("FAIL", "Tests", "Site has no field tests.");
  // review status consistency
  const sStat = ctx.R.first("SITE", ctx.t("SITE"), "stat", true), sRev = ctx.R.first("SITE", ctx.t("SITE"), "revw", true);
  const draftTests = ctx.tests.filter((t) => t.stat === 0);
  if (sStat === 1 && draftTests.length) add("UNSURE", "Submission status", `Site is submitted but ${draftTests.length} test(s) are not (TEST_STAT = 0): ${draftTests.map((t) => t.name).join(", ")}.`);
  if (sRev === 1 && ctx.tests.some((t) => t.revw === 0)) add("UNSURE", "Review status", "Site is marked reviewed but some tests are not (TEST_REVW = 0).");
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
    else if (t.kind === "Vs") r = { kind: "Vs", ...checkVs(ctx, t.testId, cptDers) };
    else r = { kind: t.kind, findings: [{ status: "UNSURE", group: "Other", check: "Not checked", message: `No automatic checks for test type '${t.type}'.`, target: ctx.label(t.testId), where: "", testId: t.testId, depths: [], points: [], sampIds: [] }] };
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
  return { ctx, findings, perTest, obs, cptDers, coverage: coverage(ctx) };
}

// what was found for the site, per data type (shown so reviewers see what was / wasn't checked)
export function coverage(ctx) {
  const n = (t) => ctx.t(t).length;
  return [
    ["Tests (TEST)", n("TEST")], ["CPT soundings (SCPG) / readings (SCPT)", `${n("SCPG")} / ${n("SCPT")}`],
    ["Boring records (BORH)", n("BORH")], ["Strata (STRA) / depth notes (DETL)", `${n("STRA")} / ${n("DETL")}`],
    ["Samples (SAMP) / SPT (ISPT)", `${n("SAMP")} / ${n("ISPT")}`], ["Specimens (SPEC)", n("SPEC")],
    ["Gradation tests (GRAG) / points (GRAT)", `${n("GRAG")} / ${n("GRAT")}`], ["Atterberg limits (PLAS)", n("PLAS")], ["Index tests (INDX)", n("INDX")],
    ["Groundwater (WATR)", n("WATR")], ["Surface-wave tests (GSWG / SWVG / SWVD / GSWD)", `${n("GSWG")} / ${n("SWVG")} / ${n("SWVD")} / ${n("GSWD")}`],
    ["Invasive Vs (GINV / GIND)", `${n("GINV")} / ${n("GIND")}`], ["Field observations (FLDO)", n("FLDO")],
    ["Manifestations (FLDM) / vectors (FLDD) / GM (GMIM)", `${n("FLDM")} / ${n("FLDD")} / ${n("GMIM")}`],
    ["Citations (SITP/TESP/FLDP)", n("SITP") + n("TESP") + n("FLDP")], ["Files (SITF/TESF/FLDF/SAMF)", n("SITF") + n("TESF") + n("FLDF") + n("SAMF")],
  ];
}

export const sortFindings = (fs) => [...fs].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.group.localeCompare(b.group));
export { mean };
