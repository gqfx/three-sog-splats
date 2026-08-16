import { defineConfig } from '@playwright/test';

const chromeExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ?? (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : undefined);
const testPort = process.env.PLAYWRIGHT_PORT ?? '4173';
const testBaseUrl = `http://127.0.0.1:${testPort}`;

export default defineConfig({
  testDir: './tests/browser',
  timeout: 30_000,
  snapshotPathTemplate: '{testDir}/{testFilePath}-snapshots/{arg}{ext}',
  use: {
    baseURL: testBaseUrl,
    browserName: 'chromium',
    headless: true,
    viewport: { width: 960, height: 640 },
    launchOptions: {
      ...(chromeExecutable ? { executablePath: chromeExecutable } : {}),
      args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer'],
    },
  },
  webServer: {
    command: `npm run example -- --host 127.0.0.1 --port ${testPort}`,
    url: testBaseUrl,
    reuseExistingServer: true,
  },
});
