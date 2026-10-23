import { createServer } from 'node:http'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { BrowserRig } from '../engine/rig.mjs'
import { Reflex, decode } from '../engine/reflex.mjs'
const out = process.argv[2]; mkdirSync(out, { recursive: true })
// serve standin/ (the page plus its vendored three.js)
const DIR = new URL('../standin/', import.meta.url)
const srv = createServer((q, r) => {
  const p = q.url.split('?')[0].replace(/^\/+/, '') || 'index.html'
  if (p.includes('..')) { r.statusCode = 400; return r.end() }
  try { r.setHeader('content-type', p.endsWith('.js') ? 'text/javascript' : 'text/html'); r.end(readFileSync(new URL(p, DIR))) } catch { r.statusCode = 404; r.end() }
}).listen(0)
const rig = new BrowserRig('t', `http://127.0.0.1:${srv.address().port}/?seed=7`)
await rig.start()
await rig.startJob({ id: 'x', kind: 'run', title: 'Drive to the bank', stops: ['the bank'], limit: 120 })
const reflex = new Reflex(); let i = 0; const t0 = Date.now()
while (Date.now() - t0 < 30000) {
  await new Promise((r) => setTimeout(r, 100))
  if (!rig.frame) continue
  const { pad, seen, act } = reflex.tick(decode(rig.frame), { mode: 'drive', maxSpeed: .85 }, Date.now())
  await rig.setPad(pad)
  if (i++ % 10 === 0) { writeFileSync(`${out}/f${String(i).padStart(4, '0')}.jpg`, rig.frame); console.log(i, act, JSON.stringify({ r: seen.route, sp: seen.speed.toFixed(2), pad })) }
}
process.exit(0)
