// Tiny static server for local testing:  node tools/serve.js [port]
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', 'app');
const PORT = +process.env.PORT || +process.argv[2] || 5173;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8' };
http.createServer((req, res) => {
  // dev helper: save generated icons (POST /__save/icons/<name>.png with a data: URL body)
  if (req.method === 'POST' && /^\/__save\/icons\/[\w-]+\.png$/.test(req.url)) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      fs.writeFileSync(path.join(ROOT, req.url.replace('/__save/', '')), Buffer.from(body.split(',')[1], 'base64'));
      res.end('saved');
    });
    return;
  }
  let p = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
