# Architecture and research notes

## Why it is built this way

GTA 6 ships on PS5 and Xbox Series X|S only, with no PC version at launch. That rules out mods, memory reads and injected code. The only honest interface is the one a player has: the picture on the screen and a controller. crew is built entirely on that interface, which also means the same agent can play any game with a minimap and a speed readout.

## The loop

| Part | File | Rate | Job |
|---|---|---|---|
| Rig | `engine/rig.mjs` | about 10 fps | Game instance. Frames out, pad in, mission events for the referee |
| Reflex | `engine/reflex.mjs` | 10 Hz | Pixels to stick and triggers: GPS line, police, speed, stuck recovery |
| Brain | `engine/brain.mjs` | every ~7 s | Vision model sets mode, speed cap and a radio line |
| Referee | `engine/server.mjs` | 2 Hz | Closes jobs as done or failed, voids in-flight jobs on restart |
| Server | `engine/server.mjs` | | Queue, state (atomic writes), SSE, MJPEG, hire API |

A slow brain answer for a job that already ended is dropped, so a radio line never leaks into the next job.

### How the reflex reads the GPS line

It walks outward from the car on the heading-up minimap in rings (radius 8 to 64 px, step 4). On each ring it collects route-coloured pixels, groups them into blobs and follows the blob closest to the previous ring's angle, skipping jumps over 1.4 rad (another branch of the route). It aims at the first ring at or beyond 24 px, a few car lengths ahead. Steering is proportional to that angle, and the target speed drops on sharp turns. If the throttle is on and the speed bar does not move for 1.4 s, it reverses for 1.5 s with the wheel turned.

Aiming at the far end of the route cut corners into buildings. Tracing ring by ring moved the eval from 1 of 12 jobs to 8 of 9.

## Honest status

| Real today | Not real yet |
|---|---|
| The full agent loop running on the stand-in city, live | GTA 6 itself. Nobody can run it before November 19 |
| Jobs, queue, referee, radio, live video | Console referee: on a console it must read the HUD, built on day one with real footage |
| Driving jobs: drive, delivery, tour, getaway | Gunfights, cutscene missions, menus. Much harder, added per job type with evals |
| | Each concurrent agent needs its own console and copy. Capacity is hardware |

## Research (checked October 2026)

- **Release:** Nov 19 2026, **PS5 + Xbox Series X|S only**. No PC date. Xbox Cloud Gaming not
  available day one (reported).
- **Online:** launch is **single-player only**. GTA 6 Online has no date (leaks say ~Dec, Twitch
  CEO hinted 2027).
- **Rockstar + crypto:** only on-record position is the Nov 2022 ban on crypto/NFTs on GTA
  roleplay servers ("commercial exploitation" also covers selling virtual currency). They sent a
  C&D to an NFT server. Nothing GTA-6-specific yet. Bans for modding/exploits in online games can
  spread to all Rockstar titles.
- **Meta right now:** GTA-6 memecoins are hot and mostly ugly: CYBERLEEK (leaker coin, ~$25M peak,
  dev extracted ~$270k), Dacity (a Solana copy of "DacityCoin" seen in the launch trailer, ran
  $104k → $3.2M in an hour). Nobody is shipping "AI agents that play GTA" with a working demo,
  which is the opening.
- **How an agent plays a console:** frames in (PS Remote Play via chiaki-ng / pyremoteplay, or an
  HDMI capture card) → model → controller out (pyremoteplay emulates a DualShock; or a USB
  controller-emulator dongle). No PC version means no memory reads, no mods: **vision only**.
- **Two clocks are mandatory:** a frontier vision call takes ~6-9 s (measured here: Haiku ~7 s,
  Sonnet ~6-12 s with the image). GTA never pauses, so a fast pixel reflex drives and the model
  decides.

## What is honest on day 1 (and what isn't)

| Real | Not real / flagged |
|---|---|
| Agent loop: frames → reflex (10 Hz) → model (every ~7 s) → virtual pad. Running now on the stand-in. | It runs on a **stand-in city**, not GTA. GTA 6 does not exist for anyone until Nov 19. |
| Jobs, queue, referee, radio, live video. | Referee on the stand-in reads the game's mission events; on console it must OCR the HUD. Needs building on day 1 with real footage. |
| Single-player jobs on **our** consoles and **our** copies. | **No GTA Online agents.** Bots there almost certainly break Rockstar's rules → account bans. We say so. |
| Coin lives outside the game. | Nothing is bought or sold **inside** the game, no in-game cash/items for tokens (Rockstar bans that). |
| Driving jobs (drive, deliver, tour, getaway). | Gunfights, missions with cutscenes, menus: much harder; add per job type with evals. |
| | Sony Remote Play with automated input is grey: one PSN account per rig, accept ban risk on that account. Capture card + controller emulator is the safer route. |
| | Each concurrent agent needs its own console + copy (~$500 + $70). Capacity = hardware. |

