const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');
const JSON_FILE = path.join(DATA_DIR, 'numbers.json');
const CSV_FILE = path.join(DATA_DIR, 'numbers.csv');
const CONFIG_FILE = path.join(ROOT_DIR, 'config.json');
const ADMIN_KEY = process.env.ADMIN_KEY || '';

function loadConfig() {
  let fileCfg = {};
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      fileCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch {
    fileCfg = {};
  }
  return {
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || fileCfg.telegramBotToken || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || fileCfg.telegramChatId || ''
  };
}

async function sendToTelegram(entry) {
  const { telegramBotToken, telegramChatId } = loadConfig();
  if (!telegramBotToken || !telegramChatId) return false;

  const text = [
    '📱 New Mobile Number Submitted',
    `Number: ${entry.fullNumber}`,
    `Country: ${entry.countryCode}`,
    `Time: ${entry.submittedAt}`,
    `IP: ${entry.ip || 'unknown'}`
  ].join('\n');

  try {
    const res = await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: telegramChatId,
        text
      })
    });
    return res.ok;
  } catch (err) {
    console.error('Telegram send failed:', err.message);
    return false;
  }
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.ico': 'image/x-icon'
};

function ensureStorageReady() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(JSON_FILE)) {
    fs.writeFileSync(JSON_FILE, '[]\n', 'utf8');
  }
  if (!fs.existsSync(CSV_FILE)) {
    fs.writeFileSync(CSV_FILE, 'id,countryCode,number,fullNumber,submittedAt,ip\n', 'utf8');
  }
}

function readNumbers() {
  ensureStorageReady();
  try {
    const raw = fs.readFileSync(JSON_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function escapeCsv(value) {
  const str = String(value == null ? '' : value);
  if (/[",\r\n]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function appendNumber(entry) {
  ensureStorageReady();
  const list = readNumbers();
  list.push(entry);
  fs.writeFileSync(JSON_FILE, JSON.stringify(list, null, 2) + '\n', 'utf8');

  const csvLine = [
    escapeCsv(entry.id),
    escapeCsv(entry.countryCode),
    escapeCsv(entry.number),
    escapeCsv(entry.fullNumber),
    escapeCsv(entry.submittedAt),
    escapeCsv(entry.ip)
  ].join(',') + '\n';
  fs.appendFileSync(CSV_FILE, csvLine, 'utf8');
}

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function isAuthorized(reqUrl) {
  if (!ADMIN_KEY) return true;
  return reqUrl.searchParams.get('key') === ADMIN_KEY;
}

function parseJsonBody(req, maxBytes = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function serveStaticFile(req, res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }

    const range = req.headers.range;
    if (range && ext === '.mp4') {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;

      if (Number.isNaN(start) || start >= stat.size || end >= stat.size || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        res.end();
        return;
      }

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': contentType
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
      return;
    }

    res.writeHead(200, {
      'Content-Length': stat.size,
      'Content-Type': contentType,
      'Accept-Ranges': ext === '.mp4' ? 'bytes' : 'none'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(reqUrl.pathname);

  if (req.method === 'POST' && pathname === '/api/save-number') {
    try {
      const body = await parseJsonBody(req);
      const countryCode = String(body.countryCode || '+91').trim().slice(0, 8);
      const number = String(body.number || '').replace(/\D/g, '');

      if (!number || number.length < 7 || number.length > 15) {
        return sendJson(res, 400, { ok: false, error: 'Invalid mobile number' });
      }
      if (countryCode === '+91' && !/^[6-9]\d{9}$/.test(number)) {
        return sendJson(res, 400, { ok: false, error: 'Invalid 10-digit Indian mobile number' });
      }

      const forwarded = req.headers['x-forwarded-for'];
      const ip = typeof forwarded === 'string'
        ? forwarded.split(',')[0].trim()
        : (req.socket && req.socket.remoteAddress) || '';

      const entry = {
        id: crypto.randomUUID(),
        countryCode,
        number,
        fullNumber: `${countryCode}${number}`,
        submittedAt: new Date().toISOString(),
        ip,
        userAgent: String(req.headers['user-agent'] || '').slice(0, 200)
      };

      appendNumber(entry);
      const telegramSent = await sendToTelegram(entry);
      return sendJson(res, 201, { ok: true, id: entry.id, telegramSent });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message || 'Bad request' });
    }
  }

  if (req.method === 'GET' && pathname === '/api/numbers') {
    if (!isAuthorized(reqUrl)) {
      return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    }
    const numbers = readNumbers().slice().reverse();
    return sendJson(res, 200, { ok: true, count: numbers.length, numbers });
  }

  if (req.method === 'GET' && pathname === '/api/numbers.csv') {
    if (!isAuthorized(reqUrl)) {
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Unauthorized');
      return;
    }
    ensureStorageReady();
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="mobile-numbers.csv"'
    });
    fs.createReadStream(CSV_FILE).pipe(res);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
    return;
  }

  // Block direct access to data directory and config.json
  if (pathname.startsWith('/data') || pathname === '/config.json') {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const resolvedPath = path.resolve(ROOT_DIR, relativePath);
  if (!resolvedPath.startsWith(ROOT_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  serveStaticFile(req, res, resolvedPath);
});

ensureStorageReady();
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Admin dashboard at http://localhost:${PORT}/admin.html`);
});
