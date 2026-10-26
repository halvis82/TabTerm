import jsQR from 'jsqr';

/**
 * Reading the pairing code with the camera, inside the page.
 *
 * The camera app would open the code's link in Safari, and an app added to the Home Screen keeps
 * its own storage, so a code scanned that way never pairs the app. Read here, the link lands in the
 * page that asked for it.
 *
 * jsQR rather than the browser's BarcodeDetector, which Safari on an iPhone does not have, so every
 * device reads codes the same way. Nothing runs and the camera stays off until Scan is pressed.
 */

/** Any QR code in one frame of RGBA pixels, either way round, as the text it holds. */
export function readCode(rgba: Uint8ClampedArray, width: number, height: number): string | null {
  return jsQR(rgba, width, height, { inversionAttempts: 'attemptBoth' })?.data ?? null;
}

/** Frames are read at most this wide. Enough for a code that fills part of the view, and quick. */
const READ_WIDTH = 640;
const READ_EVERY_MS = 150;

export interface Scan {
  stop(): void;
}

/**
 * Shows the camera in `video` and calls `found` with the first code `accept` takes. Codes it does
 * not take are passed over and the scan goes on. The camera is let go on success and on `stop`.
 */
export async function startScan(
  video: HTMLVideoElement,
  accept: (text: string) => boolean,
  found: (text: string) => void,
): Promise<Scan> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment' },
    audio: false,
  });
  let running = true;
  let timer = 0;
  const stop = (): void => {
    running = false;
    clearTimeout(timer);
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
  };
  video.srcObject = stream;
  await video.play().catch(() => undefined);

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const look = (): void => {
    if (!running) return;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (ctx && w > 0 && h > 0) {
      const scale = Math.min(1, READ_WIDTH / w);
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const text = readCode(
        ctx.getImageData(0, 0, canvas.width, canvas.height).data,
        canvas.width,
        canvas.height,
      );
      if (text !== null && accept(text)) {
        stop();
        found(text);
        return;
      }
    }
    timer = window.setTimeout(look, READ_EVERY_MS);
  };
  look();
  return { stop };
}
