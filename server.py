#!/usr/bin/env python3
"""Static file server for the Calabar Port frontend.

Serves an absolute directory and never calls os.getcwd(), which is blocked
in the preview sandbox (Python's `-m http.server` calls getcwd at startup).
"""
import functools
import http.server
import os
import socketserver

# Serve this script's own folder; derived from __file__ (not getcwd) so it
# is portable and works wherever the project is placed.
DIRECTORY = os.path.dirname(os.path.abspath(__file__))
PORT = 8000

Handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=DIRECTORY)


class Server(socketserver.TCPServer):
    allow_reuse_address = True


if __name__ == "__main__":
    with Server(("127.0.0.1", PORT), Handler) as httpd:
        print(f"Serving {DIRECTORY} on http://127.0.0.1:{PORT}")
        httpd.serve_forever()
