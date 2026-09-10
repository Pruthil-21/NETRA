// Profile photo uploads have nowhere to actually land -- this codebase has
// no file-storage pipeline (see backend-registry's schema.sql comment on
// officers.photo_url), so a picked file is resized down to avatar size and
// shipped to the existing photo_url TEXT column as a compact data: URI
// instead of a real hosted URL. No backend change needed: PUT /auth/me/photo
// already accepts any string there.

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8MB raw file, before resizing
const MAX_AVATAR_DIMENSION = 256;
const JPEG_QUALITY = 0.85;

export class ImageUploadError extends Error {}

/** Validates the file is actually an image under the size cap, then
 * resizes it down to a small square-ish JPEG and returns it as a data URI
 * -- keeps the DB row (and every future GET /auth/me response) small
 * regardless of how large the original photo was. */
export async function fileToAvatarDataUri(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new ImageUploadError('Only image files are allowed.');
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new ImageUploadError(
      `That file is too large (${(file.size / (1024 * 1024)).toFixed(1)}MB) -- please pick one under ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB.`
    );
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new ImageUploadError('Could not read that file as an image.');
  }

  const scale = Math.min(1, MAX_AVATAR_DIMENSION / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new ImageUploadError('Your browser cannot process images.');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
}
