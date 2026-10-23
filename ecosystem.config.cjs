// pm2 start ecosystem.config.cjs
module.exports = { apps: [{ name: 'crew', script: 'engine/server.mjs', cwd: __dirname, env: { PORT: 3170, HOUSE_JOBS: '1' }, max_memory_restart: '1500M' }] }
