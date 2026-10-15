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
  constructor() { this._cols = {}; this.pageInfo = {}; }

  headers() {
    const s = session.get();
    if (!s) throw new NGLError("Session expired – please log in again.");
    return { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", Authorization: "Bearer " + s.token };
  }

  async _post(path, params) {
    const r = await fetch(API_BASE + path, { method: "POST", headers: this.headers(), body: new URLSearchParams(params).toString() });
    let js;
    try { js = await r.json(); } catch { throw new NGLError(`${path}: HTTP ${r.status} (not JSON)`); }
    if (!r.ok || !Array.isArray(js)) {
      const msg = (js && js.errorMessage) || JSON.stringify(js).slice(0, 200);
      throw new NGLError(`${path}: HTTP ${r.status}: ${String(msg).replace(/<br>/g, "; ")}`);
    }
    return js;
  }

  // All rows matching `where`. Paging is defensive: if NGL returns fewer rows than asked
  // for on the first page (a server-side page-size cap), keep paging with that page size
  // until a short or empty page, de-duplicating on the primary key.
  //   includeUnreviewed: undefined -> follow the signed-in role
  //   elevated: false -> never send role=admin
  async query(table, { where, select, includeUnreviewed, limit = 1000, maxPages = 500, sort, elevated } = {}) {
    const path = ENDPOINTS[table] || table;
    const role = session.role();
    const roleParam = elevated === false ? null : ROLES[role].param;
    const unrev = includeUnreviewed === undefined ? ROLES[role].unreviewed : includeUnreviewed;
    const base = {};
    if (where) base.where = where;
    if (select) base.select = Array.isArray(select) ? select.join(",") : select;
    base.includeUnreviewed = unrev ? 1 : 0;
    if (sort) base.sort = sort;
    if (roleParam) base.role = roleParam;
    const pk = (table in ENDPOINTS ? table : "") + "_ID";
    const rows = [], seen = new Set();
    const addRows = (batch) => { let fresh = 0; for (const r of batch) { const k = r[pk] ?? JSON.stringify(r); if (!seen.has(k)) { seen.add(k); rows.push(r); fresh++; } } return fresh; };
    let calls = 1;
    const first = await this._post(path, { ...base, limit, page: 1, ...(sort ? {} : { sort: pk, direction: "asc" }) });
    addRows(first);
    // Keyset paging: ask for rows with a primary key above the last one received, until an
    // empty batch comes back. This works even if NGL caps the page size (e.g. at 20 rows) or
    // ignores `page`, which plain page-number paging does not.
    if (maxPages > 1 && first.length && pk in first[0] && !sort) {
      let last = Math.max(...rows.map((r) => Number(r[pk])).filter(Number.isFinite));
      for (let k = 1; k < maxPages && Number.isFinite(last); k++) {
        const w = where ? `(${where}) AND ${pk}>${last}` : `${pk}>${last}`;
        const batch = await this._post(path, { ...base, where: w, limit, page: 1, sort: pk, direction: "asc" });
        calls++;
        if (!batch.length || !addRows(batch)) break;
        last = Math.max(last, ...batch.map((r) => Number(r[pk])).filter(Number.isFinite));
      }
    } else if (maxPages > 1 && first.length >= limit) {
      for (let page = 2; page <= maxPages; page++) {
        const batch = await this._post(path, { ...base, limit, page });
        calls++;
        if (!addRows(batch) || batch.length < limit) break;
      }
    }
    this.pageInfo[table] = { firstPage: first.length, calls, rows: rows.length };
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

  // Review state of every visible site, from SITE_STAT (1 = submitted) and SITE_REVW
  // (number of reviews done: 2 = reviewed); falls back to comparing what the API returns with/without unreviewed data.
  async siteLists() {
    const all = await this.query("SITE");
    if (all.length && "SITE_STAT" in all[0] && "SITE_REVW" in all[0]) {
      return all.map((r) => {
        // SITE_REVW counts completed reviews; a site needs two reviewers
        const rv = Number(r.SITE_REVW), st = Number(r.SITE_STAT);
        const state = rv >= 2 ? "reviewed" : st !== 1 ? "draft" : rv === 1 ? "second" : "submitted";
        return { ...r, _state: state, _reviewed: state === "reviewed" };
      });
    }
    const reviewed = new Set((await this.query("SITE", { includeUnreviewed: false, elevated: false, select: ["SITE_ID"] })).map((r) => Number(r.SITE_ID)));
    return all.map((r) => {
      const state = reviewed.has(Number(r.SITE_ID)) ? "reviewed" : "submitted";
      return { ...r, _state: state, _reviewed: state === "reviewed" };
    });
  }

  async buildBundle(siteId, { includeUnreviewed, progress } = {}) {
    const opts = includeUnreviewed === undefined ? {} : { includeUnreviewed };
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
