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

async function requireWebGPU(
  page: Page,
  snapshot: { state: string; backend: string | null; error?: string | null },
): Promise<void> {
  const available = await page.evaluate(async () => {
    const gpu = (navigator as Navigator & {
      gpu?: { requestAdapter(): Promise<unknown | null> };
    }).gpu;
    return gpu ? (await gpu.requestAdapter()) !== null : false;
  });
  if (process.env.SOG_REQUIRE_WEBGPU === '1') expect(available, 'WebGPU is required for this release gate.').toBe(true);
  test.skip(!available, 'WebGPU is unavailable in this browser environment.');
  expect(snapshot.state, snapshot.error ?? undefined).toBe('ready');
  expect(snapshot.backend).toBe('webgpu');
}

async function measureCanvasChromaticity(page: Page): Promise<{
  foregroundPixels: number;
  chromaticPixels: number;
  chromaticRatio: number;
  maximumChannelSpread: number;
}> {
  const screenshot = await page.locator('canvas').screenshot();
  return page.evaluate(async (encodedScreenshot) => {
    const image = new Image();
    image.src = `data:image/png;base64,${encodedScreenshot}`;
    await image.decode();
    const copy = document.createElement('canvas');
    copy.width = image.naturalWidth;
    copy.height = image.naturalHeight;
    const context = copy.getContext('2d', { willReadFrequently: true })!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, copy.width, copy.height).data;
    let foregroundPixels = 0;
    let chromaticPixels = 0;
    let maximumChannelSpread = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      const red = pixels[offset]!;
      const green = pixels[offset + 1]!;
      const blue = pixels[offset + 2]!;
      const maximum = Math.max(red, green, blue);
      if (maximum < 24) continue;
      foregroundPixels += 1;
      const spread = maximum - Math.min(red, green, blue);
      maximumChannelSpread = Math.max(maximumChannelSpread, spread);
      if (spread >= 8) chromaticPixels += 1;
    }
    return {
      foregroundPixels,
      chromaticPixels,
      chromaticRatio: foregroundPixels > 0 ? chromaticPixels / foregroundPixels : 0,
      maximumChannelSpread,
    };
  }, screenshot.toString('base64'));
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
    await requireWebGPU(page, snapshot);
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
  await requireWebGPU(page, snapshot);
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
  await requireWebGPU(page, snapshot);
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
    if (backend === 'webgpu') await requireWebGPU(page, snapshot);
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
    if (backend === 'webgpu') await requireWebGPU(page, initial);
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
    if (backend === 'webgpu') expect(performance?.radixBackend).toMatch(/^(portable|onesweep)$/);
    else expect(performance?.radixBackend).toBeNull();
    expect(performance?.radixBits).toBe(backend === 'webgpu' ? 16 : 0);
    if (backend === 'webgpu') expect(performance?.radixSelectionReason).toEqual(expect.any(String));
    else expect(performance?.radixSelectionReason).toBeNull();
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
    if (backend === 'webgpu') {
      const chromaticity = await measureCanvasChromaticity(page);
      expect(chromaticity.foregroundPixels).toBeGreaterThan(1_000);
      expect(chromaticity.chromaticRatio).toBeGreaterThan(0.05);
      expect(chromaticity.maximumChannelSpread).toBeGreaterThan(20);
    }

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

    await page.locator('#source').selectOption('tomatoes');
    await page.waitForFunction(() => {
      const state = window.__THREE_SOG_EXAMPLE__;
      return state?.state === 'ready' && state.source === 'tomatoes';
    });
    const tomatoesModel = await page.evaluate(() => window.__THREE_SOG_EXAMPLE__);
    expect(tomatoesModel.backend).toBe(backend);
    expect(tomatoesModel.splatCount).toBe(445_409);
    expect(tomatoesModel.sourceSplatCount).toBe(445_409);
    expect(tomatoesModel.runtimeCopyCount).toBe(1);
    await expect(page.locator('#status')).toContainText('445,409 splats');
    await expect(page.locator('#license')).toContainText('Grail');

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

test('controlled profiler isolates cached rendering, resolution, and camera-update stages', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/webgpu_sog.html?source=no-sh');
  await page.waitForFunction(() => ['ready', 'failed'].includes(window.__THREE_SOG_EXAMPLE__?.state));
  const initial = await page.evaluate(() => window.__THREE_SOG_EXAMPLE__);
  await requireWebGPU(page, initial);

  await page.getByRole('button', { name: 'Analyze bottleneck' }).click();
  await page.waitForFunction(() => (
    ['complete', 'failed'].includes(window.__THREE_SOG_EXAMPLE__?.analysisState)
  ));
  const result = await page.evaluate(() => ({
    state: window.__THREE_SOG_EXAMPLE__.state,
    analysisState: window.__THREE_SOG_EXAMPLE__.analysisState,
    analysis: window.__THREE_SOG_EXAMPLE__.analysis,
    methodType: typeof window.__THREE_SOG_EXAMPLE__.runBottleneckAnalysis,
  }));

  expect(result.state).toBe('ready');
  expect(result.analysisState).toBe('complete');
  expect(result.methodType).toBe('function');
  expect(result.analysis?.splatCount).toBe(116_374);
  expect(result.analysis?.scenarios.map((scenario) => scenario.id)).toEqual(expect.arrayContaining([
    'empty',
    'full',
    'full-no-contribution-culling',
    'half-resolution',
    'quarter-resolution',
    'quarter-scale',
  ]));
  const full = result.analysis?.scenarios.find((scenario) => scenario.id === 'full');
  expect(full?.instanceCount).toBe(116_374);
  expect(full?.drawCalls).toBeGreaterThan(0);
  expect(full?.cullingSubmitted).toBe(116_374);
  expect(full?.cullingVisible).toBeGreaterThan(0);
  expect(full?.cullingVisible).toBeLessThanOrEqual(116_374);
  expect(full?.triangles).toBe((full?.cullingVisible ?? 0) * 2);
  expect(result.analysis?.findings.length).toBeGreaterThan(0);
  expect(result.analysis?.findings.some((finding) => (
    finding.stage === 'cached-screen-space-fetch'
  ))).toBe(true);
  expect(result.analysis?.findings.some((finding) => (
    finding.stage === 'contribution-culling'
  ))).toBe(true);
  expect(result.analysis?.cameraUpdate?.computePasses).toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: 'Analyze bottleneck' })).toBeEnabled();
  expect(errors).toEqual([]);
});

test('builds the 4.88M Lion grid from one downloaded and prepared source', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (/GPUValidationError|validation error|buffer is not big enough/i.test(message.text())) {
      errors.push(message.text());
    }
  });
  await page.goto('/webgpu_sog.html?source=lion-grid-5m');
  await page.waitForFunction(() => ['ready', 'failed'].includes(window.__THREE_SOG_EXAMPLE__?.state));
  const initial = await page.evaluate(() => window.__THREE_SOG_EXAMPLE__);
  await requireWebGPU(page, initial);

  expect(initial.source).toBe('lion-grid-5m');
  expect(initial.sourceSplatCount).toBe(195_099);
  expect(initial.runtimeCopyCount).toBe(25);
  expect(initial.splatCount).toBe(4_877_475);
  await expect(page.locator('#source')).toHaveValue('lion-grid-5m');
  await expect(page.locator('#status')).toContainText('4,877,475 splats');
  await expect(page.locator('#license')).toContainText('one full SOG download');
  await page.waitForFunction(() => (window.__THREE_SOG_EXAMPLE__.performance?.sampleFrames ?? 0) >= 10);
  const snapshot = await page.evaluate(() => ({
    performance: window.__THREE_SOG_EXAMPLE__.performance,
    resources: performance.getEntriesByType('resource').map((entry) => entry.name),
  }));
  expect(snapshot.performance?.activeSplatCount).toBe(4_877_475);
  expect(snapshot.performance?.sourceSplatCount).toBe(195_099);
  expect(snapshot.performance?.runtimeCopyCount).toBe(25);
  expect(snapshot.performance?.drawCalls).toBe(2);
  expect(snapshot.performance?.triangles).toBe(9_754_951);
  expect(snapshot.performance?.computePasses).toBe(0);
  expect(snapshot.performance?.staticDecodeDurationMs).toBeGreaterThanOrEqual(0);
  expect(snapshot.performance?.projectionRefreshCount).toBeGreaterThan(0);
  expect(snapshot.resources.filter((url) => url.endsWith('/lion.sog'))).toHaveLength(1);
  expect(snapshot.resources.some((url) => /lion-grid-5m\.sog/.test(url))).toBe(false);

  await page.getByRole('button', { name: 'Read culling telemetry' }).click();
  await page.waitForFunction(() => window.__THREE_SOG_EXAMPLE__.cullingStats !== null);
  const culled = await page.evaluate(() => window.__THREE_SOG_EXAMPLE__.cullingStats!);
  expect(culled.submitted).toBe(4_877_475);
  expect(culled.visible).toBeGreaterThan(0);
  expect(culled.visible).toBeLessThan(culled.submitted);
  expect(
    culled.visible + culled.behindOrAlpha + culled.outsideFrustum + culled.lowContribution,
  ).toBe(culled.submitted);

  await page.getByRole('checkbox', { name: 'Contribution culling' }).uncheck();
  await page.waitForFunction(() => window.__THREE_SOG_EXAMPLE__.cullingStats === null);
  await page.waitForTimeout(250);
  await page.getByRole('button', { name: 'Read culling telemetry' }).click();
  await page.waitForFunction(() => window.__THREE_SOG_EXAMPLE__.cullingStats !== null);
  const uncull = await page.evaluate(() => window.__THREE_SOG_EXAMPLE__.cullingStats!);
  expect(uncull).toEqual({
    submitted: 4_877_475,
    visible: 4_877_475,
    behindOrAlpha: 0,
    outsideFrustum: 0,
    lowContribution: 0,
  });
  await page.getByRole('checkbox', { name: 'Contribution culling' }).check();
  expect(errors).toEqual([]);
});

test('loads the complete 4.93M Moon as one unique SH3 mesh', async ({ page }) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (/GPUValidationError|validation error|buffer is not big enough/i.test(message.text())) {
      errors.push(message.text());
    }
  });
  await page.goto('/webgpu_sog.html?source=moon-5m');
  await page.waitForFunction(() => ['ready', 'failed'].includes(window.__THREE_SOG_EXAMPLE__?.state));
  const initial = await page.evaluate(() => window.__THREE_SOG_EXAMPLE__);
  await requireWebGPU(page, initial);

  expect(initial.source).toBe('moon-5m');
  expect(initial.sourceSplatCount).toBe(4_929_011);
  expect(initial.runtimeCopyCount).toBe(1);
  expect(initial.splatCount).toBe(4_929_011);
  await expect(page.locator('#source')).toHaveValue('moon-5m');
  await expect(page.locator('#status')).toContainText('4,929,011 splats');
  await expect(page.locator('#license')).toContainText('Nicolas Diolez');
  await page.waitForFunction(() => (window.__THREE_SOG_EXAMPLE__.performance?.sampleFrames ?? 0) >= 10);

  const snapshot = await page.evaluate(() => ({
    culling: window.__THREE_SOG_EXAMPLE__.cullingStats,
    performance: window.__THREE_SOG_EXAMPLE__.performance,
    resources: performance.getEntriesByType('resource').map((entry) => entry.name),
  }));
  expect(snapshot.performance?.projectedCacheEnabled).toBe(false);
  expect(snapshot.performance?.contributionCullingEnabled).toBe(false);
  expect(snapshot.performance?.sourceSplatCount).toBe(4_929_011);
  expect(snapshot.performance?.runtimeCopyCount).toBe(1);
  expect(snapshot.performance?.allocatedGpuBytes).toBeLessThan(300 * 1024 * 1024);
  expect(snapshot.performance?.allocatedCpuBytes).toBeGreaterThan(90 * 1024 * 1024);
  expect(snapshot.performance?.allocatedCpuBytes).toBeLessThan(150 * 1024 * 1024);
  expect(snapshot.culling).toBeNull();
  await expect(page.getByRole('button', { name: 'Read culling telemetry' })).toBeDisabled();
  expect(snapshot.resources.filter((url) => url.endsWith('/moon.sog'))).toHaveLength(1);
  expect(errors).toEqual([]);
});

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

test('cached SH color agrees with an independent DC cancellation oracle and native rendering', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__SOG_EXAMPLE__?.state === 'ready');
  await requireWebGPU(page, await page.evaluate(() => window.__SOG_EXAMPLE__));
  const result = await page.evaluate(async () => {
    const moduleUrl = '/regression.ts';
    return (await import(/* @vite-ignore */ moduleUrl)).compareCachedColor();
  });
  for (let channel = 0; channel < 3; channel += 1) {
    expect(result.native[channel]).toBeCloseTo(0.9, 2);
    expect(Math.abs(result.cached[channel] - result.native[channel])).toBeLessThan(0.01);
  }
});

test('Tomatoes keeps applying sorted orders during sustained WebGL motion', async ({ page }) => {
  await page.goto('/webgpu_sog.html?source=tomatoes&backend=webgl');
  await page.waitForFunction(() => window.__THREE_SOG_EXAMPLE__?.state === 'ready');
  const start = await page.evaluate(() => {
    window.__THREE_SOG_EXAMPLE__.startCameraMotion();
    return window.__THREE_SOG_EXAMPLE__.totalSortCount;
  });
  await page.waitForTimeout(2500);
  const end = await page.evaluate(() => window.__THREE_SOG_EXAMPLE__.totalSortCount);
  expect(end - start).toBeGreaterThan(3);
  await page.evaluate(() => window.__THREE_SOG_EXAMPLE__.stopCameraMotion());
});
