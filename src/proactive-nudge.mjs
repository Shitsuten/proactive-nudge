import { readFileSync } from 'node:fs';

const CHAT_API = process.env.CHAT_API || 'http://127.0.0.1:3800';
const AUTH_TOKEN = process.env.CHAT_API_TOKEN || readOptional(process.env.CHAT_API_TOKEN_FILE || './token.txt');
const AUTH = {
  ...(AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {}),
  'Content-Type': 'application/json'
};

const DEFAULTS = {
  enabled: false,
  conversation_id: '',
  intervalMin: 30,
  intervalMax: 60,
  message: ''
};

function readOptional(path) {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
}

function log(tag, message) {
  const now = new Date().toISOString().slice(11, 19);
  console.log(`[${now}] [${tag}] ${message}`);
}

async function jsonFetch(path, init = {}) {
  const response = await fetch(`${CHAT_API}${path}`, {
    ...init,
    headers: { ...AUTH, ...(init.headers || {}) }
  });
  if (!response.ok) {
    throw new Error(`${init.method || 'GET'} ${path} failed: ${response.status}`);
  }
  return response.json();
}

async function getPushSettings() {
  try {
    const settings = await jsonFetch('/settings');
    return { ...DEFAULTS, ...(settings.push || {}) };
  } catch (error) {
    log('SKIP', `settings unavailable: ${error.message}`);
    return DEFAULTS;
  }
}

async function getTargetConversationId(config) {
  if (config.conversation_id) return config.conversation_id;

  const conversations = await jsonFetch('/conversations');
  conversations.sort((a, b) => {
    const at = new Date(a.updated_at || a.created_at || 0).getTime();
    const bt = new Date(b.updated_at || b.created_at || 0).getTime();
    return bt - at;
  });
  return conversations[0]?.id || '';
}

function remainingDelayFromLastUserMessage(messages, intervalMin) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'user' || !message.timestamp) continue;

    const elapsedMinutes = (Date.now() - message.timestamp) / 60000;
    if (elapsedMinutes >= intervalMin) return 0;

    return Math.max(60_000, Math.ceil((intervalMin - elapsedMinutes) * 60_000));
  }
  return 0;
}

async function collectAssistantTextFromSse(response) {
  const text = await response.text();
  let assistantText = '';

  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    try {
      const event = JSON.parse(line.slice(6));
      if (event.type === 'content_block_delta' && event.delta?.text) {
        assistantText += event.delta.text;
      }
    } catch {
      // Ignore keepalive or malformed SSE lines.
    }
  }

  return assistantText.trim();
}

async function sendNudge(conversationId, message) {
  const response = await fetch(`${CHAT_API}/gateway/send`, {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({
      conversation_id: conversationId,
      message: `[nudge] ${message}`
    }),
    signal: AbortSignal.timeout(120_000)
  });
  if (!response.ok) throw new Error(`gateway/send failed: ${response.status}`);
  return collectAssistantTextFromSse(response);
}

async function sendPushNotification(assistantText) {
  if (!assistantText || !process.env.PUSH_ENDPOINT) return;

  await fetch(process.env.PUSH_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: process.env.PUSH_TITLE || 'Chat',
      body: assistantText.slice(0, 200),
      url: process.env.PUSH_URL || '/'
    })
  });
}

async function proactiveCheck() {
  const config = await getPushSettings();
  if (!config.enabled) {
    log('SKIP', 'disabled');
    return config;
  }

  const nudgeMessage = (config.message || '').trim();
  if (!nudgeMessage) {
    log('SKIP', 'empty message');
    return config;
  }

  const conversationId = await getTargetConversationId(config);
  if (!conversationId) {
    log('SKIP', 'no conversation');
    return config;
  }

  const conversation = await jsonFetch(`/conversations/${conversationId}`);
  const remainingDelayMs = remainingDelayFromLastUserMessage(
    conversation.messages || [],
    config.intervalMin || DEFAULTS.intervalMin
  );
  if (remainingDelayMs > 0) {
    log('SKIP', `too recent; next check in ${Math.round(remainingDelayMs / 60000)}m`);
    return { ...config, nextDelayMs: remainingDelayMs };
  }

  log('SEND', `injecting nudge into ${conversationId}`);
  const assistantText = await sendNudge(conversationId, nudgeMessage);
  if (assistantText) {
    log('REPLY', assistantText.slice(0, 80));
    try {
      await sendPushNotification(assistantText);
    } catch (error) {
      log('PUSH', error.message);
    }
  }

  return config;
}

function nextIntervalMs(config) {
  if (config.nextDelayMs) return config.nextDelayMs;

  const min = config.intervalMin || DEFAULTS.intervalMin;
  const max = Math.max(min, config.intervalMax || DEFAULTS.intervalMax);
  return (min + Math.random() * (max - min)) * 60_000;
}

async function loop() {
  let config = DEFAULTS;
  try {
    config = await proactiveCheck();
  } catch (error) {
    log('ERROR', error.message);
  }

  const delay = nextIntervalMs(config);
  log('NEXT', `${Math.round(delay / 60000)}m`);
  setTimeout(loop, delay);
}

log('INIT', 'proactive nudge worker');
setTimeout(loop, Number(process.env.FIRST_CHECK_MS || 180_000));
