// crew engine: agents, rigs, job queue, live video, referee ledger.
// Hires are paid in $CREW through the escrow (engine/money) once CREW_MINT is set and PAYMENTS_ENABLED=1;
// until then they are free test credits. House jobs are always free.
import './env.mjs'
import express from 'express'
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserRig } from './rig.mjs'
import { Reflex, decode } from './reflex.mjs'
import { think } from './brain.mjs'
import { KINDS, PLACES, makeJob, randomJob } from './jobs.mjs'
import { setupMoney } from './money/index.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.PORT || 3170)
const DATA = process.env.DATA_DIR || join(ROOT, 'data')
const BRAIN_EVERY_MS = Number(process.env.BRAIN_EVERY_MS || 7000)
const HOUSE_JOBS = process.env.HOUSE_JOBS !== '0'
mkdirSync(DATA, { recursive: true })

const AGENTS = [
  { id: 'mako', name: 'Mako', model: process.env.MAKO_MODEL || 'claude-haiku-5-5', seed: 7,
    tag: 'Fast hands. Takes the gap.', persona: 'You are a confident, quick getaway driver. You like speed but you hate getting busted. Keep lines short and cool.' },
  { id: 'juno', name: 'Juno', model: process.env.JUNO_MODEL || 'claude-sonnet-5-5', seed: 19,
    tag: 'Clean lines. Never late.', persona: 'You are a precise, calm professional driver. You value a clean run over a fast one. Keep lines short and dry.' },
]

// ---- persisted state (atomic writes)
const STATE_FILE = join(DATA, 'state.json')
let S = { n: 0, jobs: [], log: [], stats: {} }
try { if (existsSync(STATE_FILE)) S = { ...S, ...JSON.parse(readFileSync(STATE_FILE, 'utf8')) } } catch (e) { console.error('state load failed, starting clean', e.message) }
for (const j of S.jobs) if (j.status === 'running') j.status = 'void'   // a restart voids in-flight runs, never replays them
let dirty = false
const save = () => { dirty = true }
setInterval(() => {
  if (!dirty) return
  dirty = false
  try { writeFileSync(STATE_FILE + '.tmp', JSON.stringify(S)); renameSync(STATE_FILE + '.tmp', STATE_FILE) } catch (e) { console.error('save failed', e.message) }
}, 1000)
const log = (agent, kind, text, extra = {}) => {
  S.log.push({ t: Date.now(), agent, kind, text, ...extra })
  if (S.log.length > 400) S.log.splice(0, S.log.length - 400)
  save(); broadcast({ type: 'log', entry: S.log[S.log.length - 1] })
}

// ---- live viewers (SSE) — house jobs only run while someone is watching
const clients = new Set()
let lastViewer = 0
function broadcast(msg) { const s = `data: ${JSON.stringify(msg)}\n\n`; for (const c of clients) c.write(s) }

// ---- agents
const live = {}
for (const a of AGENTS) {
  S.stats[a.id] ||= { done: 0, failed: 0, earned: 0, secs: 0 }
  live[a.id] = { ...a, rig: new BrowserRig(a.id, `http://127.0.0.1:${PORT}/standin/?seed=${a.seed}`), reflex: new Reflex(),
    intent: { mode: 'stop', maxSpeed: 0.8 }, job: null, history: [], thinking: false, lastThink: 0, act: 'idle', seen: null, say: '', crashes: 0 }
}

function nextJob(id) { return S.jobs.find((j) => j.agent === id && j.status === 'queued') }

async function startNext(A) {
  const j = nextJob(A.id)
  if (!j) return
  j.status = 'running'; j.startedAt = Date.now(); A.job = j; A.history = []; A.crashes = 0; A.say = ''
  A.intent = { mode: j.kind === 'escape' ? 'flee' : 'drive', maxSpeed: 0.85 }
  try { await A.rig.startJob({ id: j.id, kind: j.kind, title: j.title, stops: j.stops, limit: j.limit }) }
  catch (e) { j.status = 'queued'; delete j.startedAt; A.job = null; save(); throw e }   // back in line, agent free
  log(A.id, 'job', `took job ${j.id} from @${j.by}: ${j.title}`, { job: j.id })
  A.lastThink = 0
  save()
}

async function brainTick(A) {
  if (!A.job || A.thinking || !A.rig.frame || Date.now() - A.lastThink < BRAIN_EVERY_MS) return
  A.thinking = true; A.lastThink = Date.now()
  const jobId = A.job.id   // a slow answer for a finished job is dropped
  try {
    const d = await think(A, A.rig.frame, { job: A.job?.title, speed: A.seen?.speed || 0, route: !!A.seen?.route, cops: A.seen?.cops || 0, crashes: A.crashes, history: A.history })
    if (d && A.job && A.job.id === jobId) {
      A.intent = { mode: d.mode, maxSpeed: d.maxSpeed }; A.say = d.say
      A.history.push(`${d.mode}@${d.maxSpeed.toFixed(1)}`); if (A.history.length > 4) A.history.shift()
      log(A.id, 'think', d.say || d.mode, { mode: d.mode, maxSpeed: d.maxSpeed, ms: d.ms })
    }
  } finally { A.thinking = false }
}

// a job the referee never closes (page crash, reload) fails on the server clock, so a paid job always ends
function endJob(A, ok, secs, why) {
  const j = A.job, st = S.stats[A.id]
  if (j.orderId) escrow?.result(j.orderId, ok, ok ? null : why)   // ledger first, then state
  j.status = ok ? 'done' : 'failed'; j.secs = secs; j.why = why; j.endedAt = Date.now()
  if (ok) { st.done++; st.earned += j.price } else st.failed++
  st.secs += secs
  log(A.id, 'result', ok ? `job ${j.id} complete in ${secs}s` : `job ${j.id} failed (${why})`, { job: j.id, ok })
  A.job = null; A.intent = { mode: 'stop', maxSpeed: 0.5 }; A.say = ''
  save()
}
function watchdog(A) {
  const j = A.job
  if (j && Date.now() - j.startedAt > (j.limit + 60) * 1000) endJob(A, false, Math.round((Date.now() - j.startedAt) / 1000), 'timeout')
}

async function refereeTick(A) {
  watchdog(A)
  const r = await A.rig.referee()
  if (!r) return
  for (const e of r.events) {
    if (e.type === 'crash') A.crashes++
    if (e.type === 'stop_reached') log(A.id, 'ref', `reached ${e.name}`)
    if (e.type === 'ped_hit') log(A.id, 'ref', 'clipped a pedestrian, wanted level up')
    if (e.type === 'lost_cops') log(A.id, 'ref', 'lost the police')
    if (e.type === 'busted') log(A.id, 'ref', 'busted')
    if (e.type === 'job_end' && A.job && e.id === A.job.id) endJob(A, e.ok, e.secs, e.why)
  }
}

function controlLoop(A) {
  // fast clock: never awaits the brain
  setInterval(async () => {
    if (!A.rig.frame) return
    let img
    try { img = decode(A.rig.frame) } catch { return }
    const intent = A.job ? A.intent : { mode: 'stop', maxSpeed: 0 }
    const { pad, seen, act } = A.reflex.tick(img, intent, Date.now())
    A.seen = seen; A.act = A.job ? act : 'idle'; A.pad = pad
    await A.rig.setPad(pad)
  }, 100)
  setInterval(() => refereeTick(A).catch((e) => { watchdog(A); console.error('referee', e.message) }), 500)
  setInterval(() => { brainTick(A).catch((e) => console.error('brain', e.message)) }, 500)
  setInterval(() => {
    if (A.job || A.starting || !A.rig.page || !A.rig.frame) return   // only hand out jobs to a rig that is up
    if (!nextJob(A.id) && HOUSE_JOBS && Date.now() - lastViewer < 120000 && Date.now() - (A.idleSince ||= Date.now()) > 4000) {
      S.jobs.push(randomJob(A.id, ++S.n)); save()
    }
    if (nextJob(A.id)) { A.idleSince = 0; A.starting = true; startNext(A).catch((e) => console.error('start', e.message)).finally(() => { A.starting = false }) }
  }, 1000)
}

// ---- http
const app = express()
app.use(express.json({ limit: '8kb' }))
app.use('/standin', express.static(join(ROOT, 'standin')))
app.use(express.static(join(ROOT, 'site'), { extensions: ['html'] }))

const publicAgent = (A) => ({
  id: A.id, name: A.name, model: A.model, tag: A.tag, act: A.act, mode: A.job ? A.intent.mode : 'idle', say: A.say,
  speed: A.seen?.speed || 0, job: A.job && { id: A.job.id, title: A.job.title, by: A.job.by, kind: A.job.kind, startedAt: A.job.startedAt },
  queue: S.jobs.filter((j) => j.agent === A.id && j.status === 'queued').length, stats: S.stats[A.id],
  pad: A.pad || null,
})
app.get('/api/state', (req, res) => {
  res.json({
    mode: escrow?.open() ? 'live' : 'preview', agents: Object.values(live).map(publicAgent), kinds: KINDS, places: PLACES,
    jobs: S.jobs.slice(-40).reverse(), log: S.log.slice(-80),
  })
})
const ipOf = (q) => (q.headers['x-forwarded-for'] || '').split(',').pop().trim() || q.socket.remoteAddress
const hits = new Map()
const limited = (key, n, ms) => {
  const now = Date.now(), recent = (hits.get(key) || []).filter((t) => now - t < ms)
  if (recent.length >= n) return true
  recent.push(now); hits.set(key, recent); if (hits.size > 50000) hits.clear()
  return false
}
app.post('/api/jobs', async (req, res) => {
  const { agent, kind, stops, by } = req.body || {}
  if (!live[agent]) return res.status(400).json({ error: 'unknown agent' })
  if (!KINDS[kind]) return res.status(400).json({ error: 'unknown job' })
  const queued = S.jobs.filter((j) => j.agent === agent && j.status === 'queued' && j.by !== 'house')
  if (queued.length + (escrow?.openFor(agent) || 0) >= 6) return res.status(429).json({ error: 'queue full, try the other agent' })
  if (escrow?.open()) {
    // paid hire: the job is queued only when the $CREW payment lands (escrow.onPaid)
    if (limited('hire:' + ipOf(req), 20, 3600e3)) return res.status(429).json({ error: 'too many hires, try later' })
    try {
      const spec = makeJob({ kind, stops, by, agent }, 0)
      const order = await escrow.create({ agent, kind, stops: spec.stops, by: spec.by })
      return res.json({ ok: true, pay: order })
    } catch (e) { return res.status(400).json({ error: e.message }) }
  }
  // drop pending house jobs so a hirer goes first
  S.jobs = S.jobs.filter((j) => !(j.agent === agent && j.status === 'queued' && j.by === 'house'))
  const j = makeJob({ kind, stops, by, agent }, ++S.n)
  S.jobs.push(j); if (S.jobs.length > 500) S.jobs.splice(0, S.jobs.length - 500)
  log(agent, 'hire', `@${j.by} hired ${live[agent].name}: ${j.title}`, { job: j.id })
  save()
  res.json({ ok: true, job: j, ahead: S.jobs.filter((x) => x.agent === agent && x.status === 'queued').length - 1 + (live[agent].job ? 1 : 0) })
})
app.get('/api/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
  res.flushHeaders(); res.write('retry: 3000\n\n')
  clients.add(res); lastViewer = Date.now()
  req.on('close', () => clients.delete(res))
})
setInterval(() => {
  if (clients.size) lastViewer = Date.now()
  broadcast({ type: 'agents', agents: Object.values(live).map(publicAgent) })
}, 1000)
setInterval(() => { for (const c of clients) c.write(': ping\n\n') }, 15000)

// MJPEG live view, capped at ~8 fps per viewer
app.get('/live/:id.mjpg', (req, res) => {
  const A = live[req.params.id]
  if (!A) return res.sendStatus(404)
  res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=f', 'Cache-Control': 'no-cache, no-store', Connection: 'close', 'X-Accel-Buffering': 'no' })
  lastViewer = Date.now()
  let last = 0
  const send = (buf) => {
    const now = Date.now(); if (now - last < 120) return; last = now
    if (res.writableLength > 512 * 1024) return   // slow phone: drop frames, don't buffer
    res.write(`--f\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`); res.write(buf); res.write('\r\n')
  }
  if (A.rig.frame) send(A.rig.frame)
  const off = A.rig.onFrame(send)
  const keep = setInterval(() => { lastViewer = Date.now() }, 5000)
  req.on('close', () => { off(); clearInterval(keep) })
})
app.get('/live/:id.jpg', (req, res) => {
  const A = live[req.params.id]
  if (!A?.rig.frame) return res.sendStatus(404)
  res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' }).send(A.rig.frame)
})
app.get('/health', (req, res) => res.json({ ok: true, agents: Object.values(live).map((A) => ({ id: A.id, frameAge: Date.now() - A.rig.frameAt })) }))

function queuePaid(o) {
  if (S.jobs.some((j) => j.orderId === o.id)) return
  S.jobs = S.jobs.filter((j) => !(j.agent === o.job.agent && j.status === 'queued' && j.by === 'house'))
  const j = { ...makeJob(o.job, ++S.n), orderId: o.id, paid: true, usd: o.usd }
  S.jobs.push(j); if (S.jobs.length > 500) S.jobs.splice(0, S.jobs.length - 500)
  o.jobId = j.id
  log(o.job.agent, 'hire', `@${j.by} paid ${live[o.job.agent].name} for: ${j.title}`, { job: j.id })
  save()
}
const escrow = setupMoney(app, { agentIds: AGENTS.map((a) => a.id), onPaid: queuePaid })
if (escrow) {
  // boot reconcile: a paid order whose job is not waiting in the queue (voided by the restart, or lost before the
  // state file was written) is refunded. Exactly once: result() is a no-op for orders that already have one.
  for (const o of escrow.unresolved()) {
    const j = S.jobs.find((x) => x.orderId === o.id)
    if (j && j.status === 'queued') { o.jobId = j.id; continue }
    escrow.result(o.id, false, j ? 'void: server restarted mid-job' : 'void: job lost on restart')
  }
}

process.on('unhandledRejection', (e) => console.error('unhandledRejection', e))
process.on('uncaughtException', (e) => console.error('uncaughtException', e))

// timers before anything long-lived (boot-order rule)
app.listen(PORT, '127.0.0.1', async () => {
  console.log(`crew engine on :${PORT} (${escrow?.open() ? 'paid hires in $CREW' : 'free test hires'}, house jobs ${HOUSE_JOBS ? 'on' : 'off'})`)
  for (const A of Object.values(live)) {
    controlLoop(A)
    A.rig.start().then(() => console.log(`rig ${A.id} up`)).catch((e) => console.error(`rig ${A.id} failed`, e))
  }
})
