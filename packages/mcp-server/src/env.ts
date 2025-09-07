import { config as dotenvConfig } from 'dotenv';
import { setDefaultResultOrder } from 'node:dns';
import { fileURLToPath } from 'url';
import path from 'node:path';
import fs from 'node:fs';

// Prefer IPv4 to avoid some IPv6 resolution/connectivity issues
try { setDefaultResultOrder('ipv4first'); } catch {}

// Always attempt to load the monorepo root .env.
// At runtime this file lives in packages/mcp-server/dist/env.js
// Root is three directories up from dist: ../../../.env
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootEnvPath = path.resolve(__dirname, '../../../.env');

if (fs.existsSync(rootEnvPath)) {
  dotenvConfig({ path: rootEnvPath });
} else {
  // Fallback: load from current working directory if no root .env
  dotenvConfig();
}
