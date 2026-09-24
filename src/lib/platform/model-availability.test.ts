import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkModelAvailability } from './model-availability';
import { DEEPSEEK_MODEL_ID, LOCAL_QWEN_MODEL_ID, MODELPORT_DEEPSEEK_MODEL_ID } from '@/lib/constants/models';

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('MODELPORT_API_KEY', '');
  vi.stubEnv('DEEPSEEK_API_KEY', '');
  vi.stubEnv('QUANTPILOT_DEGRADATION_MODE', 'auto');
  vi.stubEnv('QUANTPILOT_MODELPORT_ENABLED', '1');
  vi.stubEnv('QUANTPILOT_LLM_AGENT_ENABLED', '1');
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('model access availability', () => {
  it('does not call any provider without credentials', async () => {
    expect(await checkModelAvailability()).toMatchObject({ installed: true, configured: false, available: false, models: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts direct-only configuration without falsely enabling the default gateway model', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'private-direct-key');
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [{ id: DEEPSEEK_MODEL_ID }] })));
    const status = await checkModelAvailability();
    expect(status.models).toEqual([DEEPSEEK_MODEL_ID]);
    expect(status.available).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(status)).not.toContain('private-direct-key');
  });

  it('shares one catalog request but checks each model grant separately', async () => {
    vi.stubEnv('MODELPORT_API_KEY', 'private-gateway-key');
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [{ id: LOCAL_QWEN_MODEL_ID }] })));
    const status = await checkModelAvailability();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(status.models).toEqual([LOCAL_QWEN_MODEL_ID]);
    expect(status.modelChecks).toContainEqual(expect.objectContaining({ id: MODELPORT_DEEPSEEK_MODEL_ID, status: 'unadvertised' }));
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:38082/v1/models', expect.objectContaining({ redirect: 'error', cache: 'no-store' }));
  });

  it.each([401, 403, 503])('does not mistake credentials for access on HTTP %s or expose the response', async code => {
    vi.stubEnv('MODELPORT_API_KEY', 'private-key');
    fetchMock.mockResolvedValue(new Response('private provider diagnostic', { status: code }));
    const status = await checkModelAvailability();
    expect(status).toMatchObject({ configured: true, available: false, models: [] });
    expect(status.modelChecks?.[0].status).toBe(code === 503 ? 'unreachable' : 'unauthorized');
    expect(JSON.stringify(status)).not.toContain('private');
  });

  it('does not treat a malformed HTTP 200 catalog as access', async () => {
    vi.stubEnv('MODELPORT_API_KEY', 'private-key');
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [{ wrong: 'id' }] })));
    expect((await checkModelAvailability()).modelChecks?.[0].status).toBe('invalid_response');
  });

  it('handles timeout and network errors without exposing credentials', async () => {
    vi.stubEnv('MODELPORT_API_KEY', 'private-key');
    fetchMock.mockRejectedValue(new Error('timeout at private-key'));
    const status = await checkModelAvailability();
    expect(status.available).toBe(false);
    expect(status.modelChecks?.[0].status).toBe('unreachable');
    expect(JSON.stringify(status)).not.toContain('private-key');
  });

  it('honors a disabled ModelPort even with credentials', async () => {
    vi.stubEnv('MODELPORT_API_KEY', 'private-key');
    vi.stubEnv('QUANTPILOT_MODELPORT_ENABLED', '0');
    const status = await checkModelAvailability();
    expect(status.models).toEqual([]);
    expect(status.modelChecks?.[0].status).toBe('disabled');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
