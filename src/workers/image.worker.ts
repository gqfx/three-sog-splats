/// <reference lib="webworker" />

interface DecodeMessage {
  buffer: ArrayBuffer;
  mimeType: string;
}

self.onmessage = async (event: MessageEvent<DecodeMessage>) => {
  try {
    const bitmap = await createImageBitmap(new Blob([event.data.buffer], { type: event.data.mimeType }), {
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
      imageOrientation: 'none',
    });
    self.postMessage({ bitmap }, { transfer: [bitmap] });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};

export {};
