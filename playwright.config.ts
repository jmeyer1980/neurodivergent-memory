import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests for the two web UIs the bridge serves.
 *
 * These exist because a whole class of defect in this project is invisible to
 * `node:test`: rotated cards that cannot be hit-tested, a chrome bar overflowing
 * its viewport, a touch-scroll path that was declared but never wired, an SSE
 * stream left idle long enough for a phone to reap it, an unbounded drum that
 * took the tab's renderer with it. Every one of those was found by driving a
 * browser, and none of them by unit tests.
 *
 * Deliberately NOT part of `npm test`, which stays fast and offline.
 * Run them with `npm run test:browser`.
 *
 * WebKit matters more than it looks: it is the engine EVERY iOS browser uses
 * (Safari, Edge and DuckDuckGo on iOS all reproduced the same defects), so it is
 * the closest thing here to the device where they actually showed up. Know its
 * limits though — Playwright's WebKit exposes no CDP and its touchscreen API is
 * tap-only, so it can gate layout and JS routing but cannot answer "would the
 * browser have scrolled or zoomed this natively". Device confirmation is still
 * required for anything gesture-shaped.
 */
const PORT = Number(process.env.ND_MEM_BRIDGE_TEST_PORT || 3799);

export default defineConfig({
  testDir: './e2e',
  // The bridge is shared state — one memories.json, one SSE broadcast — so
  // specs must not race each other across workers.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'list' : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'desktop-chrome', use: { ...devices['Desktop Chrome'] } },
    // iPhone 15 portrait: the viewport every mobile defect was reported at.
    { name: 'mobile-safari', use: { ...devices['iPhone 15'] } },
  ],
  webServer: {
    command: 'node scripts/nd-mem-bridge-server.mjs',
    url: `http://127.0.0.1:${PORT}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: {
      ND_MEM_BRIDGE_PORT: String(PORT),
      ND_MEM_BRIDGE_OPEN: '0',
    },
  },
});
