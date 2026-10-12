import { getProjectLlmConfig } from '@/lib/config/llm';
import { getRuntimeDegradationConfig } from '@/lib/config/degradation';
import {
  DEEPSEEK_MODEL_ID,
  PI_AGENT_MODEL_DEFINITIONS,
  isOfficialDeepSeekModelId,
  type PiAgentModelDefinition,
} from '@/lib/constants/models';
import type { CLIModel, CLIStatusEntry, ModelAvailability } from '@/types/cli';

type CatalogStatus = Extract<
  ModelAvailability['status'],
  'available' | 'unauthorized' | 'unreachable' | 'invalid_response'
>;

type CatalogModel = { id: string; name?: string; inputModalities?: string[] };
type CatalogResult = { status: CatalogStatus; models?: CatalogModel[] };

const STATUS_MESSAGES: Record<ModelAvailability['status'], string> = {
  available: '凭据与模型目录检查通过；实际生成能力将在研究运行时验证。',
  unconfigured: '模型凭据尚未配置。',
  disabled: '模型已停用。',
  unauthorized: '模型服务拒绝了当前凭据，请检查凭据及模型访问权限。',
  unreachable: '无法连接模型服务或服务暂时不可用，请稍后重新检查。',
  unadvertised: '当前凭据可访问的模型目录中没有此模型，请检查模型授权或选择其他模型。',
  invalid_response: '模型服务返回了无效的模型目录，请检查服务配置。',
};

function publicDefinition(model: PiAgentModelDefinition): CLIModel {
  const { id, name, description, supportsImages, provider, runtime, external } = model;
  return { id, name, description, supportsImages, provider, runtime, external };
}

function officialDefinition(model: CatalogModel): CLIModel {
  return {
    id: model.id,
    name: model.name?.trim() || model.id,
    description: 'DeepSeek 官方 API 动态发现的可用模型',
    supportsImages: model.inputModalities?.includes('image') === true,
    provider: 'deepseek',
    runtime: 'deepseek-official',
    external: false,
  };
}

async function fetchCatalog(baseUrl: string, key: string): Promise<CatalogResult> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status === 401 || response.status === 403) return { status: 'unauthorized' };
    if (!response.ok) return { status: 'unreachable' };

    const payload: unknown = await response.json();
    const data = payload && typeof payload === 'object' && 'data' in payload ? payload.data : null;
    if (!Array.isArray(data)) return { status: 'invalid_response' };

    const models: CatalogModel[] = [];
    for (const item of data) {
      if (!item || typeof item !== 'object' || !('id' in item) || typeof item.id !== 'string') {
        return { status: 'invalid_response' };
      }
      const record = item as Record<string, unknown>;
      models.push({
        id: item.id,
        name: typeof record.name === 'string' ? record.name : undefined,
        inputModalities: Array.isArray(record.input_modalities)
          ? record.input_modalities.filter((value): value is string => typeof value === 'string')
          : undefined,
      });
    }
    return { status: 'available', models };
  } catch {
    // Never project upstream error bodies, endpoints or credentials to clients.
    return { status: 'unreachable' };
  }
}

function check(
  id: string,
  configured: boolean,
  status: ModelAvailability['status'],
  message?: string,
): ModelAvailability {
  return { id, configured, status, message: message ?? STATUS_MESSAGES[status] };
}

/** Catalog access is a prerequisite, not proof of successful model inference. */
export async function checkModelAvailability(): Promise<CLIStatusEntry> {
  const modelPortEnabled = getRuntimeDegradationConfig().components.modelPort.enabled;
  const modelChecks: ModelAvailability[] = [];
  const modelDefinitions: CLIModel[] = [];
  const catalogs = new Map<string, Promise<CatalogResult>>();
  const staticDefinitions = PI_AGENT_MODEL_DEFINITIONS.filter(model => model.runtime === 'modelport');

  for (const model of staticDefinitions) {
    modelDefinitions.push(publicDefinition(model));
    const config = getProjectLlmConfig(model.id);
    const key = process.env[config.credentialEnv]?.trim();
    if (!config.agent.enabled || !modelPortEnabled) {
      modelChecks.push(check(model.id, Boolean(key), 'disabled'));
      continue;
    }
    if (!key) {
      modelChecks.push(check(
        model.id,
        false,
        'unconfigured',
        `此模型尚未配置 ${config.credentialEnv}，请配置后重新检查，或选择已就绪的模型。`,
      ));
      continue;
    }

    const catalogId = `${config.baseUrl}:${config.credentialEnv}`;
    if (!catalogs.has(catalogId)) catalogs.set(catalogId, fetchCatalog(config.baseUrl, key));
    const catalog = await catalogs.get(catalogId)!;
    const status = catalog.status === 'available' && !catalog.models?.some(item => item.id === config.model)
      ? 'unadvertised'
      : catalog.status;
    modelChecks.push(check(model.id, true, status));
  }

  const officialSeed = PI_AGENT_MODEL_DEFINITIONS.find(model => model.id === DEEPSEEK_MODEL_ID)!;
  const officialConfig = getProjectLlmConfig(DEEPSEEK_MODEL_ID);
  const officialKey = process.env[officialConfig.credentialEnv]?.trim();
  if (!officialConfig.agent.enabled) {
    modelDefinitions.push(publicDefinition(officialSeed));
    modelChecks.push(check(DEEPSEEK_MODEL_ID, Boolean(officialKey), 'disabled'));
  } else if (!officialKey) {
    modelDefinitions.push(publicDefinition(officialSeed));
    modelChecks.push(check(
      DEEPSEEK_MODEL_ID,
      false,
      'unconfigured',
      `官方模型目录需要 ${officialConfig.credentialEnv}，配置后将自动加载可选模型。`,
    ));
  } else {
    const catalog = await fetchCatalog(officialConfig.baseUrl, officialKey);
    const officialModels = catalog.status === 'available'
      ? (catalog.models ?? []).filter(model => isOfficialDeepSeekModelId(model.id))
      : [];

    if (catalog.status === 'available' && officialModels.length > 0) {
      for (const model of officialModels) {
        modelDefinitions.push(officialDefinition(model));
        modelChecks.push(check(model.id, true, 'available'));
      }
    } else {
      modelDefinitions.push(publicDefinition(officialSeed));
      modelChecks.push(check(
        DEEPSEEK_MODEL_ID,
        true,
        catalog.status === 'available' ? 'invalid_response' : catalog.status,
      ));
    }
  }

  const models = modelChecks.filter(model => model.status === 'available').map(model => model.id);
  return {
    installed: true,
    version: 'PI Agent Runtime (built-in)',
    checking: false,
    configured: modelChecks.some(model => model.configured),
    available: models.length > 0,
    models,
    modelDefinitions,
    modelChecks,
    error: models.length ? undefined : '当前没有通过访问检查的模型，请查看所选模型的状态。',
  };
}
