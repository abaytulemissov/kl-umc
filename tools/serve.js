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
  // dev-only: PIN setup page for the stamp, the original stamp (never published), saving the encrypted file
  if (req.method === 'GET' && req.url === '/__dev/stamp-setup') {
    res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(path.join(__dirname, 'stamp-setup.html')));
  }
  if (req.method === 'GET' && req.url === '/__dev/stamp.png') {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(path.join(__dirname, '..', 'templates-src', 'stamp.png')));
  }
  if (req.method === 'POST' && req.url === '/__save/stamp.enc.json') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const box = JSON.parse(body);
      if (box.v !== 1 || !box.data || !box.iv || !box.salt) { res.writeHead(400); return res.end('bad'); }
      fs.writeFileSync(path.join(ROOT, 'stamp.enc.json'), JSON.stringify(box));
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
