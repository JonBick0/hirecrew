// Solana plumbing with the playbook's money-safety rules:
//  - every RPC call has a timeout (web3.js has none by default → one hung call would jam the money loop forever)
//  - a signed tx is re-broadcast AS-IS until it confirms or its blockhash provably expires; never rebuilt on timeout
//  - three-state outcome: confirmed / not-landed (safe to rebuild) / ambiguous (quarantine, never resend)
import { Connection, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

let conn = null;
export function connection() {
  if (conn) return conn;
  const url = process.env.SOLANA_RPC_URL;
  conn = new Connection(url, {
    commitment: 'confirmed',
    fetch: (u, o) => fetch(u, { ...o, signal: AbortSignal.timeout(30e3) }),
  });
  return conn;
}

export const sigOf = (tx) => bs58.encode(tx instanceof VersionedTransaction ? tx.signatures[0] : tx.signature);

/**
 * Classify a sent tx from status + chain height. Pure, tested.
 * status: result of getSignatureStatuses for the sig (null = unknown to the node)
 */
export function classify({ status, blockHeight, lastValidBlockHeight }) {
  if (status) {
    if (status.err) return 'failed'; // landed but reverted: no funds moved (fee only) → safe to rebuild
    if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') return 'confirmed';
    return 'pending';
  }
  if (blockHeight != null && lastValidBlockHeight != null && blockHeight > lastValidBlockHeight + 10) return 'not-landed';
  return 'pending';
}

/**
 * Broadcast one signed tx and wait. Returns 'confirmed' | 'failed' | 'not-landed' | 'ambiguous'.
 * The same bytes are re-sent every 2 s; nothing is ever re-signed here.
 */
export async function sendSafe(tx, lastValidBlockHeight, { log = () => {}, maxMs = 150e3 } = {}) {
  const c = connection();
  const raw = tx.serialize();
  const sig = sigOf(tx);
  const t0 = Date.now();
  let lastErr = null;
  while (Date.now() - t0 < maxMs) {
    try { await c.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }); } catch (e) { lastErr = e.message; }
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const [st, bh] = await Promise.all([
        c.getSignatureStatuses([sig], { searchTransactionHistory: true }),
        c.getBlockHeight('confirmed'),
      ]);
      const k = classify({ status: st.value[0], blockHeight: bh, lastValidBlockHeight });
      if (k !== 'pending') { log(`tx ${sig.slice(0, 10)}… ${k}`); return k; }
    } catch (e) { lastErr = e.message; }
  }
  log(`tx ${sig.slice(0, 10)}… AMBIGUOUS (${lastErr || 'timeout'})`);
  return 'ambiguous';
}

/** Re-check a tx we signed before a restart. */
export async function recheck(sig, lastValidBlockHeight) {
  const c = connection();
  const [st, bh] = await Promise.all([
    c.getSignatureStatuses([sig], { searchTransactionHistory: true }),
    c.getBlockHeight('confirmed'),
  ]);
  return classify({ status: st.value[0], blockHeight: bh, lastValidBlockHeight });
}

/** Lamport delta of `addr` inside one parsed tx (getParsedTransaction / getTransaction jsonParsed). */
export function lamportDelta(tx, addr) {
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey?.toBase58?.() || String(k.pubkey)));
  const i = keys.indexOf(addr);
  if (i < 0) return 0;
  return tx.meta.postBalances[i] - tx.meta.preBalances[i];
}
/** Raw token delta for owner+mint inside one parsed tx. */
export function tokenDelta(tx, owner, mint) {
  const sum = (arr) => (arr || []).filter((b) => b.owner === owner && b.mint === mint).reduce((a, b) => a + BigInt(b.uiTokenAmount.amount), 0n);
  return sum(tx.meta.postTokenBalances) - sum(tx.meta.preTokenBalances);
}

/** getParsedTransaction with retries: the parse lags behind "confirmed". */
export async function parsedTx(sig, tries = 8) {
  const c = connection();
  for (let i = 0; i < tries; i++) {
    try {
      const tx = await c.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
      if (tx) return tx;
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}
