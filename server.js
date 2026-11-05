/* PORTAL ARENA — zero-dependency static server.
   Usage: node server.js [port]   (default 8080) */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const ROOT = __dirname;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webm': 'audio/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ico': 'image/x-icon'
};

/* The upstream build requests both Fire.webm and fire.webm (one was a 404).
   On case-sensitive filesystems that breaks a sound; resolve it here. */
const ALIAS = { '/assets/sounds/fire.webm': '/assets/sounds/Fire.webm' };

function caseInsensitiveResolve(rel) {
  const parts = rel.split('/').filter(Boolean);
  let cur = ROOT;
  for (let i = 0; i < parts.length; i++) {
    let names;
    try { names = fs.readdirSync(cur); } catch (e) { return null; }
    const hit = names.find(n => n.toLowerCase() === parts[i].toLowerCase());
    if (!hit) return null;
    cur = path.join(cur, hit);
    if (i < parts.length - 1 && !fs.statSync(cur).isDirectory()) return null;
  }
  try { if (fs.statSync(cur).isFile()) return cur; } catch (e) {}
  return null;
}

const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(url.parse(req.url).pathname); }
  catch (e) { res.writeHead(400); res.end('Bad request'); return; }
  if (pathname === '/' || pathname === '') pathname = '/index.html';
  if (ALIAS[pathname]) pathname = ALIAS[pathname];

  let file = path.resolve(ROOT, '.' + pathname);
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    const alt = caseInsensitiveResolve(pathname);
    if (alt) file = alt;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 · ' + pathname);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(data);
  });
});

let port = Number(process.argv[2] || process.env.PORT) || 8080;
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log('Port ' + port + ' is busy, trying ' + (port + 1));
    port += 1;
    server.listen(port, '0.0.0.0');
  } else { throw e; }
});
server.listen(port, '0.0.0.0', () => {
  console.log('');
  console.log('  PORTAL ARENA is running');
  console.log('  ->  http://localhost:' + port);
  console.log('');
  console.log('  All assets are local. Press Ctrl+C to stop.');
  console.log('');
});
