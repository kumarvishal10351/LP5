async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) {
      return JSON.parse(req.body.toString('utf8') || '{}');
    }
    if (typeof req.body === 'string') {
      return JSON.parse(req.body || '{}');
    }
    if (typeof req.body === 'object') {
      return req.body;
    }
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = (process.env.TELEGRAM_CHAT_ID || '').trim();

  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      hasToken: Boolean(token),
      hasChatId: Boolean(chatId)
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  let body;
  try {
    body = await readBody(req);
  } catch {
    return res.status(400).json({ ok: false, error: 'Invalid JSON' });
  }

  const countryCode = String(body.countryCode || '+91').trim().slice(0, 8);
  const number = String(body.number || '').replace(/\D/g, '');

  if (!number || number.length < 7 || number.length > 15) {
    return res.status(400).json({ ok: false, error: 'Invalid mobile number' });
  }
  if (countryCode === '+91' && !/^[6-9]\d{9}$/.test(number)) {
    return res.status(400).json({ ok: false, error: 'Invalid 10-digit Indian mobile number' });
  }

  const fullNumber = `${countryCode}${number}`;
  const submittedAt = new Date().toISOString();
  const forwarded = req.headers['x-forwarded-for'];
  const ip = typeof forwarded === 'string'
    ? forwarded.split(',')[0].trim()
    : (req.socket && req.socket.remoteAddress) || 'unknown';
  const country = req.headers['x-vercel-ip-country'] || '';

  let telegramSent = false;
  let telegramError = null;

  if (!token || !chatId) {
    telegramError = 'Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID';
    console.error(telegramError);
  } else {
    const text = [
      '📱 New Mobile Number Submitted',
      `Number: ${fullNumber}`,
      `Country: ${countryCode}`,
      `Time: ${submittedAt}`,
      `IP: ${ip}${country ? ` (${country})` : ''}`
    ].join('\n');

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text
          })
        });
        telegramSent = tgRes.ok;
        if (tgRes.ok) {
          telegramError = null;
          break;
        }
        telegramError = await tgRes.text();
        console.error(`Telegram API error (attempt ${attempt}):`, tgRes.status, telegramError);
      } catch (err) {
        telegramError = err.message;
        console.error(`Telegram fetch failed (attempt ${attempt}):`, err);
        telegramSent = false;
      }
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }

  return res.status(201).json({ ok: true, telegramSent, telegramError });
};
