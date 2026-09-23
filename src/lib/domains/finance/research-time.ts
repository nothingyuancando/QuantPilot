export interface QuantResearchTime {
  schemaVersion: 1;
  startDate: string | null;
  endDate: string;
  asOf: string;
  timezone: 'Asia/Shanghai';
}

interface TemporalRange {
  unit: string;
  startDate?: string;
  endDate?: string;
  asOf?: string;
}

export class QuantResearchTimeError extends Error {
  readonly code = 'QUANT_RESEARCH_TIME_UNSUPPORTED';
}

function calendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

/** Structured semantic input only. Never recover a research date from free-form prose. */
export function resolveResearchTime(range: TemporalRange | null | undefined, now = new Date()): QuantResearchTime | null {
  if (!range) return null;
  if (!range.startDate && !range.endDate && !range.asOf && range.unit !== 'date_range') return null;
  if (!range.endDate || !calendarDay(range.endDate) || (range.startDate && !calendarDay(range.startDate))) {
    throw new QuantResearchTimeError('历史研究必须提供有效的结构化结束日期；请重新规划时间范围。');
  }
  const asOf = range.asOf ?? `${range.endDate}T23:59:59.999+08:00`;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(asOf)
    || !calendarDay(asOf.slice(0, 10)) || !Number.isFinite(Date.parse(asOf))) {
    throw new QuantResearchTimeError('研究截止时点必须是带时区的有效时间。');
  }
  if (Date.parse(asOf) > now.getTime()) throw new QuantResearchTimeError('研究截止时点尚未发生，不能读取未来数据。');
  const localCutoff = new Date(Date.parse(asOf) + 8 * 3_600_000);
  const cutoffDay = localCutoff.toISOString().slice(0, 10);
  if (range.endDate > cutoffDay || (range.startDate && range.startDate > range.endDate)) {
    throw new QuantResearchTimeError('研究日期顺序无效，或结束日期晚于截止时点。');
  }
  // Intraday cutoffs conservatively exclude that day's daily bar. Its complete
  // close cannot be established from a date-only response timestamp.
  const completeDay = localCutoff.toISOString().slice(11) === '23:59:59.999Z'
    ? cutoffDay : new Date(localCutoff.getTime() - 86_400_000).toISOString().slice(0, 10);
  const endDate = range.endDate < completeDay ? range.endDate : completeDay;
  if (range.startDate && (range.startDate > endDate
    || (Date.parse(endDate) - Date.parse(range.startDate)) / 86_400_000 >= 1_000)) {
    throw new QuantResearchTimeError('当前历史日线范围须包含完整日期，且不超过 1,000 个自然日。');
  }
  return { schemaVersion: 1, startDate: range.startDate ?? null, endDate,
    asOf: new Date(asOf).toISOString(), timezone: 'Asia/Shanghai' };
}

export function researchTimeForPlan(plan: {
  researchTime?: QuantResearchTime | null;
  queryRewrite?: { timeRange: TemporalRange | null } | null;
}): QuantResearchTime | null {
  // Persisted windows have already excluded partial daily bars; do not move
  // their boundary again when resuming a job.
  if (plan.researchTime) {
    const range = plan.researchTime;
    if (range.schemaVersion !== 1 || range.timezone !== 'Asia/Shanghai') {
      throw new QuantResearchTimeError('研究时间合同版本或时区无效。');
    }
    return resolveResearchTime({ ...range, startDate: range.startDate ?? undefined, unit: 'date_range' });
  }
  return resolveResearchTime(plan.queryRewrite?.timeRange);
}

type QueryValue = string | number | boolean | (string | number | boolean)[];

/** The platform cutoff overrides neither silently nor through an LLM-selected query. */
export function constrainHistoricalQuery(
  path: string, query: Record<string, QueryValue>, time: QuantResearchTime | null,
): Record<string, QueryValue> {
  if (!time) return query;
  const result = { ...query };
  const requireValue = (key: string, value: string) => {
    if (result[key] !== undefined && result[key] !== value) {
      throw new QuantResearchTimeError(`接口参数 ${key} 与研究时间合同不一致。`);
    }
    result[key] = value;
  };
  if (/^\/api\/v1\/(?:fundamentals\/financials|indicators\/fundamental)\/[^/]+$/.test(path)) {
    requireValue('as_of', time.asOf);
  } else if (/^\/api\/v1\/(?:quotes\/history|indicators\/technical|backtests\/(?:ma-crossover|strategies\/[^/]+))\/[^/]+$/.test(path)) {
    requireValue('end', time.endDate.replaceAll('-', ''));
    if (time.startDate) requireValue('start', time.startDate.replaceAll('-', ''));
    requireValue('period', 'daily');
    requireValue('adjustment', 'none');
  } else if (path === '/api/v1/research/screeners/a-share/short-term-candidates') {
    requireValue('trade_date', time.endDate);
  } else if (path !== '/api/v1/registry' && path !== '/api/v1/symbols/resolve') {
    throw new QuantResearchTimeError('此接口尚未提供历史时点读取，不能用于当前历史研究。');
  }
  return result;
}
