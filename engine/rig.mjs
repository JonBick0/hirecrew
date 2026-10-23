// A rig = one game instance an agent plays. The agent side only needs three
// things from it: a stream of JPEG frames, a controller port, and a way for the
// operator to start a job. Everything above this file is identical on launch day.
//
//   BrowserRig  (now)        headless Chromium running the stand-in city
//   ConsoleRig  (Nov 19)     PS5/Xbox → capture (Remote Play client or HDMI card)
//                            → same JPEG frames; pad → virtual DualSense/XInput
//
// The referee reads the stand-in's mission events; on a console it reads the
// HUD ("mission passed", cash, stars) from the same frames.
import { chromium } from 'playwright'

// one browser per rig: the 3D city renders in software GL, and pages sharing a browser share
// its GPU process, which halves each rig's frame rate
const launch = () => chromium.launch({ args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] })

export class BrowserRig {
  constructor(id, url) { this.id = id; this.url = url; this.frame = null; this.frameAt = 0; this.listeners = new Set(); this.seenEvents = 0 }

  async start() {
    const b = this.browser ||= await launch()
    this.page = await b.newPage({ viewport: { width: 960, height: 540 } })
    this.page.on('pageerror', (e) => console.error(`[rig ${this.id}] page error`, e.message))
    await this.page.goto(this.url)
    this.cdp = await this.page.context().newCDPSession(this.page)
    this.cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
      this.frame = Buffer.from(data, 'base64'); this.frameAt = Date.now()
      this.cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
      for (const fn of this.listeners) fn(this.frame)
    })
    await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 72, maxWidth: 960, maxHeight: 540, everyNthFrame: 1 })
  }

  onFrame(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) }
  async setPad(pad) { await this.page.evaluate((p) => Object.assign(window.__pad, p), pad).catch(() => {}) }
  async startJob(job) { return this.page.evaluate((j) => window.__world.startJob(j), job) }

  // referee: new mission events since last poll + HUD numbers
  async referee() {
    const r = await this.page.evaluate(() => ({ events: window.__world.events.slice(-60), cash: window.__world.cash, wanted: window.__world.wanted, crashes: window.__world.crashes })).catch(() => null)
    if (!r) return null
    const fresh = r.events.filter((e) => e.t > (this.lastT ?? -1))
    if (fresh.length) this.lastT = fresh[fresh.length - 1].t
    return { ...r, events: fresh }
  }
}
