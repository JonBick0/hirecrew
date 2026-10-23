// $CREW treasury loop: claim creator fees (engine = creator) → split buyback pool / run budget (house rigs + models) → buy $CREW
// on Jupiter → burn exactly what that buy returned. Every step: write-ahead ledger, own-tx deltas, three-state confirm.
// Txs built by third parties (pump.fun collect-fees, Jupiter swap) are checked instruction by instruction AND
// simulated against the engine's balances before the engine signs them.
//
// Ledger types: claim-signed {sig, lvbh} · claim {sig, received, pool, landmark} · claim-result {sig, outcome}
//               buy-signed {sig, lvbh, lamports} · buy-result {sig, outcome, tokens}
//               burn-signed {sig, lvbh, amount} · burn-result {sig, outcome, amount}
//               ("landmark" fields below = the run budget; this file is shared with the PumpCity engine)
import { PublicKey, Transaction, VersionedTransaction, ComputeBudgetProgram } from '@solana/web3.js';
import { createBurnCheckedInstruction, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getMint } from '@solana/spl-token';
import { cfg, flags } from './config.mjs';
import { connection, sendSafe, recheck, parsedTx, lamportDelta, tokenDelta, sigOf } from './chain.mjs';

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PUMP_AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const JUPITER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const SYSTEM = '11111111111111111111111111111111';
const COMPUTE = 'ComputeBudget111111111111111111111111111111';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const TOKEN = TOKEN_PROGRAM_ID.toBase58(), TOKEN22 = TOKEN_2022_PROGRAM_ID.toBase58();
const WSOL = 'So11111111111111111111111111111111111111112';
const DISC = { collectCreatorFee: '1416567bc61cdb84', collectCoinCreatorFee: 'a039592ab58b2b42' };

const hex8 = (data) => Buffer.from(data).subarray(0, 8).toString('hex');
/**
 * Top-level instruction allowlist for a tx the engine signs but did not build. Pure, tested.
 * kind 'claim': only the two creator-fee collect instructions + ATA create + WSOL unwrap to the engine.
 * kind 'swap':  only the Jupiter route + ATA create + SOL wrap into the engine's own WSOL account + unwrap to engine.
 * Never: token approve / set-authority, system transfers to anyone else, any other program.
 */
export function checkInstructions(ixs, engine, kind, engineWsolAta) {
  for (const ix of ixs) {
    const { program, data, accounts } = ix;
    if (program === COMPUTE) continue;
    if (program === ATA) { if (data.length === 0 || data[0] === 0 || data[0] === 1) continue; throw new Error('ATA ix not allowed'); }
    if (program === TOKEN || program === TOKEN22) {
      if (data[0] === 17) continue; // SyncNative
      if (data[0] === 9 && accounts[1] === engine && accounts[2] === engine) continue; // CloseAccount → engine
      throw new Error('token ix ' + data[0] + ' not allowed');
    }
    if (kind === 'claim') {
      if (program === PUMP && hex8(data) === DISC.collectCreatorFee) continue;
      if (program === PUMP_AMM && hex8(data) === DISC.collectCoinCreatorFee) continue;
    }
    if (kind === 'swap') {
      if (program === JUPITER) continue;
      // wrap SOL: system transfer from the engine into its OWN WSOL account only
      if (program === SYSTEM && data.length >= 4 && Buffer.from(data).readUInt32LE(0) === 2 && accounts[0] === engine && accounts[1] === engineWsolAta) continue;
    }
    throw new Error(`${kind} tx: instruction for ${program} not allowed`);
  }
  return true;
}
function decodeIxs(tx) {
  // programs always come from static keys; an account loaded from a lookup table shows as 'alt:i' and so can never
  // satisfy an "account must be the engine" check (fail-closed)
  return tx.message.compiledInstructions.map((ix) => ({
    program: tx.message.staticAccountKeys[ix.programIdIndex].toBase58(),
    data: ix.data,
    accounts: ix.accountKeyIndexes.map((i) => tx.message.staticAccountKeys[i]?.toBase58() || 'alt:' + i),
  }));
}

/** Lamports the next buyback may spend. Pure, tested. */
export function buybackBudget({ pool, balance, reserve, pendingRefunds, max, min }) {
  const free = balance - reserve - pendingRefunds;
  const b = Math.min(pool, free, max);
  return b >= min ? Math.floor(b) : 0;
}
/** Split claimed fees between the buyback pool and the landmark budget. Pure, tested. */
export function splitClaim(received, bps) {
  const pool = Math.floor((received * bps) / 10000);
  return { pool, landmark: received - pool };
}
const tokenAmountFromAccount = (b64) => { const b = Buffer.from(b64, 'base64'); return b.length >= 72 ? b.readBigUInt64LE(64) : 0n; };

export class Treasury {
  constructor(ledger, billboards, { log = console.log } = {}) {
    this.ledger = ledger; this.bb = billboards; this.log = log;
    this.pool = 0; this.landmark = 0; this.burnOwed = 0n; this.burned = 0n; this.bought = 0n; this.burnQuarantined = 0n;
    this.open = []; // signed txs with no outcome yet: {kind, sig, lvbh, lamports?, amount?}
    this.measured = new Set(); // claim sigs already measured into the pool
    this.quarantine = [];
    this.busy = false; this.runStarted = 0; this.lastRun = 0;
    this.rebuild();
  }

  rebuild() {
    const signed = new Map();
    for (const r of this.ledger.read()) {
      switch (r.type) {
        case 'bb-transfer': this.pool += r.delta; break;
        case 'claim': this.pool += r.pool; this.landmark += r.landmark; this.measured.add(r.sig); break;
        case 'claim-signed': case 'buy-signed': case 'burn-signed':
          signed.set(r.sig, { kind: r.type.split('-')[0], ...r });
          if (r.type === 'buy-signed') this.pool -= r.lamports;
          break;
        case 'burn-writeoff': this.burnOwed -= BigInt(r.amount); this.burnQuarantined += BigInt(r.amount); break;
        case 'claim-result': case 'buy-result': case 'burn-result': {
          const s = signed.get(r.sig);
          if (!s) break; // duplicate result line: counted once
          signed.delete(r.sig);
          if (r.type === 'buy-result') {
            if (r.outcome === 'confirmed') { this.bought += BigInt(r.tokens || 0); this.burnOwed += BigInt(r.tokens || 0); }
            else if (r.outcome !== 'ambiguous') this.pool += s.lamports; // proven not spent → back to the pool
          }
          if (r.type === 'burn-result') {
            if (r.outcome === 'confirmed') { this.burnOwed -= BigInt(r.amount); this.burned += BigInt(r.amount); }
            else if (r.outcome === 'ambiguous') { this.burnOwed -= BigInt(r.amount); this.burnQuarantined += BigInt(r.amount); }
          }
          if (r.outcome === 'ambiguous') this.quarantine.push(r.sig);
          break;
        }
      }
    }
    this.open = [...signed.values()];
  }
  totalPool() { return this.pool + Math.max(0, this.bb?.pool || 0); }
  view() {
    return { pool: this.totalPool(), runBudget: this.landmark, bought: String(this.bought), burned: String(this.burned), burnOwed: String(this.burnOwed), burnQuarantined: String(this.burnQuarantined), quarantined: this.quarantine.length, flags };
  }

  async run(kp) {
    if (this.busy || !cfg.mint) return;
    this.busy = true; this.runStarted = Date.now();
    try {
      await this.recover(kp.publicKey.toBase58());
      if (this.open.length) return; // something unresolved: do nothing new until it is
      if (flags.claim) await this.claim(kp);
      if (this.open.length) return;
      if (flags.buyback && this.burnOwed > 0n) await this.burn(kp);
      else if (flags.buyback) await this.buy(kp);
    } catch (e) { this.log('treasury', e.message); } finally { this.busy = false; this.lastRun = Date.now(); }
  }

  /** Resolve txs signed before a restart (or whose parse lagged). */
  async recover(engine) {
    for (const o of [...this.open]) {
      o.engine ||= engine;
      const k = await recheck(o.sig, o.lvbh).catch(() => 'pending');
      if (k === 'pending') continue;
      await this.finish(o, k);
    }
  }
  /** Record an outcome exactly once per sig. A confirmed claim/buy whose parse lags stays open (nothing written). */
  async finish(o, outcome) {
    if (!this.open.some((x) => x.sig === o.sig)) return; // already finished by someone else
    const eng = o.engine;
    if (o.kind === 'claim') {
      if (outcome === 'confirmed' && !this.measured.has(o.sig)) {
        const tx = await parsedTx(o.sig);
        if (!tx) { this.log('claim landed, parse lagging — measured next run'); return; }
        const received = Math.max(0, lamportDelta(tx, eng) + Number(tokenDelta(tx, eng, WSOL))); // net of fee; WSOL left wrapped counts too
        const { pool, landmark } = splitClaim(received, 10000 - cfg.runBps);
        this.ledger.append({ type: 'claim', sig: o.sig, received, pool, landmark }); // measure BEFORE closing it
        this.measured.add(o.sig);
        this.pool += pool; this.landmark += landmark;
        this.log(`claimed ${received / 1e9} SOL → pool ${pool / 1e9}, run budget ${landmark / 1e9}`);
      }
      this.ledger.append({ type: 'claim-result', sig: o.sig, outcome });
    } else if (o.kind === 'buy') {
      let tokens = 0n;
      if (outcome === 'confirmed') {
        const tx = await parsedTx(o.sig);
        if (!tx) return;
        tokens = tokenDelta(tx, eng, cfg.mint);
        if (tokens < 0n) tokens = 0n;
        this.bought += tokens; this.burnOwed += tokens;
      } else if (outcome !== 'ambiguous') this.pool += o.lamports;
      this.ledger.append({ type: 'buy-result', sig: o.sig, outcome, tokens: String(tokens) });
      this.log(`buyback ${o.sig.slice(0, 10)}… ${outcome} ${tokens} raw $CREW`);
    } else if (o.kind === 'burn') {
      this.ledger.append({ type: 'burn-result', sig: o.sig, outcome, amount: o.amount });
      if (outcome === 'confirmed') { this.burnOwed -= BigInt(o.amount); this.burned += BigInt(o.amount); }
      else if (outcome === 'ambiguous') { this.burnOwed -= BigInt(o.amount); this.burnQuarantined += BigInt(o.amount); } // never re-burn on doubt
    }
    this.open = this.open.filter((x) => x.sig !== o.sig);
    if (outcome === 'ambiguous') this.quarantine.push(o.sig);
  }

  async simulateDeltas(tx, engine, tokenAccount) {
    const c = connection();
    const addrs = [engine, ...(tokenAccount ? [tokenAccount] : [])];
    const sim = await c.simulateTransaction(tx, { sigVerify: false, accounts: { addresses: addrs, encoding: 'base64' } });
    if (sim.value.err) throw new Error('simulation failed: ' + JSON.stringify(sim.value.err));
    return { lamports: sim.value.accounts?.[0]?.lamports, token: tokenAccount && sim.value.accounts?.[1] ? tokenAmountFromAccount(sim.value.accounts[1].data[0]) : 0n };
  }

  async claim(kp) {
    const c = connection();
    const engine = kp.publicKey.toBase58();
    const r = await fetch('https://fun-block.pump.fun/agents/collect-fees', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mint: cfg.mint, user: engine, encoding: 'base64' }), signal: AbortSignal.timeout(20e3),
    });
    if (!r.ok) { this.log('collect-fees', r.status); return; }
    const j = await r.json().catch(() => null);
    const b64 = typeof j === 'string' ? j : j?.transaction || j?.tx;
    if (!b64) return;
    const tx = VersionedTransaction.deserialize(Buffer.from(b64, 'base64'));
    if (tx.message.staticAccountKeys[0].toBase58() !== engine) throw new Error('claim tx fee payer is not the engine');
    if (tx.message.addressTableLookups?.length) throw new Error('claim tx uses lookup tables — refused');
    checkInstructions(decodeIxs(tx), engine, 'claim');
    const { blockhash, lastValidBlockHeight } = await c.getLatestBlockhash('confirmed');
    tx.message.recentBlockhash = blockhash;
    tx.sign([kp]);
    const before = await c.getBalance(kp.publicKey);
    const sim = await this.simulateDeltas(tx, engine);
    if (sim.lamports == null || sim.lamports - before < -1_000_000) throw new Error('claim simulation drains the engine — refused');
    if (sim.lamports - before < cfg.buybackMinLamports / 5) return; // nothing worth claiming yet (WSOL claims: see GO-LIVE)
    const sig = sigOf(tx);
    const o = { kind: 'claim', sig, lvbh: lastValidBlockHeight, engine };
    this.ledger.append({ type: 'claim-signed', sig, lvbh: lastValidBlockHeight });
    this.open.push(o);
    await this.finish(o, await sendSafe(tx, lastValidBlockHeight, { log: this.log }));
  }

  async buy(kp) {
    const c = connection();
    const engine = kp.publicKey.toBase58();
    const balance = await c.getBalance(kp.publicKey);
    const lamports = buybackBudget({ pool: this.totalPool(), balance, reserve: cfg.reserveLamports, pendingRefunds: this.bb?.pendingRefundLamports() || 0, max: cfg.buybackMaxLamports, min: cfg.buybackMinLamports });
    if (!lamports) return;
    const q = await (await fetch(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${WSOL}&outputMint=${cfg.mint}&amount=${lamports}&slippageBps=${cfg.slippageBps}&onlyDirectRoutes=false`, { signal: AbortSignal.timeout(15e3) })).json();
    if (!q?.outAmount) { this.log('buyback quote failed'); return; }
    if (q.inputMint !== WSOL || q.outputMint !== cfg.mint || String(q.inAmount) !== String(lamports) || q.swapMode !== 'ExactIn') throw new Error('quote does not match the request');
    const sw = await (await fetch('https://lite-api.jup.ag/swap/v1/swap', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(20e3),
      body: JSON.stringify({ quoteResponse: q, userPublicKey: engine, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 200000, priorityLevel: 'high' } } }),
    })).json();
    if (!sw?.swapTransaction) { this.log('buyback swap build failed'); return; }
    const tx = VersionedTransaction.deserialize(Buffer.from(sw.swapTransaction, 'base64'));
    if (tx.message.staticAccountKeys[0].toBase58() !== engine) throw new Error('swap fee payer mismatch');
    const mint = new PublicKey(cfg.mint);
    const program = (await c.getAccountInfo(mint)).owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    const skyAta = getAssociatedTokenAddressSync(mint, kp.publicKey, false, program).toBase58();
    const wsolAta = getAssociatedTokenAddressSync(new PublicKey(WSOL), kp.publicKey, false, TOKEN_PROGRAM_ID).toBase58();
    checkInstructions(decodeIxs(tx), engine, 'swap', wsolAta);
    tx.sign([kp]);
    // simulate: the engine may lose at most the budget + 0.01 SOL (fees, ATA rent), and must receive ≥ the quote's minimum
    const preTok = await c.getTokenAccountBalance(new PublicKey(skyAta)).then((x) => BigInt(x.value.amount)).catch(() => 0n);
    const sim = await this.simulateDeltas(tx, engine, skyAta);
    if (sim.lamports == null || balance - sim.lamports > lamports + 10_000_000) throw new Error('swap simulation spends more than the budget — refused');
    if (sim.token - preTok < BigInt(q.otherAmountThreshold)) throw new Error('swap simulation returns less than the minimum — refused');
    const sig = sigOf(tx);
    const lvbh = sw.lastValidBlockHeight;
    const fromBb = Math.min(Math.max(0, this.bb?.pool || 0), lamports);
    if (fromBb) { this.ledger.append({ type: 'bb-transfer', delta: fromBb }); this.bb.pool -= fromBb; this.pool += fromBb; }
    this.ledger.append({ type: 'buy-signed', sig, lvbh, lamports });
    this.pool -= lamports;
    const o = { kind: 'buy', sig, lvbh, lamports, engine };
    this.open.push(o);
    await this.finish(o, await sendSafe(tx, lvbh, { log: this.log }));
  }

  async burn(kp) {
    const c = connection();
    const mint = new PublicKey(cfg.mint);
    const info = await c.getAccountInfo(mint);
    const program = info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    const m = await getMint(c, mint, 'confirmed', program);
    const ata = getAssociatedTokenAddressSync(mint, kp.publicKey, false, program);
    const held = await c.getTokenAccountBalance(ata).then((x) => BigInt(x.value.amount)).catch(() => 0n);
    if (held < this.burnOwed) { // tokens we owe a burn on are gone: write the difference off once (never burn other tokens)
      const gap = this.burnOwed - held;
      this.ledger.append({ type: 'burn-writeoff', amount: String(gap), reason: `held ${held} < owed ${this.burnOwed}` });
      this.burnOwed -= gap; this.burnQuarantined += gap;
      this.log(`burn write-off ${gap} (held < owed)`);
    }
    const amount = this.burnOwed;
    if (amount <= 0n) return;
    const { blockhash, lastValidBlockHeight } = await c.getLatestBlockhash('confirmed');
    const tx = new Transaction({ feePayer: kp.publicKey, blockhash, lastValidBlockHeight })
      .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }))
      .add(createBurnCheckedInstruction(ata, mint, kp.publicKey, amount, m.decimals, [], program));
    tx.sign(kp);
    const sig = sigOf(tx);
    this.ledger.append({ type: 'burn-signed', sig, lvbh: lastValidBlockHeight, amount: String(amount) });
    const o = { kind: 'burn', sig, lvbh: lastValidBlockHeight, amount: String(amount), engine: kp.publicKey.toBase58() };
    this.open.push(o);
    await this.finish(o, await sendSafe(tx, lastValidBlockHeight, { log: this.log }));
  }
}
