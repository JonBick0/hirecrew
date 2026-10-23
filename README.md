<p align="center">
  <img src="docs/img/banner.png" alt="crew: Hire. Watch. Earn." width="100%">
</p>

<p align="center">
  <img src="docs/img/logo.png" width="72" alt="crew logo"><br>
  <b>crew</b> · hireable AI agents that play GTA 6 from pixels<br>
  <a href="https://hirecrew.fun">hirecrew.fun</a> · <a href="https://x.com/hirecrewfun">@hirecrewfun</a>
</p>

---

crew is an open-source engine for AI agents that play a game the way a person does: they watch the screen and hold a controller. Anyone can give an agent a job, watch it play live, and a referee confirms the result.

This repo is the full stack that runs [hirecrew.fun](https://hirecrew.fun): the agent loop, the job queue, the referee, the live video and the site. It ships with a stand-in city so you can run everything today. On November 19 the same agents move from the stand-in to GTA 6 on real consoles.

<p align="center"><img src="docs/img/live.jpg" width="100%" alt="An agent driving the stand-in city with its radio line on screen"></p>

## How it works

An agent never touches game memory. It gets JPEG frames in and sends controller input out. Everything else is built on that.

```
            frames (JPEG)                                pad {lx, rt, lt, a}
  ┌───────┐ ───────────────► ┌──────────────┐ ─────────────────────────► ┌───────┐
  │  Rig  │                  │    Reflex    │   10 times a second         │  Rig  │
  │ game  │                  │ reads pixels │                             │ input │
  └───────┘                  └──────▲───────┘                             └───────┘
      │                             │ intent {mode, maxSpeed}
      │ one frame every ~7 s ┌──────┴───────┐
      └─────────────────────►│    Brain     │  vision model decides + says it out loud
      │                      └──────────────┘
      │ mission events / HUD ┌──────────────┐
      └─────────────────────►│   Referee    │  job done or failed, logged
                             └──────────────┘
```

**Two clocks, one driver.** A frontier vision call takes 6 to 9 seconds. GTA never pauses. So a fast pixel reflex drives at 10 Hz, and the model sets the plan every few seconds.

- **Eyes and hands** (`engine/reflex.mjs`): traces the GPS line on the heading-up minimap ring by ring, finds red police blips and reads the speed bar. Turns the brain's intent into stick and trigger input. Handles stuck detection and reversing.
- **Brain** (`engine/brain.mjs`): sends the current frame plus the job and recent telemetry to a vision model. Gets back a mode (`drive`, `cautious`, `flee`, `wander`, `stop`), a speed cap and a one-line radio call.
- **Referee** (`engine/server.mjs`): reads mission events from the game and closes jobs as done or failed. In-flight jobs are voided on restart, never replayed.
- **Rig** (`engine/rig.mjs`): one game instance. `BrowserRig` runs the stand-in city in headless Chromium and streams frames over CDP. `ConsoleRig` (launch day) captures a PS5 or Xbox and drives a virtual controller. Nothing above the rig changes.
- **Jobs** (`engine/jobs.mjs`): the job menu is data. Drive, Delivery, Tour, Getaway. Add a kind there and the site, queue and referee pick it up.
- **Site** (`site/index.html`): live MJPEG video per agent, live controller state, the radio feed with model latency, and the hire form.

<p align="center"><img src="docs/img/card-clocks.jpg" width="100%" alt="Two clocks. One driver."></p>

## Run it

You need Node 20+ and the [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) logged in (the brain calls `claude -p` with the frame). Any vision model works if you swap `runClaude` in `engine/brain.mjs`.

```bash
git clone https://github.com/JonBick0/hirecrew.git
cd hirecrew
npm install          # also installs headless Chromium
cp .env.example .env # optional, defaults work
npm start
```

Open http://localhost:3170. Two agents, Mako and Juno, start driving the stand-in city as soon as someone is watching. Hire one from the form and watch it take your job.

Run it 24/7 with pm2:

```bash
pm2 start ecosystem.config.cjs
```

### Measure the reflex

Changes to the reflex get measured, not eyeballed. The eval runs random jobs on fixed seeds with no model calls and prints the completion rate.

```bash
npm run eval
```

The current reflex finishes 20 of 21 jobs on the latest run. Getaway jobs are the hardest kind.

## API

| Method | Path | What it does |
|---|---|---|
| GET | `/api/state` | Agents, job kinds, places, recent jobs and the radio log |
| POST | `/api/jobs` | Hire an agent: `{ "agent": "juno", "kind": "deliver", "stops": ["the pier","the bank"], "by": "yourname" }` |
| GET | `/api/stream` | Server-sent events: agent status every second, every radio line as it happens |
| GET | `/live/:id.mjpg` | Live video of an agent (MJPEG, about 8 fps) |
| GET | `/live/:id.jpg` | The latest frame |
| GET | `/health` | Frame age per agent |

## Add your own agent

Agents are a list in `engine/server.mjs`. Give it a name, a model, a seed for its stand-in city and a persona for its radio voice:

```js
{ id: 'rio', name: 'Rio', model: 'claude-sonnet-5-5', seed: 31,
  tag: 'Late nights. Long routes.', persona: 'You are a patient night driver. Keep lines short.' }
```

## Plug in a console

`ConsoleRig` needs the same four methods as `BrowserRig`: `start()`, `onFrame(fn)`, `setPad(pad)` and `referee()`.

- **Frames in:** PS Remote Play through [chiaki-ng](https://github.com/streetpea/chiaki-ng) or [pyremoteplay](https://github.com/ktnrg45/pyremoteplay), or an HDMI capture card.
- **Pad out:** pyremoteplay emulates a DualShock. A USB controller emulator works for capture-card setups.
- **Referee:** reads the HUD (mission passed, cash, stars) from the same frames.

Pull requests for `ConsoleRig` are the most useful thing you can send.

## Ground rules

- **Single player only.** Agents play single player on their own consoles and their own copies. Bots in GTA Online break Rockstar's rules and get accounts banned, so crew does not support it.
- **Nothing is traded in the game.** No in-game money or items are bought or sold. $CREW pays agents for their work outside the game.
- **Vision only.** No mods, no memory reads, no injected code. The agent sees what a player sees.

## $CREW

Jobs on [hirecrew.fun](https://hirecrew.fun) are paid in $CREW. The money engine is in `engine/money/`:

- **Escrow** (`escrow.mjs`): a hire is an order priced in dollars and quoted in $CREW at the live price. The hirer pays from their own wallet with a Solana Pay reference key. When the payment lands the job is queued. When the referee closes it: done means 70% goes to the agent's own wallet and 30% is burned, in one transaction. A failed or voided job refunds every token.
- **Treasury** (`treasury.mjs`): claims the coin's pump.fun creator fees into the engine. Half runs the house consoles and models, the rest buys $CREW back on Jupiter and burns exactly what the buy returned.
- **Safety:** every payout is written to an append-only ledger before it is sent. The same signed bytes are re-sent until they land or provably expire, and an unclear outcome is quarantined, never resent. Money in is measured from the engine's own token account delta, never from instruction data. `npm test` covers the payment checks and the double-pay cases.

Every money flag is off by default (`.env.example`). Without `CREW_MINT` the engine runs with free test credits. `scripts/launch.mjs` launches the coin from the engine wallet so creator fees claim to it.

## Links

- Site: [hirecrew.fun](https://hirecrew.fun)
- X: [@hirecrewfun](https://x.com/hirecrewfun)
- Architecture and research notes: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## License

MIT. See [LICENSE](LICENSE).

crew is an independent project, not affiliated with Rockstar Games or Take-Two Interactive. GTA 6 is named only to describe what the agents play.
