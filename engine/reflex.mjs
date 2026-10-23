// The fast clock. Reads raw video frames (pixels only, no game state) and turns
// the brain's current intent into controller input ~10x a second.
//
// It reads the same three things a human glances at: the GPS line on the
// heading-up minimap, the red police blips on it, and the speed bar. On GTA 6
// the HUD coordinates change; the logic does not (GTA V's minimap is also
// heading-up with a coloured GPS route, which is what this mirrors).
import jpeg from 'jpeg-js'

export const HUD = {
  minimap: { x: 112, y: 428, r: 92 },
  speedBar: { x: 220, y: 510, w: 160 },
}

const LOOK = 24
const isRoute = (r, g, b) => r > 170 && g < 130 && b > 80 && r - g > 90
const isCop = (r, g, b) => r > 190 && g < 90 && b < 90
const isRoad = (r, g, b) => Math.abs(r - g) < 14 && Math.abs(g - b) < 14 && r > 70 && r < 120

export function decode(buf) {
  return jpeg.decode(buf, { useTArray: true, formatAsRGBA: false })
}

// angle 0 = straight ahead (up on the minimap), positive = right
export function readFrame(img) {
  const { width, data } = img
  const px = (x, y) => { const i = ((y | 0) * width + (x | 0)) * 3; return [data[i], data[i + 1], data[i + 2]] }
  const { x: mx, y: my } = HUD.minimap
  // trace the GPS line outward from the car ring by ring, staying on the same
  // branch, and aim at the point ~LOOK px out (a few car lengths ahead)
  const cops = [], roads = [], path = []
  let route = null, prev = null, aim = null
  for (let r = 8; r <= 64; r += 4) {
    const hits = []
    for (let a = 0; a < 360; a += 2) {
      const t = a * Math.PI / 180, [R, G, B] = px(mx + Math.sin(t) * r, my - Math.cos(t) * r)
      const tt = t > Math.PI ? t - 2 * Math.PI : t
      if (isRoute(R, G, B)) hits.push(tt)
      if (r === 40 && isRoad(R, G, B)) roads.push(tt)
      if (r >= 28 && isCop(R, G, B)) cops.push(tt)
    }
    if (!hits.length) { if (prev !== null && r > LOOK) continue; else continue }
    // group contiguous hits into blobs, take the blob nearest the previous ring's angle
    hits.sort((a, b) => a - b)
    const blobs = []; let cur = [hits[0]]
    for (let i = 1; i < hits.length; i++) { if (hits[i] - hits[i - 1] < 0.12) cur.push(hits[i]); else { blobs.push(cur); cur = [hits[i]] } }
    blobs.push(cur)
    if (blobs.length > 1 && blobs[0][0] < -Math.PI + 0.13 && blobs[blobs.length - 1].at(-1) > Math.PI - 0.13) blobs[0] = blobs.pop().concat(blobs[0].map((x) => x + 2 * Math.PI))
    const centers = blobs.map((b) => { const c = b.reduce((s, x) => s + x, 0) / b.length; return c > Math.PI ? c - 2 * Math.PI : c })
    const d = (x, y) => Math.abs(Math.atan2(Math.sin(x - y), Math.cos(x - y)))
    const pick = prev === null ? centers.reduce((a, b) => (d(a, 0) < d(b, 0) ? a : b)) : centers.reduce((a, b) => (d(a, prev) < d(b, prev) ? a : b))
    if (prev !== null && d(pick, prev) > 1.4) continue   // jumped to another branch
    prev = pick
    path.push({ angle: pick, radius: r })
    if (r >= LOOK && aim === null) aim = { angle: pick, radius: r }
  }
  if (prev !== null) route = aim || { angle: prev, radius: 0 }
  let bar = 0
  const { x: bx, y: by, w: bw } = HUD.speedBar
  for (let x = bx; x < bx + bw; x++) { const [R, G, B] = px(x, by); if (R > 200 && G > 200 && B > 200) bar++ }
  const copAngle = cops.length ? Math.atan2(cops.reduce((s, t) => s + Math.sin(t), 0), cops.reduce((s, t) => s + Math.cos(t), 0)) : null
  return { route, path, speed: bar / bw, cops: cops.length, copAngle, roads }
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))

// Where on the GPS line to aim. A fixed far point cuts every corner straight through the
// corner building (the route bends, the far point lands diagonally across the block), so the
// lookahead shrinks at low speed and whenever the line bends before it.
const LOOK_MIN = 12, LOOK_MAX = 32, BEND = 0.6
export function followAngle(seen) {
  const path = seen.path?.length ? seen.path : (seen.route ? [seen.route] : [])
  if (!path.length) return null
  const look = LOOK_MIN + (LOOK_MAX - LOOK_MIN) * clamp(seen.speed, 0, 1)
  let pick = path[0]
  for (const p of path) {
    if (Math.abs(p.angle - path[0].angle) > BEND) break   // the line turns here: don't aim past the turn
    pick = p
    if (p.radius >= look) break
  }
  return pick.angle
}
// the line turns within the next ~3 car lengths: brake into the corner
export function cornerAhead(seen) {
  const path = seen.path || []
  return path.some((p) => p.radius <= 36 && Math.abs(p.angle) > 0.7)
}

export class Reflex {
  constructor() { this.slowFor = 0; this.reverseUntil = 0; this.lastSteer = 0 }

  // intent: { mode, maxSpeed } from the brain. Returns { pad, seen }.
  tick(img, intent, now) {
    const seen = readFrame(img)
    const pad = { lx: 0, rt: 0, lt: 0, a: false }
    const max = clamp(intent.maxSpeed ?? 1, 0.15, 1)

    if (now < this.reverseUntil) { pad.lt = 1; pad.lx = -(this.revSteer || 1); return { pad, seen, act: 'reverse' } }
    if (intent.mode === 'stop') { pad.lt = seen.speed > 0.02 ? 1 : 0; return { pad, seen, act: 'stop' } }

    let steerTo = null
    const routeClear = seen.route && (seen.copAngle === null || Math.abs(Math.atan2(Math.sin(seen.route.angle - seen.copAngle), Math.cos(seen.route.angle - seen.copAngle))) > 1)
    if (intent.mode === 'flee' && routeClear) steerTo = seen.route.angle   // the job route is open: run along it
    else if (intent.mode === 'flee' && seen.copAngle !== null) {
      // pick the open road direction furthest from the police, biased forward
      let best = null, score = -1e9
      for (const t of seen.roads.length ? seen.roads : [0]) {
        const away = Math.abs(Math.atan2(Math.sin(t - seen.copAngle), Math.cos(t - seen.copAngle)))
        const s = away * 1.4 - Math.abs(t) * 0.8
        if (s > score) { score = s; best = t }
      }
      steerTo = best
    } else if (seen.route) steerTo = followAngle(seen)
    else if (intent.mode === 'flee' || intent.mode === 'wander') steerTo = seen.roads.length ? seen.roads.reduce((a, b) => Math.abs(a) < Math.abs(b) ? a : b) : 0

    if (steerTo === null) { pad.lt = seen.speed > 0.05 ? 0.6 : 0; return { pad, seen, act: 'no route' } }

    const turn = clamp(steerTo / (Math.PI / 3), -1, 1)
    pad.lx = turn
    const sharp = Math.abs(steerTo) > 1.2
    const want = (sharp ? 0.32 : Math.abs(turn) > 0.5 ? 0.55 : cornerAhead(seen) ? 0.4 : 1) * max
    if (seen.speed < want) pad.rt = 1
    else if (seen.speed > want + 0.15) pad.lt = 0.7
    if (Math.abs(steerTo) > 2.4) { pad.rt = 0.5; pad.lx = Math.sign(steerTo) }   // route is behind us: hard turn

    // stuck: throttle on, bar not moving
    if (pad.rt >= 0.5 && seen.speed < 0.04) this.slowFor += 0.1; else this.slowFor = Math.max(0, this.slowFor - 0.2)
    if (this.slowFor > 1.4) { this.slowFor = 0; this.reverseUntil = now + 1500; this.revSteer = Math.abs(turn) > 0.15 ? Math.sign(turn) : (Math.random() < .5 ? -1 : 1) }
    this.lastSteer = pad.lx
    return { pad, seen, act: intent.mode === 'flee' ? 'evading' : 'following gps' }
  }
}
