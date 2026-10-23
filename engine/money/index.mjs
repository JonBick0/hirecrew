// Wires the money engine into the server. Loops always run (so payments that arrive are always seen and owed payouts
// are always recorded); anything that SENDS money is behind its own env flag (see config.mjs).
import express from 'express'
import path from 'node:path'
import { Ledger } from './ledger.mjs'
import { Escrow } from './escrow.mjs'
import { Treasury } from './treasury.mjs'
import { cfg, flags, DATA, keypair, pubkey } from './config.mjs'

export function setupMoney(app, { agentIds, onPaid, log = (...a) => console.log('[money]', ...a) }) {
  const engine = pubkey('engine')
  const agents = Object.fromEntries(agentIds.map((id) => [id, pubkey(id)]))
  if (!engine) { log('no keys/engine.json, money engine off'); return null }
  const ledger = new Ledger(path.join(DATA, 'money.jsonl'))
  const escrow = new Escrow(ledger, { engine, agents, log, onPaid })
  const tr = new Treasury(ledger, null, { log })
  log('engine', engine, 'agents', JSON.stringify(agents), 'flags', JSON.stringify(flags), cfg.mint ? 'mint ' + cfg.mint : 'no CREW_MINT yet')

  const guard = (fn, name) => async () => { try { await fn() } catch (e) { log(name, e.message) } }
  setInterval(guard(() => escrow.scan(), 'scan'), 5e3)
  setInterval(guard(() => escrow.pay(keypair('engine')), 'payouts'), 15e3)
  setInterval(guard(() => tr.run(keypair('engine')), 'treasury'), 5 * 60e3)
  // stale-lock watchdog: far above any real run. The payout lock is never forced (each due also has its own busy flag).
  // (each send is bounded at ~150 s + 30 s RPC timeouts)
  setInterval(() => {
    for (const [o, k, s] of [[tr, 'busy', 'runStarted'], [escrow, 'scanning', 'scanStarted']])
      if (o[k] && Date.now() - o[s] > 30 * 60e3) { log(k, 'lock stale, released'); o[k] = false }
  }, 60e3)

  app.get('/api/money', (_q, r) => r.json({
    open: escrow.open(), flags, mint: cfg.mint || null, ticker: cfg.ticker, engine, agents, prices: cfg.usd, agentBps: cfg.agentBps,
    escrow: escrow.view(), treasury: tr.view(),
  }))
  app.get('/api/orders/:id', (q, r) => {
    const o = escrow.orders.get(q.params.id)
    if (!o) return r.status(404).json({ error: 'not found' })
    r.json(escrow.publicOrder(o))
  })
  app.post('/api/orders/:id/tx', express.json({ limit: '2kb' }), async (q, r) => {
    try { r.json({ transaction: await escrow.buildTx(q.params.id, String(q.body?.account || '')) }) } catch (e) { r.status(400).json({ error: e.message }) }
  })
  return escrow
}
