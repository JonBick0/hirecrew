// Loads .env before any module reads process.env (imported first by server.mjs).
import dotenv from 'dotenv'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env'), quiet: true })
