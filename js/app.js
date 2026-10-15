// NGL Review Assistant – single-page app (hash routing).
import { session, NGLClient, NGLError, verifyRole } from "./api.js";
import { Resolver, loadOverrides, saveOverrides } from "./schema.js";
import { runAll, worst, sortFindings } from "./checks.js";
import { STATUS_LABEL, STATUS_ICON, FIELDS, NGL_ORIGIN, API_BASE, ROLES } from "./config.js";
import { esc, fin, fmt, columns } from "./util.js";
import { bi2014, lpi } from "./geotech.js";
import * as viz from "./viz.js";
import * as refs from "./refs.js";
import * as blv from "./blv.js";
import demoData from "./demo-data.js";

const $ = (s, el = document) => el.querySelector(s);
const view = $("#view");
const client = new NGLClient();
const S = {           // app state
  siteId: null, bundle: null, res: null, R: new Resolver(loadOverrides()),
  uploads: [],        // {name, type, data(ArrayBuffer), pdf?, url?}
  overlays: {},       // testId -> [{depth,value,param}]
  tab: "summary", sel: {}, queue: null,
};
const ls = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* */ } },
};

const badge = (s) => `<span class="badge b-${s}"><span class="ic">${STATUS_ICON[s]}</span>${STATUS_LABEL[s]}</span>`;
const isDemo = () => S.siteId === "demo";

// ------------------------------------------------------------------ shell
function renderWho() {
  const s = session.get();
  $("#who").innerHTML = s
    ? `<label class="small muted" style="margin:0">Role</label><select id="role" style="width:auto" title="Privilege level sent to the NGL API">
         ${Object.entries(ROLES).map(([k, r]) => `<option value="${k}" ${session.role() === k ? "selected" : ""}>${r.label}</option>`).join("")}</select>
       <span class="pill" title="Access token lifetime">● ${esc(s.user)} · ${session.minutesLeft()} min left</span><button id="logout">Sign out</button>`
    : `<span class="pill">Demo mode</span><a class="btn primary" href="index.html">Sign in</a>`;
  $("#logout")?.addEventListener("click", () => { session.clear(); location.href = "index.html"; });
  $("#role")?.addEventListener("change", async (e) => {
    const prev = session.role(), to = e.target.value;
    session.setRole(to);
    if (ROLES[to].param) {
      try { await verifyRole(); }
      catch (err) { session.setRole(prev); alertBox(err.message); renderWho(); return; }
    }
    try { localStorage.setItem("ngl_last_role", to); } catch { /* */ }
    S.queue = null; S.bundle = null; S.res = null; client._cols = {};
    route();
  });
}
setInterval(renderWho, 60000);

async function route() {
  renderWho();
  const [, r, arg] = (location.hash || "#/queue").split("/");
  document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.r === r));
  const needsLogin = !(r === "site" && (arg === "demo" || (!arg && isDemo()))) && r !== "about" && r !== "schema";
  if (needsLogin && !session.get()) { location.href = "index.html"; return; }
  try {
    if (r === "site") await pageSite(arg);
    else if (r === "calibration") pageCalibration();
    else if (r === "schema") pageSchema();
    else if (r === "about") pageAbout();
    else await pageQueue();
  } catch (e) {
    view.innerHTML = `<div class="card"><h2>Something went wrong</h2><p class="error" style="display:block">${esc(e.message)}</p></div>`;
    if (e instanceof NGLError && /expired|token/i.test(e.message)) setTimeout(() => (location.href = "index.html"), 1500);
  }
}
window.addEventListener("hashchange", route);

// ------------------------------------------------------------------ review queue
async function pageQueue() {
  view.innerHTML = `<div class="card"><div class="row"><div class="grow"><h1>Review queue</h1>
    <div class="muted">Sites submitted but not yet reviewed. Signed in as <b>${ROLES[session.role()].label}</b>${session.role() === "user" ? " – NGL hides other contributors' unreviewed sites; switch the role at the top right." : session.role() === "reviewer" ? " – sites awaiting review are included." : " – all sites, including never-submitted drafts, are included."}</div></div>
    <button id="refresh">Refresh</button></div></div><div class="card" id="qcard"><div class="empty">Loading sites…</div></div>`;
  $("#refresh").onclick = () => { S.queue = null; pageQueue(); };
  if (!S.queue) {
    try { S.queue = await client.siteLists(); }
    catch (e) { $("#qcard").innerHTML = `<p class="error" style="display:block">${esc(e.message)}</p>`; return; }
  }
  const q = S.queue, cols = columns(q).filter((c) => !c.startsWith("_"));
  const revCols = cols.filter((c) => /STAT|REVW|REVIEW|VERS/i.test(c));
  const show = ["SITE_ID", "SITE_NAME", "SITE_LAT", "SITE_LON", ...revCols].filter((c) => cols.includes(c));
  let states = new Set(["submitted", "second"]), text = "";
  const cnt = (st) => q.filter((r) => r._state === st).length;
  const STATE = { submitted: ['b-UNSURE', 'Awaiting review (0 of 2)'], second: ['b-UNSURE', 'Needs 2nd review (1 of 2)'],
    draft: ['b-draft', 'Not submitted (draft)'], reviewed: ['b-PASS', 'Reviewed (2 of 2)'] };
  const draw = () => {
    const rows = q.filter((r) => states.has(r._state) && (!text || JSON.stringify(r).toLowerCase().includes(text)));
    $("#qcard").innerHTML = `<div class="toolbar"><input type="search" id="qs" placeholder="Filter by name or ID…" value="${esc(text)}">
      <div class="chips">${Object.entries(STATE).map(([k, [, l]]) => `<span class="chip ${states.has(k) ? "on" : ""}" data-st="${k}">${l} (${cnt(k)})</span>`).join("")}</div>
      <span class="muted small grow" style="text-align:right" title="${esc(JSON.stringify(client.pageInfo.SITE || {}))}">${q.length} sites loaded${client.pageInfo.SITE ? ` in ${client.pageInfo.SITE.calls} request(s)` : ""}${session.role() === "user" ? " · signed in as User: choose Reviewer to include unreviewed sites" : ""}</span>
      <span class="small muted">or open SITE_ID</span><input id="qid" style="width:110px" placeholder="e.g. 123"><button id="qgo">Open</button></div>
      <div class="tbl-wrap"><table><thead><tr><th>Status</th>${show.map((c) => `<th>${esc(c)}</th>`).join("")}<th></th></tr></thead><tbody>
      ${rows.map((r) => `<tr class="clickable" data-id="${esc(r.SITE_ID)}"><td><span class="badge ${STATE[r._state][0]}">${STATE[r._state][1]}</span></td>
        ${show.map((c) => `<td>${esc(r[c])}</td>`).join("")}<td><a href="#/site/${esc(r.SITE_ID)}">Review →</a></td></tr>`).join("") || `<tr><td colspan="9" class="empty">No sites.</td></tr>`}
      </tbody></table></div>`;
    $("#qs").oninput = (e) => { text = e.target.value.toLowerCase(); draw(); $("#qs").focus(); $("#qs").setSelectionRange(text.length, text.length); };
    document.querySelectorAll(".chip[data-st]").forEach((c) => (c.onclick = () => { states.has(c.dataset.st) ? states.delete(c.dataset.st) : states.add(c.dataset.st); draw(); }));
    $("#qgo").onclick = () => { const v = $("#qid").value.trim(); if (v) location.hash = "#/site/" + v; };
    document.querySelectorAll("tr.clickable").forEach((tr) => (tr.onclick = (e) => { if (e.target.tagName !== "A") location.hash = "#/site/" + tr.dataset.id; }));
  };
  draw();
}

// ------------------------------------------------------------------ site review
async function loadSite(id) {
  if (S.siteId === id && S.bundle) return;
  S.uploads = []; S.overlays = {}; S.tab = "summary"; S.sel = {};
  if (id === "demo") { S.bundle = structuredClone(demoData); S.bundle._log = ["Demo bundle (synthetic data with planted errors)."]; }
  else {
    view.innerHTML = `<div class="card"><h2>Loading site ${esc(id)}…</h2><div class="progress"><div id="pb"></div></div><p class="muted small" id="pt"></p></div>`;
    S.bundle = await client.buildBundle(id, { progress: (p, t) => { $("#pb").style.width = (p * 100).toFixed(0) + "%"; $("#pt").textContent = t; } });
  }
  S.siteId = id;
  S.res = null;
}
function results() {
  if (!S.res) S.res = runAll(S.bundle, S.R);
  return S.res;
}
function allFindings() {
  const r = results(), out = [...r.findings];
  for (const u of S.uploads) if (u.pdf) out.push(...refs.referenceChecks(u.pdf, u.name, r.ctx, r.perTest));
  for (const [tid, ov] of Object.entries(S.overlays)) {
    const t = r.perTest[tid];
    if (t?.raw) out.push(...refs.overlayCompare(t.raw, ov, Number(tid), r.ctx.label(Number(tid))));
  }
  return sortFindings(out);
}

async function pageSite(id) {
  if (!id && !S.siteId) { view.innerHTML = `<div class="card empty">Open a site from the <a href="#/queue">review queue</a>, or try the <a href="#/site/demo">demo site</a>.</div>`; return; }
  if (id && id !== S.siteId) await loadSite(id);
  if (!S.bundle?.SITE?.length) { view.innerHTML = `<div class="card"><h2>Site ${esc(S.siteId)} not found</h2><p class="muted">The API returned no site with this ID (not submitted, or no access).</p></div>`; return; }
  const r = results(), ctx = r.ctx, F = allFindings();
  const cnt = (s) => F.filter((f) => f.status === s).length;
  const rev = Object.entries(ctx.site).filter(([k]) => /STAT|REVW|REVIEW|VERS/i.test(k));
  const kinds = (k) => Object.values(r.perTest).filter((t) => t.kind === k || (k === "Borehole" && t.kind === "Test pit")).length;
  const tabs = [["summary", "Summary"], ["map", "Map & observations", Object.keys(r.obs).length], ["cpt", "CPT", kinds("CPT")],
    ["bh", "Boreholes", kinds("Borehole")], ["vs", "Vs", kinds("Vs")], ["refs", "References", S.uploads.length], ["report", "Report"]];
  view.innerHTML = `
    <div class="card"><div class="row"><div class="grow">
      <div class="muted small">SITE_ID ${esc(S.siteId)} ${isDemo() ? '· <b>synthetic demo data</b>' : ""}</div>
      <h1>${esc(ctx.siteName)}</h1>
      <div class="muted small">lat ${fmt(ctx.siteLat, 5)}, lon ${fmt(ctx.siteLon, 5)} · ${ctx.tests.length} tests · ${Object.keys(r.obs).length} field observations
      ${rev.length ? " · " + rev.map(([k, v]) => `${esc(k)} = <b>${esc(v)}</b>`).join(", ") : ""}</div></div>
    </div>
    <div class="kpis" style="margin-top:14px">
      <div class="kpi ${worst(F)}"><div class="l">Overall</div><div class="v">${badge(worst(F))}</div></div>
      <div class="kpi FAIL"><div class="l">Inconsistent</div><div class="v">${cnt("FAIL")}</div></div>
      <div class="kpi UNSURE"><div class="l">Not sure</div><div class="v">${cnt("UNSURE")}</div></div>
      <div class="kpi PASS"><div class="l">Consistent</div><div class="v">${cnt("PASS")}</div></div>
    </div></div>
    <div class="card"><div class="tabs">${tabs.map(([k, l, n]) => `<button data-t="${k}" class="${S.tab === k ? "active" : ""}">${l}${n !== undefined ? `<span class="count">${n}</span>` : ""}</button>`).join("")}</div>
    <div id="tab"></div></div>`;
  document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => { S.tab = b.dataset.t; pageSite(); }));
  const T = $("#tab");
  ({ summary: tabSummary, map: tabMap, cpt: tabCpt, bh: tabBh, vs: tabVs, refs: tabRefs, report: tabReport })[S.tab](T, r, F);
}

function findingsTable(el, F, { filters = true, initial = ["FAIL", "UNSURE"] } = {}) {
  let st = new Set(filters ? initial : ["FAIL", "UNSURE", "PASS"]), grp = "", q = "";
  const groups = [...new Set(F.map((f) => f.group))];
  const draw = () => {
    const rows = F.filter((f) => st.has(f.status) && (!grp || f.group === grp) && (!q || (f.check + f.message + f.target + f.where).toLowerCase().includes(q)));
    el.innerHTML = (filters ? `<div class="toolbar"><div class="chips">${["FAIL", "UNSURE", "PASS"].map((s) => `<span class="chip ${st.has(s) ? "on" : ""}" data-s="${s}">${STATUS_LABEL[s]} (${F.filter((f) => f.status === s).length})</span>`).join("")}</div>
      <select id="fg"><option value="">All groups</option>${groups.map((g) => `<option ${g === grp ? "selected" : ""}>${esc(g)}</option>`).join("")}</select>
      <input type="search" id="fq" placeholder="Search findings…" value="${esc(q)}"></div>` : "") +
      `<div class="tbl-wrap"><table><thead><tr><th>Status</th><th>Group</th><th>Check</th><th>Target</th><th>Where</th><th>Details</th></tr></thead><tbody>
      ${rows.map((f) => `<tr class="${f.testId ? "clickable" : ""}" data-tid="${f.testId ?? ""}" data-i="${F.indexOf(f)}"><td>${badge(f.status)}</td><td>${esc(f.group)}</td><td><b>${esc(f.check)}</b></td>
        <td>${esc(f.target)}</td><td class="where">${esc(f.where)}</td><td>${esc(f.message)}</td></tr>`).join("") || `<tr><td colspan="6" class="empty">No findings with these filters.</td></tr>`}
      </tbody></table></div>`;
    if (filters) {
      el.querySelectorAll(".chip").forEach((c) => (c.onclick = () => { st.has(c.dataset.s) ? st.delete(c.dataset.s) : st.add(c.dataset.s); draw(); }));
      $("#fg", el).onchange = (e) => { grp = e.target.value; draw(); };
      $("#fq", el).oninput = (e) => { q = e.target.value.toLowerCase(); draw(); const i = $("#fq", el); i.focus(); i.setSelectionRange(q.length, q.length); };
    }
    el.querySelectorAll("tr.clickable").forEach((tr) => (tr.onclick = () => gotoTest(Number(tr.dataset.tid), F[Number(tr.dataset.i)])));
  };
  draw();
}
function gotoTest(tid, f = null) {
  const t = results().perTest[tid];
  if (!t) return;
  const tab = { CPT: "cpt", Borehole: "bh", "Test pit": "bh", Vs: "vs" }[t.kind];
  if (!tab) return;
  S.tab = tab; S.sel[tab] = tid; S.focus = f ? fkey(f) : null;
  pageSite(); window.scrollTo({ top: 0, behavior: "smooth" });
}
const fkey = (f) => `${f.testId}|${f.check}|${f.where}|${f.message}`;

// Issues panel: every flag for one test, worst first; "Show" zooms the plot/log to it.
function issuesPanel(el, fs, onShow) {
  const flags = fs.filter((f) => f.status !== "PASS");
  const passed = fs.filter((f) => f.status === "PASS");
  el.innerHTML = `<div class="issues"><div class="row" style="margin-bottom:6px"><h3 class="grow" style="margin:0">Issues (${flags.length})</h3>
      ${flags.length ? `<button id="inext" title="Go to the next issue">Next issue ↓</button>` : ""}</div>
    ${flags.map((f, i) => `<div class="issue ${f.status}" data-i="${i}">
        <div class="row" style="gap:8px">${badge(f.status)}<b class="grow">${esc(f.check)}</b>${f.depths?.length ? `<button class="show" data-i="${i}">Show ▸</button>` : ""}</div>
        <div class="small">${esc(f.message)}</div>${f.where ? `<div class="where">${esc(f.where)}</div>` : ""}</div>`).join("") || `<div class="muted">No issues – every check passed.</div>`}
    <details style="margin-top:8px"><summary class="small">${passed.length} checks passed</summary>
      ${passed.map((f) => `<div class="small" style="padding:4px 0;border-bottom:1px solid var(--line)">${badge("PASS")} <b>${esc(f.check)}</b> – ${esc(f.message)}</div>`).join("")}</details></div>`;
  let cur = -1;
  const pick = (i) => {
    cur = i;
    el.querySelectorAll(".issue").forEach((d) => d.classList.toggle("sel", Number(d.dataset.i) === i));
    el.querySelector(`.issue[data-i="${i}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    onShow(flags[i]);
  };
  el.querySelectorAll(".issue").forEach((d) => (d.onclick = () => pick(Number(d.dataset.i))));
  el.querySelector("#inext")?.addEventListener("click", () => flags.length && pick((cur + 1) % flags.length));
  if (S.focus) { const i = flags.findIndex((f) => fkey(f) === S.focus); S.focus = null; if (i >= 0) setTimeout(() => pick(i), 300); }
}
// zoom a depth plot (Plotly, reversed y) to a finding
function zoomPlot(el, f, full) {
  if (!f || !f.depths?.length) { Plotly.relayout(el, { "yaxis.range": full }); return; }
  const d = f.depths.filter(fin), lo = Math.min(...d), hi = Math.max(...d), pad = Math.max(1, (hi - lo) * 0.5);
  Plotly.relayout(el, { "yaxis.range": [hi + pad, Math.max(0, lo - pad)], "yaxis.autorange": false });
}

function tabSummary(T, r, F) {
  const ctx = r.ctx;
  const rows = ctx.tests.map((t) => { const fs = F.filter((f) => f.testId === t.testId); return { t, fs, st: fs.length ? worst(fs) : "UNSURE" }; });
  T.innerHTML = `<h3>Tests</h3><div class="tbl-wrap" style="max-height:none;margin-bottom:18px"><table><thead><tr><th>Status</th><th>TEST_ID</th><th>Name</th><th>Kind</th><th>Type</th>
    <th class="num">Inconsistent</th><th class="num">Not sure</th><th class="num">Consistent</th></tr></thead><tbody>
    ${rows.map(({ t, fs, st }) => `<tr class="clickable" data-tid="${t.testId}"><td>${badge(st)}</td><td>${t.testId}</td><td><b>${esc(t.name)}</b></td><td>${esc(t.kind)}</td><td>${esc(t.type)}</td>
      ${["FAIL", "UNSURE", "PASS"].map((s) => `<td class="num">${fs.filter((f) => f.status === s).length}</td>`).join("")}</tr>`).join("")}
    ${Object.entries(r.obs).map(([fid, o]) => `<tr><td>${badge(o.status)}</td><td>—</td><td><b>FLDO ${fid}</b></td><td>Field observation</td><td>FLDO</td>
      ${["FAIL", "UNSURE", "PASS"].map((s) => `<td class="num">${o.findings.filter((f) => f.status === s).length}</td>`).join("")}</tr>`).join("")}
    </tbody></table></div>
    <details style="margin-bottom:16px"><summary><b>What was loaded and checked</b> (records per NGL table)</summary>
      <div class="tbl-wrap" style="max-height:none;margin-top:8px"><table><tbody>${r.coverage.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${esc(v)}</td></tr>`).join("")}</tbody></table></div>
      <p class="small muted">A table with 0 records is either empty for this site or not visible with your role. See the Checks page for what is verified in each table.</p></details>
    <h3>Findings</h3><p class="small muted" style="margin-top:-4px">Click a finding to open its test with the problem depth highlighted.</p><div id="ft"></div>
    <details style="margin-top:14px"><summary class="small muted">Data loading log</summary><pre class="small">${esc((S.bundle._log || []).join("\n"))}</pre></details>`;
  T.querySelectorAll("tr.clickable").forEach((tr) => (tr.onclick = () => gotoTest(Number(tr.dataset.tid))));
  findingsTable($("#ft", T), F);
}

function tabMap(T, r, F) {
  T.innerHTML = `<div class="toolbar"><span class="muted small">Displacement arrows exaggerated</span><input type="range" id="sc" min="1" max="100" value="20" style="width:200px"><b id="scv">×20</b>
    <span class="legend-flags grow" style="justify-content:flex-end"><span>Flagged locations are circled red (inconsistent) / orange (not sure)</span></span></div>
    <div id="map"></div><div id="obs"></div>`;
  const draw = (s) => viz.siteMap($("#map"), r.ctx, r.obs, F, s);
  draw(20);
  $("#sc").oninput = (e) => { $("#scv").textContent = "×" + e.target.value; };
  $("#sc").onchange = (e) => draw(Number(e.target.value));
  const O = $("#obs");
  for (const [fid, o] of Object.entries(r.obs)) {
    const i = o.info, ev = i.evnt || {};
    const d = document.createElement("div");
    d.style.marginTop = "20px";
    d.innerHTML = `<div class="row"><h2 class="grow" style="margin:0">Observation FLDO ${fid}</h2>${badge(o.status)}</div>
      <p class="muted">Event <b>${esc(ev.name ?? "?")}</b> (${esc(ev.date ?? "?")}, M${esc(ev.mag ?? "?")}) · PGA ${i.pga !== null ? fmt(i.pga, 3) + " g" : "—"} ·
      manifestation flag: ${esc(i.manif ?? "—")} · ${i.vectors?.length ?? 0} displacement vectors · ${i.manifest?.length ?? 0} manifestation points</p>
      <div class="plot" id="lat${fid}"></div><div id="of${fid}"></div>`;
    O.appendChild(d);
    if (!viz.lateralPlot($(`#lat${fid}`), i, r.ctx)) $(`#lat${fid}`).remove();
    findingsTable($(`#of${fid}`), o.findings, { filters: false });
  }
}

function testPicker(T, key, ids, r) {
  if (!ids.length) { T.innerHTML = `<div class="empty">No ${key === "cpt" ? "CPTs" : key === "bh" ? "boreholes" : "Vs profiles"} at this site.</div>`; return null; }
  const sel = ids.includes(S.sel[key]) ? S.sel[key] : ids[0];
  S.sel[key] = sel;
  return sel;
}
function pickerHtml(key, ids, sel, r, F) {
  return `<select id="pick">${ids.map((id) => { const st = worst(F.filter((f) => f.testId === id)); return `<option value="${id}" ${id === sel ? "selected" : ""}>${STATUS_ICON[st]} ${esc(r.ctx.label(id))}</option>`; }).join("")}</select>`;
}
function refPanel(el, tid, ctx) {
  if (!S.uploads.length) {
    el.innerHTML = `<div class="drop small">Upload the source report or figure on the <a href="#" id="toRefs">References</a> tab to view it here beside the plot.</div>`;
    $("#toRefs", el).onclick = (e) => { e.preventDefault(); S.tab = "refs"; pageSite(); };
    return;
  }
  const name = ctx.test(tid)?.name;
  let idx = Math.max(0, S.uploads.findIndex((u) => u.pdf && (refs.findMentions(u.pdf.texts, [name])[name] || []).length));
  const draw = async () => {
    const u = S.uploads[idx];
    const hits = u.pdf ? refs.findMentions(u.pdf.texts, [name])[name] || [] : [];
    let page = hits[0] || 1;
    el.innerHTML = `<div class="toolbar"><select id="rsel" class="grow">${S.uploads.map((x, i) => `<option value="${i}" ${i === idx ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select>
      ${u.pdf ? `<button id="pp">‹</button><span id="pn"></span><button id="np">›</button>` : ""}</div>
      ${u.pdf ? `<div class="small muted" style="margin-bottom:6px">${hits.length ? `“${esc(name)}” found on page(s) ${hits.join(", ")}` : `“${esc(name)}” not found in the text layer`}</div><canvas class="pdfpage" id="cv"></canvas>`
        : `<img src="${u.url}" style="width:100%;border:1px solid var(--line);border-radius:6px">`}`;
    $("#rsel", el).onchange = (e) => { idx = Number(e.target.value); draw(); };
    if (u.pdf) {
      const show = async () => { $("#pn", el).textContent = `page ${page} / ${u.pdf.numPages}`; await refs.renderPage(u.pdf, page, $("#cv", el)); };
      $("#pp", el).onclick = () => { if (page > 1) { page--; show(); } };
      $("#np", el).onclick = () => { if (page < u.pdf.numPages) { page++; show(); } };
      show();
    }
  };
  draw();
}

function tabCpt(T, r, F) {
  const ids = Object.entries(r.perTest).filter(([, t]) => t.kind === "CPT").map(([k]) => Number(k));
  const tid = testPicker(T, "cpt", ids, r); if (tid === null) return;
  const t = r.perTest[tid], fs = F.filter((f) => f.testId === tid);
  const o = Object.values(r.obs)[0];
  const canLiq = o && fin(o.info.pga) && o.info.evnt && fin(o.info.evnt.mag);
  T.innerHTML = `<div class="toolbar">${pickerHtml("cpt", ids, tid, r, F)} ${badge(worst(fs))}
      ${canLiq ? `<label class="row" style="margin:0;font-weight:400"><input type="checkbox" id="liq" style="width:auto" ${S.liq ? "checked" : ""}> BI2014 factor of safety</label>` : ""}
      <span class="grow"></span><span class="legend-flags"><span class="lf">Inconsistent</span><span class="lu">Not sure</span></span></div>
    <div class="grid2"><div><div class="row small" style="justify-content:flex-end"><button id="rz">Reset zoom</button></div><div class="plot" id="plot"></div><div class="small muted" id="liqtxt"></div></div>
      <div><div id="iss"></div><div id="ref" style="margin-top:14px"></div></div></div>
    <details style="margin-top:12px"><summary>Overlay a digitised reference curve (CSV)</summary>
      <p class="small muted">Digitise the CPT plot in the report (e.g. with WebPlotDigitizer) and load a CSV with columns <code>depth,value,param</code> (param = qc, fs or u2; units MPa / kPa as in NGL), or the two-column WebPlotDigitizer export (x = value, y = depth, treated as qc). The tool overlays it and measures the difference.</p>
      <input type="file" id="ov" accept=".csv,.txt" style="width:auto"> ${S.overlays[tid] ? `<button id="ovx">Remove overlay (${S.overlays[tid].length} pts)</button>` : ""}
    </details>`;
  $("#pick").onchange = (e) => { S.sel.cpt = Number(e.target.value); pageSite(); };
  if (t.der) {
    let liq = null;
    if (canLiq && S.liq) { liq = bi2014(t.der, o.info.pga, o.info.evnt.mag); $("#liqtxt").textContent = `LPI = ${fmt(lpi(liq.depth, liq.FS), 1)} (PGA ${o.info.pga} g, M${o.info.evnt.mag}, Boulanger & Idriss 2014)`; }
    viz.cptPlot($("#plot"), t.der, t.raw, fs, t.meta.gwt, S.overlays[tid], liq);
  } else $("#plot").innerHTML = `<div class="empty">No plottable data.</div>`;
  $("#liq") && ($("#liq").onchange = (e) => { S.liq = e.target.checked; pageSite(); });
  refPanel($("#ref"), tid, r.ctx);
  const full = t.der ? [Math.max(...t.der.depth) + 0.5, 0] : null;
  $("#rz").onclick = () => t.der && zoomPlot($("#plot"), null, full);
  issuesPanel($("#iss"), fs, (f) => t.der && zoomPlot($("#plot"), f, full));
  $("#ov").onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const pts = refs.parseOverlayCsv(await f.text());
    if (!pts.length) { alertBox("No depth/value pairs found in that CSV."); return; }
    S.overlays[tid] = pts; pageSite();
  };
  $("#ovx") && ($("#ovx").onclick = () => { delete S.overlays[tid]; pageSite(); });
}

function tabBh(T, r, F) {
  const ids = Object.entries(r.perTest).filter(([, t]) => t.kind === "Borehole" || t.kind === "Test pit").map(([k]) => Number(k));
  const tid = testPicker(T, "bh", ids, r); if (tid === null) return;
  const t = r.perTest[tid], fs = F.filter((f) => f.testId === tid), d = t.data;
  T.innerHTML = `<div class="toolbar">${pickerHtml("bh", ids, tid, r, F)} ${badge(worst(fs))}<span class="grow"></span>
    <span class="legend-flags"><span class="lf">Inconsistent</span><span class="lu">Not sure</span></span>
    <button id="dlj" title="Open this in the Boring Log Viewer (Open files…)">Download log JSON</button><button id="dls">Download SVG</button></div>
    <div class="grid2"><div><div id="logbox" class="logbox"><div class="empty">Drawing the log with the UCLA Geo Boring Log Viewer…</div></div><div class="small muted" id="logmsg"></div></div>
      <div><div id="iss"></div><div id="ref" style="margin-top:14px"></div></div></div>
    ${[["layers", "Layer descriptions (STRA)"], ["detl", "Depth notes (DETL)"], ["spt", "SPT results (ISPT)"]].filter(([k]) => d[k]?.length)
      .map(([k, l]) => `<details style="margin-top:10px"><summary>${l} (${d[k].length})</summary>${simpleTable(d[k])}</details>`).join("")}
    ${d.samples?.length ? `<details style="margin-top:10px"><summary>Samples and lab results (${d.samples.length})</summary>${simpleTable(d.samples.flatMap((s) =>
      (s.specs.length ? s.specs : [{}]).map((sp) => ({ sample: s.name, type: s.type, top: s.top, base: s.base, N: s.spt[0]?.n, ER: s.spt[0]?.er,
        specimen: sp.ref ?? "", spec_top: sp.top, FC_indx: sp.fcIndx, FC_grat: sp.fcGrat, LL: sp.ll, PL: sp.pl, wc: sp.wc }))))}</details>` : ""}`;
  $("#pick").onchange = (e) => { S.sel.bh = Number(e.target.value); pageSite(); };
  refPanel($("#ref"), tid, r.ctx);
  const cits = refs.linkedCitations(S.bundle, S.R);
  const { json, warnings } = blv.boringJson(r.ctx, tid, d, fs, cits);
  const name = (r.ctx.test(tid)?.name || "boring").replace(/[^\w.-]+/g, "_");
  $("#dlj").onclick = () => download(`${name}.json`, JSON.stringify(json, null, 2), "application/json");
  let svgText = null, depthMap = null;
  const box = $("#logbox");
  const show = (f) => {
    box.querySelectorAll(".flash").forEach((x) => x.remove());
    if (!depthMap) { const pl = $("#plotbh"); if (pl) zoomPlot(pl, f, [Math.max(1, d.depth || 10) + 0.5, 0]); return; }
    if (!f?.depths?.length) return;
    const dd = f.depths.filter(fin), lo = Math.min(...dd), hi = Math.max(...dd);
    const svgEl = box.querySelector("svg"); if (!svgEl) return;
    const scale = svgEl.getBoundingClientRect().width / (parseFloat(svgEl.getAttribute("width")) || svgEl.getBoundingClientRect().width);
    const y0 = depthMap(lo - 0.1) * scale, y1 = depthMap(hi + 0.1) * scale;
    const mark = document.createElement("div");
    mark.className = "flash " + f.status;
    Object.assign(mark.style, { top: y0 + "px", height: Math.max(6, y1 - y0) + "px" });
    box.appendChild(mark);
    box.scrollTo({ top: Math.max(0, y0 - 120), behavior: "smooth" });
  };
  issuesPanel($("#iss"), fs, show);
  blv.renderBoring(json, { width: 900 }).then(({ svg, warnings: w }) => {
    const sh = blv.shadeSvg(svg, fs);
    svgText = sh.svg; depthMap = sh.map;
    box.innerHTML = svgText;
    const el = box.querySelector("svg"); if (el) { el.style.width = "100%"; el.style.height = "auto"; }
    $("#logmsg").textContent = [w ? "Viewer warnings: " + w : "", warnings.join("; ")].filter(Boolean).join(" · ");
  }).catch((e) => {
    $("#logmsg").textContent = `Boring Log Viewer not reachable (${e.message}). Showing the built-in log instead.`;
    box.innerHTML = `<div class="plot" id="plotbh"></div>`;
    viz.borelogPlot($("#plotbh"), d, fs, r.ctx.gwtFor(tid).gwt);
  });
  $("#dls").onclick = () => svgText ? download(`${name}.svg`, svgText, "image/svg+xml") : alertBox("The log has not been drawn yet.");
}

function tabVs(T, r, F) {
  const ids = Object.entries(r.perTest).filter(([, t]) => t.kind === "Vs").map(([k]) => Number(k));
  const tid = testPicker(T, "vs", ids, r); if (tid === null) return;
  const t = r.perTest[tid], fs = F.filter((f) => f.testId === tid);
  T.innerHTML = `<div class="toolbar">${pickerHtml("vs", ids, tid, r, F)} ${badge(worst(fs))}
    <label class="row" style="margin:0;font-weight:400"><input type="checkbox" id="cv" style="width:auto" ${S.vsCpt !== false ? "checked" : ""}> overlay CPT-based Vs</label></div>
    <div class="grid2"><div><div class="row small" style="justify-content:flex-end"><button id="rz">Reset zoom</button></div><div class="plot" id="plot"></div></div>
      <div><div id="iss"></div><h3 style="margin-top:14px">Dispersion curve</h3><div class="plot" id="disp"></div></div></div>`;
  $("#pick").onchange = (e) => { S.sel.vs = Number(e.target.value); pageSite(); };
  $("#cv").onchange = (e) => { S.vsCpt = e.target.checked; pageSite(); };
  viz.vsPlot($("#plot"), t.data.profiles, fs, S.vsCpt !== false ? r.cptDers : null, r.ctx.gwtFor(tid).gwt);
  if (t.data.disp) viz.dispersionPlot($("#disp"), t.data.disp); else $("#disp").innerHTML = `<div class="empty">No dispersion data.</div>`;
  const zmax = Math.max(5, ...t.data.profiles.flatMap((p) => p.top)) + 5;
  $("#rz").onclick = () => zoomPlot($("#plot"), null, [zmax, 0]);
  issuesPanel($("#iss"), fs, (f) => zoomPlot($("#plot"), f, [zmax, 0]));
}

function tabRefs(T, r, F) {
  const files = refs.linkedFiles(S.bundle, S.R), cits = refs.linkedCitations(S.bundle, S.R);
  const tpl = ls.get("ngl_file_tpl", "{origin}/files/download/{FILE_ID}");
  T.innerHTML = `<div class="grid2"><div>
      <h3>Files attached in NGL</h3>
      ${files.length ? `<div class="tbl-wrap" style="max-height:300px"><table><thead><tr><th>File</th><th>Caption</th><th>Attached to</th><th></th></tr></thead><tbody>
        ${files.map((f, i) => `<tr><td>${esc(f.name)}<div class="small muted">${esc(f.type)}</div></td><td>${esc(f.caption)}</td><td class="small">${esc(f.attachedTo)}</td>
        <td><button data-i="${i}" class="fetch" ${isDemo() ? "disabled" : ""}>Fetch</button></td></tr>`).join("")}</tbody></table></div>
        <details style="margin-top:8px"><summary class="small">File download URL pattern</summary>
          <p class="small muted">The API returns file metadata only. If the NGL website has a download link for files, enter its pattern ({origin}, {FILE_ID}, {FILE_NAME}).</p>
          <input id="tpl" value="${esc(tpl)}"></details>` : `<p class="muted">No file metadata returned for this site.</p>`}
      <h3 style="margin-top:18px">Citations</h3>
      ${cits.length ? `<div class="tbl-wrap" style="max-height:300px"><table><thead><tr><th>Reference</th><th>Linked to</th><th></th></tr></thead><tbody>
        ${cits.map((c) => `<tr><td>${esc(c.authors ?? "")} ${c.year ? "(" + esc(c.year) + ")" : ""} <b>${esc(c.title ?? "")}</b>${c.doi ? `<div class="small muted">doi:${esc(c.doi)}</div>` : ""}</td>
          <td class="small">${esc(c.attachedTo.join(", "))}</td><td>${c.link ? `<a class="btn" target="_blank" rel="noopener" href="${esc(c.link)}">Open ↗</a>` : ""}</td></tr>`).join("")}</tbody></table></div>
        <p class="small muted">Download the paper or report from the link and drop it on the right. The tool then searches it for test names and SPT N sequences and shows the matching pages beside the plots.</p>`
        : `<p class="muted">No citations linked.</p>`}
    </div><div>
      <h3>Reference documents</h3>
      <div class="drop" id="drop">Drop PDF reports or figure images here, or <label style="display:inline;color:var(--accent);cursor:pointer">browse<input type="file" id="up" multiple accept=".pdf,.png,.jpg,.jpeg" hidden></label></div>
      <div id="ups" style="margin-top:10px"></div>
    </div></div>
    <h3 style="margin-top:18px">Checks against references</h3><div id="ft"></div>`;
  const listUps = () => {
    $("#ups").innerHTML = S.uploads.map((u, i) => {
      const hits = u.pdf ? Object.entries(refs.findMentions(u.pdf.texts, r.ctx.tests.map((t) => t.name))).filter(([, v]) => v.length) : [];
      return `<div class="row" style="border-bottom:1px solid var(--line);padding:6px 0"><div class="grow"><b>${esc(u.name)}</b>
        <div class="small muted">${u.pdf ? `${u.pdf.numPages} pages · ${hits.length ? hits.map(([k, v]) => `${esc(k)}: p.${v.slice(0, 4).join(",")}`).join(" · ") : "no test names found in text"}` : "image"}</div></div>
        <button data-i="${i}" class="rm">Remove</button></div>`;
    }).join("");
    T.querySelectorAll(".rm").forEach((b) => (b.onclick = () => { S.uploads.splice(Number(b.dataset.i), 1); pageSite(); }));
  };
  listUps();
  findingsTable($("#ft"), F.filter((f) => f.group === "Reference"), { filters: false });
  const add = async (fileList) => {
    for (const f of fileList) await addUpload(f.name, f.type, await f.arrayBuffer());
    pageSite();
  };
  $("#up").onchange = (e) => add(e.target.files);
  const dz = $("#drop");
  dz.ondragover = (e) => { e.preventDefault(); dz.classList.add("over"); };
  dz.ondragleave = () => dz.classList.remove("over");
  dz.ondrop = (e) => { e.preventDefault(); dz.classList.remove("over"); add(e.dataTransfer.files); };
  $("#tpl") && ($("#tpl").onchange = (e) => ls.set("ngl_file_tpl", e.target.value));
  T.querySelectorAll(".fetch").forEach((b) => (b.onclick = async () => {
    const f = files[Number(b.dataset.i)];
    const url = ls.get("ngl_file_tpl", tpl).replace("{origin}", API_BASE || NGL_ORIGIN).replace("{FILE_ID}", f.fileId).replace("{FILE_NAME}", encodeURIComponent(f.name));
    b.disabled = true; b.textContent = "…";
    const res = await client.tryDownload(url);
    if (res.data) { await addUpload(f.name, res.type, res.data); pageSite(); }
    else { alertBox(`Could not download ${f.name}: ${res.error}. Set the download URL pattern, or download it on the NGL website and drop it here.`); b.disabled = false; b.textContent = "Fetch"; }
  }));
}
async function addUpload(name, type, data) {
  const u = { name, type, data };
  if (/pdf/i.test(type) || /\.pdf$/i.test(name)) {
    try { u.pdf = await refs.loadPdf(data.slice(0)); } catch (e) { alertBox(`Could not read ${name}: ${e.message}`); return; }
  } else u.url = URL.createObjectURL(new Blob([data], { type: type || "image/png" }));
  S.uploads.push(u);
}

function tabReport(T, r, F) {
  const key = "ngl_notes_" + S.siteId, notes = ls.get(key, {});
  const fk = (f) => `${f.check}|${f.target}|${f.where}`;
  const flagged = F.filter((f) => f.status !== "PASS");
  const opts = ["", "Confirmed issue", "False alarm", "Needs contributor fix", "Checked – OK"];
  T.innerHTML = `<p class="muted">Confirm or override each automatic flag and add comments. Decisions are saved in this browser. Export the report and attach it to your review on the NGL website (the API is read-only).</p>
    <div class="toolbar"><button class="primary" id="csv">Download CSV</button><button id="md">Download Markdown</button><button id="pr">Print</button>
    <span class="muted small grow" style="text-align:right">${flagged.length} flags · ${flagged.filter((f) => notes[fk(f)]?.v).length} reviewed</span></div>
    <div class="tbl-wrap" style="max-height:none"><table><thead><tr><th>Status</th><th>Check</th><th>Target / where</th><th>Details</th><th style="min-width:170px">Reviewer decision</th><th style="min-width:220px">Comment</th></tr></thead><tbody>
    ${flagged.map((f, i) => `<tr><td>${badge(f.status)}</td><td><b>${esc(f.check)}</b><div class="small muted">${esc(f.group)}</div></td><td>${esc(f.target)}<div class="where">${esc(f.where)}</div></td>
      <td>${esc(f.message)}</td><td><select data-i="${i}" class="dv">${opts.map((o) => `<option ${notes[fk(f)]?.v === o ? "selected" : ""}>${o}</option>`).join("")}</select></td>
      <td><textarea data-i="${i}" class="dc" rows="2">${esc(notes[fk(f)]?.c ?? "")}</textarea></td></tr>`).join("") || `<tr><td colspan="6" class="empty">Nothing flagged.</td></tr>`}
    </tbody></table></div>`;
  const save = (i, k, v) => { const f = flagged[i]; notes[fk(f)] = { ...(notes[fk(f)] || {}), [k]: v }; ls.set(key, notes); };
  T.querySelectorAll(".dv").forEach((s) => (s.onchange = () => save(Number(s.dataset.i), "v", s.value)));
  T.querySelectorAll(".dc").forEach((s) => (s.oninput = () => save(Number(s.dataset.i), "c", s.value)));
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  const rows = () => F.map((f) => ({ Status: STATUS_LABEL[f.status], Group: f.group, Check: f.check, Target: f.target, Where: f.where, Details: f.message,
    Reviewer: notes[fk(f)]?.v ?? "", Comment: notes[fk(f)]?.c ?? "" }));
  $("#csv").onclick = () => {
    const R = rows(), h = Object.keys(R[0] || { Status: "" });
    const csv = [h.join(","), ...R.map((x) => h.map((k) => `"${String(x[k]).replace(/"/g, '""')}"`).join(","))].join("\n");
    download(`NGL_review_site${S.siteId}_${stamp}.csv`, csv, "text/csv");
  };
  $("#md").onclick = () => {
    const md = [`# NGL review – ${r.ctx.siteName} (SITE_ID ${S.siteId})`, `Generated ${new Date().toLocaleString()}. Overall: ${STATUS_LABEL[worst(F)]}`, ""];
    for (const s of ["FAIL", "UNSURE", "PASS"]) {
      const sub = F.filter((f) => f.status === s);
      md.push(`## ${STATUS_LABEL[s]} (${sub.length})`);
      sub.forEach((f) => { const n = notes[fk(f)] || {}; md.push(`- **${f.check}** – ${f.target}${f.where ? " @ " + f.where : ""}: ${f.message}${n.v || n.c ? ` — *Reviewer: ${n.v || ""}* ${n.c || ""}` : ""}`); });
      md.push("");
    }
    download(`NGL_review_site${S.siteId}_${stamp}.md`, md.join("\n"), "text/markdown");
  };
  $("#pr").onclick = () => window.print();
}

// ------------------------------------------------------------------ calibration
function pageCalibration() {
  view.innerHTML = `<div class="card"><h1>Calibration on reviewed sites</h1>
    <p class="muted">Runs every check on sites that have already passed review. A check that flags many reviewed sites is probably too strict (false alarms) – adjust its threshold in <code>js/config.js</code>.</p>
    <div class="toolbar"><span>Sites to sample</span><input id="n" type="number" value="10" min="1" max="200" style="width:90px"><button class="primary" id="go">Run</button><span id="st" class="muted small"></span></div>
    <div class="progress"><div id="pb"></div></div></div><div class="card" id="out" style="display:none"></div>`;
  $("#go").onclick = async () => {
    $("#go").disabled = true;
    try {
      const rev = await client.query("SITE", { includeUnreviewed: false, select: ["SITE_ID"] });
      const ids = rev.map((r) => r.SITE_ID).sort(() => Math.random() - 0.5).slice(0, Number($("#n").value));
      const agg = {}, all = [];
      for (const [i, id] of ids.entries()) {
        $("#st").textContent = `Site ${id} (${i + 1}/${ids.length})`; $("#pb").style.width = ((i + 1) / ids.length * 100) + "%";
        try {
          const B = await client.buildBundle(id, { includeUnreviewed: false });
          for (const f of runAll(B, S.R).findings) {
            const k = f.group + " · " + f.check;
            (agg[k] ||= { FAIL: 0, UNSURE: 0, PASS: 0 })[f.status]++;
            all.push({ SITE_ID: id, ...f, depths: undefined, points: undefined });
          }
        } catch (e) { all.push({ SITE_ID: id, status: "ERROR", message: e.message }); }
      }
      const rows = Object.entries(agg).map(([k, v]) => ({ k, ...v, rate: (v.FAIL + v.UNSURE) / (v.FAIL + v.UNSURE + v.PASS) })).sort((a, b) => b.rate - a.rate);
      $("#out").style.display = "block";
      $("#out").innerHTML = `<div class="toolbar"><h2 class="grow" style="margin:0">Flag rate per check</h2><button id="dl">Download all findings (CSV)</button></div>
        <div class="tbl-wrap"><table><thead><tr><th>Check</th><th class="num">Inconsistent</th><th class="num">Not sure</th><th class="num">Consistent</th><th class="num">Flag rate</th></tr></thead><tbody>
        ${rows.map((r) => `<tr><td>${esc(r.k)}</td><td class="num">${r.FAIL}</td><td class="num">${r.UNSURE}</td><td class="num">${r.PASS}</td><td class="num"><b>${(r.rate * 100).toFixed(0)}%</b></td></tr>`).join("")}</tbody></table></div>`;
      $("#dl").onclick = () => {
        const h = ["SITE_ID", "status", "group", "check", "target", "where", "message"];
        download("calibration.csv", [h.join(","), ...all.map((x) => h.map((k) => `"${String(x[k] ?? "").replace(/"/g, '""')}"`).join(","))].join("\n"), "text/csv");
      };
    } catch (e) { alertBox(e.message); }
    $("#go").disabled = false; $("#st").textContent = "Done.";
  };
}

// ------------------------------------------------------------------ schema
function pageSchema() {
  if (!S.bundle) { view.innerHTML = `<div class="card empty">Open a site first – the mapping is checked against its data.</div>`; return; }
  const rep = S.R.mappingReport(S.bundle);
  const ov = loadOverrides();
  view.innerHTML = `<div class="card"><div class="row"><div class="grow"><h1>Schema mapping</h1>
    <p class="muted">How the tool maps each logical field to an NGL column for the loaded site. Fields marked “—” could not be matched; choose the right column and save. The mapping is stored in this browser – use <b>Export</b> to share it, or send it to the tool maintainer to make it the default.</p></div>
    <div class="row"><button id="exp">Export mapping</button><label class="btn">Import<input type="file" id="imp" hidden accept=".json"></label><button class="primary" id="save">Save</button></div></div></div>
    ${Object.entries(rep).map(([table, m]) => {
      const cols = columns(S.bundle[table]), un = Object.values(m).filter((v) => !v).length;
      return `<div class="card"><details ${un ? "open" : ""}><summary><b>${table}</b> · ${S.bundle[table].length} rows ${un ? `· <span style="color:var(--unsure)">${un} unresolved</span>` : "· all resolved"}</summary>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:4px 16px;margin-top:10px">
        ${Object.entries(m).map(([k, c]) => `<div><label class="small">${k}</label><select data-t="${table}" data-k="${k}" class="map">${["", ...cols].map((x) => `<option value="${esc(x)}" ${x === (c || "") ? "selected" : ""}>${x || "—"}</option>`).join("")}</select></div>`).join("")}
        </div><details style="margin-top:10px"><summary class="small muted">Raw data preview</summary>${simpleTable(S.bundle[table].slice(0, 100))}</details></details></div>`;
    }).join("")}`;
  view.querySelectorAll("select.map").forEach((s) => (s.onchange = () => { (ov[s.dataset.t] ||= {})[s.dataset.k] = s.value || null; }));
  $("#save").onclick = () => { saveOverrides(ov); S.R = new Resolver(ov); S.res = null; alertBox("Mapping saved – checks will be re-run.", "ok"); };
  $("#exp").onclick = () => download("field_map.json", JSON.stringify(ov, null, 2), "application/json");
  $("#imp").onchange = async (e) => { const t = await e.target.files[0].text(); saveOverrides(JSON.parse(t)); S.R = new Resolver(); S.res = null; pageSchema(); };
}

// ------------------------------------------------------------------ about
function pageAbout() {
  const sec = (title, tables, items) => `<h3>${title} <span class="small muted">${tables}</span></h3><ul>${items.map((x) => `<li>${x}</li>`).join("")}</ul>`;
  view.innerHTML = `<div class="card" style="max-width:1000px"><h1>What the tool checks</h1>
  <p>Every check returns ${badge("FAIL")} (data contradict themselves, physics or the reference), ${badge("UNSURE")} (suspicious but possibly valid, or the check could not run) or ${badge("PASS")}, and says <b>where</b> (test, sample, depth, coordinates). A test's status is its worst finding. In each test tab the <b>Issues</b> list is in order of severity; <b>Show</b> / <b>Next issue</b> zoom the plot or boring log to the problem depth.</p>
  ${sec("Site", "SITE, TEST, WATR, SITP/TESP/FLDP", ["Site coordinates present and valid; every test within 500 m (2 km = inconsistent); swapped lat/lon hint",
    "<b>Test names</b>: duplicates at the site; names that look like another test type (e.g. a “CPT-…” stored as BORH)", "Possible duplicate tests at the same location; tests with no data rows",
    "<b>Groundwater</b>: spread of all WATR depths at the site (≤ 1 m / 1–3 m / > 3 m), negative depths, GWT below the bottom of a boring",
    "Submission/review status: site submitted but tests not (TEST_STAT), site reviewed but tests not; no citation linked"])}
  ${sec("CPT", "SCPG, SCPT (qc, fs, u stored in MPa)", ["SCPG header present; cone size 10/15 cm²; pore-pressure position (SCPG_PWP) u2 or not",
    "Depth strictly increasing, duplicates, gaps, late start (predrill)", "<b>Units</b>: median qc and Rf, and &gt;200× jumps between readings (a block entered in another unit)",
    "Ranges: qc ≤ 0 or &gt; 120 MPa, fs &lt; 0, Rf &gt; 15 %, isolated spikes, strongly negative u", "<b>GWT from u2</b> in clean-sand layers vs WATR; u ≈ 0 below the GWT",
    "Soil behaviour type (Ic) vs boring logs within 50 m (only “not sure”)"])}
  ${sec("Borings, strata and SPT", "BORH, STRA, DETL, SAMP_TEST, SAMP, ISPT", ["Layer geometry: base &gt; top, missing bases, first layer at the surface, overlaps (inconsistent), gaps (not sure)",
    "<b>USCS</b>: valid symbol, missing symbol, symbol vs description (coarse vs fine); empty descriptions; DETL notes outside the log",
    "<b>Samples</b>: valid top/base, overlaps, duplicate or missing <b>names</b>, samples below the logged depth",
    "<b>SPT</b>: ISPT depth inside its sample, sampler type split-barrel, duplicated depths, N range / missing N, partial penetration (ISPT_TPEN), energy ratio present and 40–100 %",
    "<b>N vs description</b>: density/consistency term of the layer or nearby DETL note vs the N class"])}
  ${sec("Lab (plasticity, gradation, index)", "SPEC, GRAG, GRAT, PLAS, INDX", ["Specimen depth inside its sample", "<b>Gradation</b>: % passing 0–100, curve monotonic, reaches the No. 200 sieve",
    "<b>Fines</b>: INDX_FINE vs fines read from the gradation curve; fines vs USCS symbol (SP/SW &lt; 5 %, dual 5–12 %, SM/SC 12–50 %, fines ≥ 50 %)",
    "<b>Plasticity</b>: LL 10–300, PL ≤ LL, both reported, one record per specimen, A-line and LL = 50 vs CL/CH/ML/MH, limits reported for clean sand",
    "Index: water content 0–300 % and vs LL, Gs 2.4–3.0, density 1.2–2.4 g/cm³"])}
  ${sec("Vs", "GSWG, SWVG, SWVD, GSWD, GINV, GIND", ["Layer geometry: starts at the surface, SWVD_BTTM = next top, bottom &gt; top; duplicate depths",
    "Vs 30–3500 m/s (ft/s?), Vp &gt; Vs, Vp ≥ 1300 m/s below the GWT, velocity reversals &gt; 40 %", "Dispersion curve vs profile (approximate λ/2.5 rule)",
    "Measured Vs vs CPT-based Vs (Robertson 2009) within 100 m"])}
  ${sec("Field observations", "FLDO, FLDM, FLDD, GMIM, EVNT", ["Description present; manifestation and vector points near the site; event linked, magnitude, plausible epicentral distance",
    "PGA present, unit (GMIM_UNIT) and 0.005–2.5 g", "Manifestation flags consistent (no surface evidence but sand boil / lateral spread flagged)",
    "Vectors: azimuth 0–360°, HDIS ≥ 0, very large values, direction vs neighbours, displacements without a lateral-spread flag",
    "Observed manifestation vs CPT-based LPI (Boulanger &amp; Idriss 2014) – model check, never “inconsistent”"])}
  ${sec("References", "uploaded PDFs, digitised curves", ["Test names found in the PDF text, matching page shown beside the plot", "SPT N sequence found in order on the log page",
    "Digitised CPT curves: median difference and constant depth shift"])}
  <p class="muted small">Thresholds are in <code>js/config.js</code> (THRESH). Boring logs are drawn by the UCLA Geo Boring Log Viewer API, with the review flags in a “Review flags” column and flagged depths shaded.</p></div>`;
}

// ------------------------------------------------------------------ helpers
function simpleTable(rows) {
  if (!rows?.length) return `<p class="muted small">No rows.</p>`;
  const cols = columns(rows);
  const v = (x) => (typeof x === "number" ? (Number.isInteger(x) ? x : x.toFixed(3)) : esc(x ?? ""));
  return `<div class="tbl-wrap" style="max-height:320px;margin-top:6px"><table><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td>${v(r[c])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function alertBox(msg, kind = "err") {
  const d = document.createElement("div");
  d.textContent = msg;
  Object.assign(d.style, { position: "fixed", right: "20px", bottom: "20px", maxWidth: "420px", zIndex: 5000, padding: "12px 14px", borderRadius: "8px",
    background: kind === "ok" ? "#e8f6ed" : "#fdecec", color: kind === "ok" ? "#14532d" : "#991b1b", boxShadow: "0 4px 16px rgba(0,0,0,.12)" });
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 6000);
}

route();
