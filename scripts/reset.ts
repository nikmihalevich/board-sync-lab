import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

// Require the explicit flag to avoid deleting a running demo by accident.
if (!process.argv.includes('--confirm')) {
  console.error('Остановите web и sync, закройте все вкладки доски. Затем: pnpm reset --confirm');
  process.exit(1);
}
if (process.env.BOARD_DATA_DIR) throw new Error('Reset only supports the default ./data directory');
const directory = resolve('data');
for (const suffix of ['', '-wal', '-shm']) await rm(resolve(directory, `board.sqlite${suffix}`), { force: true });
console.log('Тестовая доска и изображения удалены из ./data.');
