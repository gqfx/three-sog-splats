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
    expect(snapshot.diagnostics?.radixBackend).toBeNull();
    expect(snapshot.diagnostics?.radixBits).toBe(0);
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
    expect(snapshot.diagnostics?.radixBackend).toMatch(/^(portable|onesweep)$/);
    expect(snapshot.diagnostics?.radixBits).toBeGreaterThanOrEqual(12);
    expect(snapshot.diagnostics?.radixSelectionReason).not.toBeNull();
    expect(snapshot.diagnostics?.activeSplatCount).toBe(4);
    if (fixture === 'no-sh') {
      const verification = await page.evaluate(() => window.__SOG_EXAMPLE__.verifyGpuSort());
      expect(verification.complete).toBe(true);
      expect(verification.monotonic).toBe(true);
      expect(verification.stable).toBe(true);
      expect(verification.order).toHaveLength(4);
      expect([...verification.order].sort((left, right) => left - right)).toEqual([0, 1, 2, 3]);
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

test('validates Portable radix edge fixtures on WebGPU when available', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (/GPUValidationError|validation error/i.test(message.text())) errors.push(message.text());
  });
  await page.goto('/?fixture=no-sh');
  await page.waitForFunction(() => ['ready', 'failed'].includes(window.__SOG_EXAMPLE__?.state));
  const snapshot = await page.evaluate(() => window.__SOG_EXAMPLE__);
  if (snapshot.state !== 'ready' || snapshot.backend !== 'webgpu') {
    test.skip(true, 'WebGPU is unavailable in this browser environment.');
  }
  const fixtures = await page.evaluate(() => window.__SOG_EXAMPLE__.verifyPortableRadixFixtures());
  expect(Object.keys(fixtures)).toEqual([
    'empty',
    'singleton',
    'duplicate-heavy',
    'partial-workgroup',
    'multi-workgroup',
    'full-capacity',
  ]);
  for (const [name, result] of Object.entries(fixtures)) {
    expect(result.complete, name).toBe(true);
    expect(result.monotonic, name).toBe(true);
    expect(result.stable, name).toBe(true);
  }
  expect(errors).toEqual([]);
});

test('validates OneSweep against Portable only on admitted hardware', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (/GPUValidationError|validation error/i.test(message.text())) errors.push(message.text());
  });
  await page.goto('/?fixture=no-sh');
  await page.waitForFunction(() => ['ready', 'failed'].includes(window.__SOG_EXAMPLE__?.state));
  const snapshot = await page.evaluate(() => window.__SOG_EXAMPLE__);
  if (snapshot.state !== 'ready' || snapshot.backend !== 'webgpu') {
    test.skip(true, 'WebGPU is unavailable in this browser environment.');
  }
  const verification = await page.evaluate(
    () => window.__SOG_EXAMPLE__.verifyOneSweepIfAdmitted(),
  );
  if (verification.status === 'passed') {
    expect(verification.reason).toBe('validated-nvidia-subgroups');
    expect(verification.portable?.complete).toBe(true);
    expect(verification.portable?.stable).toBe(true);
    expect(verification.onesweep?.complete).toBe(true);
    expect(verification.onesweep?.monotonic).toBe(true);
    expect(verification.onesweep?.stable).toBe(true);
    expect(verification.exactMatch).toBe(true);
  } else {
    expect(verification.reason).not.toBe('validated-nvidia-subgroups');
    expect(verification.portable).toBeNull();
    expect(verification.onesweep).toBeNull();
  }
  expect(errors).toEqual([]);
});

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
    await page.goto(`/webgpu_sog.html?source=no-sh${backend === 'webgl' ? '&backend=webgl' : ''}`);
    await page.waitForFunction(() => ['ready', 'failed'].includes(window.__THREE_SOG_EXAMPLE__?.state));
    const initial = await page.evaluate(() => window.__THREE_SOG_EXAMPLE__);
    if (backend === 'webgpu' && (initial.state !== 'ready' || initial.backend !== 'webgpu')) {
      test.skip(true, 'WebGPU is unavailable in this browser environment.');
    }
    expect(initial.state, initial.error ?? undefined).toBe('ready');
    expect(initial.backend).toBe(backend);
    expect(initial.source).toBe('no-sh');
    expect(initial.splatCount).toBe(116_374);
    await expect(page.locator('#source')).toHaveValue('no-sh');
    await expect(page.locator('#status')).toContainText('116,374 splats');
    await expect(page.locator('#license')).toContainText('Fabian Plum');
    await page.evaluate(() => window.__THREE_SOG_EXAMPLE__.resetPerformance());
    await page.waitForFunction(() => (window.__THREE_SOG_EXAMPLE__.performance?.sampleFrames ?? 0) >= 170);
    const performance = await page.evaluate(() => window.__THREE_SOG_EXAMPLE__.performance);
    expect(performance?.fps).toBeGreaterThan(0);
    expect(performance?.averageFrameMs).toBeGreaterThan(0);
    expect(performance?.backend).toBe(backend);
    expect(performance?.activeSplatCount).toBe(116_374);
    expect(performance?.totalSortCount).toBeGreaterThan(0);
    expect(performance?.sortDurationKind).toBe(
      backend === 'webgpu' ? 'cpu-command-submission' : 'worker-execution',
    );
    expect(performance?.viewport).toEqual({ width: 960, height: 640, dpr: 1 });
    await expect.poll(() => page.evaluate(
      () => window.__THREE_SOG_EXAMPLE__.performance?.sortsPerSecond,
    )).toBe(0);
    await expect(page.locator('#performance-summary')).toContainText('FPS');

    const overlays = page.locator('#info, #controls, #diagnostics');
    await overlays.evaluateAll((elements) => {
      for (const element of elements) (element as HTMLElement).style.visibility = 'hidden';
    });
    await expect(page.locator('canvas')).toHaveScreenshot(`${backend}-public-no-sh.png`, {
      maxDiffPixelRatio: 0.025,
      threshold: 0.25,
    });
    await overlays.evaluateAll((elements) => {
      for (const element of elements) (element as HTMLElement).style.visibility = '';
    });

    const idleSortCount = await page.evaluate(() => window.__THREE_SOG_EXAMPLE__.totalSortCount);
    await page.evaluate(() => window.__THREE_SOG_EXAMPLE__.startCameraMotion());
    await expect.poll(() => page.evaluate(
      () => window.__THREE_SOG_EXAMPLE__.totalSortCount,
    )).toBeGreaterThan(idleSortCount);
    await page.evaluate(() => window.__THREE_SOG_EXAMPLE__.stopCameraMotion());
    const releasedSortCount = await page.evaluate(() => window.__THREE_SOG_EXAMPLE__.totalSortCount);
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => window.__THREE_SOG_EXAMPLE__.totalSortCount))
      .toBeLessThanOrEqual(releasedSortCount + 1);
    await page.waitForFunction(() => (window.__THREE_SOG_EXAMPLE__.performance?.sampleFrames ?? 0) >= 170);
    await expect.poll(() => page.evaluate(
      () => window.__THREE_SOG_EXAMPLE__.performance?.sortsPerSecond,
    )).toBe(0);

    await page.locator('#source').selectOption('sh');
    await page.waitForFunction(() => {
      const state = window.__THREE_SOG_EXAMPLE__;
      return state?.state === 'ready' && state.source === 'sh';
    });
    const shModel = await page.evaluate(() => window.__THREE_SOG_EXAMPLE__);
    expect(shModel.backend).toBe(backend);
    expect(shModel.splatCount).toBe(195_099);
    await expect(page.locator('#status')).toContainText('195,099 splats');
    await expect(page.locator('#license')).toContainText('Renaud');
    await page.waitForFunction(() => (window.__THREE_SOG_EXAMPLE__.performance?.sampleFrames ?? 0) >= 30);
    await expect.poll(() => page.evaluate(
      () => window.__THREE_SOG_EXAMPLE__.performance?.sortsPerSecond,
    )).toBe(0);
    await overlays.evaluateAll((elements) => {
      for (const element of elements) (element as HTMLElement).style.visibility = 'hidden';
    });
    await expect(page.locator('canvas')).toHaveScreenshot(`${backend}-lion-sh2.png`, {
      maxDiffPixelRatio: 0.025,
      threshold: 0.25,
    });
    await overlays.evaluateAll((elements) => {
      for (const element of elements) (element as HTMLElement).style.visibility = '';
    });

    await page.locator('#source').selectOption('no-sh');
    await page.waitForFunction(() => {
      const state = window.__THREE_SOG_EXAMPLE__;
      return state?.state === 'ready' && state.source === 'no-sh';
    });
    const replaced = await page.evaluate(() => window.__THREE_SOG_EXAMPLE__);
    expect(replaced.backend).toBe(backend);
    expect(replaced.splatCount).toBe(116_374);
    await expect(page.locator('#status')).toContainText('116,374 splats');
    await expect(page.locator('#license')).toContainText('Fabian Plum');
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
