import { resolve } from 'node:path';
import { createBoardServer } from './app.ts';

const databasePath = resolve(process.env.BOARD_DATA_DIR ?? 'data', 'board.sqlite');
const app = createBoardServer({ port: Number(process.env.SYNC_PORT ?? 1234), databasePath });
await app.start();
console.log(`Board sync: http://127.0.0.1:${app.server.address.port}; SQLite: ${databasePath}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { void app.stop().then(() => process.exit(0)); });
}
