// Source comparison: put the NGL data on top of the figure the contributor uploaded
// (PDF page or image), at the figure's own scale, and compare them.
//
//   1. The reviewer calibrates the figure: clicks two points on the value axis and two on
//      the depth axis and types their values (any units; converted to NGL units).
//   2. The NGL series is drawn on the figure (red).
//   3. "Compare" traces the figure's curve along each depth (pixels of the curve colour
//      near where the NGL value is drawn) and measures the difference.
//      -> findings in group "Source comparison": matches / differs (with depths) / can't tell.
import { fin, median } from "./util.js";
import * as refs from "./refs.js";

export const GROUP = "Source comparison";

// parameters that can be compared, NGL units, unit conversions to NGL units, tolerance
export const PARAMS = {
  qc: { label: "qc (cone tip resistance)", ngl: "MPa", units: { MPa: 1, kPa: 0.001, bar: 0.1, tsf: 0.09576, "kg/cm²": 0.0981, psi: 0.006895 }, floor: 0.5, rel: 0.15 },
  fs: { label: "fs (sleeve friction)", ngl: "kPa", units: { kPa: 1, MPa: 1000, bar: 100, tsf: 95.76, "kg/cm²": 98.07, psi: 6.895 }, floor: 5, rel: 0.2 },
  u2: { label: "u2 (pore pressure)", ngl: "kPa", units: { kPa: 1, MPa: 1000, bar: 100, tsf: 95.76, psi: 6.895, "m water": 9.81 }, floor: 20, rel: 0.2 },
  Rf: { label: "Rf (friction ratio)", ngl: "%", units: { "%": 1 }, floor: 0.3, rel: 0.2 },
  N: { label: "SPT N", ngl: "blows", units: { blows: 1 }, floor: 2, rel: 0.15, points: true },
  Vs: { label: "Vs (shear-wave velocity)", ngl: "m/s", units: { "m/s": 1, "ft/s": 0.3048 }, floor: 20, rel: 0.1 },
};
const DEPTH_UNITS = { m: 1, ft: 0.3048 };

const LS = "ngl_src_cal";
const loadCal = () => { try { return JSON.parse(localStorage.getItem(LS) || "{}"); } catch { return {}; } };
const saveCal = (all) => { try { localStorage.setItem(LS, JSON.stringify(all)); } catch { /* */ } };

// ---------------------------------------------------------------- page rendering
async function drawSource(doc, page, canvas) {
  if (doc.pdf) {
    const p = await doc.pdf.doc.getPage(page);
    const vp0 = p.getViewport({ scale: 1 });
    const vp = p.getViewport({ scale: Math.min(4, 1800 / vp0.width) });
    canvas.width = vp.width; canvas.height = vp.height;
    await p.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
  } else {
    const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = doc.url; });
    const k = Math.min(1, 2400 / img.naturalWidth);
    canvas.width = img.naturalWidth * k; canvas.height = img.naturalHeight * k;
    const g = canvas.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(img, 0, 0, canvas.width, canvas.height);
  }
}

// ---------------------------------------------------------------- calibration maps
function makeMap(cal) {
  const P = PARAMS[cal.param], ku = P.units[cal.unit] ?? 1, kd = DEPTH_UNITS[cal.dunit] ?? 1;
  const lg = cal.log;
  const xv = (v) => (lg ? Math.log10(v) : v);
  const [x1, x2, y1, y2] = [cal.x1, cal.x2, cal.y1, cal.y2];
  const v1 = xv(x1.v * ku), v2 = xv(x2.v * ku), d1 = y1.v * kd, d2 = y2.v * kd;
  return {
    px: (v) => x1.px + ((xv(v) - v1) / (v2 - v1)) * (x2.px - x1.px),   // NGL value -> pixel x
    py: (d) => y1.py + ((d - d1) / (d2 - d1)) * (y2.py - y1.py),        // depth [m] -> pixel y
    val: (px) => { const t = v1 + ((px - x1.px) / (x2.px - x1.px)) * (v2 - v1); return lg ? 10 ** t : t; },
    xmin: Math.min(x1.px, x2.px), xmax: Math.max(x1.px, x2.px),
  };
}

// ---------------------------------------------------------------- tracing
function isCurve(d, i, col) {
  const r = d[i], g = d[i + 1], b = d[i + 2];
  if (col) return Math.abs(r - col[0]) + Math.abs(g - col[1]) + Math.abs(b - col[2]) < 90;
  return 0.299 * r + 0.587 * g + 0.114 * b < 110;          // default: dark ink
}
function traceRow(img, y, xFrom, xTo, col) {
  const W = img.width, out = [];
  y = Math.round(y);
  if (y < 0 || y >= img.height) return out;
  for (let x = Math.max(0, Math.round(xFrom)); x <= Math.min(W - 1, Math.round(xTo)); x++) if (isCurve(img.data, (y * W + x) * 4, col)) out.push(x);
  return out;
}
// pixels that are part of long vertical/horizontal lines (axes, grid) are not the curve
function isGridColumn(img, x, y, col) {
  let run = 0;
  for (let dy = -25; dy <= 25; dy++) { const yy = y + dy; if (yy < 0 || yy >= img.height) continue; if (isCurve(img.data, (yy * img.width + x) * 4, col)) run++; }
  return run > 46;
}

// Compare NGL series [{d, v}] with the curve in the figure.
export function compare(canvas, cal, series) {
  const P = PARAMS[cal.param];
  const M = makeMap(cal);
  const img = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
  const span = Math.abs(M.xmax - M.xmin), win = Math.max(12, span * 0.12);
  const col = cal.color || null;
  const pts = series.filter((p) => fin(p.d) && fin(p.v) && (!cal.log || p.v > 0));
  // resample to at most ~1 point per 2 px of depth
  const step = Math.max(1, Math.floor(pts.length / Math.max(50, Math.abs(M.py(Math.max(...pts.map((p) => p.d))) - M.py(Math.min(...pts.map((p) => p.d)))) / 2)));
  const res = [];
  for (let i = 0; i < pts.length; i += P.points ? 1 : step) {
    const { d, v } = pts[i];
    const y = M.py(d), x = M.px(v);
    if (y < 0 || y >= canvas.height) continue;
    const inside = x >= M.xmin - 2 && x <= M.xmax + 2;
    // search near the NGL value; if NGL is off the axis, search the whole axis width
    const cand = (inside ? traceRow(img, y, x - win, x + win, col) : traceRow(img, y, M.xmin + 2, M.xmax - 2, col)).filter((px) => !isGridColumn(img, px, Math.round(y), col));
    let state, fig = NaN, fx = NaN;
    if (!cand.length) {
      if (inside) {
        // nothing near: is there a curve elsewhere on this row?
        const any = traceRow(img, y, M.xmin + 2, M.xmax - 2, col).filter((px) => !isGridColumn(img, px, Math.round(y), col));
        if (any.length) { fx = any.reduce((a, b) => (Math.abs(b - x) < Math.abs(a - x) ? b : a)); fig = M.val(fx); state = "differs"; }
        else state = "untraced";
      } else state = "untraced";
    } else {
      fx = cand.reduce((a, b) => (Math.abs(b - x) < Math.abs(a - x) ? b : a));
      fig = M.val(fx);
      state = Math.abs(fig - v) <= Math.max(P.floor, P.rel * Math.abs(v)) || Math.abs(fx - x) <= 3 ? "match" : "differs";
    }
    res.push({ d, v, fig, x, y, fx, state });
  }
  return res;
}

// group comparison results into findings
export function findingsFrom(res, cal, ctxLabel, tid, docName, page) {
  const P = PARAMS[cal.param];
  const out = [];
  const n = res.length, nm = res.filter((r) => r.state === "match").length, nd = res.filter((r) => r.state === "differs").length, nu = n - nm - nd;
  const where = `${docName}${page ? ` p.${page}` : ""}`;
  const F = (status, check, message, w, depths) => out.push({ status, group: GROUP, check, message, target: ctxLabel, where: w, testId: tid, depths: depths || [], points: [], sampIds: [], source: true });
  if (!n) { F("UNSURE", `Figure vs NGL ${cal.param}`, "No NGL points fall inside the calibrated depth range of the figure.", where); return out; }
  // contiguous ranges of "differs"
  const ranges = []; let cur = null;
  for (const r of res) {
    if (r.state === "differs") { if (!cur) cur = []; cur.push(r); }
    else if (r.state === "match" && cur) { ranges.push(cur); cur = null; }
  }
  if (cur) ranges.push(cur);
  for (const g of ranges) {
    const lo = g[0].d, hi = g[g.length - 1].d;
    if (g.length < (P.points ? 1 : 3)) continue;  // single stray pixel rows are noise
    const mv = median(g.map((r) => r.v)), mf = median(g.map((r) => r.fig).filter(fin));
    F("FAIL", `Differs from figure (${cal.param})`, `${lo.toFixed(2)}–${hi.toFixed(2)} m: NGL ${cal.param} ≈ ${fmtv(mv)} ${P.ngl} but the figure shows ≈ ${fmtv(mf)} ${P.ngl}.`,
      where, g.map((r) => r.d));
  }
  const frac = nm / Math.max(1, nm + nd);
  if (nm + nd < n * 0.3) F("UNSURE", `Figure vs NGL ${cal.param}`, `Could trace the figure's curve at only ${((nm + nd) / n * 100).toFixed(0)}% of depths – pick the curve colour, or check the calibration.`, where);
  else F(frac >= 0.9 ? "PASS" : frac >= 0.7 ? "UNSURE" : "FAIL", `Figure vs NGL ${cal.param}`,
    `NGL ${cal.param} matches the uploaded figure at ${(frac * 100).toFixed(0)}% of traced depths (${nm} match, ${nd} differ, ${nu} not traceable; tolerance ±${(P.rel * 100).toFixed(0)}% or ${P.floor} ${P.ngl}).`, where);
  return out;
}
const fmtv = (x) => (fin(x) ? (Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(2)) : "?");

// ---------------------------------------------------------------- UI component
// el: container; docs: [{name, pdf|url, testId, caption}]; series: {param: [{d,v}]};
// onResult(findings) is called after each comparison.
export function sourcePanel(el, { docs, series, tid, label, target, preferParams, onResult, initialFindings }) {
  if (!docs.length) {
    el.innerHTML = `<div class="drop small"><b>No source figure for this test.</b><br>Files uploaded to NGL for this site load automatically on the References tab (needs the NGL website login). You can also drop a PDF or image there.</div>`;
    return;
  }
  const params = Object.keys(series).filter((k) => series[k]?.some((p) => fin(p.v)));
  const st = { doc: 0, page: 1, mode: null, cal: null };
  const keyOf = () => `${docs[st.doc].name}|${st.page}|${tid}`;
  const html = `
    <div class="srcbar">
      <select id="sdoc" class="grow">${docs.map((d, i) => `<option value="${i}">${d.testId === tid ? "★ " : ""}${escapeHtml(d.name)}${d.caption ? " – " + escapeHtml(d.caption) : ""}</option>`).join("")}</select>
      <span id="spg"></span>
    </div>
    <div class="srccal">
      <div class="row small" style="gap:6px;flex-wrap:wrap">
        <b>1. Calibrate</b>
        <select id="spar">${params.map((p) => `<option value="${p}">${PARAMS[p].label}</option>`).join("")}</select>
        <select id="sunit"></select>
        <label class="row" style="margin:0;font-weight:400"><input type="checkbox" id="slog" style="width:auto"> log axis</label>
        depth in <select id="sdu"><option>m</option><option>ft</option></select>
      </div>
      <div class="calgrid small">
        ${["x1", "x2", "y1", "y2"].map((k) => `<div><button data-k="${k}" class="place">${k[0] === "x" ? "Value" : "Depth"} point ${k[1]}</button>
          <input data-k="${k}" class="cv" type="number" step="any" placeholder="${k[0] === "x" ? "value" : "depth"}"><span class="pxv" id="p_${k}">–</span></div>`).join("")}
      </div>
      <div class="row small" style="gap:6px;flex-wrap:wrap;margin-top:4px">
        <b>2.</b><button id="scol">Pick curve colour</button><span id="scolv" class="swatch"></span>
        <b>3.</b><button id="scmp" class="primary">Compare with NGL</button><button id="sclr">Clear</button>
        <span id="smsg" class="muted"></span>
      </div>
      <p class="small muted" style="margin:4px 0 0">Click a <i>point</i> button, then click that tick on the figure and type its value. The NGL data is drawn in <b style="color:#dc2626">red</b>; traced figure points in <b style="color:#2563eb">blue</b>; differing depths are shaded.</p>
    </div>
    <div class="srcwrap" id="swrap"><canvas id="sbase"></canvas><canvas id="sov"></canvas></div>
    <div id="sres"></div>`;
  el.innerHTML = html;
  const $ = (s) => el.querySelector(s);
  const base = $("#sbase"), ov = $("#sov");

  const unitOpts = () => { const p = $("#spar").value; $("#sunit").innerHTML = Object.keys(PARAMS[p].units).map((u) => `<option>${u}</option>`).join(""); };
  if (preferParams) { const p = preferParams.find((x) => params.includes(x)); if (p) $("#spar").value = p; }
  unitOpts();

  const toCanvas = (e) => { const r = base.getBoundingClientRect(); return { px: (e.clientX - r.left) * base.width / r.width, py: (e.clientY - r.top) * base.height / r.height }; };

  const currentCal = () => {
    const c = st.cal || {};
    c.param = $("#spar").value; c.unit = $("#sunit").value; c.log = $("#slog").checked; c.dunit = $("#sdu").value;
    for (const k of ["x1", "x2", "y1", "y2"]) { const v = parseFloat(el.querySelector(`.cv[data-k="${k}"]`).value); c[k] = { ...(c[k] || {}), v }; }
    st.cal = c;
    return c;
  };
  const ready = (c) => ["x1", "x2", "y1", "y2"].every((k) => c[k] && fin(c[k].v) && fin(k[0] === "x" ? c[k].px : c[k].py)) && c.x1.v !== c.x2.v && c.y1.v !== c.y2.v;

  const drawOverlay = (res) => {
    ov.width = base.width; ov.height = base.height;
    const g = ov.getContext("2d");
    g.clearRect(0, 0, ov.width, ov.height);
    const c = st.cal;
    if (!c) return;
    // calibration marks
    g.lineWidth = 2; g.strokeStyle = "#16a34a"; g.fillStyle = "#16a34a"; g.font = `${Math.max(14, base.width / 90)}px sans-serif`;
    for (const k of ["x1", "x2"]) if (c[k]?.px !== undefined) { g.beginPath(); g.moveTo(c[k].px, 0); g.lineTo(c[k].px, ov.height); g.setLineDash([6, 6]); g.stroke(); g.setLineDash([]); g.fillText(`${k}=${c[k].v ?? "?"}`, c[k].px + 4, 20); }
    for (const k of ["y1", "y2"]) if (c[k]?.py !== undefined) { g.beginPath(); g.moveTo(0, c[k].py); g.lineTo(ov.width, c[k].py); g.setLineDash([6, 6]); g.stroke(); g.setLineDash([]); g.fillText(`${k}=${c[k].v ?? "?"}`, 4, c[k].py - 4); }
    if (!ready(c)) return;
    const M = makeMap(c), s = series[c.param] || [];
    if (res) for (const r of res) if (r.state === "differs") { g.fillStyle = "rgba(220,38,38,0.12)"; g.fillRect(0, r.y - 2, ov.width, 4); }
    g.save(); g.beginPath(); g.rect(M.xmin - 3, 0, M.xmax - M.xmin + 6, ov.height); g.clip();   // stay inside the calibrated axis
    g.strokeStyle = "#dc2626"; g.fillStyle = "#dc2626"; g.lineWidth = Math.max(2, base.width / 700);
    if (PARAMS[c.param].points) s.forEach((p) => { if (fin(p.v)) { g.beginPath(); g.arc(M.px(p.v), M.py(p.d), 6, 0, 7); g.fill(); } });
    else { g.beginPath(); let on = false; s.forEach((p) => { if (!fin(p.v) || (c.log && p.v <= 0)) { on = false; return; } const x = M.px(p.v), y = M.py(p.d); on ? g.lineTo(x, y) : g.moveTo(x, y); on = true; }); g.stroke(); }
    g.restore();
    if (res) { g.fillStyle = "#2563eb"; res.forEach((r) => { if (fin(r.fx)) { g.beginPath(); g.arc(r.fx, r.y, 2.5, 0, 7); g.fill(); } }); }
  };

  const showDoc = async () => {
    const d = docs[st.doc];
    $("#spg").innerHTML = d.pdf ? `<button id="spp">‹</button> page <input id="spn" type="number" min="1" max="${d.pdf.numPages}" value="${st.page}" style="width:60px"> / ${d.pdf.numPages} <button id="snp">›</button>` : "";
    if (d.pdf) {
      $("#spp").onclick = () => { if (st.page > 1) { st.page--; showDoc(); } };
      $("#snp").onclick = () => { if (st.page < d.pdf.numPages) { st.page++; showDoc(); } };
      $("#spn").onchange = (e) => { st.page = Math.min(d.pdf.numPages, Math.max(1, Number(e.target.value) || 1)); showDoc(); };
    }
    await drawSource(d, st.page, base);
    // restore a saved calibration for this document/page/test
    const saved = loadCal()[keyOf()];
    st.cal = saved ? JSON.parse(JSON.stringify(saved)) : null;
    if (saved) {
      $("#spar").value = saved.param; unitOpts(); $("#sunit").value = saved.unit; $("#slog").checked = !!saved.log; $("#sdu").value = saved.dunit || "m";
      for (const k of ["x1", "x2", "y1", "y2"]) { el.querySelector(`.cv[data-k="${k}"]`).value = saved[k]?.v ?? ""; $("#p_" + k).textContent = saved[k] ? "✓" : "–"; }
      $("#scolv").style.background = saved.color ? `rgb(${saved.color.join(",")})` : "transparent";
    } else {
      for (const k of ["x1", "x2", "y1", "y2"]) { el.querySelector(`.cv[data-k="${k}"]`).value = ""; $("#p_" + k).textContent = "–"; }
      $("#scolv").style.background = "transparent";
    }
    drawOverlay(null);
    $("#sres").innerHTML = "";
  };

  // auto-select the document attached to this test, and a page that names it
  const own = docs.findIndex((d) => d.testId === tid);
  if (own >= 0) st.doc = own;
  const d0 = docs[st.doc];
  if (d0.pdf && label) { const h = refs.findMentions(d0.pdf.texts, [label])[label] || []; if (h.length) st.page = h[0]; }
  $("#sdoc").value = st.doc;
  $("#sdoc").onchange = (e) => { st.doc = Number(e.target.value); st.page = 1; showDoc(); };
  $("#spar").onchange = () => { unitOpts(); drawOverlay(null); };
  for (const id of ["#sunit", "#slog", "#sdu"]) $(id).onchange = () => { currentCal(); drawOverlay(null); };
  el.querySelectorAll(".cv").forEach((i) => (i.oninput = () => { currentCal(); drawOverlay(null); }));
  el.querySelectorAll(".place").forEach((b) => (b.onclick = () => { st.mode = b.dataset.k; $("#smsg").textContent = `Click the ${b.dataset.k[0] === "x" ? "value-axis" : "depth-axis"} tick for point ${b.dataset.k[1]} on the figure…`; ov.style.cursor = "crosshair"; }));
  $("#scol").onclick = () => { st.mode = "color"; $("#smsg").textContent = "Click on the data curve in the figure…"; ov.style.cursor = "copy"; };
  ov.onclick = (e) => {
    if (!st.mode) return;
    const p = toCanvas(e);
    currentCal();
    if (st.mode === "color") {
      const px = base.getContext("2d").getImageData(Math.round(p.px), Math.round(p.py), 1, 1).data;
      st.cal.color = [px[0], px[1], px[2]];
      $("#scolv").style.background = `rgb(${px[0]},${px[1]},${px[2]})`;
    } else {
      st.cal[st.mode] = { ...(st.cal[st.mode] || {}), px: p.px, py: p.py };
      $("#p_" + st.mode).textContent = "✓";
      el.querySelector(`.cv[data-k="${st.mode}"]`).focus();
    }
    st.mode = null; ov.style.cursor = "default"; $("#smsg").textContent = "";
    drawOverlay(null);
  };
  $("#sclr").onclick = () => { const all = loadCal(); delete all[keyOf()]; saveCal(all); st.cal = null; showDoc(); onResult([], keyOf()); };
  $("#scmp").onclick = () => {
    const c = currentCal();
    if (!ready(c)) { $("#smsg").textContent = "Place all four calibration points and type their values first."; return; }
    const all = loadCal(); all[keyOf()] = c; saveCal(all);
    const res = compare(base, c, series[c.param] || []);
    drawOverlay(res);
    const fs = findingsFrom(res, c, target || label || "", tid, docs[st.doc].name, docs[st.doc].pdf ? st.page : null);
    $("#sres").innerHTML = fs.map((f) => `<div class="issue ${f.status}"><b>${escapeHtml(f.check)}</b><div class="small">${escapeHtml(f.message)}</div></div>`).join("");
    onResult(fs, keyOf());
  };
  showDoc();
}

function escapeHtml(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

// series of a test for comparison
export function seriesFor(kind, t) {
  if (kind === "CPT" && t.raw && t.der) {
    const r = t.raw;
    return { qc: r.depth.map((d, i) => ({ d, v: r.qc[i] })), fs: r.depth.map((d, i) => ({ d, v: r.fs[i] })),
      u2: r.depth.map((d, i) => ({ d, v: r.u2[i] })), Rf: t.der.depth.map((d, i) => ({ d, v: t.der.rf[i] })) };
  }
  if ((kind === "Borehole" || kind === "Test pit") && t.data) return { N: (t.data.spt || []).map((s) => ({ d: s.depth, v: s.n })) };
  if (kind === "Vs" && t.data) {
    const out = [];
    for (const p of t.data.profiles) p.top.forEach((z, i) => { const b = Number.isFinite(p.base[i]) ? p.base[i] : z + 5; for (let d = z; d < b; d += Math.max(0.05, (b - z) / 40)) out.push({ d, v: p.vs[i] }); });
    return { Vs: out };
  }
  return {};
}
