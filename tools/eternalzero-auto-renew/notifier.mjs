const TELEGRAM_API_BASE = 'https://api.telegram.org';

function redactToken(token) {
  if (!token) return '';
  const str = String(token);
  if (str.length <= 8) return `${str.slice(0, 2)}***${str.slice(-2)}`;
  return `${str.slice(0, 4)}***${str.slice(-4)}`;
}

export async function notifyTelegram({ token, chatId, message, disablePreview = true }) {
  if (!token) {
    throw new Error('Telegram bot token is required');
  }
  if (!chatId) {
    throw new Error('Telegram chat ID is required');
  }
  if (!message) {
    throw new Error('Notification message is required');
  }

  const url = `${TELEGRAM_API_BASE}/bot${token}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text: message,
    disable_notification: false,
    disable_web_page_preview: disablePreview,
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const json = await response.json();
      detail = JSON.stringify(json);
    } catch (_) {
      // ignore
    }
    throw new Error(`Telegram notification failed: ${detail} (token ${redactToken(token)})`);
  }

  return response.json();
}

export default {
  notifyTelegram,
};
