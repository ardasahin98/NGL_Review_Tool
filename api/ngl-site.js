// Vercel serverless function: access to files uploaded to NGL (FILE table contents).
// The REST API only returns file metadata; the files themselves are served by the NGL
// website at /downloads/download-file-by-i-d/{FILE_ID}, which needs a website session.
//
//   POST /api/ngl-site/login        (Basic auth header)  -> { session }   website session cookie
//   GET  /api/ngl-site/file?id=123  (X-NGL-Session)      -> file bytes
//
// Credentials are only passed through to NGL's own login form; nothing is stored here.
const ORIGIN = process.env.NGL_ORIGIN || "https://nextgenerationliquefaction.org";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) 134.0.6998.118 Safari/537.36";

const cookiesOf = (r) => (r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get("set-cookie") || ""])
  .filter(Boolean).map((c) => c.split(";")[0]);
const merge = (...lists) => {
  const m = new Map();
  lists.flat().forEach((c) => { const i = c.indexOf("="); if (i > 0) m.set(c.slice(0, i), c.slice(i + 1)); });
  return [...m].map(([k, v]) => `${k}=${v}`).join("; ");
};

async function siteLogin(user, pass) {
  const g = await fetch(ORIGIN + "/login", { headers: { "User-Agent": UA }, redirect: "manual" });
  const html = await g.text();
  const csrf = (html.match(/name="_csrfToken"[^>]*value="([^"]+)"/) || html.match(/value="([^"]+)"[^>]*name="_csrfToken"/) || [])[1] || "";
  let jar = merge(cookiesOf(g));
  const body = new URLSearchParams({ _csrfToken: csrf, email: user, user_pass: pass }).toString();
  const p = await fetch(ORIGIN + "/login?url=login", { method: "POST", redirect: "manual",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", Cookie: jar, Referer: ORIGIN + "/login" }, body });
  jar = merge(jar.split("; "), cookiesOf(p));
  const loc = p.headers.get("location") || "";
  const ok = p.status >= 300 && p.status < 400 && !/\/login/.test(loc);
  if (!ok) throw new Error("NGL website login failed (check email/password).");
  return jar;
}

async function getFile(session, id, kind) {
  const route = kind === "image" ? "/downloads/get-image/" : "/downloads/download-file-by-i-d/";
  const r = await fetch(ORIGIN + route + encodeURIComponent(id), { headers: { "User-Agent": UA, Cookie: session }, redirect: "manual" });
  if (r.status >= 300 && r.status < 400) return { status: 401, error: "Website session expired or no access to this file." };
  const ct = r.headers.get("content-type") || "application/octet-stream";
  const buf = Buffer.from(await r.arrayBuffer());
  if (ct.includes("text/html") && /name="_csrfToken"/.test(buf.toString("utf8", 0, 20000))) return { status: 401, error: "Got the NGL login page instead of the file." };
  return { status: r.status, buf, ct, disp: r.headers.get("content-disposition") };
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const action = String(req.query.action || "").replace(/^\/+/, "");
  try {
    if (action === "login" && req.method === "POST") {
      const a = req.headers.authorization || "";
      const [user, ...rest] = Buffer.from(a.replace(/^Basic\s+/i, ""), "base64").toString("utf8").split(":");
      if (!user) { res.status(400).json({ errorMessage: "Missing credentials" }); return; }
      const session = await siteLogin(user, rest.join(":"));
      res.status(200).json({ session });
      return;
    }
    if (action === "file") {
      const id = String(req.query.id || "");
      if (!/^\d+$/.test(id)) { res.status(400).json({ errorMessage: "Bad file id" }); return; }
      const out = await getFile(req.headers["x-ngl-session"] || "", id, req.query.kind);
      if (out.error) { res.status(out.status).json({ errorMessage: out.error }); return; }
      res.status(out.status);
      res.setHeader("Content-Type", out.ct);
      if (out.disp) res.setHeader("Content-Disposition", out.disp);
      res.send(out.buf);
      return;
    }
    res.status(404).json({ errorMessage: "Unknown action" });
  } catch (e) {
    res.status(502).json({ errorMessage: e.message });
  }
};
