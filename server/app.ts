import { Server } from '@hocuspocus/server';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { Socket } from 'node:net';
import * as Y from 'yjs';
import { BOARD_NAME } from '../src/model.ts';

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

function imageMime(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export function createBoardServer({ port = 1234, databasePath = 'data/board.sqlite' } = {}) {
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS documents (name TEXT PRIMARY KEY, state BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, mime TEXT NOT NULL, data BLOB NOT NULL);`);
  const save = db.prepare('INSERT INTO documents(name, state) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET state=excluded.state');
  const load = db.prepare('SELECT state FROM documents WHERE name=?');
  const getAsset = db.prepare('SELECT mime, data FROM assets WHERE id=?');
  const saveAsset = db.prepare('INSERT OR IGNORE INTO assets(id, mime, data) VALUES (?, ?, ?)');

  const server = new Server({
    address: '127.0.0.1',
    port,
    quiet: true,
    stopOnSignals: false,
    websocketOptions: { maxPayload: 8 * 1024 * 1024 },
    async onConnect({ documentName }) {
      if (documentName !== BOARD_NAME) throw new Error('Only team-board exists in this spike');
    },
    async onLoadDocument({ documentName }) {
      const row = load.get(documentName);
      return row ? new Uint8Array(row.state as Uint8Array) : undefined;
    },
    async onChange({ documentName, document }) {
      // Intentionally synchronous, every update, no debounce window in this spike.
      // Binary Yjs history is preserved, including deletion information.
      save.run(documentName, Y.encodeStateAsUpdate(document));
    },
    async onStoreDocument({ documentName, document }) {
      save.run(documentName, Y.encodeStateAsUpdate(document));
    },
    async onRequest({ request, response }) {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      const json = (status: number, body: unknown) => {
        response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify(body));
      };
      try {
        if (path === '/api/health' && request.method === 'GET') {
          json(200, { ok: true, board: BOARD_NAME, persistedBytes: (load.get(BOARD_NAME)?.state as Uint8Array | undefined)?.length ?? 0 });
        } else if (path === '/api/assets' && request.method === 'POST') {
          const chunks: Buffer[] = [];
          let length = 0;
          let tooLarge = Number(request.headers['content-length'] ?? 0) > MAX_IMAGE_BYTES;
          for await (const chunk of request) {
            length += chunk.length;
            if (length > MAX_IMAGE_BYTES) tooLarge = true;
            if (!tooLarge) chunks.push(Buffer.from(chunk));
            else { json(413, { error: 'Изображение больше 2 МиБ.' }); break; }
          }
          if (!tooLarge) {
            const data = Buffer.concat(chunks);
            const mime = imageMime(data);
            if (!mime) json(415, { error: 'Поддерживаются только PNG, JPEG и WebP.' });
            else {
              const id = createHash('sha256').update(data).digest('hex');
              saveAsset.run(id, mime, data);
              json(201, { id, mime });
            }
          }
        } else if (/^\/api\/assets\/[a-f0-9]{64}$/.test(path) && request.method === 'GET') {
          const row = getAsset.get(path.split('/').at(-1)!);
          if (!row) json(404, { error: 'Изображение не найдено.' });
          else {
            response.writeHead(200, {
              'Content-Type': row.mime as string,
              'X-Content-Type-Options': 'nosniff',
              'Cache-Control': 'public, max-age=31536000, immutable',
            });
            response.end(row.data as Uint8Array);
          }
        } else json(404, { error: 'Not found' });
      } catch (error) {
        console.error('HTTP request failed', error);
        if (!response.headersSent) json(500, { error: 'Ошибка локального хранилища.' });
      }
      // Hocuspocus documents an empty rejection to stop its default HTTP handler.
      throw null;
    },
  });

  // Hocuspocus v4 destroy closes document sessions, but its upgraded TCP sockets
  // can remain open. Close those too so live clients see a real disconnect.
  const sockets = new Set<Socket>();
  server.httpServer.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  let stopped = false;
  return {
    server,
    async start() { await server.listen(); return server.address.port; },
    async stop() {
      if (stopped) return;
      stopped = true;
      await server.destroy();
      for (const socket of sockets) socket.destroy();
      db.close();
    },
  };
}
