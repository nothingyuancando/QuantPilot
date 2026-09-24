import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCliStatusFallback, fetchCliStatusSnapshot } from './useCLI';
import { modelAvailabilityError } from '@/lib/utils/cliOptions';

afterEach(() => vi.unstubAllGlobals());
describe('model status failures', () => {
  it('starts with unknown access and no implied model permissions', () => {
    expect(createCliStatusFallback().pi).toMatchObject({ installed: true, configured: false, available: false, models: [] });
  });
  it.each([401, 503])('does not promote HTTP %s to a configured model', async status => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status })));
    expect((await fetchCliStatusSnapshot()).pi.available).toBe(false);
  });
  it('does not infer model access from installed alone', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ pi: { installed: true } }))));
    expect((await fetchCliStatusSnapshot()).pi.available).toBe(false);
  });
  it('clears the unknown-state message when a fresh check succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ pi: { installed: true, available: true, configured: true, models: ['direct'] } })));
    expect((await fetchCliStatusSnapshot()).pi.error).toBeUndefined();
  });
  it('checks the selected model instead of any available model', () => {
    const entry = { installed: true, checking: false, available: true, models: ['direct'] };
    expect(modelAvailabilityError(entry, 'direct')).toBeNull();
    expect(modelAvailabilityError(entry, 'gateway')).toBeTruthy();
    expect(modelAvailabilityError({ ...entry, checking: true }, 'direct')).toBeTruthy();
  });
});
