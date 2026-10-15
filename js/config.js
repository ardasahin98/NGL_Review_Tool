// Central configuration: API location, endpoints, field-name candidates, thresholds.

// Where API calls go. On Vercel / local dev the serverless proxy at /api/ngl forwards to NGL
// (avoids CORS). When the app is hosted on the NGL website itself, call the API directly.
export const NGL_ORIGIN = "https://nextgenerationliquefaction.org";
export const API_BASE = location.hostname.endsWith("nextgenerationliquefaction.org") ? "" : "/api/ngl";

export const ENDPOINTS = {
  SITE: "/sites/api-index", TEST: "/field-tests/api-index", FLDO: "/field-observations/api-index",
  SAMP: "/samples/api-index", PLAS: "/plasticity-tests/api-index", INDX: "/index-tests/api-index",
  GRAG: "/grag/api-index", GRAT: "/grat/api-index", ISPT: "/penetration-test-results/api-index",
  BORH: "/boreholes/api-index", DETL: "/depth-layer-descriptions/api-index",
  STRA: "/stratigraphic-layer-descriptions/api-index", TEPT: "/test-pits/api-index",
  WATR: "/ground-water-tests/api-index", SCPG: "/general-cone-penetration-tests/api-index",
  SCPT: "/cone-penetration-data/api-index", GINV: "/general-invasives/api-index",
  GIND: "/invasive-details/api-index", GSWG: "/general-surface-wave-investigations/api-index",
  SWVG: "/surface-wave-tests/api-index", SWVD: "/surface-wave-details/api-index",
  GSWD: "/surface-wave-dispersion-curves/api-index", FLDD: "/displacement-vectors/api-index",
  FLDM: "/liquefaction-manifestations/api-index", GMIM: "/ground-motion-intensity-measurements/api-index",
  FILE: "/files/api-index", EVNT: "/events/api-index", IM: "/intensity-measures/api-index",
  CITATION: "/citations/api-index", SITF: "/site-files/api-index", TESF: "/field-test-files/api-index",
  FLDF: "/field-observation-files/api-index", SAMF: "/sample-files/api-index",
  SITP: "/site-citations/api-index", TESP: "/test-citations/api-index",
  FLDP: "/observation-citations/api-index", SAMP_TEST: "/test-samples/api-index",
};

// Tables loaded for one site, in dependency order; each is fetched by the first listed key
// that the table actually has and for which we already know IDs.
export const BUNDLE_ORDER = [
  ["TEST", ["SITE_ID"]], ["FLDO", ["SITE_ID"]], ["SCPG", ["TEST_ID"]], ["SCPT", ["SCPG_ID", "TEST_ID"]],
  ["BORH", ["TEST_ID"]], ["ISPT", ["BORH_ID", "TEST_ID"]], ["STRA", ["BORH_ID", "TEST_ID"]],
  ["DETL", ["BORH_ID", "TEST_ID"]], ["TEPT", ["TEST_ID"]], ["WATR", ["TEST_ID", "BORH_ID"]],
  ["SAMP_TEST", ["TEST_ID"]], ["SAMP", ["SAMP_ID", "TEST_ID", "BORH_ID"]], ["GRAG", ["SAMP_ID", "SPEC_ID"]],
  ["PLAS", ["SAMP_ID", "SPEC_ID"]], ["INDX", ["SAMP_ID", "SPEC_ID"]], ["GSWG", ["TEST_ID"]],
  ["SWVG", ["GSWG_ID", "TEST_ID"]], ["SWVD", ["SWVG_ID", "GSWG_ID", "TEST_ID"]],
  ["GSWD", ["SWVG_ID", "GSWG_ID", "TEST_ID"]], ["FLDM", ["FLDO_ID"]], ["FLDD", ["FLDO_ID"]],
  ["GMIM", ["FLDO_ID", "SITE_ID"]], ["SITF", ["SITE_ID"]], ["TESF", ["TEST_ID"]], ["FLDF", ["FLDO_ID"]],
  ["SITP", ["SITE_ID"]], ["TESP", ["TEST_ID"]], ["FLDP", ["FLDO_ID"]],
];

// logical field -> [candidate column names, regex fallback | null]
// The real column names are not confirmed yet: fix them on the Schema page (saved in the
// browser) or edit this table.
export const FIELDS = {
  SITE: { id: [["SITE_ID"], null], name: [["SITE_NAME"], "SITE_NAME"], lat: [["SITE_LAT"], "LAT"],
          lon: [["SITE_LON"], "LON"], status: [["SITE_STAT", "STAT"], "STAT"], review: [["SITE_REVW", "REVW"], "REVW|REVIEW"] },
  TEST: { id: [["TEST_ID"], null], site: [["SITE_ID"], null], type: [["TEST_TYPE"], "TYPE"],
          name: [["TEST_NAME"], "TEST_NAME|NAME"], lat: [["TEST_LAT"], "LAT"], lon: [["TEST_LON"], "LON"],
          elev: [["TEST_ELEV"], "ELEV"], date: [["TEST_DATE", "TEST_STAR"], "DATE|STAR"] },
  SCPG: { id: [["SCPG_ID"], null], test: [["TEST_ID"], null], car: [["SCPG_CAR", "SCPG_AREA"], "CAR$|AREA"],
          gwt: [["SCPG_WAT", "SCPG_GWT", "SCPG_WATD"], "WAT|GWT"], pre: [["SCPG_PRED", "SCPG_PREB"], "PRE"] },
  SCPT: { depth: [["SCPT_DPTH", "SCPT_DEPTH"], "DPTH|DEPTH"], qc: [["SCPT_RES", "SCPT_QC"], "_RES$|QC"],
          fs: [["SCPT_FRES", "SCPT_FS"], "FRES|_FS$"], u2: [["SCPT_PWP2", "SCPT_U2"], "PWP2|U2"],
          qt: [["SCPT_QT", "SCPT_CRES"], "_QT$|CRES"], ic: [["SCPT_IC", "SCPT_SBTI"], "_IC$|SBTI"] },
  BORH: { id: [["BORH_ID"], null], depth: [["BORH_DPTH", "BORH_FDEP", "BORH_DEPTH"], "DPTH|FDEP|DEPTH"],
          gwt: [["BORH_WAT", "BORH_GWT"], "WAT|GWT"], er: [["BORH_ERAT", "BORH_ENER", "BORH_ER"], "ERAT|ENER"] },
  ISPT: { top: [["ISPT_TOP", "ISPT_DPTH"], "TOP|DPTH"], base: [["ISPT_BASE", "ISPT_BOT"], "BASE|BOT"],
          n: [["ISPT_NVAL", "ISPT_N"], "NVAL|_N$"], er: [["ISPT_ERAT", "ISPT_ENER"], "ERAT|ENER"],
          n60: [["ISPT_N60"], "N60"], rem: [["ISPT_REM", "ISPT_REP"], "REM|REP"] },
  STRA: { top: [["STRA_TOP"], "TOP"], base: [["STRA_BASE", "STRA_BOT"], "BASE|BOT"], desc: [["STRA_DESC"], "DESC"],
          uscs: [["STRA_USCS", "STRA_LEG", "STRA_GEOL"], "USCS|LEG|CLASS"] },
  DETL: { top: [["DETL_TOP"], "TOP"], base: [["DETL_BASE", "DETL_BOT"], "BASE|BOT"], desc: [["DETL_DESC"], "DESC"] },
  WATR: { depth: [["WATR_DPTH", "WATR_DEP"], "DPTH|DEP"], date: [["WATR_DATE"], "DATE"] },
  SAMP: { id: [["SAMP_ID"], null], top: [["SAMP_TOP"], "TOP"], base: [["SAMP_BASE", "SAMP_BOT"], "BASE|BOT"],
          uscs: [["SAMP_USCS"], "USCS"], desc: [["SAMP_DESC"], "DESC"] },
  GRAG: { fines: [["GRAG_FINE", "GRAG_FC", "GRAG_SILT"], "FINE|_FC$"], uscs: [["GRAG_USCS"], "USCS"] },
  PLAS: { ll: [["PLAS_LL"], "_LL$"], pl: [["PLAS_PL"], "_PL$"], pi: [["PLAS_PI"], "_PI$"] },
  SWVG: { vs30: [["SWVG_VS30"], "VS30"] },
  SWVD: { top: [["SWVD_DPTH", "SWVD_TOP"], "DPTH|TOP"], thk: [["SWVD_THK", "SWVD_THIC"], "THK|THIC"],
          vs: [["SWVD_VS", "SWVD_SVEL"], "_VS$|SVEL"], vp: [["SWVD_VP", "SWVD_PVEL"], "_VP$|PVEL"] },
  GSWD: { freq: [["GSWD_FREQ"], "FREQ"], vel: [["GSWD_VEL", "GSWD_PHAS", "GSWD_VR"], "VEL|PHAS|_VR$"],
          wavelength: [["GSWD_WAVL"], "WAVL|LAMB"] },
  FLDO: { id: [["FLDO_ID"], null], event: [["EVNT_ID"], null], lat: [["FLDO_LAT"], "LAT"], lon: [["FLDO_LON"], "LON"],
          date: [["FLDO_DATE"], "DATE"], manif: [["FLDO_MANI", "FLDO_LIQ"], "MANI|LIQ"] },
  FLDM: { type: [["FLDM_TYPE", "FLDM_MANI"], "TYPE|MANI"], severity: [["FLDM_SEV", "FLDM_SEVR"], "SEV"],
          lat: [["FLDM_LAT"], "LAT"], lon: [["FLDM_LON"], "LON"] },
  FLDD: { lat: [["FLDD_LAT"], "LAT"], lon: [["FLDD_LON"], "LON"], de: [["FLDD_EAST", "FLDD_DX", "FLDD_DE"], "EAST|_DX$|_DE$"],
          dn: [["FLDD_NRTH", "FLDD_NORTH", "FLDD_DY", "FLDD_DN"], "NRTH|NORTH|_DY$|_DN$"],
          mag: [["FLDD_MAG", "FLDD_HORZ", "FLDD_DISP"], "MAG|HORZ|DISP"], azim: [["FLDD_AZIM", "FLDD_AZI"], "AZI"] },
  GMIM: { type: [["GMIM_TYPE", "IM_ID", "GMIM_IM"], "TYPE|IM_ID"], value: [["GMIM_VAL", "GMIM_VALUE"], "VAL"] },
  EVNT: { name: [["EVNT_NAME"], "NAME"], date: [["EVNT_DATE"], "DATE"], mag: [["EVNT_MAG", "EVNT_MW"], "MAG|_MW$"],
          lat: [["EVNT_LAT"], "LAT"], lon: [["EVNT_LON"], "LON"] },
  FILE: { name: [["FILE_NAME", "FILE_FSET"], "NAME"], type: [["FILE_TYPE", "FILE_MIME"], "TYPE|MIME"] },
  CITATION: { title: [["CITATION_TITLE", "TITLE"], "TITLE"], authors: [["CITATION_AUTHORS", "AUTHORS"], "AUTH"],
              year: [["CITATION_YEAR", "YEAR"], "YEAR"], doi: [["CITATION_DOI", "DOI"], "DOI"],
              url: [["CITATION_URL", "URL"], "URL|LINK"] },
};

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
