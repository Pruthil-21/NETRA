import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fileToAvatarDataUri, ImageUploadError, MAX_UPLOAD_BYTES } from '@/lib/imageUpload';

function makeFile(name: string, type: string, sizeBytes: number): File {
  const file = new File([new Uint8Array(sizeBytes)], name, { type });
  return file;
}

describe('fileToAvatarDataUri', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects a non-image file without touching createImageBitmap', async () => {
    const bitmapSpy = vi.fn();
    vi.stubGlobal('createImageBitmap', bitmapSpy);

    const file = makeFile('notes.txt', 'text/plain', 10);
    await expect(fileToAvatarDataUri(file)).rejects.toBeInstanceOf(ImageUploadError);
    await expect(fileToAvatarDataUri(file)).rejects.toThrow('Only image files are allowed.');
    expect(bitmapSpy).not.toHaveBeenCalled();
  });

  it('rejects a file over the size cap', async () => {
    const file = makeFile('huge.png', 'image/png', MAX_UPLOAD_BYTES + 1);
    await expect(fileToAvatarDataUri(file)).rejects.toThrow(/too large/i);
  });

  it('resizes down to the avatar max dimension and returns a JPEG data URI', async () => {
    const bitmap = { width: 4000, height: 2000, close: vi.fn() };
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap));

    const drawImage = vi.fn();
    const toDataURL = vi.fn().mockReturnValue('data:image/jpeg;base64,fake');
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'canvas') {
        return {
          width: 0,
          height: 0,
          getContext: () => ({ drawImage }),
          toDataURL,
        } as unknown as HTMLCanvasElement;
      }
      return originalCreateElement(tag);
    });

    const file = makeFile('photo.png', 'image/png', 1024);
    const result = await fileToAvatarDataUri(file);

    expect(result).toBe('data:image/jpeg;base64,fake');
    expect(toDataURL).toHaveBeenCalledWith('image/jpeg', expect.any(Number));
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 256, 128); // 4000x2000 scaled to fit within 256
    expect(bitmap.close).toHaveBeenCalled();

    (document.createElement as any).mockRestore?.();
  });

  it('wraps a createImageBitmap failure in ImageUploadError', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('decode failed')));

    const file = makeFile('corrupt.png', 'image/png', 10);
    await expect(fileToAvatarDataUri(file)).rejects.toBeInstanceOf(ImageUploadError);
  });
});
