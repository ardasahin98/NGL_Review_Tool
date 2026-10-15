// Boring logs drawn by the UCLA Geo Boring Log Viewer API
// (https://uclageo.com/boring-log-viewer/api/render). The NGL boring is converted to the
// viewer's JSON format; review flags go into a "Review flags" column (per sample) and into
// depth notes (per layer), and the flagged depth ranges are shaded on the returned SVG.
import { fin, median } from "./util.js";

export const BLV_URL = "https://uclageo.com/boring-log-viewer/api/render";
const USCS_RE = /^((GW|GP|GM|GC|SW|SP|SM|SC|ML|CL|OL|MH|CH|OH|PT)([-/][A-Z]{1,2})?|[A-Z]{1,2}[-/](GW|GP|GM|GC|SW|SP|SM|SC|ML|CL|OL|MH|CH|OH|PT))$/;
const SAMPLE_USCS_RE = /^(GW|GP|GM|GC|SW|SP|SM|SC|ML|CL|OL|MH|CH|OH|PT)([-/](GW|GP|GM|GC|SW|SP|SM|SC|ML|CL|OL|MH|CH|OH|PT))?$/;
const ICON = { FAIL: "✕", UNSURE: "?" };

function samplerType(t) {
  const s = String(t || "").toLowerCase();
  if (/spt|split/.test(s)) return "SPT";
  if (/shelby|thin.?wall/.test(s)) return "Shelby";
  if (/mod.*cal|california/.test(s)) return "ModCal";
  if (/dames/.test(s)) return "DamesMoore";
  if (/piston/.test(s)) return "Piston";
  if (/pitcher/.test(s)) return "Pitcher";
  if (/denison/.test(s)) return "Denison";
  if (/bulk/.test(s)) return "Bulk";
  if (/grab/.test(s)) return "Grab";
  if (/core/.test(s)) return "Core";
  if (/sonic/.test(s)) return "Sonic";
  if (/push/.test(s)) return "DirectPush";
  return "Other";
}
const pos = (x) => (fin(x) && x >= 0 ? x : undefined);
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "" && !(typeof v === "number" && !fin(v))));

// Build the viewer JSON. `findings` = this boring's findings (to label samples / depths).
export function boringJson(ctx, tid, data, findings, citations = []) {
  const t = ctx.test(tid) || {};
  const R = ctx.R, bh = ctx.rows("BORH", tid);
  const er = median((data.spt || []).map((x) => x.er));
  const flagsBySamp = new Map();
  const notes = [];
  for (const f of findings) {
    if (f.status === "PASS") continue;
    const txt = `${ICON[f.status]} ${f.group === "Lab" ? f.message.slice(0, 60) : f.check}`;
    if (f.sampIds?.length) f.sampIds.forEach((id) => { if (!flagsBySamp.has(id)) flagsBySamp.set(id, []); flagsBySamp.get(id).push(txt); });
    else if (f.depths?.length) notes.push({ depth: Math.max(0, Math.min(...f.depths.filter(fin))), description: `${ICON[f.status]} ${f.check}: ${f.message}`.slice(0, 160) });
  }
  const layers = [];
  const warnings = [];
  for (const [i, l] of (data.layers || []).entries()) {
    let bottom = fin(l.base) ? l.base : (data.layers[i + 1]?.top);
    if (!fin(l.top) || !fin(bottom) || bottom <= l.top) { warnings.push(`layer at ${l.top} m skipped (invalid top/base)`); continue; }
    layers.push(clean({ top: l.top, bottom, description: l.desc || undefined, uscs: l.uscsRaw && USCS_RE.test(l.uscsRaw) ? l.uscsRaw : undefined }));
  }
  if (!layers.length) {
    const zmax = Math.max(1, ...(data.samples || []).map((s) => (fin(s.base) ? s.base : s.top)).filter(fin));
    layers.push({ top: 0, bottom: zmax, description: "(no strata in NGL)", hatch: "none" });
  }
  const samples = (data.samples || []).filter((s) => fin(s.top)).map((s) => {
    const spt = s.spt?.[0];
    const flags = flagsBySamp.get(s.sampId);
    return clean({
      top: s.top, bottom: fin(s.base) && s.base > s.top ? s.base : s.top + 0.45, name: s.name || undefined, type: samplerType(s.type),
      blow_count: spt && fin(spt.n) ? spt.n : undefined, energy_ratio: spt && fin(spt.er) && spt.er > 0 ? spt.er : undefined,
      uscs: (() => { const m = String(s.desc || "").toUpperCase().match(/\b(GW|GP|GM|GC|SW|SP|SM|SC|ML|CL|MH|CH|OL|OH|PT)\b/); return m && SAMPLE_USCS_RE.test(m[1]) ? m[1] : undefined; })(),
      remarks: s.desc || undefined,
      specimens: s.specs.length ? s.specs.map((sp) => clean({
        name: sp.ref || undefined, top: pos(sp.top), bottom: fin(sp.base) && fin(sp.top) && sp.base >= sp.top ? sp.base : undefined,
        water_content: pos(sp.wc), specific_gravity: fin(sp.gs) && sp.gs > 0 ? sp.gs : undefined,
        fines_content: fin(sp.fcIndx) && sp.fcIndx >= 0 && sp.fcIndx <= 100 ? sp.fcIndx : fin(sp.fcGrat) && sp.fcGrat >= 0 && sp.fcGrat <= 100 ? Math.round(sp.fcGrat * 10) / 10 : undefined,
        liquid_limit: pos(sp.ll), plastic_limit: pos(sp.pl),
      })) : undefined,
      custom: flags ? { review: flags.join(" · ") } : undefined,
    });
  });
  const gw = ctx.rows("WATR", tid).map((w) => clean({ depth: pos(R.first("WATR", [w], "depth", true)), date: String(R.first("WATR", [w], "date") ?? "").slice(0, 10) || undefined })).filter((g) => fin(g.depth));
  const detl = (data.detl || []).filter((d) => fin(d.depth) && d.depth >= 0 && d.desc).map((d) => ({ depth: d.depth, description: d.desc }));
  const json = {
    schema_version: "1.0",
    units: { length: "m" },
    metadata: clean({ site_name: ctx.siteName, boring_name: t.name, latitude: fin(t.lat) ? t.lat : undefined, longitude: fin(t.lon) ? t.lon : undefined,
      boring_type: R.first("BORH", bh, "type") ?? bh[0]?.BORH_TYPE, hammer: bh[0]?.BORH_MECH, logged_by: bh[0]?.BORH_CREW,
      start_date: bh[0]?.BORH_STAR ? String(bh[0].BORH_STAR).slice(0, 10) : undefined, energy_ratio: fin(er) && er > 0 ? er : undefined,
      notes: `NGL TEST_ID ${tid}` }),
    groundwater: gw.length ? gw : undefined,
    layers,
    depth_notes: detl.concat(notes).length ? detl.concat(notes) : undefined,
    samples: samples.length ? samples : undefined,
    references: citations.length ? citations.slice(0, 50).map((c) => clean({ text: String(c.title || c.text || "").slice(0, 2000) || "reference", url: c.link })) : undefined,
    layout: { columns: ["depth", "groundwater", "graphic", "uscs", "description", "sample_type", "sample_name", "blow_count", "specimen",
      "water_content", "fines_content", "liquid_limit", "plastic_limit", { id: "review", label: "Review flags", source: "sample", width: 5 }] },
  };
  return { json: clean(json), warnings };
}

export async function renderBoring(json, { width = 900 } = {}) {
  const r = await fetch(`${BLV_URL}?format=svg&units=m&width=${width}&hide_empty_columns=true`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(json) });
  const text = await r.text();
  if (!r.ok) {
    let msg = text;
    try { const js = JSON.parse(text); msg = (js.error || "") + (js.errors ? ": " + js.errors.map((e) => `${e.path} ${e.message}`).join("; ") : ""); } catch { /* */ }
    throw new Error(`Boring log viewer: HTTP ${r.status} ${msg}`.slice(0, 600));
  }
  return { svg: text, warnings: r.headers.get("X-Boring-Log-Warnings") };
}

// Shade flagged depth ranges on the rendered SVG. The depth axis is read from the tick
// labels in the depth column (linear), so nothing about the layout has to be assumed.
export function shadeSvg(svgText, findings) {
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  const svg = doc.documentElement;
  const ticks = [...svg.querySelectorAll('text[text-anchor="end"]')]
    .map((t) => ({ v: parseFloat(t.textContent), y: parseFloat(t.getAttribute("y")), x: parseFloat(t.getAttribute("x")) }))
    .filter((t) => fin(t.v) && fin(t.y) && t.x < 80);
  if (ticks.length < 2) return { svg: svgText, map: null };
  ticks.sort((a, b) => a.v - b.v);
  const a = ticks[0], b = ticks[ticks.length - 1];
  // labels sit a few px below their tick line; use the tick lines instead when available
  const lines = [...svg.querySelectorAll("line")].filter((l) => l.getAttribute("stroke-width") === "0.75" && Math.abs(parseFloat(l.getAttribute("y1")) - parseFloat(l.getAttribute("y2"))) < 0.01 && parseFloat(l.getAttribute("x2")) - parseFloat(l.getAttribute("x1")) < 8);
  const yOf = (t) => {
    let best = null, bd = 12;
    for (const ln of lines) { const dy = Math.abs(parseFloat(ln.getAttribute("y1")) - t.y); if (dy < bd) { bd = dy; best = ln; } }
    return best ? parseFloat(best.getAttribute("y1")) : t.y;
  };
  const ya = yOf(a), yb = yOf(b);
  const k = (yb - ya) / (b.v - a.v);
  const map = (z) => ya + (z - a.v) * k;
  const W = parseFloat(svg.getAttribute("width")) || 800;
  const g = doc.createElementNS("http://www.w3.org/2000/svg", "g");
  g.setAttribute("id", "review-shading");
  const pad = 0.08;
  for (const f of findings) {
    if (f.status === "PASS" || !f.depths?.length) continue;
    const d = [...new Set(f.depths.filter(fin))].sort((x, y) => x - y);
    const ranges = []; let s = d[0], p = d[0];
    for (const x of d.slice(1)) { if (x - p > 0.3) { ranges.push([s, p]); s = x; } p = x; }
    ranges.push([s, p]);
    for (const [lo, hi] of ranges) {
      const r = doc.createElementNS("http://www.w3.org/2000/svg", "rect");
      r.setAttribute("x", 10); r.setAttribute("width", W - 20);
      r.setAttribute("y", map(lo - pad)); r.setAttribute("height", Math.max(3, (hi - lo + 2 * pad) * k));
      r.setAttribute("fill", f.status === "FAIL" ? "rgba(220,38,38,0.18)" : "rgba(234,160,0,0.22)");
      r.setAttribute("data-depth", lo);
      const title = doc.createElementNS("http://www.w3.org/2000/svg", "title");
      title.textContent = `${f.status === "FAIL" ? "Inconsistent" : "Not sure"} – ${f.check}: ${f.message}`;
      r.appendChild(title);
      g.appendChild(r);
    }
  }
  const bg = svg.querySelector('rect[width="100%"]');
  if (bg && bg.nextSibling) svg.insertBefore(g, bg.nextSibling); else svg.appendChild(g);
  return { svg: new XMLSerializer().serializeToString(svg), map, k };
}
