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
  // The video tests encode 1080p pictures and keep every core busy. Listed first, they run at the start, next to
  // screen-only tests, and are over long before the microphone tests (which the squeeze would make miss notes).
  projects: [
    { name: 'video', testMatch: /[\\/]video\.spec\.ts$/ },
    { name: 'app', testIgnore: /[\\/]video\.spec\.ts$/ },
  ],
  webServer: {
    command: `npx next dev -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
