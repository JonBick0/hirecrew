// Reflex eval: run N jobs per seed with a fixed "drive" intent (no model calls)
// and report completion rate + time. Change reflex.mjs, rerun, compare numbers.
//   node evals/reflex-eval.mjs [jobsPerSeed=4]
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { BrowserRig } from '../engine/rig.mjs'
import { Reflex, decode } from '../engine/reflex.mjs'
import { randomJob } from '../engine/jobs.mjs'

const html = readFileSync(new URL('../standin/index.html', import.meta.url))
const srv = createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(html) }).listen(0)
const port = srv.address().port
const per = Number(process.argv[2] || 4)
const seeds = [7, 19, 31]
const results = []
await Promise.all(seeds.map(async (seed) => {
  const rig = new BrowserRig('e' + seed, `http://127.0.0.1:${port}/?seed=${seed}`)
  await rig.start()
  for (let i = 0; i < per; i++) {
    const j = randomJob('e', i)
    await rig.startJob({ id: j.id + seed, kind: j.kind, title: j.title, stops: j.stops, limit: j.limit })
    const reflex = new Reflex()
    const intent = { mode: j.kind === 'escape' ? 'flee' : 'drive', maxSpeed: 0.85 }
    let end = null
    const t0 = Date.now()
    while (!end && Date.now() - t0 < (j.limit + 10) * 1000) {
      await new Promise((r) => setTimeout(r, 100))
      if (!rig.frame) continue
      const { pad } = reflex.tick(decode(rig.frame), intent, Date.now())
      await rig.setPad(pad)
      const ref = await rig.referee()
      end = ref?.events.find((e) => e.type === 'job_end')
    }
    results.push({ seed, kind: j.kind, ok: !!end?.ok, why: end?.why || (end ? '' : 'no end'), secs: end?.secs })
    console.log(seed, j.kind, end?.ok ? 'OK' : 'FAIL', end?.why || '', end?.secs ?? '')
    await rig.setPad({ lx: 0, rt: 0, lt: 0, a: false })
    await new Promise((r) => setTimeout(r, 1500))
  }
}))
const ok = results.filter((r) => r.ok)
console.log(`\n${ok.length}/${results.length} complete, avg ${(ok.reduce((s, r) => s + r.secs, 0) / (ok.length || 1)).toFixed(1)}s`)
process.exit(0)
