import { describe, it, expect, vi, beforeEach } from 'vitest';
import { changePassword, updateProfilePhoto } from '@/services/profileService';

describe('profileService', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('changePassword posts current/new password and resolves on success', async () => {
    (fetch as any).mockResolvedValue({ ok: true });
    await changePassword('old-pass', 'new-pass');
    const [, options] = (fetch as any).mock.calls[0];
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ current_password: 'old-pass', new_password: 'new-pass' });
  });

  it('changePassword throws a specific message on 401', async () => {
    (fetch as any).mockResolvedValue({ ok: false, status: 401 });
    await expect(changePassword('wrong', 'new-pass')).rejects.toThrow('Current password is incorrect');
  });

  it('changePassword throws a generic message on other failures', async () => {
    (fetch as any).mockResolvedValue({ ok: false, status: 500 });
    await expect(changePassword('old', 'new')).rejects.toThrow('HTTP 500');
  });

  it('updateProfilePhoto puts the photo_url and resolves on success', async () => {
    (fetch as any).mockResolvedValue({ ok: true });
    await updateProfilePhoto('https://example.com/a.jpg');
    const [, options] = (fetch as any).mock.calls[0];
    expect(options.method).toBe('PUT');
    expect(JSON.parse(options.body)).toEqual({ photo_url: 'https://example.com/a.jpg' });
  });

  it('updateProfilePhoto can clear the photo with null', async () => {
    (fetch as any).mockResolvedValue({ ok: true });
    await updateProfilePhoto(null);
    const [, options] = (fetch as any).mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({ photo_url: null });
  });

  it('updateProfilePhoto throws on failure', async () => {
    (fetch as any).mockResolvedValue({ ok: false, status: 400 });
    await expect(updateProfilePhoto('bad')).rejects.toThrow('HTTP 400');
  });
});
