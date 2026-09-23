export const FIRST_RESEARCH_OBSERVATION_HOURS = 24;
const OBSERVATION_MS = FIRST_RESEARCH_OBSERVATION_HOURS * 60 * 60 * 1_000;

export interface FirstResearchMetrics {
  available: boolean;
  observationHours: number;
  researchers: number;
  maturedResearchers: number;
  observingResearchers: number;
  acceptedResearchers: number;
  completionRate: number | null;
  medianDeliveryMs: number | null;
  p90DeliveryMs: number | null;
  invalidDeliveryTimings: number;
  error: string | null;
}

export function unavailableFirstResearch(error: string): FirstResearchMetrics {
  return {
    available: false, observationHours: FIRST_RESEARCH_OBSERVATION_HOURS,
    researchers: 0, maturedResearchers: 0, observingResearchers: 0, acceptedResearchers: 0,
    completionRate: null, medianDeliveryMs: null, p90DeliveryMs: null,
    invalidDeliveryTimings: 0, error,
  };
}

/** First submission cohort, with a complete 24-hour opportunity to retry and deliver. */
export function summarizeFirstResearch(params: {
  firstRequests: { actorUserId: string | null; _min: { createdAt: Date | null } }[];
  acceptedRequests: { actorUserId: string | null; createdAt: Date; completedAt: Date | null }[];
  since: Date;
  now: Date;
}): FirstResearchMetrics {
  const firstTimes = new Map<string, number>();
  for (const entry of params.firstRequests) {
    const first = entry._min.createdAt?.getTime();
    if (entry.actorUserId && first !== undefined && Number.isFinite(first)
      && first >= params.since.getTime() && first <= params.now.getTime()) {
      firstTimes.set(entry.actorUserId, first);
    }
  }
  const mature = new Map([...firstTimes].filter(([, first]) => first + OBSERVATION_MS <= params.now.getTime()));
  const deliveries = new Map<string, number>();
  let invalidDeliveryTimings = 0;
  for (const request of params.acceptedRequests) {
    const first = request.actorUserId ? mature.get(request.actorUserId) : undefined;
    if (first === undefined) continue;
    const created = request.createdAt.getTime();
    const completed = request.completedAt?.getTime();
    if (!Number.isFinite(created) || completed === undefined || !Number.isFinite(completed)
      || created < first || completed < created || completed > params.now.getTime()) {
      invalidDeliveryTimings += 1;
      continue;
    }
    if (completed > first + OBSERVATION_MS) continue;
    const duration = completed - first;
    const previous = deliveries.get(request.actorUserId!);
    if (previous === undefined || duration < previous) deliveries.set(request.actorUserId!, duration);
  }
  const sorted = [...deliveries.values()].sort((left, right) => left - right);
  const percentile = (quantile: number) => {
    if (!sorted.length) return null;
    const position = (sorted.length - 1) * quantile;
    const lower = Math.floor(position);
    return Math.round(sorted[lower] + (sorted[Math.ceil(position)] - sorted[lower]) * (position - lower));
  };
  return {
    available: true, observationHours: FIRST_RESEARCH_OBSERVATION_HOURS,
    researchers: firstTimes.size, maturedResearchers: mature.size,
    observingResearchers: firstTimes.size - mature.size, acceptedResearchers: deliveries.size,
    completionRate: mature.size ? Math.round(deliveries.size / mature.size * 1_000) / 10 : null,
    medianDeliveryMs: percentile(0.5), p90DeliveryMs: percentile(0.9), invalidDeliveryTimings, error: null,
  };
}
