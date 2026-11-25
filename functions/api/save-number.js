export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Invalid JSON' }, 400);
  }

  const countryCode = String(body.countryCode || '+91').trim().slice(0, 8);
  const number = String(body.number || '').replace(/\D/g, '');

  if (!number || number.length < 7 || number.length > 15) {
    return jsonResponse({ ok: false, error: 'Invalid mobile number' }, 400);
  }
  if (countryCode === '+91' && !/^[6-9]\d{9}$/.test(number)) {
    return jsonResponse({ ok: false, error: 'Invalid 10-digit Indian mobile number' }, 400);
  }

  const fullNumber = `${countryCode}${number}`;
  const submittedAt = new Date().toISOString();
  const ip =
    request.headers.get('CF-Connecting-IP') ||
    (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    'unknown';
  const country = request.cf && request.cf.country ? request.cf.country : '';

  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;

  let telegramSent = false;
  if (token && chatId) {
    const text = [
      '📱 New Mobile Number Submitted',
      `Number: ${fullNumber}`,
      `Country: ${countryCode}`,
      `Time: ${submittedAt}`,
      `IP: ${ip}${country ? ` (${country})` : ''}`
    ].join('\n');

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
    } catch {
      telegramSent = false;
    }
  }

  return jsonResponse({ ok: true, telegramSent }, 201);
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
}
