// Plots (Plotly.js) and maps (Leaflet).
import { fin, median, haversine } from "./util.js";
import { vsFromCpt, uscsGroup } from "./geotech.js";

const C = { line: "#1f4e79", grey: "#94a3b8", ref: "#c2410c", gwt: "#0284c7", fail: "rgba(220,38,38,0.20)", unsure: "rgba(234,160,0,0.22)" };
const USCS_COLOR = { coarse: "#f2d16b", fine: "#8fb3d9", organic: "#7a5c3e", null: "#d9d9d9" };
const CFG = { responsive: true, displaylogo: false, modeBarButtonsToRemove: ["select2d", "lasso2d"] };
const FONT = { family: "Inter, system-ui, sans-serif", size: 12, color: "#334155" };

function depthRanges(depths, pad = 0.05, join = 0.3) {
  const d = [...new Set(depths.filter(fin))].sort((a, b) => a - b);
  if (!d.length) return [];
  const out = []; let s = d[0], p = d[0];
  for (const x of d.slice(1)) { if (x - p > join) { out.push([s - pad, p + pad]); s = x; } p = x; }
  out.push([s - pad, p + pad]);
  return out;
}
function flagShapes(findings, nAxes) {
  const shapes = [];
  for (const f of findings) {
    if (f.status === "PASS") continue;
    for (const [a, b] of depthRanges(f.depths || []).slice(0, 40)) {
      for (let k = 1; k <= nAxes; k++) {
        shapes.push({ type: "rect", xref: `x${k === 1 ? "" : k} domain`, x0: 0, x1: 1, yref: "y", y0: a, y1: b, line: { width: 0 },
          fillcolor: f.status === "FAIL" ? C.fail : C.unsure, layer: "below" });
      }
    }
  }
  return shapes;
}
function hline(y, nAxes, color = C.gwt) {
  return Array.from({ length: nAxes }, (_, k) => ({ type: "line", xref: `x${k === 0 ? "" : k + 1} domain`, x0: 0, x1: 1, yref: "y", y0: y, y1: y,
    line: { color, width: 1, dash: "dot" } }));
}
function axes(n, titles, widths) {
  const lay = {}, gap = 0.025;
  const w = widths || Array(n).fill(1 / n);
  let x = 0;
  const ann = [];
  for (let k = 0; k < n; k++) {
    const key = k === 0 ? "xaxis" : `xaxis${k + 1}`;
    const d0 = x + (k ? gap / 2 : 0), d1 = x + w[k] - (k < n - 1 ? gap / 2 : 0);
    lay[key] = { domain: [d0, d1], anchor: "y", side: "top", gridcolor: "#eef2f7", zeroline: false, title: { text: titles[k], font: { size: 12 } } };
    x += w[k];
  }
  return { lay, ann };
}

export function cptPlot(el, der, raw, findings = [], gwt = null, overlay = null, fsLiq = null) {
  const n = fsLiq ? 5 : 4;
  const titles = ["qc / qt (MPa)", "fs (kPa)", "u2, u0 (kPa)", "Ic (Robertson 2009)", "FS liq. (BI2014)"].slice(0, n);
  const { lay } = axes(n, titles);
  const y = der.depth;
  const tr = [
    { x: raw.qc, y: raw.depth, name: "qc", xaxis: "x", line: { color: C.grey, width: 1 } },
    { x: der.qt_mpa, y, name: "qt", xaxis: "x", line: { color: C.line, width: 1.4 } },
    { x: raw.fs, y: raw.depth, name: "fs", xaxis: "x2", line: { color: C.line, width: 1.2 } },
  ];
  if (raw.u2.some(fin)) tr.push({ x: raw.u2, y: raw.depth, name: "u2", xaxis: "x3", line: { color: C.line, width: 1.2 } });
  tr.push({ x: der.u0, y, name: "u0 (hydrostatic)", xaxis: "x3", line: { color: "#0ea5e9", dash: "dash", width: 1.2 } });
  tr.push({ x: der.Ic, y, name: "Ic", xaxis: "x4", line: { color: C.line, width: 1.2 } });
  if (fsLiq) tr.push({ x: fsLiq.FS, y: fsLiq.depth, name: "FS", xaxis: "x5", line: { color: C.line } });
  if (overlay?.length) {
    const ax = { qc: "x", qt: "x", fs: "x2", u2: "x3" };
    for (const p of [...new Set(overlay.map((o) => o.param))]) {
      const g = overlay.filter((o) => o.param === p);
      tr.push({ x: g.map((o) => o.value), y: g.map((o) => o.depth), name: `reference ${p}`, xaxis: ax[p] || "x", mode: "lines+markers",
        line: { color: C.ref, width: 2 }, marker: { size: 4 } });
    }
  }
  tr.forEach((t) => { t.type = "scattergl"; t.mode ||= "lines"; t.yaxis = "y"; });
  const sbt = [[1, 1.31, "#f6c344"], [1.31, 2.05, "#f9dc7c"], [2.05, 2.6, "#cbd5e1"], [2.6, 2.95, "#93c5fd"], [2.95, 4, "#60a5fa"]]
    .map(([a, b, c]) => ({ type: "rect", xref: "x4", x0: a, x1: b, yref: "y domain", y0: 0, y1: 1, fillcolor: c, opacity: 0.3, line: { width: 0 }, layer: "below" }));
  const shapes = [...sbt, ...flagShapes(findings, n), ...(gwt !== null ? hline(gwt, n) : [])];
  if (fsLiq) shapes.push({ type: "line", xref: "x5", x0: 1, x1: 1, yref: "y domain", y0: 0, y1: 1, line: { color: "#dc2626", dash: "dot" } });
  lay.xaxis4.range = [1, 4];
  Plotly.react(el, tr, { ...lay, yaxis: { autorange: "reversed", title: { text: "Depth (m)" }, gridcolor: "#eef2f7", zeroline: false },
    shapes, height: 720, margin: { l: 55, r: 10, t: 50, b: 30 }, font: FONT, hovermode: "y unified",
    legend: { orientation: "h", y: -0.04 }, paper_bgcolor: "white", plot_bgcolor: "white" }, CFG);
}

export function borelogPlot(el, data, findings = [], gwt = null) {
  const { layers: lay, spt, samples: samp } = data;
  const { lay: L } = axes(3, ["Log (USCS / description)", "SPT N (blows/ft)", "FC (%) / PI"], [0.5, 0.28, 0.22]);
  const tr = [], shapes = [], ann = [];
  let zmax = 1;
  for (const l of lay || []) {
    const base = fin(l.base) ? l.base : l.top + 0.5;
    zmax = Math.max(zmax, base);
    shapes.push({ type: "rect", xref: "x", yref: "y", x0: 0, x1: 0.22, y0: l.top, y1: base, fillcolor: USCS_COLOR[uscsGroup(l.uscs)], line: { color: "#64748b", width: 0.5 } });
    ann.push({ xref: "x", yref: "y", x: 0.25, y: (l.top + base) / 2, xanchor: "left", showarrow: false, align: "left",
      text: `<b>${l.uscs || ""}</b> ${String(l.desc).slice(0, 70)}`, font: { size: 10 } });
  }
  if (spt?.length) {
    zmax = Math.max(zmax, ...spt.map((s) => s.depth));
    tr.push({ x: spt.map((s) => s.n), y: spt.map((s) => s.depth), name: "N", xaxis: "x2", mode: "markers+lines", marker: { color: C.line, size: 8 }, line: { color: C.line } });
    if (spt.some((s) => fin(s.er))) tr.push({ x: spt.map((s) => (s.n * s.er) / 60), y: spt.map((s) => s.depth), name: "N60", xaxis: "x2", mode: "markers", marker: { color: C.grey, symbol: "diamond", size: 7 } });
  }
  if (samp?.length) {
    const sp = samp.flatMap((x) => (x.specs || []).map((q) => ({ top: fin(q.top) ? q.top : x.top, fc: fin(q.fcIndx) ? q.fcIndx : q.fcGrat, pi: q.ll - q.pl })));
    if (sp.some((x) => fin(x.fc))) tr.push({ x: sp.map((x) => x.fc), y: sp.map((x) => x.top), name: "FC %", xaxis: "x3", mode: "markers", marker: { color: "#a16207", size: 9, symbol: "square" } });
    if (sp.some((x) => fin(x.pi))) tr.push({ x: sp.map((x) => x.pi), y: sp.map((x) => x.top), name: "PI", xaxis: "x3", mode: "markers", marker: { color: "#2563eb", size: 9, symbol: "triangle-up" } });
    samp.filter((x) => fin(x.top)).forEach((x) => shapes.push({ type: "line", xref: "x", yref: "y", x0: -0.03, x1: 0, y0: x.top, y1: x.top, line: { color: "black", width: 3 } }));
  }
  if (gwt !== null) { shapes.push(...hline(gwt, 3)); ann.push({ xref: "x", yref: "y", x: -0.015, y: gwt, text: "▽", showarrow: false, yshift: 8, font: { color: C.gwt } }); }
  if (data.depth) { zmax = Math.max(zmax, data.depth); shapes.push({ type: "line", xref: "x domain", x0: 0, x1: 0.45, yref: "y", y0: data.depth, y1: data.depth, line: { color: "black", width: 2 } }); }
  shapes.push(...flagShapes(findings, 3));
  tr.forEach((t) => { t.yaxis = "y"; t.type = "scatter"; });
  L.xaxis.range = [-0.05, 2.3]; L.xaxis.visible = false; L.xaxis.showgrid = false;
  L.xaxis.title = undefined;
  ann.push({ xref: "x domain", yref: "paper", x: 0.5, y: 1.02, text: "Log (USCS / description)", showarrow: false, yanchor: "bottom" });
  Plotly.react(el, tr, { ...L, yaxis: { range: [zmax + 0.5, 0], title: { text: "Depth (m)" }, gridcolor: "#eef2f7", zeroline: false },
    shapes, annotations: ann, height: 720, margin: { l: 55, r: 10, t: 50, b: 30 }, font: FONT, legend: { orientation: "h", y: -0.04 },
    paper_bgcolor: "white", plot_bgcolor: "white" }, CFG);
}

export function vsPlot(el, profiles, findings = [], cptDers = null, gwt = null) {
  const tr = [];
  const step = (t, b, v) => { const zz = [], vv = []; t.forEach((ti, i) => { const bi = fin(b[i]) ? b[i] : ti + 5; zz.push(ti, bi); vv.push(v[i], v[i]); }); return [vv, zz]; };
  for (const p of profiles) {
    const [x, y] = step(p.top, p.base, p.vs);
    tr.push({ x, y, name: `Vs profile ${p.id}`, mode: "lines", line: { color: C.line, width: 2.5 } });
    if (p.vp.some(fin)) { const [xp, yp] = step(p.top, p.base, p.vp); tr.push({ x: xp, y: yp, name: "Vp", mode: "lines", line: { color: C.grey, dash: "dot" }, visible: "legendonly" }); }
  }
  for (const [cid, der] of Object.entries(cptDers || {})) {
    if (der) tr.push({ x: vsFromCpt(der), y: der.depth, name: `CPT-based Vs (TEST ${cid})`, mode: "lines", line: { width: 1 }, opacity: 0.55 });
  }
  const shapes = [];
  for (const f of findings) if (f.status !== "PASS") depthRanges(f.depths || []).forEach(([a, b]) =>
    shapes.push({ type: "rect", xref: "paper", x0: 0, x1: 1, yref: "y", y0: a, y1: b, fillcolor: f.status === "FAIL" ? C.fail : C.unsure, line: { width: 0 }, layer: "below" }));
  if (gwt !== null) shapes.push({ type: "line", xref: "paper", x0: 0, x1: 1, yref: "y", y0: gwt, y1: gwt, line: { color: C.gwt, dash: "dot" } });
  const vmax = Math.max(...profiles.flatMap((p) => p.vs.filter(fin)), 100);
  const zmax = Math.max(...profiles.flatMap((p) => p.top), 5) + 5;
  Plotly.react(el, tr, { yaxis: { range: [zmax, 0], title: { text: "Depth (m)" }, gridcolor: "#eef2f7" },
    xaxis: { range: [0, vmax * 1.6], title: { text: "Velocity (m/s)" }, gridcolor: "#eef2f7", side: "top" },
    shapes, height: 620, margin: { l: 55, r: 10, t: 50, b: 30 }, font: FONT, legend: { orientation: "h", y: -0.05 }, paper_bgcolor: "white", plot_bgcolor: "white" }, CFG);
}

export function dispersionPlot(el, disp) {
  Plotly.react(el, [{ x: disp.map((d) => d.freq), y: disp.map((d) => d.vel), mode: "markers+lines", line: { color: C.line } }],
    { xaxis: { type: "log", title: { text: "Frequency (Hz)" }, gridcolor: "#eef2f7" }, yaxis: { title: { text: "Phase velocity (m/s)" }, gridcolor: "#eef2f7" },
      height: 340, margin: { l: 55, r: 10, t: 20, b: 45 }, font: FONT, paper_bgcolor: "white", plot_bgcolor: "white" }, CFG);
}

export function lateralPlot(el, info, ctx) {
  const V = info.vectors;
  if (!V?.length) return false;
  const kx = 111000 * Math.cos(ctx.siteLat * Math.PI / 180);
  const x = V.map((v) => (v.lon - ctx.siteLon) * kx), y = V.map((v) => (v.lat - ctx.siteLat) * 111000), mag = V.map((v) => Math.hypot(v.de, v.dn));
  const ann = V.map((v, i) => ({ x: x[i] + v.de * 20, y: y[i] + v.dn * 20, ax: x[i], ay: y[i], xref: "x", yref: "y", axref: "x", ayref: "y", showarrow: true, arrowhead: 2, arrowcolor: "#dc2626", arrowwidth: 1.5 }));
  Plotly.react(el, [
    { x, y, mode: "markers", marker: { size: 7, color: mag, colorscale: "Reds", showscale: true, colorbar: { title: { text: "m" }, x: 0.46 } }, xaxis: "x", yaxis: "y", hovertext: mag.map((m) => m.toFixed(2) + " m") },
    { x, y: mag, mode: "markers", marker: { color: C.line }, xaxis: "x2", yaxis: "y2" },
  ], { xaxis: { domain: [0, 0.42], title: { text: "Easting from site (m)" } }, yaxis: { scaleanchor: "x", title: { text: "Northing (m)" } },
    xaxis2: { domain: [0.58, 1], title: { text: "Easting from site (m)" } }, yaxis2: { anchor: "x2", title: { text: "Displacement (m)" } },
    annotations: ann, showlegend: false, height: 420, margin: { l: 55, r: 10, t: 20, b: 45 }, font: FONT, paper_bgcolor: "white", plot_bgcolor: "white" }, CFG);
  return true;
}

// ---------------------------------------------------------------- map
let _map = null;
export function siteMap(el, ctx, obs, findings, scale = 20) {
  if (_map) { _map.remove(); _map = null; }
  const lat0 = fin(ctx.siteLat) ? ctx.siteLat : median(ctx.tests.map((t) => t.lat)) || 0;
  const lon0 = fin(ctx.siteLon) ? ctx.siteLon : median(ctx.tests.map((t) => t.lon)) || 0;
  _map = L.map(el, { preferCanvas: true }).setView([lat0, lon0], 17);
  const providers = {
    "Streets (CARTO)": L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", { maxZoom: 20, subdomains: "abcd", attribution: "© OpenStreetMap contributors © CARTO" }),
    "Satellite (Esri)": L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 20, attribution: "Esri World Imagery" }),
    "OpenStreetMap": L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap contributors" }),
  };
  const order = Object.keys(providers);
  let cur = 0, errors = 0;
  const use = (i) => { order.forEach((k) => _map.removeLayer(providers[k])); providers[order[i]].addTo(_map); };
  order.forEach((k) => providers[k].on("tileerror", () => {
    if (providers[order[cur]] !== providers[k]) return;
    if (++errors > 6 && cur < order.length - 1) { errors = 0; cur++; use(cur); }
  }));
  use(0);
  const osm = providers[order[0]], sat = providers[order[1]];
  if (window.ResizeObserver) new ResizeObserver(() => _map && _map.invalidateSize()).observe(el);
  const groups = {};
  const grp = (n) => (groups[n] ||= L.layerGroup().addTo(_map));
  const bounds = [];
  if (fin(ctx.siteLat)) { L.circleMarker([ctx.siteLat, ctx.siteLon], { radius: 9, color: "#111", fillColor: "#111", fillOpacity: 0.9 }).bindTooltip(`Site: ${ctx.siteName}`).addTo(grp("Site")); bounds.push([ctx.siteLat, ctx.siteLon]); }
  const col = { CPT: "#2563eb", Borehole: "#16a34a", Vs: "#9333ea" };
  for (const t of ctx.tests) {
    if (!fin(t.lat) || !fin(t.lon)) continue;
    bounds.push([t.lat, t.lon]);
    L.circleMarker([t.lat, t.lon], { radius: 6, color: col[t.kind] || "#475569", fillColor: col[t.kind] || "#475569", fillOpacity: 0.85, weight: 1 })
      .bindTooltip(`${t.kind} ${t.name}`, { permanent: true, direction: "right", className: "map-label" }).addTo(grp("Tests"));
  }
  for (const [fid, o] of Object.entries(obs || {})) {
    for (const m of o.info.manifest || []) if (fin(m.lat)) {
      L.circleMarker([m.lat, m.lon], { radius: 6, color: "#a16207", fillColor: "#ca8a04", fillOpacity: 0.9 }).bindTooltip(`${m.type} ${m.severity}`).addTo(grp("Manifestations"));
      bounds.push([m.lat, m.lon]);
    }
    for (const v of o.info.vectors || []) if (fin(v.lat)) {
      const k = 111000;
      const tip = [v.lat + (v.dn * scale) / k, v.lon + (v.de * scale) / (k * Math.cos(v.lat * Math.PI / 180))];
      L.polyline([[v.lat, v.lon], tip], { color: "#dc2626", weight: 2.5 }).addTo(grp("Displacement vectors"));
      L.circleMarker(tip, { radius: 2.5, color: "#dc2626", fillOpacity: 1 }).bindTooltip(`${Math.hypot(v.de, v.dn).toFixed(2)} m`).addTo(grp("Displacement vectors"));
      bounds.push([v.lat, v.lon]);
    }
  }
  for (const f of findings) if (f.status !== "PASS") for (const p of f.points || []) {
    if (!fin(p[0])) continue;
    L.circleMarker(p, { radius: 16, color: f.status === "FAIL" ? "#dc2626" : "#f59e0b", weight: 3, fillOpacity: 0.15 })
      .bindTooltip(`${f.status === "FAIL" ? "Inconsistent" : "Not sure"}: ${f.check}`).addTo(grp("Flags"));
  }
  L.control.layers(providers, groups, { collapsed: false }).addTo(_map);
  L.control.scale().addTo(_map);
  if (bounds.length > 1) {
    // keep the view around the site; outliers far away should not shrink everything
    const near = bounds.filter((b) => !fin(ctx.siteLat) || haversine(ctx.siteLat, ctx.siteLon, b[0], b[1]) < 600);
    _map.fitBounds(near.length > 1 ? near : bounds, { padding: [30, 30], maxZoom: 18 });
  }
  setTimeout(() => _map.invalidateSize(), 50);
}
