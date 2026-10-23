// Job menu. Data, not conditionals: add a kind here and the site, queue and
// referee pick it up. Prices are paper credits in the preview.
export const PLACES = ['the pier', 'the marina', 'downtown', 'the motel', 'the diner', 'the airfield gate', 'the bridge', 'the bank', 'the club', 'the garage', 'the beach lot', 'the stadium']

export const KINDS = {
  run: { label: 'Drive', stops: 1, price: 100, limit: 120, title: (s) => `Drive to ${s[0]}` },
  deliver: { label: 'Delivery', stops: 2, price: 250, limit: 170, title: (s) => `Pick up at ${s[0]}, drop at ${s[1]}` },
  tour: { label: 'Tour', stops: 3, price: 300, limit: 220, title: (s) => `Tour: ${s.join(', ')}` },
  escape: { label: 'Getaway', stops: 0, price: 400, limit: 120, title: () => 'Two stars. Lose the police.' },
}

export function makeJob({ kind, stops, by, agent }, n) {
  const k = KINDS[kind]
  if (!k) throw new Error('unknown job kind')
  const list = (Array.isArray(stops) ? stops : []).filter((s) => PLACES.includes(s)).slice(0, k.stops)
  while (list.length < k.stops) {
    const p = PLACES[(Math.random() * PLACES.length) | 0]
    if (!list.includes(p)) list.push(p)
  }
  const handle = String(by || 'anon').replace(/[^\w.@-]/g, '').slice(0, 24) || 'anon'
  return { id: `J${n}`, kind, agent, stops: list, title: k.title(list), limit: k.limit, price: k.price, by: handle, status: 'queued', createdAt: Date.now() }
}

export function randomJob(agent, n) {
  const kinds = ['run', 'deliver', 'tour', 'escape', 'deliver', 'run']
  return makeJob({ kind: kinds[(Math.random() * kinds.length) | 0], by: 'house', agent }, n)
}
