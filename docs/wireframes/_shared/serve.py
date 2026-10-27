"""线稿本地预览：python3 docs/wireframes/_shared/serve.py [port]
no-store：改线稿刷新即见，免启发式缓存干扰。"""
import http.server
import sys

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

port = int(sys.argv[1]) if len(sys.argv) > 1 else 4173
http.server.ThreadingHTTPServer(
    ("127.0.0.1", port), NoCacheHandler
).serve_forever()
