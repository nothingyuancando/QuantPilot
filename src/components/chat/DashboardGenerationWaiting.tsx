'use client';

import { useReducedMotion } from 'framer-motion';
import Image from 'next/image';

import dashboardGenerationAnime from '@/assets/dashboard-generation-anime-v1.webp';
import type {
  MultiAgentNodeProgress,
  MultiAgentProgress,
} from '@/lib/contracts/multi-agent-progress';
import { MotionDiv } from '@/lib/motion';

export type DashboardGenerationWaitingMode = 'generating' | 'preview';

const WAITING_STAGES = [
  { id: 'planning', label: '理解问题' },
  { id: 'data', label: '准备数据' },
  { id: 'generation', label: '生成看板' },
  { id: 'validation', label: '自动验证' },
  { id: 'preview', label: '准备预览' },
] as const;

export type DashboardGenerationWaitingStage = (typeof WAITING_STAGES)[number];

const WAITING_COPY: Record<
  DashboardGenerationWaitingMode,
  { eyebrow: string; title: string; helper: string }
> = {
  generating: {
    eyebrow: '量化研究员工作中',
    title: '正在为你生成量化看板',
    helper: '系统会持续取数、编排图表并完成自动验证，完成后自动展示。',
  },
  preview: {
    eyebrow: '最后一步 · 准备预览',
    title: '正在准备可视化看板',
    helper: '正在启动并确认预览服务，准备好后会自动切换到结果。',
  },
};

const AGENT_LABELS: Record<string, string> = {
  fundamental_research: '基本面',
  technical_analysis: '技术分析',
  risk_precheck: '风险预检',
  risk_crosscheck: '风险复核',
  synthesis: '综合研判',
  workspace_generation: '看板生成',
};

const TERMINAL_SUCCESS = new Set(['passed', 'succeeded', 'candidate_complete', 'degraded']);
const TERMINAL_FAILURE = new Set(['failed', 'cancelled']);
const ACTIVE = new Set(['ready', 'claimed', 'running', 'waiting_approval', 'retry_wait']);

function agentStatus(node: MultiAgentNodeProgress) {
  if (TERMINAL_SUCCESS.has(node.status)) {
    return { symbol: '✓', label: node.status === 'degraded' ? '降级完成' : '完成', tone: 'border-emerald-300 bg-emerald-50 text-emerald-700' };
  }
  if (TERMINAL_FAILURE.has(node.status)) {
    return { symbol: '!', label: node.status === 'cancelled' ? '已取消' : '失败', tone: 'border-rose-300 bg-rose-50 text-rose-700' };
  }
  if (ACTIVE.has(node.status)) {
    return { symbol: '●', label: node.status === 'retry_wait' ? '等待重试' : '执行中', tone: 'border-indigo-300 bg-indigo-50 text-indigo-700' };
  }
  return { symbol: '○', label: '等待', tone: 'border-slate-200 bg-white/75 text-slate-500' };
}

function compactMetric(node: MultiAgentNodeProgress) {
  const metrics = [];
  if (node.durationMs !== null) metrics.push(`${(node.durationMs / 1_000).toFixed(1)}s`);
  if (node.tokenUsage.totalTokens > 0) metrics.push(`${node.tokenUsage.totalTokens.toLocaleString('zh-CN')} tokens`);
  return metrics.join(' · ');
}

function AgentNodeCard({ node }: { node: MultiAgentNodeProgress }) {
  const status = agentStatus(node);
  const metric = compactMetric(node);
  return (
    <div
      className={`min-w-0 rounded-xl border px-3 py-2 text-left shadow-sm ${status.tone}`}
      title={node.artifact?.storagePath ?? node.error?.message ?? undefined}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[11px] font-semibold">{AGENT_LABELS[node.key] ?? node.key}</span>
        <span className="shrink-0 text-[10px] font-semibold"><span aria-hidden="true">{status.symbol}</span> {status.label}</span>
      </div>
      {metric ? <p className="mt-1 truncate text-[10px] opacity-75">{metric}</p> : null}
      {node.error?.message ? <p className="mt-1 line-clamp-1 text-[10px] text-rose-700">{node.error.message}</p> : null}
    </div>
  );
}

export function MultiAgentDAGProgress({ progress }: { progress: MultiAgentProgress }) {
  if (!progress.enabled) return null;
  const byKey = new Map(progress.nodes.map((node) => [node.key, node]));
  const waves = [
    ['fundamental_research', 'technical_analysis', 'risk_precheck'],
    ['risk_crosscheck'],
    ['synthesis'],
    ['workspace_generation'],
  ].map((keys) => keys.map((key) => byKey.get(key)).filter((node): node is MultiAgentNodeProgress => Boolean(node)));
  if (waves.every((wave) => wave.length === 0)) return null;

  return (
    <div className="mt-3 rounded-2xl border border-white/80 bg-white/60 px-3 py-3 shadow-sm backdrop-blur-sm" aria-label="多 Agent 执行图">
      <div className="mb-2 flex items-center justify-between gap-3 text-[11px]">
        <span className="font-semibold text-slate-700">Multi-Agent Mission DAG</span>
        <span className="text-slate-500">独立上下文 · 结构化交接</span>
      </div>
      <div className="flex flex-col items-stretch gap-1.5 sm:flex-row sm:items-center">
        {waves.map((wave, waveIndex) => wave.length > 0 ? (
          <div key={waveIndex} className="contents">
            {waveIndex > 0 ? <span className="self-center text-xs text-slate-400" aria-hidden="true">→</span> : null}
            <div className={`grid min-w-0 flex-1 gap-1.5 ${wave.length > 1 ? 'grid-cols-3 sm:grid-cols-1' : ''}`}>
              {wave.map((node) => <AgentNodeCard key={node.key} node={node} />)}
            </div>
          </div>
        ) : null)}
      </div>
    </div>
  );
}

export function getDashboardGenerationWaitingCopy(mode: DashboardGenerationWaitingMode) {
  return WAITING_COPY[mode];
}

export function resolveDashboardGenerationWaitingStage(
  mode: DashboardGenerationWaitingMode,
  message: string,
  step?: string | null,
): DashboardGenerationWaitingStage & { index: number } {
  const stagesByStep: Record<string, number> = {
    request_received: 0, planning: 0, data_prefetch: 1, agent_execution: 2,
    validation: 3, repair: 3, final_validation: 3, evidence_verification: 3, preview: 4,
  };
  if (step && Object.hasOwn(stagesByStep, step)) {
    const index = stagesByStep[step];
    return { ...WAITING_STAGES[index], index };
  }
  const normalized = message.replace(/\s+/g, '');
  let index = 0;

  if (
    mode === 'preview' ||
    /(?:启动|确认|准备|恢复).*预览|预览(?:服务|已就绪|启动|准备|确认)/u.test(normalized)
  ) {
    index = 4;
  } else if (/准备数据|获取数据|取数|预取|行情数据|信源数据/u.test(normalized)) {
    index = 1;
  } else if (/正在生成|生成看板|构建看板|编排图表|生成页面/u.test(normalized)) {
    index = 2;
  } else if (/验证|自动修复|验收|凭据|证据/u.test(normalized)) {
    index = 3;
  }

  return { ...WAITING_STAGES[index], index };
}

function DashboardGenerationProgress({
  mode,
  message,
  step,
  accentColor,
  reduceMotion,
}: {
  mode: DashboardGenerationWaitingMode;
  message: string;
  step?: string | null;
  accentColor: string;
  reduceMotion: boolean | null;
}) {
  const activeStage = resolveDashboardGenerationWaitingStage(mode, message, step);
  const progressWidth = `${(activeStage.index / (WAITING_STAGES.length - 1)) * 80}%`;

  return (
    <div className="mt-5 rounded-2xl border border-white/80 bg-white/55 px-3.5 py-3 shadow-[0_12px_36px_-28px_rgba(79,70,229,0.55)] backdrop-blur-sm sm:px-5">
      <div className="mb-3 flex items-center justify-between gap-3 text-[11px] font-medium">
        <span className="text-slate-500">生成进度</span>
        <span className="rounded-full bg-white/80 px-2.5 py-1 font-semibold text-slate-700 shadow-sm">
          当前：{activeStage.label}
        </span>
      </div>

      <div
        role="progressbar"
        aria-label="看板生成阶段"
        aria-valuemin={1}
        aria-valuemax={WAITING_STAGES.length}
        aria-valuenow={activeStage.index + 1}
        aria-valuetext={`当前阶段：${activeStage.label}`}
        className="relative"
      >
        <div className="absolute left-[10%] right-[10%] top-[7px] h-1 overflow-hidden rounded-full bg-slate-200/80">
          <MotionDiv
            className="relative h-full overflow-hidden rounded-full"
            initial={false}
            animate={{ width: progressWidth }}
            transition={{ duration: reduceMotion ? 0 : 0.55, ease: 'easeOut' }}
            style={{
              background: `linear-gradient(90deg, ${accentColor}, #8b8cf8 58%, #d8a4f2)`,
            }}
          >
            {!reduceMotion && activeStage.index > 0 ? (
              <MotionDiv
                aria-hidden="true"
                className="absolute inset-y-0 w-10 bg-gradient-to-r from-transparent via-white/80 to-transparent blur-[1px]"
                initial={{ x: '-120%' }}
                animate={{ x: '520%' }}
                transition={{ duration: 2.2, repeat: Infinity, repeatDelay: 0.7, ease: 'easeInOut' }}
              />
            ) : null}
          </MotionDiv>
        </div>

        <div className="relative grid grid-cols-5">
          {WAITING_STAGES.map((stage, index) => {
            const completed = index < activeStage.index;
            const active = index === activeStage.index;
            return (
              <div key={stage.id} className="flex min-w-0 flex-col items-center">
                <div className="relative flex h-[18px] items-start justify-center">
                  {active && !reduceMotion ? (
                    <MotionDiv
                      aria-hidden="true"
                      className="absolute top-0 h-4 w-4 rounded-full"
                      style={{ backgroundColor: accentColor }}
                      animate={{ scale: [1, 1.75, 1], opacity: [0.28, 0, 0.28] }}
                      transition={{ duration: 1.8, repeat: Infinity, ease: 'easeOut' }}
                    />
                  ) : null}
                  <span
                    aria-hidden="true"
                    className={`relative flex h-4 w-4 items-center justify-center rounded-full border-2 text-[9px] font-bold transition-colors ${
                      completed || active
                        ? 'border-white text-white shadow-[0_2px_8px_rgba(74,85,150,0.25)]'
                        : 'border-slate-300 bg-white text-transparent'
                    }`}
                    style={completed || active ? { backgroundColor: accentColor } : undefined}
                  >
                    {completed ? '✓' : ''}
                  </span>
                </div>
                <span
                  className={`mt-1.5 truncate text-[10px] font-medium sm:text-[11px] ${
                    active
                      ? 'text-slate-800'
                      : completed
                        ? 'text-slate-600'
                        : 'text-slate-400'
                  }`}
                >
                  {stage.label}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function DashboardGenerationWaiting({
  mode,
  message,
  step,
  accentColor,
  multiAgent,
}: {
  mode: DashboardGenerationWaitingMode;
  message: string;
  step?: string | null;
  accentColor: string;
  multiAgent?: MultiAgentProgress;
}) {
  const reduceMotion = useReducedMotion();
  const copy = getDashboardGenerationWaitingCopy(mode);

  return (
    <MotionDiv
      role="status"
      aria-atomic="true"
      aria-live="polite"
      data-testid={`dashboard-generation-waiting-${mode}`}
      className="max-h-full w-full max-w-[580px] overflow-x-hidden overflow-y-auto px-4 py-5 text-center sm:px-6"
      initial={reduceMotion ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.45, ease: 'easeOut' }}
    >
      <div className="relative mx-auto w-full max-w-[520px]">
        <div
          aria-hidden="true"
          className="absolute -inset-5 rounded-[36px] opacity-25 blur-2xl"
          style={{
            background: `radial-gradient(circle at 50% 60%, ${accentColor}, transparent 68%)`,
          }}
        />

        <MotionDiv
          className="relative h-[clamp(190px,38vh,300px)] overflow-hidden rounded-[28px] border border-white/90 bg-white/70 p-2 shadow-[0_22px_70px_-34px_rgba(91,104,164,0.45)] backdrop-blur-sm"
          animate={reduceMotion ? undefined : { y: [0, -4, 0] }}
          transition={{ duration: 5.5, repeat: Infinity, ease: 'easeInOut' }}
        >
          <div className="relative h-full overflow-hidden rounded-[21px] bg-[#f8f7ff]">
            <MotionDiv
              className="absolute inset-0"
              animate={reduceMotion ? undefined : { scale: [1, 1.018, 1] }}
              transition={{ duration: 8, repeat: Infinity, ease: 'easeInOut' }}
            >
              <Image
                src={dashboardGenerationAnime}
                alt=""
                fill
                draggable={false}
                sizes="(max-width: 640px) calc(100vw - 48px), 520px"
                className="select-none object-cover"
              />
            </MotionDiv>

            <div className="absolute inset-0 bg-gradient-to-t from-white/20 via-transparent to-white/10" />
            {!reduceMotion ? (
              <MotionDiv
                aria-hidden="true"
                className="absolute -inset-y-12 w-24 rotate-12 bg-gradient-to-r from-transparent via-white/30 to-transparent blur-md"
                initial={{ x: '-180%' }}
                animate={{ x: '720%' }}
                transition={{ duration: 4.8, repeat: Infinity, repeatDelay: 1.4, ease: 'easeInOut' }}
              />
            ) : null}

            <div className="absolute left-4 top-4 inline-flex items-center gap-2 rounded-full border border-white/80 bg-white/80 px-3 py-1.5 text-[11px] font-semibold tracking-wide text-slate-700 shadow-sm backdrop-blur-md sm:left-5 sm:top-5">
              <span className="relative flex h-2 w-2" aria-hidden="true">
                <span
                  className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-50 motion-reduce:animate-none"
                  style={{ backgroundColor: accentColor }}
                />
                <span
                  className="relative inline-flex h-2 w-2 rounded-full"
                  style={{ backgroundColor: accentColor }}
                />
              </span>
              {copy.eyebrow}
            </div>
          </div>
        </MotionDiv>
      </div>

      <div className="mx-auto mt-5 max-w-[520px] px-1">
        <h3 className="text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">
          {copy.title}
        </h3>
        <div className="mt-2 flex min-h-6 items-center justify-center gap-2 text-sm font-medium text-slate-600">
          <span>{message}</span>
          <span className="inline-flex items-center gap-1" aria-hidden="true">
            {[0, 1, 2].map((index) => (
              <MotionDiv
                key={index}
                className="h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: accentColor }}
                animate={reduceMotion ? { opacity: 0.7 } : { opacity: [0.25, 1, 0.25], y: [0, -2, 0] }}
                transition={{ duration: 1.2, repeat: Infinity, delay: index * 0.18 }}
              />
            ))}
          </span>
        </div>
        <DashboardGenerationProgress
          mode={mode}
          message={message}
          step={step}
          accentColor={accentColor}
          reduceMotion={reduceMotion}
        />
        {multiAgent ? <MultiAgentDAGProgress progress={multiAgent} /> : null}
        <p className="mt-3 text-xs leading-5 text-slate-500 sm:text-[13px]">
          {copy.helper}
        </p>
      </div>
    </MotionDiv>
  );
}
