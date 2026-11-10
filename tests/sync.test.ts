import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createBoardServer, MAX_IMAGE_BYTES } from '../server/app.ts';
import { client, converge, rectangle, until } from './helpers.ts';
import { fingerprint } from '../src/model.ts';

async function fixture(t: test.TestContext) {
  await mkdir('.test-data', { recursive: true });
  const directory = await mkdtemp(resolve('.test-data/integration-'));
  const databasePath = resolve(directory, 'board.sqlite');
  let server = createBoardServer({ port: 0, databasePath });
  const port = await server.start();
  const clients: Awaited<ReturnType<typeof client>>[] = [];
  async function connect(name = 'test') { const c = await client(port, name); clients.push(c); return c; }
  t.after(async () => { clients.forEach(c => c.destroy()); await server.stop(); await rm(directory, { recursive: true, force: true }); });
  return {
    port, connect,
    async restartAndAssert(expected: unknown) {
      await server.stop();
      server = createBoardServer({ port, databasePath });
      await server.start();
      const fresh = await connect('fresh-after-restart');
      assert.equal(fingerprint(fresh.model.read()), fingerprint(expected));
    },
  };
}

test('real WebSocket: create, edit, move independent objects, delete; restart preserves tombstone', async t => {
  const f = await fixture(t);
  const a = await f.connect('A'); const b = await f.connect('B');
  a.model.write([rectangle('one')]);
  await converge(a, b);
  assert.equal(b.model.read()[0].x, 0);
  b.model.write([{ ...b.model.read()[0], x: 250, width: 200 }]);
  await converge(a, b);
  assert.equal(a.model.read()[0].x, 250);
  assert.equal(a.model.read()[0].width, 200);
  a.model.write([rectangle('independent-a')]); b.model.write([rectangle('independent-b')]);
  await converge(a, b);
  assert.equal(a.model.read().length, 3);
  a.model.write([{ ...a.model.read().find(e => e.id === 'one')!, isDeleted: true }]);
  await converge(a, b);
  assert.equal(b.model.read().find(e => e.id === 'one')!.isDeleted, true);
  await f.restartAndAssert(a.model.read());
});

test('offline edits in memory merge with online edits on reconnect and survive restart', async t => {
  const f = await fixture(t); const a = await f.connect('A'); const b = await f.connect('B');
  a.model.write([rectangle('base')]); await converge(a, b);
  a.provider.disconnect();
  a.model.write([{ ...a.model.read()[0], x: 123 }, rectangle('offline-created')]);
  b.model.write([rectangle('online-created', 500)]);
  await until(() => !b.provider.hasUnsyncedChanges);
  await a.provider.connect(); await converge(a, b);
  assert.equal(b.model.read().find(e => e.id === 'base')!.x, 123);
  assert.equal(b.model.read().length, 3);
  await f.restartAndAssert(a.model.read());
});

test('concurrent moves: one atomic position wins, both clients converge, restart agrees', async t => {
  const f = await fixture(t); const a = await f.connect('A'); const b = await f.connect('B');
  a.model.write([rectangle('shared')]); await converge(a, b);
  a.provider.disconnect(); b.provider.disconnect();
  await until(() => a.provider.configuration.websocketProvider.status === 'disconnected' && b.provider.configuration.websocketProvider.status === 'disconnected', 'both sockets closed');
  a.model.write([{ ...a.model.read()[0], x: 100, y: 101 }]);
  b.model.write([{ ...b.model.read()[0], x: 200, y: 201 }]);
  await Promise.all([a.provider.connect(), b.provider.connect()]); await converge(a, b);
  const result = a.model.read()[0];
  assert.ok((result.x === 100 && result.y === 101) || (result.x === 200 && result.y === 201));
  t.diagnostic(`Observed winning position: (${result.x}, ${result.y}); Yjs client IDs: ${a.doc.clientID}, ${b.doc.clientID}`);
  await f.restartAndAssert(a.model.read());
});

test('concurrent delete vs edit: deletion wins; explicit local undo of deletion restores', async t => {
  const f = await fixture(t); const a = await f.connect('A'); const b = await f.connect('B');
  a.model.write([rectangle('shared')]); await converge(a, b); a.model.undo.clear();
  a.provider.disconnect(); b.provider.disconnect();
  await until(() => a.provider.configuration.websocketProvider.status === 'disconnected' && b.provider.configuration.websocketProvider.status === 'disconnected', 'both sockets closed');
  a.model.write([{ ...a.model.read()[0], isDeleted: true }]);
  b.model.write([{ ...b.model.read()[0], x: 999 }]);
  await Promise.all([a.provider.connect(), b.provider.connect()]); await converge(a, b);
  assert.equal(a.model.read()[0].isDeleted, true);
  assert.equal(a.model.read()[0].x, 999);
  await f.restartAndAssert(a.model.read());
  await until(() => a.provider.synced && b.provider.synced);
  a.model.undo.undo(); await converge(a, b);
  assert.equal(b.model.read()[0].isDeleted, false);
  assert.equal(b.model.read()[0].x, 999);
  await f.restartAndAssert(a.model.read());
});

test('selective undo: A edit, B later edit, A undo does not overwrite B; own create undo/redo', async t => {
  const f = await fixture(t); const a = await f.connect('A'); const b = await f.connect('B');
  a.model.write([rectangle('shared')]); await converge(a, b); a.model.undo.clear(); b.model.undo.clear();
  a.model.write([{ ...a.model.read()[0], x: 100 }]); await converge(a, b);
  b.model.write([{ ...b.model.read()[0], x: 200 }]); await converge(a, b);
  a.model.undo.undo(); await converge(a, b);
  assert.equal(b.model.read()[0].x, 200);
  a.model.undo.stopCapturing();
  a.model.write([rectangle('own')]); await converge(a, b);
  a.model.undo.undo(); await converge(a, b);
  assert.equal(b.model.read().some(e => e.id === 'own'), false);
  assert.equal(b.model.read()[0].x, 200);
  a.model.undo.redo(); await converge(a, b);
  assert.equal(b.model.read().some(e => e.id === 'own'), true);
  await f.restartAndAssert(a.model.read());
});

test('awareness joins and disappears on clean disconnect', async t => {
  const f = await fixture(t); const a = await f.connect('A'); const b = await f.connect('B');
  await until(() => a.provider.awareness!.getStates().size === 2);
  const bId = b.doc.clientID;
  b.provider.disconnect();
  await until(() => !a.provider.awareness!.getStates().has(bId), 'presence removal');
});

export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT1sAAAAASUVORK5CYII=', 'base64');

test('images: bounded binary HTTP storage outside Yjs; exact bytes survive restart; reject SVG and >2 MiB', async t => {
  const f = await fixture(t); const a = await f.connect('A');
  const endpoint = `http://127.0.0.1:${f.port}/api/assets`;
  const response = await fetch(endpoint, { method: 'POST', body: PNG });
  assert.equal(response.status, 201);
  const { id } = await response.json() as { id: string };
  a.model.write([{ ...rectangle('image'), type: 'image', fileId: id }]);
  await until(() => !a.provider.hasUnsyncedChanges);
  assert.ok(fingerprint(a.model.read()).length < 500, 'no base64 in shared document');
  await f.restartAndAssert(a.model.read());
  const fetched = await fetch(`${endpoint}/${id}`);
  assert.equal(fetched.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await fetched.arrayBuffer()), PNG);
  assert.equal((await fetch(endpoint, { method: 'POST', body: '<svg></svg>' })).status, 415);
  assert.equal((await fetch(endpoint, { method: 'POST', body: Buffer.alloc(MAX_IMAGE_BYTES + 1) })).status, 413);
});

test('abrupt server process kill: binary Yjs update survives and is readable by a fresh client', async t => {
  await mkdir('.test-data', { recursive: true });
  const directory = await mkdtemp(resolve('.test-data/crash-'));
  const processes: ChildProcess[] = [];
  const clients: Awaited<ReturnType<typeof client>>[] = [];
  async function launch(port: number) {
    const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
      env: { ...process.env, SYNC_PORT: String(port), BOARD_DATA_DIR: directory }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    processes.push(child);
    let output = ''; let errors = '';
    child.stdout!.on('data', data => { output += String(data); });
    child.stderr!.on('data', data => { errors += String(data); });
    await until(() => output.includes('Board sync:') || child.exitCode !== null, 'child server startup');
    assert.equal(child.exitCode, null, errors);
    return { child, port: Number(output.match(/127\.0\.0\.1:(\d+)/)![1]) };
  }
  async function kill(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    child.kill('SIGKILL'); await exited;
  }
  t.after(async () => { clients.forEach(c => c.destroy()); for (const process of processes) await kill(process); await rm(directory, { recursive: true, force: true }); });
  const first = await launch(0);
  const a = await client(first.port); clients.push(a);
  a.model.write([rectangle('durable-after-kill', 777)]);
  await until(() => !a.provider.hasUnsyncedChanges);
  await kill(first.child);
  a.destroy(); clients.splice(clients.indexOf(a), 1);
  await launch(first.port);
  const b = await client(first.port); clients.push(b);
  assert.equal(b.model.read()[0].id, 'durable-after-kill');
  assert.equal(b.model.read()[0].x, 777);
});
