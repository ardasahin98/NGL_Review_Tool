// Resolve logical field names (e.g. CPT "qc") to the actual NGL column names.
import { FIELDS } from "./config.js";
import { columns, num } from "./util.js";

const KEY = "ngl_field_map";

export function loadOverrides() {
  try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { return {}; }
}
export function saveOverrides(o) {
  try { localStorage.setItem(KEY, JSON.stringify(o)); } catch { /* storage unavailable */ }
}

export class Resolver {
  constructor(overrides) { this.overrides = overrides ?? loadOverrides(); this._cache = new Map(); }

  col(table, rows, key) {
    if (!rows || !rows.length) return null;
    const cols = columns(rows);
    const ck = table + "|" + key + "|" + cols.join(",");
    if (this._cache.has(ck)) return this._cache.get(ck);
    let res = null;
    const ov = this.overrides?.[table]?.[key];
    if (ov) res = cols.includes(ov) ? ov : null;
    else {
      const spec = FIELDS[table]?.[key];
      if (spec) {
        const [cands, rx] = spec;
        res = cands.find((c) => cols.includes(c)) ?? null;
        if (!res && rx) {
          const re = new RegExp(rx, "i");
          const hits = cols.filter((c) => re.test(c) && !c.toUpperCase().endsWith("_ID"));
          res = hits.find((c) => c.toUpperCase().startsWith(table + "_")) ?? hits[0] ?? null;
        }
      }
    }
    this._cache.set(ck, res);
    return res;
  }

  // values of a logical field for every row (numeric if asked); null if unresolved
  get(table, rows, key, numeric = false) {
    const c = this.col(table, rows, key);
    if (!c) return null;
    return rows.map((r) => (numeric ? num(r[c]) : r[c]));
  }

  // first value
  first(table, rows, key, numeric = false) {
    const v = this.get(table, rows, key, numeric);
    if (!v) return numeric ? NaN : null;
    const f = v.find((x) => (numeric ? Number.isFinite(x) : x !== null && x !== undefined && x !== ""));
    return f === undefined ? (numeric ? NaN : null) : f;
  }

  mappingReport(bundle) {
    const rep = {};
    for (const [table, keys] of Object.entries(FIELDS)) {
      const rows = bundle[table];
      if (!rows || !rows.length) continue;
      rep[table] = Object.fromEntries(Object.keys(keys).map((k) => [k, this.col(table, rows, k)]));
    }
    return rep;
  }
}
