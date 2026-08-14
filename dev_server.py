import http.server
import urllib.request
import urllib.error
import os

API_TARGET = "http://localhost:12345"
STATIC_DIR = os.path.dirname(os.path.abspath(__file__))

class ProxyHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/api/"):
            url = API_TARGET + self.path
            try:
                resp = urllib.request.urlopen(url)
                self.send_response(resp.status)
                for k, v in resp.getheaders():
                    if k.lower() not in ("transfer-encoding", "content-encoding", "connection"):
                        self.send_header(k, v)
                self.end_headers()
                self.wfile.write(resp.read())
            except urllib.error.HTTPError as e:
                self.send_response(e.code)
                ct = e.headers.get("Content-Type", "text/plain")
                self.send_header("Content-Type", ct)
                self.end_headers()
                self.wfile.write(e.read())
            except Exception as e:
                self.send_response(502)
                self.send_header("Content-Type", "text/plain")
                self.end_headers()
                self.wfile.write(f"Proxy error: {e}".encode())
        else:
            super().do_GET()

    def log_message(self, format, *args):
        pass

if __name__ == "__main__":
    os.chdir(STATIC_DIR)
    http.server.test(HandlerClass=ProxyHandler, port=8111, bind="0.0.0.0")