// Read-only NGL REST API client (token kept in sessionStorage for its 2-hour lifetime).
import { API_BASE, ENDPOINTS, BUNDLE_ORDER, ROLES } from "./config.js";

const TOKEN_KEY = "ngl_token";
const LIFETIME_MS = 2 * 3600 * 1000;

export class NGLError extends Error {}

export const session = {
  get() {
    try {
      const s = JSON.parse(sessionStorage.getItem(TOKEN_KEY) || "null");
      if (s && Date.now() - s.t < LIFETIME_MS) return s;
    } catch { /* ignore */ }
    return null;
  },
  set(token, user, role = "user") { try { sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ token, user, role, t: Date.now() })); } catch { /* */ } },
  setRole(role) { const s = this.get(); if (s) { s.role = role; try { sessionStorage.setItem(TOKEN_KEY, JSON.stringify(s)); } catch { /* */ } } },
  role() { const r = this.get()?.role; return ROLES[r] ? r : "user"; },
  roleParam() { return ROLES[this.role()].param; },
  isElevated() { return this.roleParam() !== null; },
  clear() { try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* */ } },
  minutesLeft() { const s = this.get(); return s ? Math.max(0, Math.round((LIFETIME_MS - (Date.now() - s.t)) / 60000)) : 0; },
};

// role: key of ROLES (user / reviewer / admin). Elevated roles are verified right after
// sign-in so a missing privilege shows a clear message instead of an empty queue.
export async function login(user, password, role = "reviewer") {
  const r = await fetch(API_BASE + "/users/api-token", {
    headers: { Accept: "application/json", Authorization: "Basic " + btoa(unescape(encodeURIComponent(user + ":" + password))) },
  });
  let js = {};
  try { js = await r.json(); } catch { /* not json */ }
  if (!js.token) throw new NGLError(js.errorMessage || `Login failed (HTTP ${r.status}).`);
  session.set(js.token, user, role);
  if (ROLES[role]?.param) {
    try { await verifyRole(); }
    catch (e) { session.clear(); throw e; }
  }
  return js.token;
}

export async function verifyRole() {
  const r = session.role(), p = ROLES[r].param;
  try { await new NGLClient().query("SITE", { limit: 1, maxPages: 1 }); }
  catch (e) {
    throw new NGLError(`NGL did not accept ${ROLES[r].label} privileges for this account (role=${p}). ` +
      `Pick a lower level, or check which role your NGL account has. (${e.message})`);
  }
}

export class NGLClient {
  constructor() { this._cols = {}; }

  headers() {
    const s = session.get();
    if (!s) throw new NGLError("Session expired – please log in again.");
    return { Accept: "application/json", "Content-Type": "application/json", Authorization: "Bearer " + s.token };
  }

  // all rows matching `where` (follows pagination); POST with JSON body
  // elevated: undefined -> follow the signed-in role; false -> force a plain user request
  async query(table, { where, select, includeUnreviewed = true, limit = 5000, maxPages = 200, sort, elevated, roleOverride } = {}) {
    const roleParam = roleOverride ? ROLES[roleOverride].param : elevated === false ? null : session.roleParam();
    const path = ENDPOINTS[table] || table;
    const rows = [];
    for (let page = 1; page <= maxPages; page++) {
      const body = { limit, page };
      if (where) body.where = where;
      if (select) body.select = Array.isArray(select) ? select.join(",") : select;
      if (includeUnreviewed) body.includeUnreviewed = 1;
      if (sort) body.sort = sort;
      if (roleParam) body.role = roleParam;
      const r = await fetch(API_BASE + path, { method: "POST", headers: this.headers(), body: JSON.stringify(body) });
      let js;
      try { js = await r.json(); } catch { throw new NGLError(`${table}: HTTP ${r.status} (not JSON)`); }
      if (!r.ok || !Array.isArray(js)) {
        const msg = (js && js.errorMessage) || JSON.stringify(js).slice(0, 200);
        throw new NGLError(`${table}: HTTP ${r.status}: ${String(msg).replace(/<br>/g, "; ")}`);
      }
      rows.push(...js);
      if (js.length < limit) break;
    }
    return rows;
  }

  async queryIn(table, key, ids, opts = {}, chunk = 200) {
    const list = [...new Set(ids)].filter((x) => x !== null && x !== undefined);
    const out = [];
    for (let i = 0; i < list.length; i += chunk) {
      out.push(...(await this.query(table, { ...opts, where: `${key} IN (${list.slice(i, i + chunk).join(",")})` })));
    }
    return out;
  }

  async columns(table) {
    if (!(table in this._cols)) {
      try {
        const r = await this.query(table, { limit: 1, maxPages: 1 });
        this._cols[table] = r.length ? Object.keys(r[0]) : [];
      } catch { this._cols[table] = []; }
    }
    return this._cols[table];
  }

  // Review state of every visible site:
  //   reviewed  – returned without includeUnreviewed
  //   submitted – returned only with includeUnreviewed=1 (awaiting review)
  //   draft     – returned only with an elevated role (never submitted)
  async siteLists() {
    const all = await this.query("SITE", { includeUnreviewed: true });
    const ids = async (opts) => new Set((await this.query("SITE", { ...opts, select: ["SITE_ID"] })).map((r) => Number(r.SITE_ID)));
    const reviewed = await ids({ includeUnreviewed: false, elevated: false });
    // Only an admin can also see drafts; to tell drafts from submitted sites, ask again with
    // the lower privilege levels (errors ignored) and treat what they return as submitted.
    let submitted = null;
    if (session.role() === "admin") {
      submitted = new Set();
      for (const opts of [{ elevated: false }, { roleOverride: "reviewer" }]) {
        try { (await ids({ includeUnreviewed: true, ...opts })).forEach((x) => submitted.add(x)); } catch { /* not allowed */ }
      }
    }
    return all.map((r) => {
      const id = Number(r.SITE_ID);
      const state = reviewed.has(id) ? "reviewed" : !submitted || submitted.has(id) ? "submitted" : "draft";
      return { ...r, _state: state, _reviewed: state === "reviewed" };
    });
  }

  async buildBundle(siteId, { includeUnreviewed = true, progress } = {}) {
    const opts = { includeUnreviewed };
    const B = { _log: [] };
    B.SITE = await this.query("SITE", { ...opts, where: `SITE_ID=${Number(siteId)}` });
    const ids = { SITE_ID: new Set([Number(siteId)]) };
    const collect = (rows) => rows.forEach((r) => Object.entries(r).forEach(([k, v]) => {
      if (k.toUpperCase().endsWith("_ID") && v !== null && v !== "" && Number.isFinite(Number(v))) {
        (ids[k.toUpperCase()] ||= new Set()).add(Number(v));
      }
    }));
    let i = 0;
    for (const [table, keys] of BUNDLE_ORDER) {
      progress?.(++i / (BUNDLE_ORDER.length + 3), `Loading ${table}…`);
      const cols = await this.columns(table);
      const key = keys.find((k) => cols.includes(k) && ids[k]?.size);
      if (!key) { B[table] = []; B._log.push(`${table}: skipped (no usable link key)`); continue; }
      try {
        B[table] = await this.queryIn(table, key, [...ids[key]], opts);
        B._log.push(`${table}: ${B[table].length} rows via ${key}`);
        collect(B[table]);
      } catch (e) { B[table] = []; B._log.push(`${table}: error ${e.message}`); }
    }
    for (const [table, key] of [["FILE", "FILE_ID"], ["CITATION", "CITATION_ID"], ["EVNT", "EVNT_ID"]]) {
      progress?.(0.97, `Loading ${table}…`);
      try { B[table] = ids[key]?.size ? await this.queryIn(table, key, [...ids[key]], opts) : []; }
      catch (e) { B[table] = []; B._log.push(`${table}: error ${e.message}`); }
    }
    return B;
  }

  async tryDownload(url) {
    try {
      const r = await fetch(url, { headers: { Authorization: this.headers().Authorization } });
      const ct = r.headers.get("Content-Type") || "";
      if (!r.ok) return { error: `HTTP ${r.status}` };
      if (ct.includes("text/html")) return { error: "Got an HTML page (probably a login page), not the file." };
      return { data: await r.arrayBuffer(), type: ct };
    } catch (e) { return { error: e.message }; }
  }
}
