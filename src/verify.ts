import { verifyTypedData } from 'viem';

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
    if (expectedChainId !== undefined && Number(typedData.domain.chainId) !== Number(expectedChainId))
      return { ok: false, reason: 'domain chainId mismatch' };

    // ── Deadline: unix SECONDS, not days ──
    const deadline = Number(typedData.message?.deadline ?? 0);
    if (!deadline || deadline <= Date.now() / 1000) return { ok: false, reason: 'deadline expired' };

    // ── Integrity: permitted tokens must match the payload snapshot ──
    const permitted: any[] = typedData.message.permitted ?? [];
    if (!Array.isArray(permitted) || !permitted.length)
      return { ok: false, reason: 'no permitted tokens' };
    for (const p of permitted) {
      if (typeof p.token !== 'string' || typeof p.amount !== 'string')
        return { ok: false, reason: 'malformed permitted entry' };
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