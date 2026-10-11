// Imported first: loads .env before any other module is evaluated.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const envPath = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);
