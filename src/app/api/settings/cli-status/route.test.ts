import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ requireAction: vi.fn(), checkModelAvailability: vi.fn() }));
vi.mock('@/lib/auth/action', () => ({ requireAction: mocks.requireAction }));
vi.mock('@/lib/platform/model-availability', () => ({ checkModelAvailability: mocks.checkModelAvailability }));
import { AuthorizationError } from '@/lib/auth/authorization';
import { GET } from './route';

beforeEach(() => { mocks.requireAction.mockResolvedValue({}); });
describe('model availability route', () => {
  it('requires authorization before contacting providers', async () => {
    mocks.requireAction.mockRejectedValue(new AuthorizationError('FORBIDDEN', 403, 'Forbidden'));
    expect((await GET(new Request('http://localhost/api/settings/cli-status'))).status).toBe(403);
    expect(mocks.checkModelAvailability).not.toHaveBeenCalled();
  });
  it('returns uncached status when no models are available', async () => {
    mocks.checkModelAvailability.mockResolvedValue({ installed: true, available: false, models: [] });
    const response = await GET(new Request('http://localhost/api/settings/cli-status'));
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await response.json()).toMatchObject({ pi: { available: false, models: [] } });
  });
});
