import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 90000,
  expect: { timeout: 12000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { actionTimeout: 12000, baseURL: 'http://127.0.0.1:5174', viewport: { width: 1440, height: 960 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: {
    command: 'pnpm web --port 5174', url: 'http://127.0.0.1:5174', reuseExistingServer: false, timeout: 60000,
    env: { SYNC_PORT: '1235' },
  },
});
