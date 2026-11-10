import { test, expect, type Browser, type Page } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createBoardServer } from '../../server/app';

let app: ReturnType<typeof createBoardServer>;
let directory: string;
let databasePath: string;

declare global { interface Window { __canvasLabels: string[] } }

test.beforeAll(async () => {
  await mkdir('.test-data', { recursive: true });
  directory = await mkdtemp(resolve('.test-data/browser-'));
  databasePath = resolve(directory, 'board.sqlite');
  app = createBoardServer({ port: 1235, databasePath });
  await app.start();
});
test.afterAll(async () => { await app?.stop(); if (directory) await rm(directory, { recursive: true, force: true }); });

async function join(browser: Browser, name: string) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__canvasLabels = [];
    const original = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function(text, x, y, maxWidth) {
      window.__canvasLabels.push(text);
      if (window.__canvasLabels.length > 1000) window.__canvasLabels.shift();
      if (maxWidth === undefined) original.call(this, text, x, y);
      else original.call(this, text, x, y, maxWidth);
    };
  });
  await page.goto('/');
  await page.getByLabel('Как вас показать на доске?').fill(name);
  await page.getByRole('button', { name: /Открыть общий холст/ }).click();
  await expect(page.getByTestId('connection')).toHaveText('Подключено');
  await page.waitForFunction(() => !!window.__board);
  return { context, page };
}

async function snapshot(page: Page) {
  return page.evaluate(() => window.__board!.scene().map(e => ({ id: e.id, x: e.x, y: e.y, type: e.type, isDeleted: e.isDeleted, groupIds: e.groupIds, text: 'text' in e ? e.text : undefined })));
}

async function assertEditorConvergence(a: Page, b: Page) {
  await expect.poll(async () => JSON.stringify(await snapshot(b))).toBe(JSON.stringify(await snapshot(a)));
}

test('two isolated browsers: native drawing, dragging, deleting, local undo, text, arrow, grouping, offline, images, restart', async ({ browser }, testInfo) => {
  const a = await join(browser, 'Аня'); const b = await join(browser, 'Борис');
  const pageErrors: string[] = [];
  for (const page of [a.page, b.page]) page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await expect(a.page.getByTestId('participants')).toContainText('Борис');
    await expect(b.page.getByTestId('participants')).toContainText('Аня');
    const bLocalBefore = await b.page.evaluate(() => window.__board!.localTransactions());

    // Draw with native Excalidraw UI (no model injection).
    await a.page.getByTitle('Прямоугольник — R или 2', { exact: true }).click();
    await a.page.mouse.move(450, 340); await a.page.mouse.down();
    await a.page.mouse.move(610, 460, { steps: 12 }); await a.page.mouse.up();
    await expect.poll(async () => (await snapshot(b.page)).filter(e => !e.isDeleted).length).toBe(1);
    const rect = (await snapshot(a.page)).find(e => !e.isDeleted)!;

    await a.page.keyboard.press('v');
    await a.page.mouse.move(530, 400); await a.page.mouse.down();
    await a.page.mouse.move(710, 480, { steps: 12 }); await a.page.mouse.up();
    await expect.poll(async () => (await snapshot(b.page)).find(e => e.id === rect.id)?.x).toBeGreaterThan(rect.x + 100);
    await assertEditorConvergence(a.page, b.page);

    await a.page.keyboard.press('Delete');
    await expect.poll(async () => (await snapshot(b.page)).find(e => e.id === rect.id)?.isDeleted).toBe(true);
    await a.page.keyboard.press('Control+z');
    await expect.poll(async () => (await snapshot(b.page)).find(e => e.id === rect.id)?.isDeleted).toBe(false);

    await a.page.keyboard.press('Escape'); await a.page.keyboard.press('t');
    await a.page.mouse.click(450, 600);
    await a.page.keyboard.type('Team ideas'); await a.page.keyboard.press('Escape');
    await expect.poll(async () => (await snapshot(b.page)).some(e => e.text === 'Team ideas')).toBe(true);
    await a.page.keyboard.press('a');
    await a.page.mouse.move(480, 560); await a.page.mouse.down();
    await a.page.mouse.move(680, 560, { steps: 10 }); await a.page.mouse.up();
    await expect.poll(async () => (await snapshot(b.page)).some(e => e.type === 'arrow')).toBe(true);

    await a.page.keyboard.press('Escape'); await a.page.keyboard.press('Control+a'); await a.page.keyboard.press('Control+g');
    await expect.poll(async () => (await snapshot(b.page)).filter(e => !e.isDeleted).every(e => e.groupIds.length === 1)).toBe(true);
    await a.page.keyboard.press('Control+Shift+g');
    await expect.poll(async () => (await snapshot(b.page)).filter(e => !e.isDeleted).every(e => e.groupIds.length === 0)).toBe(true);
    expect(await b.page.evaluate(() => window.__board!.localTransactions())).toBe(bLocalBefore);

    // Actual cursor rendering through Excalidraw collaborators.
    await a.page.mouse.move(820, 650, { steps: 5 });
    // Cursor names are painted on canvas, not exposed as DOM text.
    await expect.poll(() => b.page.evaluate(() => window.__canvasLabels.includes('Аня'))).toBe(true);
    await b.page.screenshot({ path: testInfo.outputPath('remote-cursor.png') });

    await a.page.getByTestId('toggle-connection').click();
    await expect(b.page.getByTestId('participants')).not.toContainText('Аня');
    await a.page.evaluate(id => window.__board!.patch(id, { x: 333 }), rect.id);
    await b.page.evaluate(() => window.__board!.add('online-while-a-offline', 900));
    await a.page.getByTestId('toggle-connection').click();
    await expect(a.page.getByTestId('connection')).toHaveText('Подключено');
    await assertEditorConvergence(a.page, b.page);
    expect((await snapshot(b.page)).find(e => e.id === rect.id)?.x).toBe(333);
    expect((await snapshot(a.page)).some(e => e.id === 'online-while-a-offline')).toBe(true);

    const png = await a.page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 100;
      const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#24627c'; ctx.fillRect(0, 0, 160, 100);
      ctx.fillStyle = 'white'; ctx.font = '20px sans-serif'; ctx.fillText('Board Lab', 28, 56);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    await a.page.getByLabel('Добавить изображение', { exact: true }).setInputFiles({ name: 'sample.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    await expect.poll(async () => b.page.evaluate(() => window.__board!.files().length)).toBe(1);
    await expect.poll(async () => (await snapshot(b.page)).some(e => e.type === 'image' && !e.isDeleted)).toBe(true);
    await assertEditorConvergence(a.page, b.page);

    // Wait for remote feedback to settle and ensure it doesn't create local echoes.
    const localBefore = await b.page.evaluate(() => window.__board!.localTransactions());
    await a.page.waitForTimeout(350);
    expect(await b.page.evaluate(() => window.__board!.localTransactions())).toBe(localBefore);

    const beforeView = await a.page.evaluate(() => window.__board!.viewport());
    await a.page.getByRole('button', { name: 'Увеличить', exact: true }).click();
    await expect.poll(() => a.page.evaluate(() => window.__board!.viewport().zoom)).toBeGreaterThan(beforeView.zoom);
    const beforePan = await a.page.evaluate(() => window.__board!.viewport());
    await a.page.mouse.move(1150, 700); await a.page.keyboard.down('Space'); await a.page.mouse.down();
    await a.page.mouse.move(1220, 750, { steps: 8 }); await a.page.mouse.up(); await a.page.keyboard.up('Space');
    await expect.poll(() => a.page.evaluate(() => window.__board!.viewport().x)).not.toBe(beforePan.x);
    await assertEditorConvergence(a.page, b.page);

    await a.page.getByRole('button', { name: 'Вся доска', exact: true }).click();
    await a.page.screenshot({ path: testInfo.outputPath('board-desktop.png') });
    const expected = await snapshot(a.page);
    console.log('Browser: restarting sync after CRUD, offline and images');
    await app.stop();
    await expect(a.page.getByTestId('connection')).not.toHaveText('Подключено');
    app = createBoardServer({ port: 1235, databasePath }); await app.start();
    await expect(a.page.getByTestId('connection')).toHaveText('Подключено');
    await expect(b.page.getByTestId('connection')).toHaveText('Подключено');
    await b.context.close();
    const fresh = await join(browser, 'Вера');
    try {
      await expect.poll(async () => snapshot(fresh.page)).toEqual(expected);
      await expect.poll(async () => fresh.page.evaluate(() => window.__board!.files().length)).toBe(1);
      await fresh.page.setViewportSize({ width: 390, height: 844 });
      expect(await fresh.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await fresh.page.screenshot({ path: testInfo.outputPath('board-mobile.png') });
    } finally { await fresh.context.close(); }
    expect(pageErrors).toEqual([]);
  } finally { await a.context.close(); await b.context.close(); }
});

test('offline edits are explicitly lost on page reload; server state remains intact', async ({ browser }) => {
  const a = await join(browser, 'Offline'); const b = await join(browser, 'Online');
  try {
    await a.page.evaluate(() => window.__board!.add('reload-saved', 120));
    await assertEditorConvergence(a.page, b.page);
    await a.page.getByTestId('toggle-connection').click();
    await expect(b.page.getByTestId('participants')).not.toContainText('Offline');
    await a.page.evaluate(() => { window.__board!.patch('reload-saved', { x: 800 }); window.__board!.add('reload-unsaved', 750); });
    expect((await snapshot(a.page)).some(e => e.id === 'reload-unsaved')).toBe(true);
    await a.page.reload();
    await a.page.getByRole('button', { name: /Открыть общий холст/ }).click();
    await expect(a.page.getByTestId('connection')).toHaveText('Подключено');
    await a.page.waitForFunction(() => !!window.__board);
    await assertEditorConvergence(a.page, b.page);
    expect((await snapshot(a.page)).some(e => e.id === 'reload-unsaved')).toBe(false);
    expect((await snapshot(a.page)).find(e => e.id === 'reload-saved')?.x).toBe(120);
  } finally { await a.context.close(); await b.context.close(); }
});

test('browser adapter: concurrent moves, delete/edit, selective undo preserve convergence after restart', async ({ browser }) => {
  const a = await join(browser, 'Alice'); const b = await join(browser, 'Bob');
  try {
    await a.page.evaluate(() => window.__board!.add('conflict-shared', 100));
    console.log('Browser conflicts: seeded');
    await assertEditorConvergence(a.page, b.page);
    await Promise.all([a.page.getByTestId('toggle-connection').click(), b.page.getByTestId('toggle-connection').click()]);
    await a.page.evaluate(() => window.__board!.patch('conflict-shared', { x: 210, y: 211 }));
    await b.page.evaluate(() => window.__board!.patch('conflict-shared', { x: 310, y: 311 }));
    await Promise.all([a.page.getByTestId('toggle-connection').click(), b.page.getByTestId('toggle-connection').click()]);
    await expect(a.page.getByTestId('connection')).toHaveText('Подключено');
    await expect(b.page.getByTestId('connection')).toHaveText('Подключено');
    await assertEditorConvergence(a.page, b.page);
    const winner = (await snapshot(a.page)).find(e => e.id === 'conflict-shared')!;
    expect([[210, 211], [310, 311]]).toContainEqual([winner.x, winner.y]);
    console.log('Browser conflicts: concurrent moves converged', winner.x, winner.y);

    await a.page.evaluate(() => window.__board!.patch('conflict-shared', { x: 410 }));
    await assertEditorConvergence(a.page, b.page);
    await b.page.evaluate(() => window.__board!.patch('conflict-shared', { x: 510 }));
    await assertEditorConvergence(a.page, b.page);
    await a.page.getByRole('button', { name: 'Отменить моё', exact: true }).click();
    await assertEditorConvergence(a.page, b.page);
    expect((await snapshot(a.page)).find(e => e.id === 'conflict-shared')?.x).toBe(510);
    console.log('Browser conflicts: selective undo preserved Bob');

    await Promise.all([a.page.getByTestId('toggle-connection').click(), b.page.getByTestId('toggle-connection').click()]);
    await a.page.evaluate(() => window.__board!.patch('conflict-shared', { isDeleted: true }));
    await b.page.evaluate(() => window.__board!.patch('conflict-shared', { x: 610 }));
    await Promise.all([a.page.getByTestId('toggle-connection').click(), b.page.getByTestId('toggle-connection').click()]);
    await expect(a.page.getByTestId('connection')).toHaveText('Подключено');
    await expect(b.page.getByTestId('connection')).toHaveText('Подключено');
    await assertEditorConvergence(a.page, b.page);
    expect((await snapshot(b.page)).find(e => e.id === 'conflict-shared')?.isDeleted).toBe(true);
    console.log('Browser conflicts: delete/edit converged, restarting');
    const expected = await snapshot(a.page);
    await app.stop(); app = createBoardServer({ port: 1235, databasePath }); await app.start();
    const fresh = await join(browser, 'Fresh');
    try { await expect.poll(async () => snapshot(fresh.page)).toEqual(expected); }
    finally { await fresh.context.close(); }
  } finally { await a.context.close(); await b.context.close(); }
});

test('dev sync toggle closes only this client socket, blocks incoming edits, and catches up on reconnect', async ({ browser }, testInfo) => {
  const a = await join(browser, 'Dev-offline'); const b = await join(browser, 'Dev-online');
  const aClosedSockets: string[] = [];
  const bSocketEvents: string[] = [];
  const aNewSockets: string[] = [];
  try {
    await b.page.evaluate(() => window.__board!.add('dev-toggle-shared', 110));
    await assertEditorConvergence(a.page, b.page);
    // Observe the actual WebSocket lifecycle in addition to the editor scene.
    const aSession = await a.context.newCDPSession(a.page);
    await aSession.send('Network.enable');
    aSession.on('Network.webSocketClosed', event => aClosedSockets.push(event.requestId));
    const bSession = await b.context.newCDPSession(b.page);
    await bSession.send('Network.enable');
    bSession.on('Network.webSocketClosed', () => bSocketEvents.push('closed'));
    b.page.on('websocket', () => bSocketEvents.push('new-socket'));
    a.page.on('websocket', ws => aNewSockets.push(ws.url()));

    const bBefore = await snapshot(b.page);
    await a.page.getByRole('button', { name: 'Отключить синхронизацию', exact: true }).click();
    await expect(a.page.getByTestId('connection')).toHaveAttribute('data-state', 'disconnected');
    await expect(a.page.getByTestId('connection')).toHaveText('Соединение отключено');
    await expect.poll(() => aClosedSockets.length).toBe(1);
    await expect(b.page.getByTestId('connection')).toHaveAttribute('data-state', 'connected');
    await expect(b.page.getByTestId('participants')).not.toContainText('Dev-offline');
    const aOffline = await snapshot(a.page);

    // The online client continues editing through the same server and socket.
    await b.page.evaluate(() => {
      window.__board!.patch('dev-toggle-shared', { x: 660 });
      window.__board!.add('dev-toggle-online-created', 740);
    });
    await expect(b.page.getByTestId('connection')).toHaveText('Подключено');
    const health = await b.page.request.get('/api/health');
    expect(health.ok()).toBe(true);
    expect((await health.json()).ok).toBe(true);

    // A negative assertion needs a bounded observation window, not an immediate check.
    await a.page.waitForTimeout(750);
    expect(await snapshot(a.page)).toEqual(aOffline);
    expect((await snapshot(a.page)).find(e => e.id === 'dev-toggle-shared')?.x).toBe(110);
    expect((await snapshot(a.page)).some(e => e.id === 'dev-toggle-online-created')).toBe(false);

    await a.page.evaluate(() => window.__board!.add('dev-toggle-offline-created', 830));
    await a.page.waitForTimeout(250);
    expect((await snapshot(b.page)).some(e => e.id === 'dev-toggle-offline-created')).toBe(false);
    expect(bSocketEvents).toEqual([]);

    await a.page.getByRole('button', { name: 'Подключить синхронизацию', exact: true }).click();
    await expect(a.page.getByTestId('connection')).toHaveAttribute('data-state', 'connected');
    await expect(a.page.getByTestId('connection')).toHaveText('Подключено');
    await assertEditorConvergence(a.page, b.page);
    expect(aNewSockets).toHaveLength(1);
    expect(bSocketEvents).toEqual([]);
    const converged = await snapshot(a.page);
    expect(converged.find(e => e.id === 'dev-toggle-shared')?.x).toBe(660);
    expect(converged.some(e => e.id === 'dev-toggle-online-created')).toBe(true);
    expect(converged.some(e => e.id === 'dev-toggle-offline-created')).toBe(true);
    expect(converged.length).toBe(bBefore.length + 2);
    await testInfo.attach('dev-sync-check', {
      body: JSON.stringify({ isolatedContexts: 2, offlineObservationMs: 750, missedUpdatesReceivedAfterReconnect: true, localOfflineEditMerged: true, closedSocketsA: aClosedSockets.length, newSocketsA: aNewSockets.length, socketEventsB: bSocketEvents, serverHealth: health.status() }, null, 2),
      contentType: 'application/json',
    });
    await aSession.detach(); await bSession.detach();
  } finally { await a.context.close(); await b.context.close(); }
});
