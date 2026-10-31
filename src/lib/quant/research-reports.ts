import { createHash } from 'node:crypto';

import { Prisma, type NotificationDelivery } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { getRuntimeDegradationConfig } from '@/lib/config/degradation';
import { assessResearch, candidateWithinWatchlist, canonicalResearchSymbol } from '@/lib/domains/finance/research-policy';
import { resolveResearchTime, type QuantResearchTime } from '@/lib/domains/finance/research-time';
import { assertResearchScope, assertSameResearchProject, scopedResearchId, type ResearchScope } from './research-scope';
import {
  deliverResearchReportNotification,
  type ResearchNotificationChannelInput,
  type ResearchNotificationReportInput,
} from './notification-adapters';

const MARKET_API_BASE_URL =
  process.env.QUANTPILOT_MARKET_API_URL ||
  process.env.QUANTPILOT_MARKET_API_BASE_URL ||
  'http://127.0.0.1:8000';

const DEFAULT_WATCHLIST_ID = 'daily-quantpilot-core';
const DEFAULT_CHANNEL_ID = 'dry-run-wxwork-research';
const DEFAULT_UNIVERSE_ID = 'a-share-sample-research-pool';

const DEFAULT_SYMBOLS = ['600519.SH', '000001.SZ', '510300.SH'];
const DEFAULT_MARKETS = ['A股', 'ETF'];

type JsonRecord = Record<string, unknown>;

export type ResearchProviderStatus = 'available' | 'partial' | 'unavailable' | 'disabled';

export interface ResearchEvidenceItem {
  source: string;
  status: ResearchProviderStatus;
  detail: string;
  capturedAt: string;
  metrics?: JsonRecord;
}

export interface ResearchWatchlistSnapshot {
  id: string;
  name: string;
  description: string | null;
  universeId: string | null;
  symbols: string[];
  markets: string[];
  status: string;
  schedule: JsonRecord;
  reportTemplate: string;
  notificationChannelIds: string[];
  updatedAt: string;
}

export interface ResearchReportRunSnapshot {
  id: string;
  watchlistId: string | null;
  status: string;
  runType: string;
  startedAt: string;
  finishedAt: string | null;
  providerMode: string;
  error: string | null;
}

export interface ResearchReportSnapshot {
  id: string;
  runId: string;
  watchlistId: string | null;
  title: string;
  summary: string;
  reportDate: string;
  score: number;
  recommendation: string;
  riskLevel: string;
  contentMarkdown: string;
  structured: JsonRecord;
  evidence: ResearchEvidenceItem[];
  source: string;
  createdAt: string;
}

export interface NotificationChannelSnapshot {
  id: string;
  name: string;
  channelType: string;
  status: string;
  target: string | null;
  isDryRun: boolean;
  updatedAt: string;
}

export interface NotificationDeliverySnapshot {
  id: string;
  runId: string | null;
  reportId: string | null;
  channelId: string | null;
  channelType: string;
  status: string;
  title: string;
  error: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

export interface ResearchProviderMatrixItem {
  id: string;
  name: string;
  role: string;
  status: ResearchProviderStatus;
  detail: string;
}

export interface ResearchAutomationDashboard {
  projectId: string;
  generatedAt: string;
  summary: {
    watchlists: number;
    reports: number;
    activeChannels: number;
    latestScore: number | null;
  };
  watchlists: ResearchWatchlistSnapshot[];
  latestReports: ResearchReportSnapshot[];
  recentRuns: ResearchReportRunSnapshot[];
  notificationChannels: NotificationChannelSnapshot[];
  recentDeliveries: NotificationDeliverySnapshot[];
  providerMatrix: ResearchProviderMatrixItem[];
}

export interface RunDailyResearchReportOptions {
  watchlistId?: string;
  dryRun?: boolean;
  runType?: 'manual' | 'scheduled' | 'dry_run';
}

export interface SendResearchReportOptions {
  reportId?: string;
  dryRun?: boolean;
  idempotencyKey?: string;
}

interface MarketProbe<T = unknown> {
  data: T | null;
  evidence: ResearchEvidenceItem;
}

interface ReportBuildResult {
  title: string;
  summary: string;
  score: number;
  recommendation: string;
  riskLevel: string;
  contentMarkdown: string;
  structured: JsonRecord;
  evidence: ResearchEvidenceItem[];
}

function nowIso() {
  return new Date().toISOString();
}

function asRecord(value: unknown): JsonRecord {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as JsonRecord;
  }
  return {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function stringArray(value: Prisma.JsonValue | null | undefined): string[] {
  return asArray(value).filter((item): item is string => typeof item === 'string');
}

function jsonRecord(value: Prisma.JsonValue | null | undefined): JsonRecord {
  return asRecord(value);
}

function inputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function evidenceArray(value: Prisma.JsonValue | null | undefined): ResearchEvidenceItem[] {
  return asArray(value)
    .map((item) => {
      const record = asRecord(item);
      const status = asString(record.status, 'unavailable') as ResearchProviderStatus;
      return {
        source: asString(record.source, 'unknown'),
        status: ['available', 'partial', 'unavailable', 'disabled'].includes(status) ? status : 'unavailable',
        detail: asString(record.detail),
        capturedAt: asString(record.capturedAt, nowIso()),
        metrics: asRecord(record.metrics),
      };
    });
}

function compactError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reportDateValue() {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function extractUniverses(payload: unknown): JsonRecord[] {
  return asArray(asRecord(payload).universes).map(asRecord);
}

function extractCandidates(payload: unknown): JsonRecord[] {
  return asArray(asRecord(payload).candidates).map(asRecord);
}

function candidateLabel(candidate: JsonRecord) {
  const symbol = asString(candidate.symbol) || asString(candidate.code, '-');
  const name = asString(candidate.name, '未命名');
  const score = asNumber(candidate.score);
  const changePercent = asNumber(candidate.change_percent);
  const scoreText = score == null ? '无评分' : `${score.toFixed(1)} 分`;
  const changeText = changePercent == null ? '涨跌未知' : `${changePercent.toFixed(2)}%`;
  return `${name} ${symbol}：${scoreText}，最新涨跌 ${changeText}`;
}

function statusPriority(status: ResearchProviderStatus) {
  if (status === 'available') return 3;
  if (status === 'partial') return 2;
  if (status === 'disabled') return 1;
  return 0;
}

function riskLevelLabel(level: string) {
  if (level === 'low') return '低';
  if (level === 'high') return '高';
  if (level === 'medium') return '中';
  return '待评估';
}

async function fetchMarketProbe<T>(pathName: string, source: string, timeoutMs = 3500): Promise<MarketProbe<T>> {
  const marketApiConfig = getRuntimeDegradationConfig().components.marketApi;
  const capturedAt = nowIso();

  if (!marketApiConfig.enabled) {
    return {
      data: null,
      evidence: {
        source,
        status: 'disabled',
        detail: 'market-data API 已按降级配置停用。',
        capturedAt,
      },
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${MARKET_API_BASE_URL}${pathName}`, {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return {
        data: null,
        evidence: {
          source,
          status: 'unavailable',
          detail: `market-data API ${response.status}: ${body.slice(0, 180)}`,
          capturedAt,
        },
      };
    }
    const data = await response.json() as T;
    return {
      data,
      evidence: {
        source,
        status: 'available',
        detail: '已读取本地 market-data API。',
        capturedAt,
        metrics: probeMetrics(data),
      },
    };
  } catch (error) {
    return {
      data: null,
      evidence: {
        source,
        status: 'unavailable',
        detail: compactError(error),
        capturedAt,
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

function probeMetrics(data: unknown): JsonRecord {
  const record = asRecord(data);
  const metrics: JsonRecord = {};
  if (Array.isArray(record.universes)) metrics.universes = record.universes.length;
  if (Array.isArray(record.candidates)) metrics.candidates = record.candidates.length;
  if (typeof record.scanned_symbols === 'number') metrics.scannedSymbols = record.scanned_symbols;
  if (typeof record.source === 'string') metrics.source = record.source;

  const analytics = asRecord(record.analytics);
  if (analytics.engine) metrics.engine = analytics.engine;
  if (analytics.status) metrics.analyticsStatus = analytics.status;

  const clickhouseStatus = asString(record.status);
  if (clickhouseStatus) metrics.status = clickhouseStatus;
  return metrics;
}

function mapWatchlist(watchlist: {
  id: string;
  name: string;
  description: string | null;
  universeId: string | null;
  symbols: Prisma.JsonValue;
  markets: Prisma.JsonValue;
  status: string;
  schedule: Prisma.JsonValue;
  reportTemplate: string;
  notificationChannelIds: Prisma.JsonValue;
  updatedAt: Date;
}): ResearchWatchlistSnapshot {
  return {
    id: watchlist.id,
    name: watchlist.name,
    description: watchlist.description,
    universeId: watchlist.universeId,
    symbols: stringArray(watchlist.symbols),
    markets: stringArray(watchlist.markets),
    status: watchlist.status,
    schedule: jsonRecord(watchlist.schedule),
    reportTemplate: watchlist.reportTemplate,
    notificationChannelIds: stringArray(watchlist.notificationChannelIds),
    updatedAt: watchlist.updatedAt.toISOString(),
  };
}

function mapRun(run: {
  id: string;
  watchlistId: string | null;
  status: string;
  runType: string;
  startedAt: Date;
  finishedAt: Date | null;
  providerMode: string;
  error: string | null;
}): ResearchReportRunSnapshot {
  return {
    id: run.id,
    watchlistId: run.watchlistId,
    status: run.status,
    runType: run.runType,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    providerMode: run.providerMode,
    error: run.error,
  };
}

function mapReport(report: {
  id: string;
  runId: string;
  watchlistId: string | null;
  title: string;
  summary: string;
  reportDate: Date;
  score: number;
  recommendation: string;
  riskLevel: string;
  contentMarkdown: string;
  structured: Prisma.JsonValue;
  evidence: Prisma.JsonValue;
  source: string;
  createdAt: Date;
}): ResearchReportSnapshot {
  return {
    id: report.id,
    runId: report.runId,
    watchlistId: report.watchlistId,
    title: report.title,
    summary: report.summary,
    reportDate: report.reportDate.toISOString(),
    score: report.score,
    recommendation: report.recommendation,
    riskLevel: report.riskLevel,
    contentMarkdown: report.contentMarkdown,
    structured: jsonRecord(report.structured),
    evidence: evidenceArray(report.evidence),
    source: report.source,
    createdAt: report.createdAt.toISOString(),
  };
}

function mapChannel(channel: {
  id: string;
  name: string;
  channelType: string;
  status: string;
  target: string | null;
  isDryRun: boolean;
  updatedAt: Date;
}): NotificationChannelSnapshot {
  return {
    id: channel.id,
    name: channel.name,
    channelType: channel.channelType,
    status: channel.status,
    target: channel.target,
    isDryRun: channel.isDryRun,
    updatedAt: channel.updatedAt.toISOString(),
  };
}

function mapDelivery(delivery: {
  id: string;
  runId: string | null;
  reportId: string | null;
  channelId: string | null;
  channelType: string;
  status: string;
  title: string;
  error: string | null;
  deliveredAt: Date | null;
  createdAt: Date;
}): NotificationDeliverySnapshot {
  return {
    id: delivery.id,
    runId: delivery.runId,
    reportId: delivery.reportId,
    channelId: delivery.channelId,
    channelType: delivery.channelType,
    status: delivery.status,
    title: delivery.title,
    error: delivery.error,
    deliveredAt: delivery.deliveredAt?.toISOString() ?? null,
    createdAt: delivery.createdAt.toISOString(),
  };
}

function mapNotificationReport(report: {
  id: string;
  title: string;
  summary: string;
  score: number;
  recommendation: string;
  riskLevel: string;
  contentMarkdown: string;
}): ResearchNotificationReportInput {
  return {
    id: report.id,
    title: report.title,
    summary: report.summary,
    score: report.score,
    recommendation: report.recommendation,
    riskLevel: report.riskLevel,
    contentMarkdown: report.contentMarkdown,
  };
}

function mapNotificationChannel(channel: {
  id: string;
  name: string;
  channelType: string;
  target: string | null;
  config: Prisma.JsonValue;
  isDryRun: boolean;
}): ResearchNotificationChannelInput {
  return {
    id: channel.id,
    name: channel.name,
    channelType: channel.channelType,
    target: channel.target,
    config: channel.config,
    isDryRun: channel.isDryRun,
  };
}

export async function ensureResearchAutomationSeed(scope: ResearchScope) {
  assertResearchScope(scope);
  const watchlistId = scopedResearchId(scope, DEFAULT_WATCHLIST_ID);
  const channelId = scopedResearchId(scope, DEFAULT_CHANNEL_ID);
  const watchlist = await prisma.researchWatchlist.upsert({
    where: { id: watchlistId },
    create: {
      id: watchlistId,
      projectId: scope.projectId,
      createdById: scope.actorUserId,
      name: 'QuantPilot 每日核心观察池',
      description: '围绕默认 A 股研究池和少量核心标的生成证据型日报。',
      universeId: DEFAULT_UNIVERSE_ID,
      symbols: DEFAULT_SYMBOLS,
      markets: DEFAULT_MARKETS,
      status: 'active',
      schedule: {
        timezone: 'Asia/Shanghai',
        frequency: 'daily',
        time: '08:30',
        enabled: false,
      },
      reportTemplate: 'daily_brief',
      notificationChannelIds: [channelId],
      metadata: {
        seeded: true,
        intent: 'research_automation_p0',
        sourceProject: 'QuantPilot',
      },
    },
    update: {},
  });

  const channel = await prisma.notificationChannel.upsert({
    where: { id: channelId },
    create: {
      id: channelId,
      projectId: scope.projectId,
      createdById: scope.actorUserId,
      name: '企业微信投研日报 Dry-run',
      channelType: 'wxwork',
      status: 'configured',
      target: '本地模拟推送',
      config: {
        mode: 'dry_run',
        adapter: 'wxwork-webhook',
        webhookEnv: 'QUANTPILOT_WXWORK_RESEARCH_WEBHOOK',
        secretConfigured: false,
      },
      isDryRun: true,
    },
    update: {},
  });

  assertSameResearchProject(scope, [watchlist, channel]);
  return { watchlist, channel };
}

async function findChannelsForWatchlist(scope: ResearchScope, watchlist: ResearchWatchlistSnapshot | null) {
  const ids = watchlist?.notificationChannelIds ?? [scopedResearchId(scope, DEFAULT_CHANNEL_ID)];
  const channels = await prisma.notificationChannel.findMany({
    where: {
      projectId: scope.projectId,
      id: { in: ids },
      status: { not: 'disabled' },
    },
  });

  if (channels.length !== new Set(ids).size) throw new Error('Notification channel missing, disabled or outside this project.');
  return channels;
}

export async function createNotificationDeliveries(params: {
  scope: ResearchScope;
  runId?: string | null;
  report: ResearchNotificationReportInput;
  channels: ResearchNotificationChannelInput[];
  dryRun: boolean;
  idempotencyKey?: string | null;
}) {
  assertResearchScope(params.scope);
  // Re-read authoritative rows at the side-effect boundary, even for worker callers.
  const [reportRecord, channelRecords, runRecord] = await Promise.all([
    prisma.researchReport.findFirst({ where: { id: params.report.id, projectId: params.scope.projectId } }),
    prisma.notificationChannel.findMany({ where: { id: { in: params.channels.map((channel) => channel.id) }, projectId: params.scope.projectId, status: { not: 'disabled' } } }),
    params.runId ? prisma.researchReportRun.findFirst({ where: { id: params.runId, projectId: params.scope.projectId } }) : Promise.resolve(null),
  ]);
  if (!reportRecord || (params.runId && (!runRecord || reportRecord.runId !== params.runId)) || channelRecords.length !== new Set(params.channels.map((channel) => channel.id)).size) {
    throw new Error('Research notification resources must belong to the same project.');
  }
  const authoritativeReport = mapNotificationReport(reportRecord);
  const deliveries: NotificationDelivery[] = [];

  for (const channelRecord of channelRecords) {
    const channel = mapNotificationChannel(channelRecord);
    const deliveryIdempotencyKey = params.idempotencyKey
      ? `research-notification:${createHash('sha256')
        .update(`${params.scope.projectId}\0${params.idempotencyKey}\0${params.report.id}\0${channel.id}`)
        .digest('hex')}`
      : null;
    let reserved: NotificationDelivery;
    try {
      // Persist the delivery fence before contacting an external webhook. If
      // the process dies after the webhook call, a retry sees this row and does
      // not send a second notification.
      reserved = await prisma.notificationDelivery.create({
        data: {
          projectId: params.scope.projectId,
          createdById: params.scope.actorUserId,
          idempotencyKey: deliveryIdempotencyKey,
          runId: params.runId ?? null,
          reportId: params.report.id,
          channelId: channel.id,
          status: 'sending',
          channelType: channel.channelType,
          title: authoritativeReport.title,
          payload: inputJson({
            adapter: `${channel.channelType}-webhook`,
            mode: params.dryRun ? 'dry_run_reserved' : 'real_reserved',
            channelId: channel.id,
            reportId: params.report.id,
          }),
          error: null,
          deliveredAt: null,
        },
      });
    } catch (error) {
      if (
        deliveryIdempotencyKey &&
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'P2002'
      ) {
        const existing = await prisma.notificationDelivery.findUnique({
          where: { idempotencyKey: deliveryIdempotencyKey },
        });
        if (existing && existing.projectId === params.scope.projectId) {
          deliveries.push(existing);
          continue;
        }
      }
      throw error;
    }

    try {
      const result = await deliverResearchReportNotification({
        channel,
        report: authoritativeReport,
        forceDryRun: params.dryRun,
      });
      deliveries.push(await prisma.notificationDelivery.update({
        where: { id: reserved.id },
        data: {
          status: result.status,
          channelType: result.channelType,
          title: result.title,
          payload: result.payload,
          error: result.error,
          deliveredAt: result.deliveredAt,
        },
      }));
    } catch (error) {
      // An adapter or persistence failure remains fenced. The same operation
      // key may be retried safely without contacting this channel again.
      const failed = await prisma.notificationDelivery.update({
        where: { id: reserved.id },
        data: { status: 'failed', error: compactError(error) },
      }).catch(() => reserved);
      deliveries.push(failed);
    }
  }

  return deliveries;
}

function buildProviderMatrix(
  evidence: ResearchEvidenceItem[] = [],
  channels: NotificationChannelSnapshot[] = []
): ResearchProviderMatrixItem[] {
  const evidenceBySource = new Map(evidence.map((item) => [item.source, item]));
  const market = evidenceBySource.get('本地股票池');
  const screener = evidenceBySource.get('短线候选筛选');
  const clickhouse = evidenceBySource.get('ClickHouse 分析层');

  return [
    {
      id: 'local-market-data',
      name: '本地 market-data',
      role: '股票池、行情覆盖、K 线和候选筛选的事实源',
      status: market?.status ?? 'partial',
      detail: market?.detail ?? '等待下一次日报运行采样。',
    },
    {
      id: 'clickhouse',
      name: 'ClickHouse',
      role: '全市场筛选、横截面因子和批量分析加速层',
      status: clickhouse?.status ?? 'partial',
      detail: clickhouse?.detail ?? '未采样时不判断健康状态。',
    },
    {
      id: 'timescaledb',
      name: 'TimescaleDB',
      role: '本地日线事实库和回测读取口径',
      status: screener?.status ?? 'partial',
      detail: screener?.metrics?.engine === 'timescaledb'
        ? '当前筛选由 TimescaleDB 承接。'
        : '作为 ClickHouse 失败后的稳定回退路径。',
    },
    {
      id: 'news-sentiment',
      name: '新闻与舆情源',
      role: '后续接入企业新闻源、搜索 API 和社交舆情',
      status: 'disabled',
      detail: 'P0 先保留结构化证据位，不默认依赖付费 API。',
    },
    {
      id: 'notifications',
      name: '推送通道',
      role: '企业微信、飞书、钉钉、Telegram、Discord、邮件',
      status: channels.length > 0 ? 'partial' : 'disabled',
      detail: channels.length > 0
        ? `已配置 ${channels.length} 个通道，当前默认 dry-run。`
        : '尚未配置通道。',
    },
  ];
}

function buildReport(params: {
  watchlist: ResearchWatchlistSnapshot;
  universesProbe: MarketProbe;
  screenerProbe: MarketProbe;
  clickhouseProbe: MarketProbe;
  researchTime: QuantResearchTime;
}): ReportBuildResult {
  const evidence = [
    { ...params.universesProbe.evidence, source: '本地股票池' },
    { ...params.screenerProbe.evidence, source: '短线候选筛选' },
    { ...params.clickhouseProbe.evidence, source: 'ClickHouse 分析层' },
  ];

  const universes = extractUniverses(params.universesProbe.data);
  const candidates = extractCandidates(params.screenerProbe.data).filter((candidate) => candidateWithinWatchlist(candidate, { ...params.watchlist, endDate: params.researchTime.endDate }));
  const targetUniverse = universes.find((universe) => asString(universe.id) === params.watchlist.universeId) ?? {};
  const analytics = asRecord(asRecord(params.screenerProbe.data).analytics);
  const screenerData = asRecord(params.screenerProbe.data);
  const readyCount = asNumber(screenerData.safety_complete_symbols) ?? 0;
  const memberCount = params.watchlist.symbols.length || (asNumber(screenerData.total_symbols) ?? 0);
  const coverageRatio = memberCount > 0 ? readyCount / memberCount : 0;
  const assessment = assessResearch({ coverageRatio, sourceStatuses: evidence.slice(0, 2).map((item) => item.status), candidates });
  const score = assessment.dataConfidence;
  const riskLevel = assessment.investmentRisk;
  const recommendation = assessment.recommendation;

  const topCandidates = candidates.slice(0, 5).map(candidateLabel);
  const evidenceLines = evidence.map((item) => `- ${item.source}: ${item.status}，${item.detail}`);
  const checklist = [
    ...(params.watchlist.markets.includes('ETF') ? ['当前短线筛选接口仅支持 A 股股票；ETF 尚未纳入候选及风险评估。'] : []),
    candidates.length > 0 ? '核对前 3 个候选标的的最新 K 线、成交额和涨跌停状态。' : '先检查筛选条件和本地行情覆盖，确认为何没有候选标的。',
    coverageRatio >= 0.8 ? '股票池覆盖率可用于日报观察，继续保留补数监控。' : '优先补齐股票池日线覆盖，避免日报结论偏样本。',
    analytics.engine === 'clickhouse' ? 'ClickHouse 已参与筛选，可继续扩展横截面因子。' : '当前未确认 ClickHouse 命中，批量筛选仍需关注性能。',
    '任何买卖动作必须结合人工复核和风控仓位，不把日报作为即时交易指令。',
  ];

  const title = `${reportDateValue()} ${params.watchlist.name} 投研日报`;
  const summary = candidates.length > 0
    ? `本次生成 ${candidates.length} 个候选标的，数据可信度 ${score}，建议：${recommendation}。`
    : `本次未生成候选标的，数据可信度 ${score}，重点处理数据覆盖和筛选证据。`;

  const contentMarkdown = [
    `# ${title}`,
    '',
    `## 核心结论`,
    summary,
    '',
    `## 数据可信度`,
    `- 数据可信度：${score}/100`,
    `- 风险等级：${riskLevelLabel(riskLevel)}`,
    `- 建议：${recommendation}`,
    '',
    `## 观察池`,
    `- 股票池：${params.watchlist.universeId ?? '未绑定'}`,
    `- 标的：${params.watchlist.symbols.join('、') || '使用股票池成员'}`,
    `- 市场：${params.watchlist.markets.join('、') || '未设置'}`,
    '',
    `## 候选标的`,
    ...(topCandidates.length > 0 ? topCandidates.map((item) => `- ${item}`) : ['- 暂无候选标的。']),
    '',
    `## 证据来源`,
    ...evidenceLines,
    '',
    `## 操作检查清单`,
    ...checklist.map((item) => `- ${item}`),
  ].join('\n');

  return {
    title,
    summary,
    score,
    recommendation,
    riskLevel,
    contentMarkdown,
    evidence,
    structured: {
      version: 2,
      assessment,
      researchTime: params.researchTime,
      watchlistId: params.watchlist.id,
      coverage: {
        universeId: params.watchlist.universeId,
        readyCount,
        memberCount,
        coverageRatio: Number(coverageRatio.toFixed(4)),
        universeReadyCount: asNumber(targetUniverse.ready_count) ?? 0,
        universeMemberCount: asNumber(targetUniverse.member_count) ?? 0,
        basis: 'watchlist_screener_safety_fields',
      },
      candidates: candidates.slice(0, 10).map((candidate) => ({
        symbol: asString(candidate.symbol),
        code: asString(candidate.code),
        name: asString(candidate.name),
        score: asNumber(candidate.score),
        changePercent: asNumber(candidate.change_percent),
        tradeDate: asString(candidate.trade_date),
        signals: asArray(candidate.signals).filter((item): item is string => typeof item === 'string'),
        warnings: asArray(candidate.warnings).filter((item): item is string => typeof item === 'string'),
      })),
      analytics: {
        engine: asString(analytics.engine, 'unknown'),
        status: asString(analytics.status, 'unknown'),
        basis: asString(analytics.basis),
      },
      risks: checklist,
      nextAdapters: ['llm-synthesis', 'news-search', 'sentiment-snapshot', 'real-notification-delivery'],
    },
  };
}

export async function getResearchAutomationDashboard(scope: ResearchScope): Promise<ResearchAutomationDashboard> {
  await ensureResearchAutomationSeed(scope);
  const where = { projectId: scope.projectId };

  const [watchlistCount, reportCount, channelCount, watchlists, reports, runs, channels, deliveries] = await Promise.all([
    prisma.researchWatchlist.count({ where }),
    prisma.researchReport.count({ where }),
    prisma.notificationChannel.count({ where: { ...where, status: { not: 'disabled' } } }),
    prisma.researchWatchlist.findMany({ where, orderBy: { updatedAt: 'desc' }, take: 20 }),
    prisma.researchReport.findMany({ where, orderBy: { createdAt: 'desc' }, take: 20 }),
    prisma.researchReportRun.findMany({ where, orderBy: { startedAt: 'desc' }, take: 20 }),
    prisma.notificationChannel.findMany({ where, orderBy: { updatedAt: 'desc' }, take: 10 }),
    prisma.notificationDelivery.findMany({ where, orderBy: { createdAt: 'desc' }, take: 20 }),
  ]);

  const latestReports = reports.map(mapReport);
  const notificationChannels = channels.map(mapChannel);
  const latestEvidence = latestReports[0]?.evidence ?? [];

  return {
    projectId: scope.projectId,
    generatedAt: nowIso(),
    summary: {
      watchlists: watchlistCount,
      reports: reportCount,
      activeChannels: channelCount,
      latestScore: latestReports[0]?.score ?? null,
    },
    watchlists: watchlists.map(mapWatchlist),
    latestReports,
    recentRuns: runs.map(mapRun),
    notificationChannels,
    recentDeliveries: deliveries.map(mapDelivery),
    providerMatrix: buildProviderMatrix(latestEvidence, notificationChannels),
  };
}

export async function runDailyResearchReport(
  scope: ResearchScope,
  options: RunDailyResearchReportOptions = {}
): Promise<ResearchAutomationDashboard> {
  await ensureResearchAutomationSeed(scope);

  const watchlistRecord = await prisma.researchWatchlist.findFirst({
    where: {
      projectId: scope.projectId,
      id: options.watchlistId ?? scopedResearchId(scope, DEFAULT_WATCHLIST_ID),
      status: { not: 'disabled' },
    },
  });

  if (!watchlistRecord) {
    throw new Error(`Research watchlist not found: ${options.watchlistId ?? DEFAULT_WATCHLIST_ID}`);
  }

  const watchlist = mapWatchlist(watchlistRecord);
  watchlist.symbols.forEach(canonicalResearchSymbol);
  const startedAt = new Date();
  const researchTime = resolveResearchTime({ unit: 'date_range', endDate: new Date(startedAt.getTime() + 8 * 3600000).toISOString().slice(0, 10), asOf: startedAt.toISOString() }, startedAt)!;
  const run = await prisma.researchReportRun.create({
    data: {
      projectId: scope.projectId,
      createdById: scope.actorUserId,
      watchlistId: watchlist.id,
      status: 'running',
      runType: options.runType ?? (options.dryRun === false ? 'manual' : 'dry_run'),
      startedAt,
      providerMode: 'local',
      metadata: inputJson({
        dryRun: options.dryRun ?? true,
        marketApiBaseUrl: MARKET_API_BASE_URL,
        researchTime,
      }),
    },
  });

  try {
    const universeId = watchlist.universeId ?? DEFAULT_UNIVERSE_ID;
    const query = new URLSearchParams({ universe_id: universeId, limit: '8', trade_date: researchTime.endDate });
    watchlist.symbols.forEach((symbol) => query.append('symbols', symbol));
    watchlist.markets.forEach((market) => query.append('markets', market));
    const [universesProbe, screenerProbe, clickhouseProbe] = await Promise.all([
      fetchMarketProbe(`/api/v1/research/universes/summary`, '本地股票池'),
      fetchMarketProbe(`/api/v1/research/screeners/a-share/short-term-candidates?${query}`, '短线候选筛选', 5000),
      fetchMarketProbe(`/api/v1/analytics/clickhouse/health`, 'ClickHouse 分析层'),
    ]);

    const builtReport = buildReport({ watchlist, universesProbe, screenerProbe, clickhouseProbe, researchTime });
    const report = await prisma.researchReport.create({
      data: {
        projectId: scope.projectId,
        createdById: scope.actorUserId,
        runId: run.id,
        watchlistId: watchlist.id,
        title: builtReport.title,
        summary: builtReport.summary,
        reportDate: startedAt,
        marketScope: inputJson({
          universeId: watchlist.universeId,
          symbols: watchlist.symbols,
          markets: watchlist.markets,
        }),
        score: builtReport.score,
        recommendation: builtReport.recommendation,
        riskLevel: builtReport.riskLevel,
        contentMarkdown: builtReport.contentMarkdown,
        structured: inputJson(builtReport.structured),
        evidence: inputJson(builtReport.evidence),
        source: 'local-market-data',
      },
    });

    const deliveryChannels = await findChannelsForWatchlist(scope, watchlist);
    const deliveries = await createNotificationDeliveries({
      scope,
      runId: run.id,
      report: mapNotificationReport(report),
      channels: deliveryChannels.map(mapNotificationChannel),
      dryRun: options.dryRun ?? true,
    });

    await prisma.researchReportRun.update({
      where: { id: run.id },
      data: {
        status: 'completed',
        finishedAt: new Date(),
        metadata: {
          dryRun: options.dryRun ?? true,
          reportId: report.id,
          evidenceStatuses: builtReport.evidence.map((item) => ({
            source: item.source,
            status: item.status,
          })),
          deliveryStatuses: deliveries.map((delivery) => ({
            id: delivery.id,
            channelType: delivery.channelType,
            status: delivery.status,
            error: delivery.error,
          })),
        },
      },
    });
  } catch (error) {
    await prisma.researchReportRun.update({
      where: { id: run.id },
      data: {
        status: 'failed',
        finishedAt: new Date(),
        error: compactError(error),
      },
    });
    throw error;
  }

  return getResearchAutomationDashboard(scope);
}

export async function sendResearchReport(
  scope: ResearchScope,
  options: SendResearchReportOptions = {}
): Promise<ResearchAutomationDashboard> {
  await ensureResearchAutomationSeed(scope);

  const report = options.reportId
    ? await prisma.researchReport.findFirst({ where: { id: options.reportId, projectId: scope.projectId } })
    : await prisma.researchReport.findFirst({ where: { projectId: scope.projectId }, orderBy: { createdAt: 'desc' } });

  if (!report) {
    throw new Error(options.reportId ? `Research report not found: ${options.reportId}` : 'No research report available to send');
  }

  const watchlistRecord = report.watchlistId
    ? await prisma.researchWatchlist.findFirst({ where: { id: report.watchlistId, projectId: scope.projectId } })
    : null;
  const watchlist = watchlistRecord ? mapWatchlist(watchlistRecord) : null;
  if (report.watchlistId && !watchlistRecord) throw new Error('Research report watchlist is unavailable in this project.');
  const deliveryChannels = await findChannelsForWatchlist(scope, watchlist);

  if (deliveryChannels.length === 0) {
    throw new Error('No notification channel available');
  }

  const dryRun = options.dryRun ?? false;
  const idempotencyKey = options.idempotencyKey?.trim();
  const reservationKey = !dryRun && idempotencyKey
    ? `research-delivery-idempotency:${createHash('sha256').update(`${scope.projectId}:${idempotencyKey}`).digest('hex')}`
    : null;
  if (!dryRun && !reservationKey) {
    throw new Error('Real research report delivery requires an idempotency key');
  }

  if (reservationKey) {
    try {
      await prisma.platformSetting.create({
        data: {
          key: reservationKey,
          value: {
            status: 'reserved',
            reportId: report.id,
            requestedAt: new Date().toISOString(),
          },
        },
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
        const existing = await prisma.platformSetting.findUnique({ where: { key: reservationKey } });
        const value = asRecord(existing?.value);
        if (asString(value.reportId) && asString(value.reportId) !== report.id) {
          throw new Error('Research delivery idempotency conflict: the key is bound to another report');
        }
        if (asString(value.status) !== 'failed') {
          // completed means a known success; reserved means the outcome may be
          // uncertain after a crash. Both are at-most-once and must not resend.
          return getResearchAutomationDashboard(scope);
        }
        await prisma.platformSetting.update({
          where: { key: reservationKey },
          data: {
            value: {
              status: 'reserved',
              reportId: report.id,
              requestedAt: new Date().toISOString(),
              retryOfFailedAttempt: true,
            },
          },
        });
      } else {
        throw error;
      }
    }
  }

  try {
    const deliveries = await createNotificationDeliveries({
      scope,
      runId: null,
      report: mapNotificationReport(report),
      channels: deliveryChannels.map(mapNotificationChannel),
      dryRun,
      idempotencyKey: reservationKey,
    });
    if (reservationKey) {
      await prisma.platformSetting.update({
        where: { key: reservationKey },
        data: {
          value: {
            status: 'completed',
            reportId: report.id,
            completedAt: new Date().toISOString(),
            deliveryIds: deliveries.map((delivery) => delivery.id),
          },
        },
      });
    }
  } catch (error) {
    if (reservationKey) {
      await prisma.platformSetting.update({
        where: { key: reservationKey },
        data: {
          value: {
            status: 'failed',
            reportId: report.id,
            failedAt: new Date().toISOString(),
            error: error instanceof Error ? error.message : String(error),
          },
        },
      }).catch(() => undefined);
    }
    throw error;
  }

  return getResearchAutomationDashboard(scope);
}
