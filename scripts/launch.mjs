// Launch $CREW on pump.fun FROM THE ENGINE WALLET (creator = fee payer = engine, so creator fees claim to it).
//   node scripts/launch.mjs              → builds + SIMULATES the create tx, sends nothing
//   node scripts/launch.mjs --send       → sends it (needs the engine funded: ~0.03 SOL + any dev buy)
//   DEV_BUY_SOL=0.5 node scripts/launch.mjs --send
// Prints the mint. Then set CREW_MINT=<mint> in .env and `pm2 restart crew --update-env`.
import '../engine/env.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import BN from 'bn.js'
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from '@solana/web3.js'
import { connection, sendSafe, sigOf } from '../engine/money/chain.mjs'
import { keypair, ROOT, DATA } from '../engine/money/config.mjs'
import { Ledger } from '../engine/money/ledger.mjs'
const { PUMP_SDK, OnlinePumpSdk, getBuyTokenAmountFromSolAmount } = createRequire(import.meta.url)('@pump-fun/pump-sdk')

const SEND = process.argv.includes('--send')
const DEV = Number(process.env.DEV_BUY_SOL || 0)
const meta = {
  name: 'crew', symbol: 'CREW', website: 'https://hirecrew.fun', twitter: 'https://x.com/hirecrewfun',
  description: 'Hire an AI crew for GTA 6. Agents watch the screen, hold the controller and take your job live. Paid in $CREW: 70% to the agent, 30% burned. Independent project, not affiliated with Rockstar Games.',
}
const engine = keypair('engine')
const c = connection()
const launches = new Ledger(path.join(DATA, 'launch.jsonl'))
for (const r of launches.read()) if (r.type === 'sent' && r.outcome === 'confirmed') { console.log('already launched:', r.mint); process.exit(0) }

const bal = await c.getBalance(engine.publicKey)
console.log(`engine ${engine.publicKey.toBase58()} holds ${bal / 1e9} SOL, dev buy ${DEV} SOL`)

// metadata: pump.fun's uploader
const img = fs.readFileSync(path.join(ROOT, 'launch/out/logo-500.png'))
const fd = new FormData()
fd.append('file', new Blob([img], { type: 'image/png' }), 'logo.png')
for (const k of ['name', 'symbol', 'description', 'twitter', 'website']) fd.append(k, meta[k])
fd.append('showName', 'true')
const up = await fetch('https://pump.fun/api/ipfs', { method: 'POST', body: fd, headers: { origin: 'https://pump.fun', referer: 'https://pump.fun/create', 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30e3) })
let uri = (await up.json().catch(() => null))?.metadataUri
if (!uri) {
  // pump.fun's uploader refused: host the metadata ourselves on hirecrew.fun (site/meta, served by the engine)
  console.log(`pump.fun ipfs ${up.status}, self-hosting metadata`)
  fs.writeFileSync(path.join(ROOT, 'site/meta/crew.json'), JSON.stringify({ name: meta.name, symbol: meta.symbol, description: meta.description, image: 'https://hirecrew.fun/meta/crew.png', showName: true, createdOn: 'https://pump.fun', website: meta.website, twitter: meta.twitter }))
  uri = 'https://hirecrew.fun/meta/crew.json'
}
console.log('metadata', uri)

const mint = Keypair.generate()
const online = new OnlinePumpSdk(c)
const [global, feeConfig] = await Promise.all([online.fetchGlobal(), online.fetchFeeConfig().catch(() => null)])
const creator = !SEND && process.env.SIM_AS ? new PublicKey(process.env.SIM_AS) : engine.publicKey // SIM_AS: dry-run as a funded wallet
const ixs = [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }), ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })]
if (DEV > 0) {
  const solAmount = new BN(Math.round(DEV * 1e9))
  const amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: null, bondingCurve: null, amount: solAmount, quoteMint: new PublicKey('So11111111111111111111111111111111111111112') })
  ixs.push(...(await PUMP_SDK.createV2AndBuyInstructions({ global, mint: mint.publicKey, name: meta.name, symbol: meta.symbol, uri, creator, user: creator, amount, solAmount, mayhemMode: false })))
} else ixs.push(await PUMP_SDK.createV2Instruction({ mint: mint.publicKey, name: meta.name, symbol: meta.symbol, uri, creator, user: creator, mayhemMode: false }))
const { blockhash, lastValidBlockHeight } = await c.getLatestBlockhash('confirmed')
const tx = new VersionedTransaction(new TransactionMessage({ payerKey: creator, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message())
tx.sign(creator.equals(engine.publicKey) ? [engine, mint] : [mint])
const sim = await c.simulateTransaction(tx, { sigVerify: false })
console.log('simulation', sim.value.err ? 'FAILED ' + JSON.stringify(sim.value.err) : 'ok', `${sim.value.unitsConsumed} units`)
if (sim.value.err) { console.log((sim.value.logs || []).slice(-8).join('\n')); process.exit(1) }
if (!SEND) { console.log(`dry run. mint would be ${mint.publicKey.toBase58()} (a new one is made on --send)`); process.exit(0) }

const sig = sigOf(tx)
launches.append({ type: 'signed', mint: mint.publicKey.toBase58(), sig, lvbh: lastValidBlockHeight, mintSecret: Array.from(mint.secretKey) })
const outcome = await sendSafe(tx, lastValidBlockHeight, { log: console.log })
launches.append({ type: 'sent', mint: mint.publicKey.toBase58(), sig, outcome })
console.log(outcome === 'confirmed' ? `LAUNCHED $CREW ${mint.publicKey.toBase58()}\nhttps://pump.fun/coin/${mint.publicKey.toBase58()}\nhttps://solscan.io/tx/${sig}` : `launch ${outcome}: check https://solscan.io/tx/${sig} before trying again`)
process.exit(outcome === 'confirmed' ? 0 : 1)
