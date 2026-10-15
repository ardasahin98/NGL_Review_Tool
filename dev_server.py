"""Local preview server: serves the web app and proxies /api/ngl/* to the NGL API
(the same job the Vercel function does in production). Standard library only.

    python3 dev_server.py              # http://localhost:8000
    python3 dev_server.py --port 8080 --target https://nextgenerationliquefaction.org
"""
import argparse
import http.server
import re
import ssl
import urllib.error
import urllib.request
import urllib.parse
import base64
import json

ALLOWED = [re.compile(r"^/users/api-token$"), re.compile(r"^/[a-z0-9-]+/api-index$")]
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "134.0.6998.118 Safari/537.36")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def _cookies(jar, resp):
    for c in resp.headers.get_all("Set-Cookie") or []:
        k, _, v = c.split(";")[0].partition("=")
        if k:
            jar[k.strip()] = v
    return jar


def _jar(jar):
    return "; ".join(f"{k}={v}" for k, v in jar.items())


class Handler(http.server.SimpleHTTPRequestHandler):
    target = "https://nextgenerationliquefaction.org"

    def _proxy(self, method):
        path = self.path[len("/api/ngl"):].split("?")[0]
        if not any(r.match(path) for r in ALLOWED):
            return self._send(403, b'{"errorMessage":"Path not allowed by proxy"}', "application/json")
        body = None
        if method == "POST":
            body = self.rfile.read(int(self.headers.get("Content-Length", 0) or 0))
        req = urllib.request.Request(self.target + path, data=body, method=method)
        req.add_header("User-Agent", UA)
        req.add_header("Accept", self.headers.get("Accept", "application/json"))
        for h in ("Authorization", "Content-Type"):
            if self.headers.get(h):
                req.add_header(h, self.headers[h])
        try:
            with urllib.request.urlopen(req, timeout=60, context=ssl.create_default_context()) as r:
                self._send(r.status, r.read(), r.headers.get("Content-Type", "application/json"))
        except urllib.error.HTTPError as e:
            self._send(e.code, e.read(), e.headers.get("Content-Type", "application/json"))
        except Exception as e:  # noqa
            self._send(502, ('{"errorMessage":"Proxy could not reach NGL: %s"}' % str(e).replace('"', "'")).encode(),
                       "application/json")

    def _send(self, code, data, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    # ---- website session + uploaded files (same as api/ngl-site.js on Vercel)
    def _site(self, method):
        u = urllib.parse.urlparse(self.path)
        action = u.path.rsplit("/", 1)[-1]
        q = urllib.parse.parse_qs(u.query)
        opener = urllib.request.build_opener(_NoRedirect)
        try:
            if action == "login" and method == "POST":
                user, _, pw = base64.b64decode(self.headers.get("Authorization", "").split()[-1]).decode().partition(":")
                r = opener.open(urllib.request.Request(self.target + "/login", headers={"User-Agent": UA}), timeout=60)
                html = r.read().decode("utf8", "ignore")
                m = re.search(r'name="_csrfToken"[^>]*value="([^"]+)"', html) or re.search(r'value="([^"]+)"[^>]*name="_csrfToken"', html)
                jar = _cookies({}, r)
                body = urllib.parse.urlencode({"_csrfToken": m.group(1) if m else "", "email": user, "user_pass": pw}).encode()
                req = urllib.request.Request(self.target + "/login?url=login", data=body, method="POST", headers={
                    "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", "Cookie": _jar(jar), "Referer": self.target + "/login"})
                try:
                    r2 = opener.open(req, timeout=60); status, loc = r2.status, r2.headers.get("Location", "")
                except urllib.error.HTTPError as e:
                    r2, status, loc = e, e.code, e.headers.get("Location", "")
                jar = _cookies(jar, r2)
                if not (300 <= status < 400 and "/login" not in loc):
                    return self._send(401, b'{"errorMessage":"NGL website login failed (check email/password)."}', "application/json")
                return self._send(200, json.dumps({"session": _jar(jar)}).encode(), "application/json")
            if action == "file":
                fid = (q.get("id") or [""])[0]
                if not fid.isdigit():
                    return self._send(400, b'{"errorMessage":"Bad file id"}', "application/json")
                route = "/downloads/get-image/" if (q.get("kind") or [""])[0] == "image" else "/downloads/download-file-by-i-d/"
                req = urllib.request.Request(self.target + route + fid, headers={"User-Agent": UA, "Cookie": self.headers.get("X-NGL-Session", "")})
                try:
                    r = opener.open(req, timeout=60)
                except urllib.error.HTTPError as e:
                    if 300 <= e.code < 400:
                        return self._send(401, b'{"errorMessage":"Website session expired or no access to this file."}', "application/json")
                    return self._send(e.code, e.read(), "application/json")
                data, ct = r.read(), r.headers.get("Content-Type", "application/octet-stream")
                if "text/html" in ct and b'name="_csrfToken"' in data[:20000]:
                    return self._send(401, b'{"errorMessage":"Got the NGL login page instead of the file."}', "application/json")
                self.send_response(200)
                self.send_header("Content-Type", ct)
                if r.headers.get("Content-Disposition"):
                    self.send_header("Content-Disposition", r.headers["Content-Disposition"])
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            self._send(404, b'{"errorMessage":"Unknown action"}', "application/json")
        except Exception as e:  # noqa
            self._send(502, json.dumps({"errorMessage": str(e)}).encode(), "application/json")

    def do_GET(self):
        if self.path.startswith("/api/ngl-site/"):
            return self._site("GET")
        if self.path.startswith("/api/ngl/"):
            return self._proxy("GET")
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith("/api/ngl-site/"):
            return self._site("POST")
        if self.path.startswith("/api/ngl/"):
            return self._proxy("POST")
        self._send(404, b"", "text/plain")

    def end_headers(self):
        # never let the browser reuse an old copy of the app's JS/CSS
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):  # keep the console quiet except for errors
        if args and str(args[1]).startswith(("4", "5")):
            super().log_message(fmt, *args)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--target", default=Handler.target)
    a = ap.parse_args()
    Handler.target = a.target.rstrip("/")
    Handler.extensions_map[".js"] = "text/javascript"
    import os
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    print(f"NGL Review Assistant on http://localhost:{a.port}  (API proxy -> {Handler.target})")
    http.server.ThreadingHTTPServer(("127.0.0.1", a.port), Handler).serve_forever()
