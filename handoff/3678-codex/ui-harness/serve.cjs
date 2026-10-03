const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const port = Number(process.argv[2] || 4179);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Use a nonprivileged local port');
const root = path.join(__dirname, 'dist');
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.map': 'application/json' };
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'htt[historical local path omitted]').pathname;
  const filename = ['/fees', '/quotes', '/refund', '/boundary', '/'].includes(pathname) ? 'index.html' : pathname.slice(1);
  const resolved = path.resolve(root, filename);
  if (!resolved.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': types[path.extname(resolved)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(resolved).pipe(res);
});
server.listen(port, '127.0.0.1', () => console.log(`Private actual-component harness htt[historical local path omitted]`));
process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));

