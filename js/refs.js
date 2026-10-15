// References: NGL file/citation links, uploaded PDFs (pdf.js), digitised curve overlays.
import { THRESH } from "./config.js";
import { num, fin, median, columns } from "./util.js";

const JUNCTIONS = { SITF: "SITE_ID", TESF: "TEST_ID", FLDF: "FLDO_ID", SAMF: "SAMP_ID" };
const CIT_JUNCTIONS = { SITP: "SITE_ID", TESP: "TEST_ID", FLDP: "FLDO_ID" };

export function linkedFiles(B, R) {
  const F = B.FILE || [], out = [];
  for (const [j, key] of Object.entries(JUNCTIONS)) {
    const J = B[j] || [];
    if (!J.length || !("FILE_ID" in J[0])) continue;
    const cap = columns(J).find((c) => c.toUpperCase().includes("CAP"));
    for (const r of J) {
      const m = F.filter((f) => num(f.FILE_ID) === num(r.FILE_ID));
      out.push({ attachedTo: `${key}=${r[key]}`, fileId: r.FILE_ID, caption: cap ? r[cap] ?? "" : "",
        name: R.first("FILE", m, "name") ?? `file_${r.FILE_ID}`, type: R.first("FILE", m, "type") ?? "" });
    }
  }
  return out;
}

export function linkedCitations(B, R) {
  const C = B.CITATION || [], seen = new Map();
  for (const [j, key] of Object.entries(CIT_JUNCTIONS)) {
    for (const r of B[j] || []) {
      if (!("CITATION_ID" in r)) continue;
      const id = num(r.CITATION_ID);
      if (seen.has(id)) { seen.get(id).attachedTo.push(`${key}=${r[key]}`); continue; }
      const m = C.filter((c) => num(c.CITATION_ID) === id);
      const d = { id, attachedTo: [`${key}=${r[key]}`] };
      for (const k of ["authors", "year", "title", "doi", "url"]) d[k] = R.first("CITATION", m, k);
      if (!d.title && m.length) d.title = Object.values(m[0]).filter((v) => typeof v === "string").join(" | ").slice(0, 300);
      if (d.doi) d.link = "https://doi.org/" + String(d.doi).trim().replace("https://doi.org/", "");
      else if (d.url) d.link = d.url;
      else if (d.title) d.link = "https://scholar.google.com/scholar?q=" + encodeURIComponent(d.title);
      seen.set(id, d);
    }
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------- PDFs
export async function loadPdf(arrayBuffer) {
  const pdfjs = window.pdfjsLib;
  pdfjs.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
  const doc = await pdfjs.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
  const texts = [];
  for (let i = 1; i <= Math.min(doc.numPages, 150); i++) {
    const p = await doc.getPage(i);
    const tc = await p.getTextContent();
    texts.push(tc.items.map((it) => it.str).join(" "));
  }
  return { doc, texts, numPages: doc.numPages };
}
export async function renderPage(pdf, pageNo, canvas, width) {
  const p = await pdf.doc.getPage(pageNo);
  const vp0 = p.getViewport({ scale: 1 });
  const scale = (width || canvas.parentElement.clientWidth || 600) / vp0.width;
  const vp = p.getViewport({ scale: scale * (window.devicePixelRatio || 1) });
  canvas.width = vp.width; canvas.height = vp.height;
  canvas.style.width = "100%";
  await p.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
}

const norm = (s) => String(s).toUpperCase().replace(/[\s_\-]+/g, "");
export function findMentions(texts, names) {
  const res = {};
  for (const n of names) {
    const k = norm(n);
    if (k.length < 2) continue;
    res[n] = texts.map((t, i) => (norm(t).includes(k) ? i + 1 : 0)).filter(Boolean);
  }
  return res;
}
export function matchSequence(texts, values, pageFilter, tol = 0.5) {
  const vals = values.filter(fin);
  if (!vals.length) return { page: null, k: 0, n: 0 };
  let best = { page: null, k: 0 };
  texts.forEach((t, i) => {
    if (pageFilter && pageFilter.size && !pageFilter.has(i + 1)) return;
    const nums = (t.match(/(?<![\d.])\d+(?:\.\d+)?(?![\d.])/g) || []).map(Number);
    let j = 0, k = 0;
    while (j < nums.length && k < vals.length) { if (Math.abs(nums[j] - vals[k]) <= tol) k++; j++; }
    if (k > best.k) best = { page: i + 1, k };
  });
  return { ...best, n: vals.length };
}

export function referenceChecks(pdf, name, ctx, perTest) {
  const out = [];
  const F = (status, check, message, target, where, testId) => out.push({ status, group: "Reference", check, message, target, where, testId, depths: [], points: [] });
  if (!pdf.texts.some((t) => t.trim())) { F("UNSURE", "PDF text", `${name}: no text layer (scanned). Compare visually or digitise the figure.`, name, "", null); return out; }
  const names = ctx.tests.map((t) => t.name);
  const hits = findMentions(pdf.texts, names);
  for (const t of ctx.tests) {
    const pg = hits[t.name] || [];
    if (pg.length) F("PASS", "Test named in reference", `'${t.name}' appears in ${name} on page(s) ${pg.slice(0, 10).join(", ")}.`, ctx.label(t.testId), `${name} p.${pg[0]}`, t.testId);
    const r = perTest[t.testId];
    if (r && (r.kind === "Borehole" || r.kind === "Test pit") && r.data?.spt?.length) {
      const m = matchSequence(pdf.texts, r.data.spt.map((s) => s.n), new Set(pg));
      if (m.n) {
        const frac = m.k / m.n;
        F(frac >= 0.8 ? "PASS" : "UNSURE", "SPT N vs reference", `${m.k}/${m.n} SPT N values found in the same order on page ${m.page} of ${name}.` +
          (frac >= 0.8 ? "" : " Low match – may be a scanned or graphic log; compare visually."), ctx.label(t.testId), `${name} p.${m.page}`, t.testId);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- digitised overlays
export function parseOverlayCsv(text) {
  const lines = text.trim().split(/\r?\n/).map((l) => l.split(/[,;\t]/).map((s) => s.trim()));
  let header = lines[0].map((s) => s.toLowerCase());
  let rows = lines;
  const isNum = header.every((h) => fin(parseFloat(h)));
  if (!isNum) rows = lines.slice(1); else header = null;
  const out = [];
  for (const r of rows) {
    let depth, value, param = "qc";
    if (header && header.includes("depth") && header.includes("value")) {
      depth = parseFloat(r[header.indexOf("depth")]); value = parseFloat(r[header.indexOf("value")]);
      if (header.includes("param")) param = r[header.indexOf("param")] || "qc";
    } else { value = parseFloat(r[0]); depth = parseFloat(r[1]); }   // WebPlotDigitizer: x=value, y=depth
    if (fin(depth) && fin(value)) out.push({ depth, value, param });
  }
  return out;
}

export function overlayCompare(raw, overlay, tid, label) {
  const out = [], [p_, u_] = THRESH.ref_overlay_rel_diff;
  const params = [...new Set(overlay.map((o) => o.param))];
  for (const param of params) {
    const col = { qc: "qc", qt: "qc", fs: "fs", u2: "u2" }[param];
    if (!col) continue;
    const idx = raw.depth.map((_, i) => i).filter((i) => fin(raw[col][i]));
    const z = idx.map((i) => raw.depth[i]), v = idx.map((i) => raw[col][i]);
    const g = overlay.filter((o) => o.param === param && o.depth >= z[0] && o.depth <= z[z.length - 1]).sort((a, b) => a.depth - b.depth);
    if (g.length < 3) { out.push(mk("UNSURE", `Overlay ${param}`, "The digitised curve does not overlap the data depths.", label, "", tid)); continue; }
    const win = Math.max(1, Math.floor(z.length / g.length / 2));
    const sm = v.map((_, i) => median(v.slice(Math.max(0, i - win), i + win + 1)));
    const interp = (x) => { let k = z.findIndex((zz) => zz >= x); if (k <= 0) return sm[Math.max(k, 0)]; const t = (x - z[k - 1]) / (z[k] - z[k - 1]); return sm[k - 1] + t * (sm[k] - sm[k - 1]); };
    const err = (shift) => median(g.map((o) => { const a = interp(o.depth + shift); return Math.abs(o.value - a) / Math.max(Math.abs(a), 1e-6); }));
    const rel = g.map((o) => { const a = interp(o.depth); return Math.abs(o.value - a) / Math.max(Math.abs(a), 1e-6); });
    const med = median(rel), st = med <= p_ ? "PASS" : med <= u_ ? "UNSURE" : "FAIL";
    const bad = g.filter((o, i) => rel[i] > u_).map((o) => o.depth);
    out.push({ ...mk(st, `Overlay ${param}`, `Median relative difference between the reference and NGL ${param}: ${(med * 100).toFixed(0)}% (${g.length} digitised points).`,
      label, st === "PASS" ? "" : `${bad.length} points > ${(u_ * 100).toFixed(0)}%`, tid), depths: bad });
    let best = [0, med];
    for (let s = -1; s <= 1.001; s += 0.05) { const e = err(s); if (e < best[1]) best = [s, e]; }
    if (Math.abs(best[0]) >= 0.2 && best[1] < med * 0.6)
      out.push(mk("UNSURE", `Depth shift ${param}`, `The reference matches much better if shifted by ${best[0] >= 0 ? "+" : ""}${best[0].toFixed(2)} m (${(best[1] * 100).toFixed(0)}% vs ${(med * 100).toFixed(0)}%) – check the depth datum or predrill.`, label, "", tid));
  }
  return out;
}
const mk = (status, check, message, target, where, testId) => ({ status, group: "Reference", check, message, target, where, testId, depths: [], points: [] });
