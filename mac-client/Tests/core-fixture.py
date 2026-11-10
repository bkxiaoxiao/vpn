"""Loopback CONNECT fixtures; optional credential-free Apple HTTPS probes."""
import http.server
import json
import os
import select
import signal
import socket
import sys
import threading
import time

signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))


def watch_parent():
    parent = os.getppid()
    while os.getppid() == parent:
        time.sleep(.5)
    os._exit(0)


threading.Thread(target=watch_parent, daemon=True).start()


def proxy(label, delay):
    class Handler(http.server.BaseHTTPRequestHandler):
        # sing-box may send the TLS ClientHello with the CONNECT request.
        # Do not buffer it while parsing the plaintext proxy headers.
        rbufsize = 0
        def log_message(self, *args):
            pass

        def do_CONNECT(self):
            self.send_response(200)
            self.end_headers()
            self.connection.settimeout(8)
            # The delay API requires HTTPS. Relay a credential-free HEAD probe
            # to one public endpoint so TLS validation stays fully enabled.
            if self.path == 'www.apple.com:443':
                time.sleep(delay)
                with socket.create_connection(('www.apple.com', 443), timeout=5) as upstream:
                    while True:
                        ready, _, _ = select.select([self.connection, upstream], [], [], 8)
                        if not ready:
                            break
                        for source in ready:
                            data = source.recv(65536)
                            if not data:
                                return
                            (upstream if source is self.connection else self.connection).sendall(data)
                return
            if self.path.endswith(':443'):
                return
            connection = self.connection
            reader = connection.makefile('rb')
            line = reader.readline().decode()
            while reader.readline().strip():
                pass
            time.sleep(delay)
            if 'generate_204' in line:
                connection.sendall(b'HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
            else:
                body = label.encode()
                connection.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: ' + str(len(body)).encode() + b'\r\nConnection: close\r\n\r\n' + body)
            reader.close()
            self.close_connection = True

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server.server_port


with socket.socket() as unused:
    unused.bind(('127.0.0.1', 0))
    unavailable = unused.getsockname()[1]
class Direct(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass
    def do_GET(self):
        body = b'direct'
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

direct = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Direct)
direct.daemon_threads = True
threading.Thread(target=direct.serve_forever, daemon=True).start()
print(json.dumps({'a': proxy('route-a', .04), 'b': proxy('route-b', .08), 'unavailable': unavailable, 'direct': direct.server_port}), flush=True)
threading.Event().wait()
