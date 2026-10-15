// Vercel serverless proxy: /api/ngl/<path> -> https://nextgenerationliquefaction.org/<path>
// Needed because browsers block direct cross-site calls to the NGL API (CORS).
// Only the token endpoint, the */api-index endpoints and (optionally) a file-download
// pattern are forwarded, so this is not an open proxy. Nothing is logged or stored.
const ORIGIN = process.env.NGL_ORIGIN || "https://nextgenerationliquefaction.org";
const ALLOWED = [/^\/users\/api-token$/, /^\/[a-z0-9-]+\/api-index$/];
if (process.env.NGL_FILE_PATH_REGEX) ALLOWED.push(new RegExp(process.env.NGL_FILE_PATH_REGEX));
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) 134.0.6998.118 Safari/537.36";

module.exports = async (req, res) => {
  let path = req.query.path;
  if (Array.isArray(path)) path = path.join("/");
  path = "/" + String(path || "").replace(/^\/+/, "");
  if (!ALLOWED.some((re) => re.test(path))) {
    res.status(403).json({ errorMessage: `Path not allowed by proxy: ${path}` });
    return;
  }
  const headers = { "User-Agent": UA, Accept: req.headers.accept || "application/json" };
  if (req.headers.authorization) headers.Authorization = req.headers.authorization;
  const init = { method: req.method === "POST" ? "POST" : "GET", headers };
  if (init.method === "POST") {
    let body = req.body;
    if (body && typeof body === "object" && !Buffer.isBuffer(body)) body = JSON.stringify(body);
    init.body = body || "{}";
    headers["Content-Type"] = req.headers["content-type"] || "application/json";
  }
  try {
    const r = await fetch(ORIGIN + path, init);
    const buf = Buffer.from(await r.arrayBuffer());
    res.status(r.status);
    res.setHeader("Content-Type", r.headers.get("content-type") || "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    res.send(buf);
  } catch (e) {
    res.status(502).json({ errorMessage: "Proxy could not reach NGL: " + e.message });
  }
};
