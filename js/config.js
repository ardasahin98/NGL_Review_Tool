// Central configuration: API location, endpoints, field-name candidates, thresholds.

// Where API calls go. On Vercel / local dev the serverless proxy at /api/ngl forwards to NGL
// (avoids CORS). When the app is hosted on the NGL website itself, call the API directly.
export const NGL_ORIGIN = "https://nextgenerationliquefaction.org";
export const API_BASE = location.hostname.endsWith("nextgenerationliquefaction.org") ? "" : "/api/ngl";

export const ENDPOINTS = {
  SITE: "/sites/api-index", TEST: "/field-tests/api-index", FLDO: "/field-observations/api-index",
  SAMP: "/samples/api-index", SPEC: "/specimens/api-index", PLAS: "/plasticity-tests/api-index",
  INDX: "/index-tests/api-index", RDEN: "/density-measurements/api-index", OTHR: "/other-tests/api-index",
  GRAG: "/grag/api-index", GRAT: "/grat/api-index", ISPT: "/penetration-test-results/api-index",
  BORH: "/boreholes/api-index", DETL: "/depth-layer-descriptions/api-index",
  STRA: "/stratigraphic-layer-descriptions/api-index", TEPT: "/test-pits/api-index",
  WATR: "/ground-water-tests/api-index", OTHF: "/other-field-tests/api-index",
  SCPG: "/general-cone-penetration-tests/api-index", SCPT: "/cone-penetration-data/api-index",
  GINV: "/general-invasives/api-index", GIND: "/invasive-details/api-index",
  GSWG: "/general-surface-wave-investigations/api-index", SWVG: "/surface-wave-tests/api-index",
  SWVD: "/surface-wave-details/api-index", GSWD: "/surface-wave-dispersion-curves/api-index",
  FLDD: "/displacement-vectors/api-index", FLDM: "/liquefaction-manifestations/api-index",
  GMIM: "/ground-motion-intensity-measurements/api-index", FILE: "/files/api-index",
  EVNT: "/events/api-index", CITATION: "/citations/api-index",
  SITF: "/site-files/api-index", TESF: "/field-test-files/api-index", FLDF: "/field-observation-files/api-index",
  SAMF: "/sample-files/api-index", SITP: "/site-citations/api-index", TESP: "/test-citations/api-index",
  FLDP: "/observation-citations/api-index", SAMP_TEST: "/test-samples/api-index",
};

// Tables loaded for one site, in dependency order (NGL schema, sjbrande_ngl_db). Each is
// fetched by the first listed key that the table has and for which IDs are already known.
//   SITE -> TEST -> SCPG -> SCPT                 (CPT)
//   TEST -> STRA / DETL / WATR / TEPT            (logs, groundwater)
//   TEST -> SAMP_TEST -> SAMP -> ISPT            (SPT is attached to the sample)
//   SAMP -> SPEC -> GRAG -> GRAT / PLAS / INDX   (lab)
//   TEST -> GSWG -> SWVG -> SWVD ; GSWG -> GSWD  (surface waves)
//   TEST -> GINV -> GIND                         (invasive Vs)
//   SITE -> FLDO -> FLDM / FLDD / GMIM           (field performance)
export const BUNDLE_ORDER = [
  ["TEST", ["SITE_ID"]], ["FLDO", ["SITE_ID"]],
  ["SCPG", ["TEST_ID"]], ["SCPT", ["SCPG_ID"]],
  ["BORH", ["TEST_ID"]], ["STRA", ["TEST_ID"]], ["DETL", ["TEST_ID"]], ["WATR", ["TEST_ID"]],
  ["TEPT", ["TEST_ID"]], ["OTHF", ["TEST_ID"]],
  ["SAMP_TEST", ["TEST_ID"]], ["SAMP", ["SAMP_ID"]], ["ISPT", ["SAMP_ID"]],
  ["SPEC", ["SAMP_ID"]], ["GRAG", ["SPEC_ID"]], ["GRAT", ["GRAG_ID"]], ["PLAS", ["SPEC_ID"]], ["INDX", ["SPEC_ID"]],
  ["GSWG", ["TEST_ID"]], ["SWVG", ["GSWG_ID"]], ["SWVD", ["SWVG_ID"]], ["GSWD", ["GSWG_ID"]],
  ["GINV", ["TEST_ID"]], ["GIND", ["GINV_ID"]],
  ["FLDM", ["FLDO_ID"]], ["FLDD", ["FLDO_ID"]], ["GMIM", ["FLDO_ID"]],
  ["SITF", ["SITE_ID"]], ["TESF", ["TEST_ID"]], ["FLDF", ["FLDO_ID"]], ["SAMF", ["SAMP_ID"]],
  ["SITP", ["SITE_ID"]], ["TESP", ["TEST_ID"]], ["FLDP", ["FLDO_ID"]],
];

// logical field -> [candidate column names, regex fallback | null]
// First candidates are the actual NGL column names (schema page, sjbrande_ngl_db). The others
// are fallbacks in case the API renames columns; anything unresolved can be fixed on the
// Schema page.
export const FIELDS = {
  SITE: { name: [["SITE_NAME"], null], lat: [["SITE_LAT"], null], lon: [["SITE_LON"], null],
          geol: [["SITE_GEOL"], null], stat: [["SITE_STAT"], null], revw: [["SITE_REVW"], null] },
  TEST: { type: [["TEST_TYPE"], null], name: [["TEST_NAME"], null], lat: [["TEST_LAT"], null], lon: [["TEST_LON"], null],
          stat: [["TEST_STAT"], null], revw: [["TEST_REVW"], null] },
  SCPG: { area: [["SCPG_CSA"], null], pwp: [["SCPG_PWP"], null], car: [["SCPG_CAR", "SCPG_AREA_RATIO"], null] },
  SCPT: { depth: [["SCPT_DPTH"], "DPTH|DEPTH"], qc: [["SCPT_RES"], "_RES$|QC"], fs: [["SCPT_FRES"], "FRES|_FS$"],
          u2: [["SCPT_PWP", "SCPT_PWP2"], "PWP"] },
  STRA: { top: [["STRA_TOP"], null], base: [["STRA_BASE"], null], uscs: [["STRA_USCS"], null], desc: [["STRA_DESC"], null] },
  DETL: { depth: [["DETL_DPTH"], null], desc: [["DETL_DESC"], null] },
  WATR: { depth: [["WATR_DPTH"], null], date: [["WATR_DATE"], null] },
  TEPT: { base: [["TEPT_BASE"], null] },
  SAMP: { top: [["SAMP_TOP"], null], base: [["SAMP_BASE"], null], name: [["SAMP_NAME"], null], type: [["SAMP_TYPE"], null],
          desc: [["SAMP_DESC"], null] },
  ISPT: { top: [["ISPT_TOP"], null], n: [["ISPT_NVAL"], null], er: [["ISPT_ERAT"], null], tpen: [["ISPT_TPEN"], null],
          rodl: [["ISPT_RODL"], null], rem: [["ISPT_REM"], null] },
  SPEC: { top: [["SPEC_TOP"], null], base: [["SPEC_BASE"], null] },
  GRAT: { size: [["GRAT_SIZE"], null], perp: [["GRAT_PERP"], null] },
  PLAS: { ll: [["PLAS_LL"], null], pl: [["PLAS_PL"], null] },
  INDX: { fines: [["INDX_FINE"], null], wc: [["INDX_WC"], null], gs: [["INDX_GS"], null], bden: [["INDX_BDEN"], null] },
  GSWG: { type: [["GSWG_TYPE"], null] },
  SWVG: { name: [["SWVG_NAME"], null] },
  SWVD: { top: [["SWVD_TOP"], null], base: [["SWVD_BTTM"], null], vs: [["SWVD_VS"], null], vp: [["SWVD_VP"], null], rho: [["SWVD_RHO"], null] },
  GSWD: { freq: [["GSWD_FREQ"], null], vel: [["GSWD_PHVL"], null] },
  GINV: { type: [["GINV_TYPE"], null] },
  GIND: { depth: [["GIND_DPTH"], null], vs: [["GIND_VS"], null], vp: [["GIND_VP"], null] },
  FLDO: { desc: [["FLDO_DESC"], null], stat: [["FLDO_STAT"], null], revw: [["FLDO_REVW"], null] },
  FLDM: { lat: [["FLDM_LAT"], null], lon: [["FLDM_LON"], null], sfev: [["FLDM_SFEV"], null], snbl: [["FLDM_SNBL"], null],
          ltsp: [["FLDM_LTSP"], null], sttl: [["FLDM_STTL"], null], desc: [["FLDM_DESC"], null] },
  FLDD: { lat: [["FLDD_LAT"], null], lon: [["FLDD_LON"], null], azim: [["FLDD_AZIM"], null], hdis: [["FLDD_HDIS"], null],
          vdis: [["FLDD_VDIS"], null], meth: [["FLDD_METH"], null] },
  GMIM: { type: [["GMIM_TYPE"], null], value: [["GMIM_VALUE"], null], unit: [["GMIM_UNIT"], null] },
  EVNT: { name: [["EVNT_NM"], null], year: [["EVNT_YR"], null], md: [["EVNT_MD"], null], mag: [["EVNT_MAG"], null],
          lat: [["HYPO_LAT"], null], lon: [["HYPO_LON"], null] },
  FILE: { name: [["FILE_NAME"], null], type: [["FILE_TYPE"], null], size: [["FILE_SIZE"], null], pub: [["FILE_PUB"], null] },
  CITATION: { text: [["CITATION_TEXT"], null], url: [["CITATION_URL"], null] },
};

// Stored units (from the schema column remarks) -> factor to the units the checks use
// (depth m, qc MPa, fs kPa, u kPa).
export const SCALE = { SCPT: { qc: 1, fs: 1000, u2: 1000 } };

export const GAMMA_W = 9.81;  // kN/m3
export const PA = 101.325;    // kPa

// [pass_limit, unsure_limit]; beyond unsure_limit -> Inconsistent
export const THRESH = {
  test_site_dist_m: [500, 2000], gwt_diff_m: [1.0, 3.0], rf_max_pct: 15, qc_max_mpa: 120, cpt_gap_m: 0.5,
  ic_diff: 0.10, uscs_fc_tol: 3, vs_cpt_ratio: [1.5, 2.5], disp_mag_m: 15, ref_overlay_rel_diff: [0.15, 0.35],
  spt_class_offset: [1, 2],
};

export const STATUS_ORDER = { FAIL: 0, UNSURE: 1, PASS: 2 };
export const STATUS_LABEL = { FAIL: "Inconsistent", UNSURE: "Not sure", PASS: "Consistent" };
export const STATUS_ICON = { FAIL: "✕", UNSURE: "?", PASS: "✓" };

// Privilege levels offered at sign-in. NGL has admin / reviewer / event permissions in its
// PERM table, but the REST API only knows role=admin; unreviewed (submitted) data is opened
// with includeUnreviewed=1. So:
//   user     -> reviewed (public) data only
//   reviewer -> includeUnreviewed=1 (submitted, not yet reviewed)
//   admin    -> role=admin (everything, including never-submitted drafts)
export const ROLES = {
  user:     { label: "User",     param: null,    unreviewed: false, desc: "Reviewed (public) data only" },
  reviewer: { label: "Reviewer", param: null,    unreviewed: true,  desc: "Plus submitted sites awaiting review" },
  admin:    { label: "Admin",    param: "admin", unreviewed: true,  desc: "Everything, including never-submitted drafts" },
};
