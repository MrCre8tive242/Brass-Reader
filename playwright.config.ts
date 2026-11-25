import { defineConfig } from '@playwright/test';

const PORT = 3100;
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'off',
    viewport: { width: 375, height: 812 },
    launchOptions: {
      executablePath: '/opt/pw-browsers/chromium',
      args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
    },
  },
  webServer: {
    command: `npx next dev -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
