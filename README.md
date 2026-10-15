# NGL Review Assistant (web)

A web app that helps reviewers check NGL case histories that have been submitted but not yet reviewed. It is built with plain HTML, CSS and JavaScript and needs no build step.

The flow is:

1. Sign in on the **login page** (`index.html`).
2. Pick a site from the **review queue**.
3. The site review page plots each test: CPT, boring log with SPT, Vs with its dispersion curve, and a map with lateral-spread vectors. It also runs about 40 consistency checks. Each finding is marked **Inconsistent**, **Not sure** or **Consistent**, along with where it was found.
4. Check the data against the reference PDFs and figures, shown side by side.
5. Record your decisions and export a CSV or Markdown review report.

## Files

```
index.html            login page
app.html              the app (review queue, site review, calibration, schema, checks)
css/style.css
js/config.js          endpoints, field-name candidates, thresholds  <- tune here
js/api.js             NGL API client (token, pagination, loading all data for a site)
js/checks.js          all consistency checks
js/geotech.js         Robertson 2009, Boulanger & Idriss 2014, LPI, VS30, USCS helpers
js/refs.js            files/citations, PDF search (pdf.js), digitised overlays
js/viz.js             Plotly plots, Leaflet map
js/app.js             UI
js/demo-data.js       synthetic demo site with deliberately planted errors
vendor/               Plotly, Leaflet, pdf.js (bundled locally, no CDN needed)
api/ngl.js            Vercel serverless proxy to the NGL API
vercel.json
dev_server.py         local preview with the same proxy (Python standard library)
```

## Why there is a proxy

Browsers block a page on one domain from calling an API on another domain unless that API allows it (this is called CORS). So when the app runs on Vercel or locally, it calls `/api/ngl/...`, and a small proxy forwards the call to nextgenerationliquefaction.org.

The proxy only forwards the token endpoint and the `*/api-index` endpoints. It never stores passwords or tokens.

When the app is later hosted on the NGL website itself, `js/config.js` detects that and calls the API directly, so the `api/` folder is not needed there. On uclageo.com the proxy is still needed, or NGL has to send CORS headers that allow requests from that domain.

## Run it locally

```bash
python3 dev_server.py          # then open http://localhost:8000
```

You can also double-click `start_local.command` on a Mac. Use **Explore with demo data** on the login page to try the app without an account.

## Deploy on Vercel

**Option A: from GitHub**

1. Push this folder to a GitHub repository.
2. In Vercel, choose *Add New → Project* and import the repository.
3. Set Framework to **Other**. There is no build command, and the output directory is the root.
4. Deploy.

**Option B: from the command line**

Run `npx vercel` in this folder, then `npx vercel --prod`.

Optional environment variables:

- `NGL_ORIGIN`: a different API host, for example a staging server.
- `NGL_FILE_PATH_REGEX`: lets the proxy forward file downloads once we know NGL's file-download URL pattern.

## Roles

The NGL database has admin, reviewer and event permissions, but the REST API only knows `role=admin`. So the three choices on the login page work like this:

| Role | What is sent | What you see |
|---|---|---|
| User | `includeUnreviewed=0` | reviewed (public) data only |
| Reviewer | `includeUnreviewed=1` | adds submitted sites awaiting review |
| Admin | `role=admin` | everything, including never-submitted drafts (rejected by NGL if the account is not an admin) |

The review queue labels each site using `SITE_STAT` (1 = submitted) and `SITE_REVW` (1 = reviewed).

## Paging

NGL may return fewer rows than requested per page. The client notices this and keeps requesting pages at that size until a short page comes back. (This was the cause of "only 20 sites".)

## Schema

Field names and units come from NGL's schema page (`/schema/index.html`, database `sjbrande_ngl_db`). Note that `SCPT_RES`, `SCPT_FRES` and `SCPT_PWP` are all stored in MPa.

The links between tables are:

- SPT results (ISPT) belong to samples: TEST → SAMP_TEST → SAMP → ISPT.
- Lab results belong to specimens: SAMP → SPEC → GRAG/GRAT, PLAS, INDX.
- Fines content is taken from INDX_FINE, or read from the gradation curve at 0.075 mm.

The **Schema** page shows the mapping for the loaded site and lets you override a column.

## Boring logs

Boring logs are drawn by the UCLA Geo Boring Log Viewer API (`https://uclageo.com/boring-log-viewer/api/render`), which allows cross-origin calls, so no proxy is needed.

- The tool converts each NGL boring to the viewer's JSON. Each sample's flags go into a **Review flags** column, and layer-level flags become depth notes.
- Flagged depths are shaded on the returned SVG.
- **Download log JSON** gives the exact JSON sent, which you can open in the viewer page.
- If the viewer can't be reached, a built-in log is shown instead.

## Notes

- The NGL API is read-only, so the review status itself is still recorded on the NGL website. The tool exports the reviewer report to attach there.
- The API returns file **metadata only**. You can download a report or paper from the citation link and drop it on the References tab. Alternatively, set the file-download URL pattern on that tab once it is known.
- The **Calibration** page runs every check on sites that have already been reviewed. It shows which checks flag too often, which tells you which thresholds need tuning.
