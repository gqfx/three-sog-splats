import { zipSync } from 'fflate';
import { FloatType, NoToneMapping, PerspectiveCamera, RenderTarget, Scene, WebGPURenderer } from 'three/webgpu';
import { SOGGaussianSplatMesh, SOGLoader } from '../src/index.js';

/** Independent synthetic DC + SH cancellation oracle, using real GPU pixels. */
export async function compareCachedColor(): Promise<{ cached: number[]; native: number[] }> {
  const filenames = ['means_l.png', 'means_u.png', 'quats.png', 'scales.png', 'sh0.png', 'centroids.png', 'labels.png'];
  const codebook = Array(256).fill(0) as number[];
  const shCodebook = [...codebook]; shCodebook[1] = -0.5 / 0.4886025119029199;
  const meta = {
    version: 2, count: 1,
    means: { mins: [0, 0, 0], maxs: [0, 0, 0], files: filenames.slice(0, 2) },
    quats: { files: [filenames[2]] }, scales: { files: [filenames[3]], codebook: Array(256).fill(-1.5) },
    sh0: { files: [filenames[4]], codebook: Array(256).fill((1.4 - 0.5) / 0.28209479177387814) },
    shN: { files: filenames.slice(5), count: 1, bands: 1, codebook: shCodebook },
  };
  const archive = zipSync(Object.fromEntries([
    ['meta.json', new TextEncoder().encode(JSON.stringify(meta))],
    ...filenames.map((name) => [name, new Uint8Array([1])]),
  ]));
  const resource = await new SOGLoader().loadAsync('oracle.sog', {
    fetch: async () => new Response(archive), useArchiveWorker: false,
    imageDecoder: { decode: async (_bytes, filename) => {
      const canvas = document.createElement('canvas'); canvas.width = filename === 'centroids.png' ? 192 : 1; canvas.height = 1;
      const context = canvas.getContext('2d')!;
      const pixels = context.createImageData(canvas.width, 1);
      for (let i = 0; i < canvas.width; i += 1) pixels.data[i * 4 + 3] = 255;
      if (filename === 'quats.png') pixels.data.set([128, 128, 128, 252]);
      if (filename === 'centroids.png') pixels.data.set([1, 1, 1, 255], 4);
      context.putImageData(pixels, 0, 0);
      return { attribute: 'sh0', filename, width: canvas.width, height: 1, source: canvas, close() {} };
    } },
  });
  const renderer = new WebGPURenderer();
  renderer.toneMapping = NoToneMapping;
  renderer.setSize(65, 65);
  const target = new RenderTarget(65, 65, { type: FloatType });
  const camera = new PerspectiveCamera(50, 1, 0.01, 100);
  camera.position.z = 3; camera.updateMatrixWorld();
  const results: number[][] = [];
  try {
    for (const maxProjectedCacheBytes of [256 * 1024 * 1024, 0]) {
      const mesh = new SOGGaussianSplatMesh(resource).setContributionCullingEnabled(false);
      try {
        await mesh.prepare(renderer, { maxProjectedCacheBytes });
        const scene = new Scene(); scene.add(mesh);
        renderer.setRenderTarget(target); renderer.render(scene, camera); renderer.setRenderTarget(null);
        const pixels = await renderer.readRenderTargetPixelsAsync(target, 32, 32, 1, 1);
        results.push(Array.from(pixels as Float32Array));
      } finally { mesh.dispose(); }
    }
  } finally { target.dispose(); renderer.dispose(); resource.dispose(); }
  return { cached: results[0]!, native: results[1]! };
}
