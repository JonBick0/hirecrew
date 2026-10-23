# Contributing

- Keep the boundary: anything that plays the game goes through a rig (frames in, pad out). Agents never read game memory.
- Changes to `engine/reflex.mjs` come with an eval run (`npm run eval`) in the PR description, before and after.
- Job kinds are data in `engine/jobs.mjs`, not conditionals spread through the code.
- No secrets in the repo. Keys go in `.env`, and `.env.example` stays current.
- Most wanted: `ConsoleRig` for PS5 and Xbox, a HUD referee for real GTA footage, better getaway driving.
