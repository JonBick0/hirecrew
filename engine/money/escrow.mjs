// Job escrow in $CREW. A hire is an order with its own random Solana Pay `reference` key. The hirer's $CREW transfer
// to the engine must carry it. When the payment is seen the job is queued; when the referee closes the job the
// escrow settles it: done → 70% to the agent's own wallet + 30% burned; failed / voided → full refund.
//
// Payments are found by paging the engine's $CREW account history (one cursor), never by trusting instruction data:
// money in = the engine's own token delta in that tx, capped at what the paying signer actually lost.
//
// Ledger records (append-only JSONL, fsync'd before any send). Every payout is DERIVED from the single record that
// created the debt, with a deterministic id, so a crash can never lose one or create it twice:
//   order      {order}
//   paid       {id, sig, payer, received, excess}   → refund `${sig}:excess` if excess
//   reject     {id, sig, payer, received, reason}   → refund `${sig}` (unless dust)
//   result     {id, ok, why}                        → settle `${id}:settle` or refund `${id}:refund`
//   pay-signed {rid, sig, lvbh}
//   pay-result {rid, sig, outcome}
//   cursor     {sig}
import crypto from 'node:crypto'
import { Keypair, PublicKey, Transaction, ComputeBudgetProgram, TransactionInstruction } from '@solana/web3.js'
import {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction,
  createBurnCheckedInstruction, getMint, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import { cfg, flags, isPubkey } from './config.mjs'
import { connection, sendSafe, recheck, parsedTx, sigOf } from './chain.mjs'

const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')

// ---------------- pure logic (unit tested) ----------------
/** Raw $CREW for a USD price. Rounds up so the agent is never short. */
export function quote(usd, priceUsd, decimals) {
  if (!(usd > 0) || !(priceUsd > 0) || !Number.isFinite(priceUsd)) throw new Error('no $CREW price yet')
  const raw = BigInt(Math.ceil((usd / priceUsd) * 10 ** decimals))
  if (raw <= 0n) throw new Error('bad quote')
  return raw
}
/** Settled job → (agent pay, burn). Sum is exactly the amount. */
export function split(amount, bps = cfg.agentBps) {
  const agent = (amount * BigInt(bps)) / 10000n
  return { agent, burn: amount - agent }
}
const keyList = (tx) => tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? { pubkey: k, signer: false } : { pubkey: String(k.pubkey), signer: !!k.signer }))
// per-owner token deltas; the engine's side counts ONLY its own $CREW account (engineAta), so tokens moved into any
// other account the engine happens to own (e.g. via SetAuthority) are never credited
const ownerDeltas = (tx, mint, engine, engineAta, keys) => {
  const d = new Map()
  for (const [arr, sign] of [[tx.meta.preTokenBalances, -1n], [tx.meta.postTokenBalances, 1n]])
    for (const b of arr || []) {
      if (b.mint !== mint || !b.owner) continue
      if (engineAta && b.owner === engine && keys[b.accountIndex]?.pubkey !== engineAta) continue
      d.set(b.owner, (d.get(b.owner) || 0n) + sign * BigInt(b.uiTokenAmount.amount))
    }
  return d
}
/** Check one parsed tx against an order. */
export function verifyPayment(tx, order, engine, mint, engineAta = null, grace = cfg.lateGraceMs) {
  if (!tx || !tx.meta) return { ok: false, received: 0n, reason: 'unparsed' }
  if (tx.meta.err) return { ok: false, received: 0n, reason: 'tx failed' }
  const keys = keyList(tx)
  if (!keys.some((k) => k.pubkey === order.ref)) return { ok: false, received: 0n, reason: 'no reference' }
  const d = ownerDeltas(tx, mint, engine, engineAta, keys)
  const engineIn = d.get(engine) || 0n
  if (engineIn <= 0n) return { ok: false, received: 0n, reason: 'nothing received' }
  const signers = new Set(keys.filter((k) => k.signer).map((k) => k.pubkey))
  let payer = null, worst = 0n
  for (const [owner, v] of d) if (owner !== engine && signers.has(owner) && v < worst) { worst = v; payer = owner }
  if (!payer || !isPubkey(payer)) return { ok: false, received: 0n, reason: 'no payer' }
  const received = engineIn < -worst ? engineIn : -worst
  const amount = BigInt(order.amount)
  if ((tx.blockTime || 0) * 1000 > order.expiresAt + grace) return { ok: false, received, payer, reason: 'late' }
  if (received < amount) return { ok: false, received, payer, reason: 'underpaid' }
  return { ok: true, received: amount, payer, excess: received - amount }
}
/** Refunds below 5% of the order are dust: they would cost more than they return. */
export const isDust = (received, order) => BigInt(received) * 20n < BigInt(order.amount)

// ---------------- service ----------------
export class Escrow {
  constructor(ledger, { engine, agents, mint = cfg.mint, log = console.log, onPaid = () => {} }) {
    this.mintAddr = mint; this.ledger = ledger; this.engine = engine; this.agents = agents; this.log = log; this.onPaid = onPaid
    this.orders = new Map(); this.byRef = new Map(); this.usedSigs = new Set()
    this.dues = new Map() // rid → {rid, kind, id, to, agent?, amount, burn, sig, lvbh, outcome, at}
    this.cursor = null
    this.scanning = false; this.scanStarted = 0; this.paying = false; this.payStarted = 0
    this.mintInfo = null; this.price = null
    this.rebuild()
  }

  owe(rid, d) { if (!this.dues.has(rid)) this.dues.set(rid, { rid, sig: null, outcome: null, burn: 0n, ...d }) }
  oweFromResult(o, ok, why, at) {
    if (ok) { const s = split(BigInt(o.received)); this.owe(`${o.id}:settle`, { kind: 'settle', id: o.id, to: this.agents[o.job.agent], agent: o.job.agent, amount: s.agent, burn: s.burn, at }) }
    else this.owe(`${o.id}:refund`, { kind: 'refund', id: o.id, to: o.payer, amount: BigInt(o.received), why, at })
  }

  rebuild() {
    for (const r of this.ledger.read()) {
      const o = this.orders.get(r.id)
      switch (r.type) {
        case 'order': { const x = { ...r.order, status: 'open' }; this.orders.set(x.id, x); this.byRef.set(x.ref, x); break }
        case 'paid':
          this.usedSigs.add(r.sig)
          if (o) Object.assign(o, { status: 'paid', sig: r.sig, payer: r.payer, received: r.received, paidAt: r.at })
          if (BigInt(r.excess || 0) > 0n) this.owe(`${r.sig}:excess`, { kind: 'refund', id: r.id, to: r.payer, amount: BigInt(r.excess), why: 'overpaid', at: r.at })
          break
        case 'reject':
          this.usedSigs.add(r.sig)
          if (o && !r.dust) this.owe(r.sig, { kind: 'refund', id: r.id, to: r.payer, amount: BigInt(r.received), why: r.reason, at: r.at })
          break
        case 'result': if (o && o.status === 'paid') { o.status = r.ok ? 'done' : 'refund'; o.why = r.why; this.oweFromResult(o, r.ok, r.why, r.at) } break
        case 'cursor': this.cursor = r.sig; break
        case 'pay-signed': { const f = this.dues.get(r.rid); if (f) Object.assign(f, { sig: r.sig, lvbh: r.lvbh, outcome: null, signedAt: r.at }); break }
        case 'pay-result': { const f = this.dues.get(r.rid); if (f && f.sig === r.sig) { f.outcome = r.outcome; if (r.outcome === 'failed') f.fails = (f.fails || 0) + 1 } break }
      }
    }
  }

  open() { return flags.payments && isPubkey(cfg.mint) && isPubkey(this.engine) && Object.values(this.agents).every(isPubkey) }
  async mint() {
    if (this.mintInfo) return this.mintInfo
    const c = connection(), mint = new PublicKey(cfg.mint)
    const info = await c.getAccountInfo(mint)
    if (!info) throw new Error('$CREW mint not found')
    const program = info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
    const m = await getMint(c, mint, 'confirmed', program)
    const engineAta = getAssociatedTokenAddressSync(mint, new PublicKey(this.engine), false, program)
    return (this.mintInfo = { mint, program, decimals: m.decimals, engineAta })
  }
  async priceUsd() {
    if (this.price && Date.now() - this.price.at < 30e3) return this.price.usd
    let usd = null
    try {
      const j = await (await fetch(`https://lite-api.jup.ag/price/v3?ids=${cfg.mint}`, { signal: AbortSignal.timeout(8e3) })).json()
      usd = Number(j?.[cfg.mint]?.usdPrice) || null
    } catch {}
    if (!usd) try {
      const j = await (await fetch(`https://api.dexscreener.com/latest/dex/tokens/${cfg.mint}`, { signal: AbortSignal.timeout(8e3) })).json()
      usd = Number(j?.pairs?.[0]?.priceUsd) || null
    } catch {}
    if (!usd) throw new Error('no $CREW price yet, try again in a minute')
    this.price = { usd, at: Date.now() }
    return usd
  }
  watched(now = Date.now()) { return [...this.orders.values()].filter((o) => o.status === 'open' && now < o.expiresAt + cfg.watchMs) }
  openFor(agent, now = Date.now()) { return [...this.orders.values()].filter((o) => o.status === 'open' && o.job.agent === agent && now < o.expiresAt).length }

  /** Create an order for a job (no money moves). */
  async create(job) {
    if (!this.open()) throw new Error('payments are not open')
    const usd = cfg.usd[job.kind]
    if (!usd) throw new Error('unknown job')
    if (this.watched().length >= 1000) throw new Error('busy, try again in a few minutes')
    const [{ decimals }, priceUsd] = await Promise.all([this.mint(), this.priceUsd()])
    const amount = quote(usd, priceUsd, decimals)
    const now = Date.now()
    const order = { id: crypto.randomBytes(6).toString('hex'), job, usd, priceUsd, amount: String(amount), decimals, ref: Keypair.generate().publicKey.toBase58(), createdAt: now, expiresAt: now + cfg.orderTtlMs }
    this.ledger.append({ type: 'order', order })
    const x = { ...order, status: 'open' }
    this.orders.set(order.id, x); this.byRef.set(order.ref, x)
    return this.publicOrder(x)
  }
  ui(raw, decimals) { const s = BigInt(raw).toString().padStart(decimals + 1, '0'); return (s.slice(0, -decimals) + '.' + s.slice(-decimals)).replace(/\.?0+$/, '') }
  publicOrder(o) {
    const amountUi = this.ui(o.amount, o.decimals)
    return { id: o.id, status: o.status, job: o.job, usd: o.usd, amount: amountUi, mint: cfg.mint, ref: o.ref, payTo: this.engine, expiresAt: o.expiresAt, jobId: o.jobId || null, why: o.why || null,
      url: `solana:${this.engine}?amount=${amountUi}&spl-token=${cfg.mint}&reference=${o.ref}&label=crew&message=${encodeURIComponent('Hire ' + o.job.agent)}` }
  }

  /** Unsigned transfer for the hirer's wallet: their $CREW → engine, with the order's reference key attached. */
  async buildTx(id, account) {
    const o = this.orders.get(id)
    if (!o || o.status !== 'open' || Date.now() > o.expiresAt) throw new Error('order expired, hire again')
    if (!isPubkey(account) || account === this.engine) throw new Error('bad wallet')
    const { mint, program, decimals, engineAta } = await this.mint()
    const payer = new PublicKey(account), engine = new PublicKey(this.engine)
    const src = getAssociatedTokenAddressSync(mint, payer, false, program)
    const bal = await connection().getTokenAccountBalance(src).then((x) => BigInt(x.value.amount)).catch(() => 0n)
    if (bal < BigInt(o.amount)) throw new Error(`you need ${this.ui(o.amount, decimals)} $CREW in this wallet`)
    const ix = createTransferCheckedInstruction(src, mint, engineAta, payer, BigInt(o.amount), decimals, [], program)
    ix.keys.push({ pubkey: new PublicKey(o.ref), isSigner: false, isWritable: false })
    const { blockhash, lastValidBlockHeight } = await connection().getLatestBlockhash('confirmed')
    const tx = new Transaction({ feePayer: payer, blockhash, lastValidBlockHeight })
      .add(createAssociatedTokenAccountIdempotentInstruction(payer, engineAta, engine, mint, program))
      .add(ix)
      .add(new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from(`crew hire ${o.id}`) }))
    return Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString('base64')
  }

  /** Handle one parsed tx that touched the engine's $CREW account. */
  apply(sig, tx) {
    if (this.usedSigs.has(sig)) return
    const o = keyList(tx).map((k) => this.byRef.get(k.pubkey)).find(Boolean)
    if (!o) return // not a hire payment (settlements, buybacks, plain transfers)
    if (Date.now() > o.expiresAt + cfg.watchMs) return
    const v = verifyPayment(tx, o, this.engine, this.mintAddr, this.mintInfo?.engineAta?.toBase58() || null)
    if (v.received <= 0n) return
    if (!v.payer) { // money arrived but no signing owner lost it (multisig / PDA wallet): record it, can't refund
      this.usedSigs.add(sig)
      this.ledger.append({ type: 'reject', id: o.id, sig, payer: null, received: String(v.received), reason: v.reason, dust: true })
      this.log(`order ${o.id} payment from a non-signing owner, held for a manual refund (${sig})`)
      return
    }
    this.usedSigs.add(sig)
    if (v.ok && o.status === 'open') {
      this.ledger.append({ type: 'paid', id: o.id, sig, payer: v.payer, received: String(v.received), excess: String(v.excess) })
      Object.assign(o, { status: 'paid', sig, payer: v.payer, received: String(v.received), paidAt: Date.now() })
      if (v.excess > 0n) this.owe(`${sig}:excess`, { kind: 'refund', id: o.id, to: v.payer, amount: v.excess, why: 'overpaid', at: Date.now() })
      this.log(`order ${o.id} paid ${this.ui(v.received, o.decimals)} $CREW by ${v.payer}`)
      try { this.onPaid(o) } catch (e) { this.log('onPaid', e.message) }
    } else {
      const reason = v.ok ? 'duplicate payment' : v.reason
      const dust = isDust(v.received, o)
      this.ledger.append({ type: 'reject', id: o.id, sig, payer: v.payer, received: String(v.received), reason, dust })
      if (!dust) this.owe(sig, { kind: 'refund', id: o.id, to: v.payer, amount: v.received, why: reason, at: Date.now() })
      this.log(`order ${o.id} payment rejected (${reason})${dust ? ', dust kept' : ', refund due'}`)
    }
  }

  /** The referee closed (or a restart voided) a paid job. Exactly once per order. */
  result(id, ok, why) {
    const o = this.orders.get(id)
    if (!o || o.status !== 'paid') return
    this.ledger.append({ type: 'result', id, ok: !!ok, why: why || null })
    o.status = ok ? 'done' : 'refund'; o.why = why
    this.oweFromResult(o, ok, why, Date.now())
    this.log(`order ${id} ${ok ? 'settles: 70% to ' + o.job.agent + ', 30% burned' : 'refunds (' + why + ')'}`)
  }
  /** Paid orders with no result yet (for boot reconcile). */
  unresolved() { return [...this.orders.values()].filter((o) => o.status === 'paid') }

  /** Page the engine $CREW account's signatures newer than the cursor; oldest → newest; never skip an unparsed one. */
  async scan() {
    if (this.scanning || !this.open()) return
    const watched = this.watched()
    if (!watched.length) return
    this.scanning = true; this.scanStarted = Date.now()
    try {
      const c = connection()
      const { engineAta } = await this.mint()
      const oldest = Math.min(...watched.map((o) => o.createdAt)) - 120e3
      const fresh = []
      let before
      for (let page = 0; page < 20; page++) {
        const sigs = await c.getSignaturesForAddress(engineAta, { limit: 1000, before, until: this.cursor || undefined })
        fresh.push(...sigs)
        if (sigs.length < 1000) break
        before = sigs[sigs.length - 1].signature
        if (!this.cursor && (sigs[sigs.length - 1].blockTime || 0) * 1000 < oldest) break
      }
      const todo = fresh.filter((s) => this.cursor || (s.blockTime || Infinity) * 1000 >= oldest).reverse()
      for (const s of todo) {
        if (!s.err && !this.usedSigs.has(s.signature)) {
          const tx = await parsedTx(s.signature, 4)
          if (!tx) break // parse lag: the cursor stays before this sig, the next scan retries it
          this.apply(s.signature, tx)
        }
        this.cursor = s.signature
        this.ledger.append({ type: 'cursor', sig: s.signature })
      }
    } finally { this.scanning = false }
  }

  /** Send due payouts (PAYOUTS_ENABLED only). Fail-closed: ambiguous is never resent. */
  async pay(kp) {
    if (this.paying || !isPubkey(cfg.mint)) return
    this.paying = true; this.payStarted = Date.now()
    try {
      const c = connection()
      for (const f of this.dues.values()) {
        if (f.busy) continue
        f.busy = true // claimed synchronously: no second run can touch this due until it is released
        try { await this.payOne(kp, c, f) } finally { f.busy = false }
      }
    } finally { this.paying = false }
  }
  quarantine(f, why) {
    const sig = f.sig && !f.outcome ? f.sig : 'none:' + f.rid + ':' + Date.now()
    if (sig.startsWith('none:')) this.ledger.append({ type: 'pay-signed', rid: f.rid, sig, lvbh: 0 })
    this.ledger.append({ type: 'pay-result', rid: f.rid, sig, outcome: 'ambiguous' })
    Object.assign(f, { sig, outcome: 'ambiguous' }); this.log(`payout ${f.rid} quarantined: ${why}`)
  }
  async payOne(kp, c, f) {
    if (f.sig && !f.outcome) { // signed before a restart / unresolved: re-check, never re-sign blindly
      const k = await recheck(f.sig, f.lvbh).catch(() => 'pending')
      if (k === 'pending') return
      this.ledger.append({ type: 'pay-result', rid: f.rid, sig: f.sig, outcome: k }); f.outcome = k
      if (k === 'failed') f.fails = (f.fails || 0) + 1
    }
    if (f.outcome === 'confirmed' || f.outcome === 'ambiguous' || !flags.payouts) return
    if ((f.fails || 0) >= 2) return this.quarantine(f, 'failed twice on chain')
    const { mint, program, decimals, engineAta } = await this.mint()
    if (!isPubkey(f.to) || f.to === this.engine) return this.quarantine(f, 'bad destination')
    const held = await c.getTokenAccountBalance(engineAta).then((x) => BigInt(x.value.amount)).catch(() => 0n)
    if (held < f.amount + f.burn) { this.log(`payout ${f.rid} waits: engine holds ${held}`); return }
    if ((await c.getBalance(kp.publicKey)) < 5_000_000) { this.log(`payout ${f.rid} waits: engine needs SOL for fees`); return }
    const to = new PublicKey(f.to)
    const dst = getAssociatedTokenAddressSync(mint, to, true, program)
    const tx = new Transaction({ feePayer: kp.publicKey, ...(await c.getLatestBlockhash('confirmed')) })
      .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }))
    if (f.kind === 'settle') tx.add(createAssociatedTokenAccountIdempotentInstruction(kp.publicKey, dst, to, mint, program)) // our own agents only
    else if (!(await c.getAccountInfo(dst))) { this.log(`refund ${f.rid} waits: payer closed their $CREW account`); return } // never pay rent for strangers
    tx.add(new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from(`crew ${f.kind} ${f.id}`) })) // satisfies required-memo accounts
    if (f.amount > 0n) tx.add(createTransferCheckedInstruction(engineAta, mint, dst, kp.publicKey, f.amount, decimals, [], program))
    if (f.burn > 0n) tx.add(createBurnCheckedInstruction(engineAta, mint, kp.publicKey, f.burn, decimals, [], program))
    tx.sign(kp)
    const sim = await c.simulateTransaction(tx)
    if (sim.value.err) { // would fail on chain: never pay fees for it; a destination that always fails ends in quarantine
      f.simFails = (f.simFails || 0) + 1
      this.log(`payout ${f.rid} simulation failed ${JSON.stringify(sim.value.err)} (${f.simFails})`)
      if (f.simFails >= 20) this.quarantine(f, 'simulation keeps failing')
      return
    }
    const sig = sigOf(tx), lvbh = tx.lastValidBlockHeight
    this.ledger.append({ type: 'pay-signed', rid: f.rid, sig, lvbh }) // write-ahead
    Object.assign(f, { sig, lvbh, outcome: null, signedAt: Date.now() })
    const k = await sendSafe(tx, lvbh, { log: this.log })
    this.ledger.append({ type: 'pay-result', rid: f.rid, sig, outcome: k }); f.outcome = k
    if (k === 'failed') f.fails = (f.fails || 0) + 1
    if (k === 'confirmed') this.log(`${f.kind} ${f.rid} landed ${sig}`)
  }

  view() {
    const d = [...this.dues.values()]
    const sum = (xs, k) => xs.reduce((a, f) => a + f[k], 0n)
    const done = d.filter((f) => f.outcome === 'confirmed')
    const settles = done.filter((f) => f.kind === 'settle'), refunds = done.filter((f) => f.kind === 'refund')
    const dec = this.mintInfo?.decimals ?? 6
    const perAgent = {}
    for (const f of settles) perAgent[f.agent] = (perAgent[f.agent] || 0n) + f.amount
    return {
      paidJobs: [...this.orders.values()].filter((o) => ['paid', 'done', 'refund'].includes(o.status)).length,
      toAgents: this.ui(sum(settles, 'amount'), dec), burned: this.ui(sum(settles, 'burn'), dec), refunded: this.ui(sum(refunds, 'amount'), dec),
      perAgent: Object.fromEntries(Object.entries(perAgent).map(([k, v]) => [k, this.ui(v, dec)])),
      due: d.filter((f) => f.outcome !== 'confirmed' && f.outcome !== 'ambiguous').length,
      quarantined: d.filter((f) => f.outcome === 'ambiguous').length,
      recent: done.sort((a, b) => (b.signedAt || 0) - (a.signedAt || 0)).slice(0, 12).map((f) => ({ kind: f.kind, agent: f.agent || null, amount: this.ui(f.amount, dec), burn: this.ui(f.burn, dec), sig: f.sig, at: f.signedAt })),
    }
  }
}
