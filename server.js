/* Crypto Journal sync server — static site + data API (single JSON store) */
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname);
const DATA_DIR = process.env.CJ_DATA_DIR || path.join(os.homedir(), '.cryptojournal');
const DB = path.join(DATA_DIR, 'data.json');
const NOTES_DB = path.join(DATA_DIR, 'notes.json');
const PORT = process.env.CJ_PORT || 8737;

function loadData() {
  try { return JSON.parse(fs.readFileSync(DB, 'utf8')); }
  catch (e) { return []; }
}
function saveData(list) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, DB);
}
function loadNotes() {
  try { return JSON.parse(fs.readFileSync(NOTES_DB, 'utf8')); }
  catch (e) { return []; }
}
function saveNotes(list) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = NOTES_DB + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, NOTES_DB);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.wav': 'audio/wav', '.flac': 'audio/flac', '.ogg': 'audio/ogg'
};
function ext(p) { return path.extname(p).toLowerCase(); }

function send(res, code, obj, mime) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store'
  };
  if (Buffer.isBuffer(obj)) {
    headers['Content-Type'] = mime || 'application/octet-stream';
    res.writeHead(code, headers);
    return res.end(obj);
  }
  if (typeof obj === 'string') {
    headers['Content-Type'] = mime || 'text/plain; charset=utf-8';
    res.writeHead(code, headers);
    return res.end(obj);
  }
  headers['Content-Type'] = 'application/json; charset=utf-8';
  res.writeHead(code, headers);
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (req.method === 'OPTIONS') return send(res, 204, 'ok', 'text/plain');

  // ------- API -------
  if (url === '/api/trades' && req.method === 'GET') {
    return send(res, 200, { ok: true, trades: loadData() });
  }
  if (url === '/api/trades' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 50e6) req.destroy(); });
    req.on('end', () => {
      try {
        const body = JSON.parse(raw);
        const list = loadData();
        const incoming = Array.isArray(body) ? body : [body];
        let added = 0;
        for (const t of incoming) {
          if (!t || !t.id) continue;
          const i = list.findIndex((x) => x.id === t.id);
          if (i >= 0) list[i] = t; else { list.push(t); added++; }
        }
        saveData(list);
        send(res, 200, { ok: true, added, total: list.length });
      } catch (e) { send(res, 400, { ok: false, error: 'bad json' }); }
    });
    return;
  }
  if (url === '/api/trades/clear' && req.method === 'POST') {
    saveData([]);
    return send(res, 200, { ok: true, total: 0 });
  }
  const delMatch = url.match(/^\/api\/trades\/(.+)$/);
  if (delMatch && req.method === 'DELETE') {
    const id = decodeURIComponent(delMatch[1]);
    const list = loadData().filter((t) => t.id !== id);
    saveData(list);
    return send(res, 200, { ok: true, total: list.length });
  }

  // ------- Notes API -------
  if (url === '/api/notes' && req.method === 'GET') {
    return send(res, 200, { ok: true, notes: loadNotes() });
  }
  const delNote = url.match(/^\/api\/notes\/(.+)$/);
  if (delNote && req.method === 'DELETE') {
    const id = decodeURIComponent(delNote[1]);
    const list = loadNotes().filter((n) => n.id !== id);
    saveNotes(list);
    return send(res, 200, { ok: true, total: list.length });
  }

  // ------- Static -------
  let safe = url === '/' ? '/index.html' : url;
  try { safe = decodeURIComponent(safe); } catch (e) { /* keep as-is */ }
  const file = path.join(ROOT, 'www', safe);
  if (!file.startsWith(path.join(ROOT, 'www'))) return send(res, 403, 'forbidden', 'text/plain');
  fs.stat(file, (err0, stats) => {
    if (err0) return send(res, 404, 'not found', 'text/plain');
    const total = stats.size;
    const headers = {
      'Accept-Ranges': 'bytes',
      'Content-Type': MIME[ext(file)] || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-store'
    };
    const range = req.headers.range;
    if (range) {
      const mm = /bytes=(\d*)-(\d*)/.exec(range);
      let start = mm && mm[1] !== '' ? parseInt(mm[1], 10) : 0;
      let end = mm && mm[2] !== '' ? parseInt(mm[2], 10) : total - 1;
      if (Number.isNaN(start)) start = 0;
      if (Number.isNaN(end) || end > total - 1) end = total - 1;
      if (start > end || start >= total) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` });
        return res.end();
      }
      headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
      headers['Content-Length'] = end - start + 1;
      res.writeHead(206, headers);
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    headers['Content-Length'] = total;
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Crypto Journal server: http://0.0.0.0:${PORT}  (data: ${DB})`);
});