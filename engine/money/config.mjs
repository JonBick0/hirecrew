// Money config. Every flag is OFF unless its env var is exactly "1". Never default a flag on in code.
import fs from 'node:fs'
import path from 'node:path'
import bs58 from 'bs58'
import { Keypair } from '@solana/web3.js'

const on = (k) => process.env[k] === '1'
const num = (k, d) => (process.env[k] != null && process.env[k] !== '' && Number.isFinite(+process.env[k]) ? +process.env[k] : d)

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..')
export const DATA = process.env.DATA_DIR || path.join(ROOT, 'data')
export const KEYS = process.env.KEYS_DIR || path.join(ROOT, 'keys')

export const flags = {
  payments: on('PAYMENTS_ENABLED'), // hires cost $CREW (otherwise free test credits)
  payouts: on('PAYOUTS_ENABLED'),   // send agent pay, burns and refunds (otherwise they queue as "due")
  claim: on('CLAIM_ENABLED'),       // claim $CREW creator fees into the engine
  buyback: on('BUYBACK_ENABLED'),   // swap claimed fees above the run budget into $CREW and burn it
}

export const cfg = {
  mint: process.env.CREW_MINT || '',
  ticker: 'CREW',
  // job prices in USD, quoted in $CREW at the live price when the hire is made
  usd: { run: num('PRICE_RUN_USD', 1), deliver: num('PRICE_DELIVER_USD', 2.5), tour: num('PRICE_TOUR_USD', 3), escape: num('PRICE_ESCAPE_USD', 4) },
  agentBps: num('AGENT_BPS', 7000), // the rest of a paid job is burned
  orderTtlMs: num('ORDER_TTL_MIN', 15) * 60e3,
  lateGraceMs: 120e3,
  watchMs: 24 * 3600e3, // a reference is honoured (queued or refunded) this long after its order expires
  reserveLamports: Math.round(num('ENGINE_RESERVE_SOL', 0.03) * 1e9),
  // creator fees: this share funds the house rigs + models, the rest buys back and burns
  runBps: num('RUN_BUDGET_BPS', 5000),
  buybackMinLamports: Math.round(num('BUYBACK_MIN_SOL', 0.05) * 1e9),
  buybackMaxLamports: Math.round(num('BUYBACK_MAX_SOL', 2) * 1e9),
  slippageBps: num('BUYBACK_SLIPPAGE_BPS', 300),
}

const cache = {}
export function keypair(name) {
  if (cache[name]) return cache[name]
  const raw = JSON.parse(fs.readFileSync(path.join(KEYS, `${name}.json`), 'utf8'))
  return (cache[name] = Keypair.fromSecretKey(Uint8Array.from(raw)))
}
export function pubkey(name) { try { return keypair(name).publicKey.toBase58() } catch { return '' } }
export const isPubkey = (s) => { try { return typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) && bs58.decode(s).length === 32 } catch { return false } }
