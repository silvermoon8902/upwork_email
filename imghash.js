/* Perceptual image hashing — runs in the service worker via OffscreenCanvas.
 *
 * Tier 1 of the identity match: if the Upwork and ContactOut avatars are the
 * SAME photograph (people reuse one headshot across platforms constantly), a
 * dHash comparison proves it locally — free, instant, no API call, and no
 * face recognition involved.                                                 */

const W = 9, H = 8;                 // 9x8 grayscale -> 8x8 adjacent-pixel diffs -> 64 bits

// A flat image (LinkedIn's grey silhouette, Upwork's initials placeholder)
// hashes to near-constant bits and would collide with every other placeholder.
// Reject anything with too little tonal variation to be a real photo.
const MIN_VARIANCE = 120;

export async function imageHash(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) return null;
    const bmp = await createImageBitmap(await res.blob());
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, W, H);
    bmp.close();

    const { data } = ctx.getImageData(0, 0, W, H);
    const gray = new Float64Array(W * H);
    let sum = 0;
    for (let i = 0; i < W * H; i++) {
      const o = i * 4;
      gray[i] = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
      sum += gray[i];
    }
    const mean = sum / gray.length;
    let variance = 0;
    for (const g of gray) variance += (g - mean) ** 2;
    if (variance / gray.length < MIN_VARIANCE) return null;   // placeholder avatar

    let bits = '';
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W - 1; x++)
        bits += gray[y * W + x] > gray[y * W + x + 1] ? '1' : '0';
    return bits;
  } catch {
    return null;
  }
}

/** Bit distance between two hashes; null if either is missing. 0 = identical. */
export function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

/** <=6/64 bits apart survives re-encoding and resizing of the same source photo. */
export const SAME_PHOTO_MAX_DISTANCE = 6;
