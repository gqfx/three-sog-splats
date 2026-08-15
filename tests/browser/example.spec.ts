import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const fixtureExpected = JSON.parse(await readFile(
  new URL('../fixtures/expected.json', import.meta.url),
  'utf8',
)) as {
  rgbaTexels: Record<string, number[]>;
  webpChannelTolerance: number;
};

async function waitForStableSort(page: Page): Promise<number> {
  let previous = -1;
  let stableSamples = 0;
  for (let sample = 0; sample < 20; sample += 1) {
    const current = await page.evaluate(() => window.__SOG_EXAMPLE__.diagnostics?.sortCount ?? 0);
    stableSamples = current === previous ? stableSamples + 1 : 0;
    if (stableSamples >= 3) return current;
    previous = current;
    await page.waitForTimeout(100);
  }
  throw new Error('SOG sort count did not become stable.');
}

for (const fixture of ['no-sh', 'sh'] as const) {
  test(`forced WebGL backend renders ${fixture}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (/GL_INVALID_OPERATION|buffer is not big enough/i.test(message.text())) errors.push(message.text());
    });
    await page.goto(`/?backend=webgl&fixture=${fixture === 'sh' ? 'sh' : 'no-sh'}`);
    await page.waitForFunction(() => window.__SOG_EXAMPLE__?.state === 'ready');
    await page.waitForFunction(() => (window.__SOG_EXAMPLE__?.diagnostics?.firstVisibleFrameDurationMs ?? 0) > 0);
    await waitForStableSort(page);
    const snapshot = await page.evaluate(() => window.__SOG_EXAMPLE__);
    expect(snapshot.backend).toBe('webgl');
    expect(snapshot.diagnostics?.readbackCount).toBe(1);
    expect(snapshot.diagnostics?.deferredUploadCount).toBe(0);
    expect(snapshot.diagnostics?.deferredCompileCount).toBe(0);
    expect(errors).toEqual([]);
    await page.locator('aside').evaluate((element) => { element.style.visibility = 'hidden'; });
    if (fixture === 'sh') {
      const [actual, noSh] = await Promise.all([
        page.locator('canvas').screenshot(),
        readFile(new URL('./example.spec.ts-snapshots/webgl-no-sh.png', import.meta.url)),
      ]);
      expect(actual.equals(noSh), 'SH output must differ from the no-SH reference').toBe(false);
    }
    await expect(page.locator('canvas')).toHaveScreenshot(`webgl-${fixture}.png`, {
      maxDiffPixelRatio: 0.015,
      threshold: 0.25,
    });

    const before = await waitForStableSort(page);
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => window.__SOG_EXAMPLE__.diagnostics?.sortCount)).toBe(before);
    await page.evaluate(() => window.__SOG_EXAMPLE__.moveCamera());
    await expect.poll(() => page.evaluate(() => window.__SOG_EXAMPLE__.diagnostics?.sortCount ?? 0)).toBeGreaterThan(before);
    expect(await page.evaluate(() => window.__SOG_EXAMPLE__.diagnostics?.readbackCount)).toBe(1);
    await page.evaluate(() => {
      window.__SOG_EXAMPLE__.moveCamera();
      window.__SOG_EXAMPLE__.dispose();
    });
    expect(await page.evaluate(() => window.__SOG_EXAMPLE__.state)).toBe('disposed');
    expect(errors).toEqual([]);
  });
}

for (const fixture of ['no-sh', 'sh'] as const) {
  test(`uses WebGPU without readback for ${fixture} when available`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (/GPUValidationError|validation error|GL_INVALID_OPERATION/i.test(message.text())) errors.push(message.text());
    });
    await page.goto(`/?fixture=${fixture}`);
    await page.waitForFunction(() => ['ready', 'failed'].includes(window.__SOG_EXAMPLE__?.state));
    const snapshot = await page.evaluate(() => window.__SOG_EXAMPLE__);
    if (snapshot.state !== 'ready' || snapshot.backend !== 'webgpu') test.skip(true, 'WebGPU is unavailable in this browser environment.');
    await page.waitForFunction(() => (window.__SOG_EXAMPLE__?.diagnostics?.firstVisibleFrameDurationMs ?? 0) > 0);
    expect(snapshot.diagnostics?.readbackCount).toBe(0);
    expect(snapshot.diagnostics?.activeSplatCount).toBe(4);
    if (fixture === 'no-sh') {
      expect(await page.evaluate(() => window.__SOG_EXAMPLE__.verifyGpuSort())).toEqual([1, 0, 3, 2]);
      expect((await page.evaluate(() => window.__SOG_EXAMPLE__.diagnostics?.readbackCount))).toBe(0);
    }
    expect(errors).toEqual([]);
    await page.locator('aside').evaluate((element) => { element.style.visibility = 'hidden'; });
    if (fixture === 'sh') {
      const [actual, noSh] = await Promise.all([
        page.locator('canvas').screenshot(),
        readFile(new URL('./example.spec.ts-snapshots/webgpu-no-sh.png', import.meta.url)),
      ]);
      expect(actual.equals(noSh), 'SH output must differ from the no-SH reference').toBe(false);
    }
    await expect(page.locator('canvas')).toHaveScreenshot(`webgpu-${fixture}.png`, {
      maxDiffPixelRatio: 0.015,
      threshold: 0.25,
    });
  });
}

for (const backend of ['webgpu', 'webgl'] as const) {
  test(`renders the real Three.js millipede fixture with ${backend}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (/GPUValidationError|validation error|GL_INVALID_OPERATION|buffer is not big enough/i.test(message.text())) {
        errors.push(message.text());
      }
    });
    await page.goto(`/?fixture=real${backend === 'webgl' ? '&backend=webgl' : ''}`);
    await page.waitForFunction(() => ['ready', 'failed'].includes(window.__SOG_EXAMPLE__?.state));
    const snapshot = await page.evaluate(() => window.__SOG_EXAMPLE__);
    if (backend === 'webgpu' && (snapshot.state !== 'ready' || snapshot.backend !== 'webgpu')) {
      test.skip(true, 'WebGPU is unavailable in this browser environment.');
    }
    expect(snapshot.state, snapshot.error ?? undefined).toBe('ready');
    expect(snapshot.backend).toBe(backend);
    expect(snapshot.fixture).toBe('millipede.sog');
    expect(snapshot.diagnostics?.activeSplatCount).toBe(116_374);
    expect(snapshot.diagnostics?.readbackCount).toBe(backend === 'webgl' ? 1 : 0);
    expect(snapshot.diagnostics?.deferredUploadCount).toBe(0);
    expect(snapshot.diagnostics?.deferredCompileCount).toBe(0);
    expect(errors).toEqual([]);
    await waitForStableSort(page);
    await page.locator('aside').evaluate((element) => { element.style.visibility = 'hidden'; });
    await expect(page.locator('canvas')).toHaveScreenshot(`${backend}-millipede.png`, {
      maxDiffPixelRatio: 0.025,
      threshold: 0.25,
    });

    const before = await page.evaluate(() => window.__SOG_EXAMPLE__.diagnostics?.sortCount ?? 0);
    await page.evaluate(() => window.__SOG_EXAMPLE__.moveCamera());
    await expect.poll(() => page.evaluate(
      () => window.__SOG_EXAMPLE__.diagnostics?.sortCount ?? 0,
    )).toBeGreaterThan(before);
    expect(await page.evaluate(() => window.__SOG_EXAMPLE__.diagnostics?.readbackCount))
      .toBe(backend === 'webgl' ? 1 : 0);
  });
}

for (const backend of ['webgpu', 'webgl'] as const) {
  test(`Three.js-style example loads and replaces SOG assets with ${backend}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (/GPUValidationError|validation error|GL_INVALID_OPERATION|buffer is not big enough/i.test(message.text())) {
        errors.push(message.text());
      }
    });
    await page.goto(`/webgpu_sog.html?source=millipede${backend === 'webgl' ? '&backend=webgl' : ''}`);
    await page.waitForFunction(() => ['ready', 'failed'].includes(window.__THREE_SOG_EXAMPLE__?.state));
    const initial = await page.evaluate(() => window.__THREE_SOG_EXAMPLE__);
    if (backend === 'webgpu' && (initial.state !== 'ready' || initial.backend !== 'webgpu')) {
      test.skip(true, 'WebGPU is unavailable in this browser environment.');
    }
    expect(initial.state, initial.error ?? undefined).toBe('ready');
    expect(initial.backend).toBe(backend);
    expect(initial.source).toBe('millipede');
    expect(initial.splatCount).toBe(116_374);
    await expect(page.locator('#status')).toContainText('116,374 splats');
    await expect(page.locator('#license')).toContainText('Fabian Plum');

    await page.locator('#source').selectOption('no-sh');
    await page.waitForFunction(() => {
      const state = window.__THREE_SOG_EXAMPLE__;
      return state?.state === 'ready' && state.source === 'no-sh';
    });
    const replaced = await page.evaluate(() => window.__THREE_SOG_EXAMPLE__);
    expect(replaced.backend).toBe(backend);
    expect(replaced.splatCount).toBe(4);
    expect(errors).toEqual([]);
  });
}

test('decodes known WebP values without browser image transformations', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__SOG_EXAMPLE__?.state === 'ready');
  for (const [filename, expected] of Object.entries(fixtureExpected.rgbaTexels)) {
    const actual = await page.evaluate(
      (imageFilename) => window.__SOG_EXAMPLE__.decodeFixtureTexel(imageFilename),
      filename,
    );
    expect(actual, filename).toHaveLength(4);
    for (let channel = 0; channel < 4; channel += 1) {
      expect(
        Math.abs(actual[channel]! - expected[channel]!),
        `${filename} channel ${channel}`,
      ).toBeLessThanOrEqual(channel === 3 ? 1 : fixtureExpected.webpChannelTolerance);
    }
  }
});
