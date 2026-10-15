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

ALLOWED = [re.compile(r"^/users/api-token$"), re.compile(r"^/[a-z0-9-]+/api-index$")]
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "134.0.6998.118 Safari/537.36")


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

    def do_GET(self):
        if self.path.startswith("/api/ngl/"):
            return self._proxy("GET")
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith("/api/ngl/"):
            return self._proxy("POST")
        self._send(404, b"", "text/plain")

    def end_headers(self):
        # never let the browser reuse an old copy of the app's JS/CSS
        if not self.path.startswith("/api/ngl/"):
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
