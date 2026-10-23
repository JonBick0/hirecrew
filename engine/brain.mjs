// The slow clock. Every few seconds the agent's model looks at the latest
// frame and decides what the reflex should be doing. It never steers directly:
// a model call takes seconds, and GTA can't be paused for it.
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const MODES = ['drive', 'cautious', 'flee', 'wander', 'stop']
const FRAMES = process.env.FRAMES_DIR || '/tmp/crew-frames'
mkdirSync(FRAMES, { recursive: true })

function runClaude(prompt, model, timeoutMs = 45000) {
  return new Promise((resolve) => {
    const p = spawn('claude', ['-p', '--model', model, '--allowedTools', 'Read', '--output-format', 'text'], {
      cwd: FRAMES, stdio: ['pipe', 'pipe', 'pipe'], env: process.env,
    })
    let out = ''
    const kill = setTimeout(() => { p.kill('SIGKILL'); resolve(null) }, timeoutMs)
    p.stdout.on('data', (d) => (out += d))
    p.on('close', () => { clearTimeout(kill); resolve(out) })
    p.on('error', () => { clearTimeout(kill); resolve(null) })
    p.stdin.end(prompt)   // prompt via stdin, never argv
  })
}

export function parseDecision(text) {
  if (!text) return null
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const j = JSON.parse(m[0])
    const mode = MODES.includes(j.mode) ? j.mode : 'drive'
    const maxSpeed = Math.max(0.15, Math.min(1, Number(j.max_speed) || 0.8))
    const say = String(j.say || '').replace(/\s+/g, ' ').slice(0, 140)
    return { mode, maxSpeed, say }
  } catch { return null }
}

export async function think(agent, frame, ctx) {
  const file = join(FRAMES, `${agent.id}.jpg`)
  writeFileSync(file, frame)
  const prompt = `You are ${agent.name}, an AI agent hired to play an open-world driving game live on stream.
${agent.persona}
Read the image file ${file}. It is the current game frame. The circle bottom-left is a heading-up minimap: a pink line is the GPS route to the objective, red blips are police. The bar bottom-centre is your speed. Stars top-right are your wanted level. The objective is written at the bottom.

Your hirer's job: "${ctx.job || 'none, free roam'}"
Your hands (a fast autopilot) follow the GPS line on their own. You choose what they do next:
- drive: follow the GPS line at max_speed
- cautious: follow it slowly (crowds, tight turns, just crashed)
- flee: police are on you, run from them
- wander: no route, cruise the streets
- stop: job done or nothing to do
Telemetry: speed ${(ctx.speed * 100) | 0}%, gps line ${ctx.route ? 'visible' : 'not visible'}, police blips ${ctx.cops}, crashes so far ${ctx.crashes}.
Your last calls: ${ctx.history.join(' | ') || 'none'}

Reply with ONE JSON object only: {"mode":"drive|cautious|flee|wander|stop","max_speed":0.2-1.0,"say":"one short first-person line for the stream, plain words, no emoji"}`
  const t0 = Date.now()
  const out = await runClaude(prompt, agent.model)
  const d = parseDecision(out)
  return d ? { ...d, ms: Date.now() - t0 } : null
}
