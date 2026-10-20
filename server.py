#!/usr/bin/env python3
"""Hull planner: serves the static app and stores named layouts as JSON files.

GET    /api/layouts          -> [{"name", "modified"}]
GET    /api/layouts/<name>   -> layout JSON
PUT    /api/layouts/<name>   -> save (body = layout JSON)
DELETE /api/layouts/<name>   -> remove
"""
import json
import os
import re
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
LAYOUTS = ROOT / "layouts"
NAME_RE = re.compile(r"^[\w .\-()]{1,80}$")
MAX_BODY = 2 * 1024 * 1024


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(STATIC), **kw)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.command, fmt % args))

    def end_headers(self):
        if not self.path.startswith("/vendor/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _layout_path(self):
        name = unquote(urlparse(self.path).path[len("/api/layouts/"):])
        if not NAME_RE.match(name) or name.strip(" .") == "":
            return None
        return LAYOUTS / f"{name}.json"

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/layouts":
            items = [{"name": p.stem, "modified": p.stat().st_mtime}
                     for p in LAYOUTS.glob("*.json")]
            return self._json(200, sorted(items, key=lambda i: -i["modified"]))
        if path.startswith("/api/layouts/"):
            p = self._layout_path()
            if not p or not p.exists():
                return self._json(404, {"error": "not found"})
            return self._json(200, json.loads(p.read_text()))
        return super().do_GET()

    def do_PUT(self):
        if not self.path.startswith("/api/layouts/"):
            return self._json(404, {"error": "not found"})
        p = self._layout_path()
        if not p:
            return self._json(400, {"error": "bad name"})
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            return self._json(413, {"error": "too large"})
        try:
            data = json.loads(self.rfile.read(n))
        except ValueError:
            return self._json(400, {"error": "bad json"})
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=1))
        os.replace(tmp, p)
        return self._json(200, {"ok": True})

    def do_DELETE(self):
        p = self._layout_path() if self.path.startswith("/api/layouts/") else None
        if not p or not p.exists():
            return self._json(404, {"error": "not found"})
        p.unlink()
        return self._json(200, {"ok": True})


if __name__ == "__main__":
    LAYOUTS.mkdir(exist_ok=True)
    port = int(os.environ.get("PORT", "8791"))
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
