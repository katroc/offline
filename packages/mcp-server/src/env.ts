import { config as dotenvConfig } from 'dotenv';
import { setDefaultResultOrder } from 'node:dns';

// Load environment variables from a .env file in the current working directory
// This keeps development simple: place .env at the repo root and run from there.
// Prefer IPv4 to avoid some IPv6 resolution/connectivity issues
try { setDefaultResultOrder('ipv4first'); } catch {}

dotenvConfig();
