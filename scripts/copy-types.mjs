import { copyFile } from 'node:fs/promises';
await copyFile(new URL('../src/wire.d.ts', import.meta.url), new URL('../dist/wire.d.ts', import.meta.url));
