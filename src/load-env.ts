import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Backend/.env (next to package.json), regardless of process.cwd()
config({ path: resolve(__dirname, '../.env') });
