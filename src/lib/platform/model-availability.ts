import { getProjectLlmConfig } from '@/lib/config/llm';
import { getRuntimeDegradationConfig } from '@/lib/config/degradation';
import { PI_AGENT_MODEL_DEFINITIONS } from '@/lib/constants/models';
import type { CLIStatusEntry, ModelAvailability } from '@/types/cli';

/** Catalog access is a prerequisite, not proof of successful model inference. */
export async function checkModelAvailability(): Promise<CLIStatusEntry> {
  const catalogs = new Map<string, Promise<{ status: ModelAvailability['status']; ids?: string[] }>>();
  const modelPortEnabled = getRuntimeDegradationConfig().components.modelPort.enabled;
  const modelChecks = await Promise.all(PI_AGENT_MODEL_DEFINITIONS.map(async (model): Promise<ModelAvailability> => {
    const config = getProjectLlmConfig(model.id);
    const key = process.env[config.credentialEnv]?.trim();
    if (!config.agent.enabled || (model.runtime === 'modelport' && !modelPortEnabled)) {
      return { id: model.id, configured: Boolean(key), status: 'disabled', message: '此模型已停用，请选择其他模型或检查运行配置。' };
    }
    if (!key) {
      return { id: model.id, configured: false, status: 'unconfigured', message: `此模型尚未配置 ${config.credentialEnv}，请配置后重新检查，或选择已就绪的模型。` };
    }
    // Profiles on the same provider share one bounded read, with no inference cost.
    const catalogId = `${config.baseUrl}:${config.credentialEnv}`;
    if (!catalogs.has(catalogId)) {
      catalogs.set(catalogId, (async () => {
        try {
          const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/models`, {
            headers: { Authorization: `Bearer ${key}` },
            cache: 'no-store',
            redirect: 'error',
            signal: AbortSignal.timeout(2_500),
          });
          if (response.status === 401 || response.status === 403) return { status: 'unauthorized' as const };
          if (!response.ok) return { status: 'unreachable' as const };
          const payload: unknown = await response.json();
          const data = payload && typeof payload === 'object' && 'data' in payload ? payload.data : null;
          if (!Array.isArray(data) || data.some(item => !item || typeof item.id !== 'string')) {
            return { status: 'invalid_response' as const };
          }
          return { status: 'available' as const, ids: data.map(item => item.id as string) };
        } catch {
          // Never project upstream error bodies, endpoints or credentials to clients.
          return { status: 'unreachable' as const };
        }
      })());
    }
    const catalog = await catalogs.get(catalogId)!;
    const status = catalog.status === 'available' && !catalog.ids?.includes(config.model)
      ? 'unadvertised' : catalog.status;
    const messages: Record<ModelAvailability['status'], string> = {
      available: '凭据与模型目录检查通过；实际生成能力将在研究运行时验证。',
      unconfigured: '模型凭据尚未配置。',
      disabled: '模型已停用。',
      unauthorized: '模型服务拒绝了当前凭据，请检查凭据及模型访问权限。',
      unreachable: '无法连接模型服务或服务暂时不可用，请启动服务后重新检查。',
      unadvertised: '当前凭据可访问的模型目录中没有此模型，请检查模型授权或选择其他模型。',
      invalid_response: '模型服务返回了无效的模型目录，请检查服务配置。',
    };
    return { id: model.id, configured: true, status, message: messages[status] };
  }));
  const models = modelChecks.filter(model => model.status === 'available').map(model => model.id);
  return {
    installed: true,
    version: 'PI Agent Runtime (built-in)',
    checking: false,
    configured: modelChecks.some(model => model.configured),
    available: models.length > 0,
    models,
    modelChecks,
    error: models.length ? undefined : '当前没有通过访问检查的模型，请查看所选模型的状态。',
  };
}
