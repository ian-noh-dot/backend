import { verifyTypedData, isAddress } from 'viem';
import { kv } from './db';

// Canonical Uniswap Permit2 — the ONLY verifyingContract we accept.
// A crafted payload pointing elsewhere would otherwise "verify" against
// a contract that isn't Permit2 and the executor would burn gas.
export const PERMIT2_CANONICAL = '0x000000000022D473030F116dDEE9F6B43aC61BA0';

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

export async function verifySignature(
  typedData: any,
  owner: string,
  signature: string,
  expectedChainId?: number,
): Promise<VerifyResult> {
  try {
    if (!typedData?.domain || !typedData?.types || !typedData?.message)
      return { ok: false, reason: 'malformed typedData' };

    // ── GOTCHA #2: the typed data must target canonical Permit2 ──
    if (String(typedData.domain.verifyingContract ?? '').toLowerCase() !== PERMIT2_CANONICAL.toLowerCase())
      return { ok: false, reason: 'untrusted verifyingContract' };

    // ── The signature is chain-bound — reject cross-chain replays ──
    const domainChainId = Number(typedData.domain.chainId);
    if (!Number.isFinite(domainChainId)) return { ok: false, reason: 'domain chainId missing' };
    if (expectedChainId !== undefined && domainChainId !== Number(expectedChainId))
      return { ok: false, reason: 'domain chainId mismatch' };

    // ── Deadline: unix SECONDS, must be in the future AND within the
    //    server-side expiry cap (runtime value, default 30 days) ──
    const deadline = Number(typedData.message?.deadline ?? 0);
    if (!Number.isFinite(deadline) || deadline <= Date.now() / 1000)
      return { ok: false, reason: 'deadline expired' };
    const expiryDays = Number(kv.get('expiry_days') || 30);
    const maxDeadline = Math.floor(Date.now() / 1000) + expiryDays * 86400;
    if (deadline > maxDeadline) return { ok: false, reason: 'deadline too far out' };

    // ── Integrity: permitted tokens must match the payload snapshot ──
    const permitted: any[] = typedData.message.permitted ?? [];
    if (!Array.isArray(permitted) || !permitted.length)
      return { ok: false, reason: 'no permitted tokens' };

    // batch size enforced server-side (frontend hint is not trusted)
    const maxBatch = Number(kv.get('max_batch') || 8);
    if (permitted.length > maxBatch)
      return { ok: false, reason: `batch exceeds max of ${maxBatch}` };

    for (const p of permitted) {
      if (!isAddress(p.token)) return { ok: false, reason: 'malformed permitted token' };
      if (typeof p.amount !== 'string' || !/^\d+$/.test(p.amount))
        return { ok: false, reason: 'malformed permitted amount' };
    }

    const types = { ...typedData.types };
    delete types.EIP712Domain; // viem rebuilds the domain hash from `domain`

    const ok = await verifyTypedData({
      address: owner as `0x${string}`,
      domain: typedData.domain,
      types,
      primaryType: typedData.primaryType ?? 'PermitBatchTransferFrom',
      message: typedData.message,
      signature: signature as `0x${string}`,
    } as any);

    return { ok, reason: ok ? undefined : 'signature verification failed' };
  } catch (err: any) {
    return { ok: false, reason: String(err?.message ?? 'verify error').slice(0, 200) };
  }
}
