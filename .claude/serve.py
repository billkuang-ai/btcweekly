import http.server, functools, os

os.chdir("/Users/Bill/Documents/dev/btcweekly/_site")
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory="/Users/Bill/Documents/dev/btcweekly/_site")
with http.server.HTTPServer(("", 8080), handler) as httpd:
    httpd.serve_forever()
