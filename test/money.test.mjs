import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Keypair } from '@solana/web3.js'
import { quote, split, verifyPayment, isDust, Escrow } from '../engine/money/escrow.mjs'
import { Ledger } from '../engine/money/ledger.mjs'

const pk = () => Keypair.generate().publicKey.toBase58()
const MINT = pk(), ENGINE = pk(), PAYER = pk(), REF = pk(), OTHER = pk()
const order = { id: 'o1', ref: REF, amount: '1000000', expiresAt: Date.now() + 60e3, job: { agent: 'mako', kind: 'run', stops: ['the pier'], by: 'x' } }
const bal = (owner, amount, mint = MINT) => ({ owner, mint, uiTokenAmount: { amount: String(amount) } })
function tx({ keys = [{ pubkey: PAYER, signer: true }, { pubkey: REF, signer: false }], pre, post, err = null, blockTime = Math.floor(Date.now() / 1000) }) {
  return { blockTime, meta: { err, preTokenBalances: pre, postTokenBalances: post }, transaction: { message: { accountKeys: keys } } }
}

test('quote rounds up and refuses no price', () => {
  assert.equal(quote(1, 0.001, 6), 1000000000n)
  assert.equal(quote(1, 3, 6), 333334n)
  assert.throws(() => quote(1, 0, 6))
  assert.throws(() => quote(1, NaN, 6))
})

test('split is exact', () => {
  for (const a of [1n, 7n, 999999n, 123456789012345n]) { const s = split(a, 7000); assert.equal(s.agent + s.burn, a) }
  assert.deepEqual(split(1000n, 7000), { agent: 700n, burn: 300n })
})

test('verifyPayment: exact payment', () => {
  const v = verifyPayment(tx({ pre: [bal(PAYER, 5e6), bal(ENGINE, 0)], post: [bal(PAYER, 4e6), bal(ENGINE, 1e6)] }), order, ENGINE, MINT)
  assert.equal(v.ok, true); assert.equal(v.payer, PAYER); assert.equal(v.received, 1000000n); assert.equal(v.excess, 0n)
})
test('verifyPayment: overpay → excess', () => {
  const v = verifyPayment(tx({ pre: [bal(PAYER, 5e6)], post: [bal(PAYER, 2e6), bal(ENGINE, 3e6)] }), order, ENGINE, MINT)
  assert.equal(v.ok, true); assert.equal(v.excess, 2000000n)
})
test('verifyPayment: rejects', () => {
  assert.equal(verifyPayment(tx({ pre: [bal(PAYER, 5e6)], post: [bal(PAYER, 4.5e6), bal(ENGINE, 5e5)] }), order, ENGINE, MINT).reason, 'underpaid')
  assert.equal(verifyPayment(tx({ keys: [{ pubkey: PAYER, signer: true }], pre: [bal(PAYER, 5e6)], post: [bal(PAYER, 4e6), bal(ENGINE, 1e6)] }), order, ENGINE, MINT).reason, 'no reference')
  assert.equal(verifyPayment(tx({ err: { x: 1 }, pre: [], post: [] }), order, ENGINE, MINT).reason, 'tx failed')
  assert.equal(verifyPayment(tx({ pre: [bal(PAYER, 5e6)], post: [bal(PAYER, 4e6), bal(ENGINE, 1e6)], blockTime: Math.floor((order.expiresAt + 600e3) / 1000) }), order, ENGINE, MINT).reason, 'late')
  // a different token sent to the engine counts for nothing
  assert.equal(verifyPayment(tx({ pre: [bal(PAYER, 5e6, OTHER)], post: [bal(PAYER, 4e6, OTHER), bal(ENGINE, 1e6, OTHER)] }), order, ENGINE, MINT).reason, 'nothing received')
})
test('verifyPayment: tokens from a non-signer never count as the payer', () => {
  // engine receives from OTHER (not a signer); signer PAYER lost nothing → no payer, never a refund target
  const v = verifyPayment(tx({ pre: [bal(OTHER, 5e6)], post: [bal(OTHER, 4e6), bal(ENGINE, 1e6)] }), order, ENGINE, MINT)
  assert.equal(v.ok, false); assert.equal(v.reason, 'no payer')
})
test('verifyPayment: received capped at what the payer lost', () => {
  // payer lost 0.4, engine got 1.0 (0.6 from elsewhere in the same tx) → only 0.4 is the payer's, underpaid
  const v = verifyPayment(tx({ keys: [{ pubkey: PAYER, signer: true }, { pubkey: OTHER, signer: true }, { pubkey: REF, signer: false }], pre: [bal(PAYER, 5e6), bal(OTHER, 1e6)], post: [bal(PAYER, 4.6e6), bal(OTHER, 4e5), bal(ENGINE, 1e6)] }), order, ENGINE, MINT)
  assert.equal(v.ok, false); assert.equal(v.reason, 'underpaid'); assert.equal(v.payer, OTHER); assert.equal(v.received, 600000n)
})
test('dust', () => { assert.equal(isDust(49999n, order), true); assert.equal(isDust(50000n, order), false) })

function freshEscrow(dir, onPaid = () => {}) {
  return new Escrow(new Ledger(path.join(dir, 'money.jsonl')), { engine: ENGINE, agents: { mako: pk() }, mint: MINT, log: () => {}, onPaid })
}
test('paid → result settles once, survives restart, never twice', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-'))
  let e = freshEscrow(dir)
  e.ledger.append({ type: 'order', order }); e.rebuild()
  let paid = 0
  e.onPaid = () => paid++
  const t = tx({ pre: [bal(PAYER, 5e6)], post: [bal(PAYER, 4e6), bal(ENGINE, 1e6)] })
  e.apply('SIG1', t); e.apply('SIG1', t)
  assert.equal(paid, 1)
  e.result('o1', true); e.result('o1', false, 'again')
  assert.deepEqual([...e.dues.keys()], ['o1:settle'])
  assert.equal(e.dues.get('o1:settle').amount, 700000n); assert.equal(e.dues.get('o1:settle').burn, 300000n)
  // restart: same dues, same paid sig refused
  e = freshEscrow(dir)
  assert.deepEqual([...e.dues.keys()], ['o1:settle'])
  e.apply('SIG1', t)
  assert.equal(e.unresolved().length, 0)
  // a second payment on the same reference is refunded, not a second job
  e.apply('SIG2', t)
  assert.ok(e.dues.has('SIG2')); assert.equal(e.dues.get('SIG2').to, PAYER)
})
test('failed job refunds the payer in full', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-'))
  const e = freshEscrow(dir)
  e.ledger.append({ type: 'order', order }); e.rebuild()
  e.apply('S', tx({ pre: [bal(PAYER, 5e6)], post: [bal(PAYER, 4e6), bal(ENGINE, 1e6)] }))
  e.result('o1', false, 'busted')
  const f = e.dues.get('o1:refund')
  assert.equal(f.to, PAYER); assert.equal(f.amount, 1000000n); assert.equal(f.burn, 0n)
})
test('signed payout is never re-signed after restart without a result', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-'))
  let e = freshEscrow(dir)
  e.ledger.append({ type: 'order', order }); e.rebuild()
  e.apply('S', tx({ pre: [bal(PAYER, 5e6)], post: [bal(PAYER, 4e6), bal(ENGINE, 1e6)] }))
  e.result('o1', true)
  e.ledger.append({ type: 'pay-signed', rid: 'o1:settle', sig: 'PAYSIG', lvbh: 100 })
  e = freshEscrow(dir)
  const f = e.dues.get('o1:settle')
  assert.equal(f.sig, 'PAYSIG'); assert.equal(f.outcome, null) // pay() rechecks this sig before anything new
  e.ledger.append({ type: 'pay-result', rid: 'o1:settle', sig: 'PAYSIG', outcome: 'ambiguous' })
  e = freshEscrow(dir)
  assert.equal(e.dues.get('o1:settle').outcome, 'ambiguous')
  assert.equal(e.view().quarantined, 1)
})

test('verifyPayment: only the engine $CREW account counts, not other engine-owned accounts', () => {
  const ATA = pk(), SIDE = pk()
  const keys = [{ pubkey: PAYER, signer: true }, { pubkey: REF, signer: false }, { pubkey: ATA, signer: false }, { pubkey: SIDE, signer: false }]
  const b = (owner, amount, accountIndex) => ({ ...bal(owner, amount), accountIndex })
  // 1.0 lands in an engine-owned side account, only 0.1 in the real ATA → underpaid by what the ATA got
  const t = tx({ keys, pre: [b(PAYER, 5e6, 0), b(ENGINE, 0, 2), b(ENGINE, 0, 3)], post: [b(PAYER, 3.9e6, 0), b(ENGINE, 1e5, 2), b(ENGINE, 1e6, 3)] })
  const v = verifyPayment(t, order, ENGINE, MINT, ATA)
  assert.equal(v.ok, false); assert.equal(v.reason, 'underpaid'); assert.equal(v.received, 100000n)
})
test('payments stay closed when an agent key is missing', () => {
  const e = new Escrow(new Ledger(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crew-')), 'm.jsonl')), { engine: ENGINE, agents: { mako: '' }, mint: MINT, log: () => {} })
  assert.equal(e.open(), false)
})
