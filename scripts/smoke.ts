import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

// Smoke-test a real running build, without development instrumentation.
const url = process.env.SMOKE_URL ?? 'http://127.0.0.1:4173';
await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch();
const errors: string[] = [];
const external = new Set<string>();
try {
  const first = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const second = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const a = await first.newPage(); const b = await second.newPage();
  for (const [page, name] of [[a, 'Саша'], [b, 'Женя']] as const) {
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== new URL(url).origin) external.add(request.url()); });
    await page.goto(url);
    if (page === a) await page.screenshot({ path: 'artifacts/entry.png' });
    await page.getByLabel('Как вас показать на доске?').fill(name);
    await page.getByRole('button', { name: /Открыть общий холст/ }).click();
    await expect(page.getByTestId('connection')).toHaveText('Подключено');
    await expect(page.getByTestId('toggle-connection')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /(?:Отключить|Подключить) синхронизацию/ })).toHaveCount(0);
  }
  expect(await a.evaluate(() => window.__board)).toBeUndefined();
  await expect(a.getByTestId('participants')).toContainText('Женя');
  const initial = Number((await a.getByTestId('object-count').innerText()).match(/\d+/)![0]);
  await a.getByTitle('Прямоугольник — R или 2', { exact: true }).click();
  await a.mouse.move(480, 350); await a.mouse.down(); await a.mouse.move(700, 510, { steps: 15 }); await a.mouse.up();
  await expect(b.getByTestId('object-count')).toHaveText(`Объектов: ${initial + 1}`);
  await a.screenshot({ path: 'artifacts/production-board.png' });
  await a.keyboard.press('Delete');
  await expect(b.getByTestId('object-count')).toHaveText(`Объектов: ${initial}`);
  expect(errors).toEqual([]);
  expect([...external]).toEqual([]);
  const report = { url, result: 'passed', independentContexts: 2, nativeCreateDelete: true, developmentHooksAbsent: true, developmentSyncControlsAbsent: true, pageErrors: errors, externalHttpRequests: [...external] };
  await writeFile('artifacts/smoke.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
