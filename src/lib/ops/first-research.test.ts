import { describe, expect, it } from 'vitest';
import { summarizeFirstResearch } from './first-research';

const now = new Date('2026-09-23T12:00:00Z');
const since = new Date('2026-09-16T12:00:00Z');
const first = (actorUserId: string | null, time: string) => ({ actorUserId, _min: { createdAt: new Date(time) } });
const accepted = (actorUserId: string | null, createdAt: string, completedAt: string | null) => ({
  actorUserId, createdAt: new Date(createdAt), completedAt: completedAt ? new Date(completedAt) : null,
});

describe('first research cohort', () => {
  it('uses global first submissions, mature observation windows and earliest accepted retries', () => {
    const result = summarizeFirstResearch({ now, since,
      firstRequests: [
        first('returning', '2026-09-01T12:00:00Z'),
        first('retry', '2026-09-20T12:00:00Z'), first('failed', '2026-09-20T12:00:00Z'),
        first('observing', '2026-09-23T00:00:00Z'), first(null, '2026-09-20T12:00:00Z'),
      ],
      acceptedRequests: [
        accepted('returning', '2026-09-20T12:00:00Z', '2026-09-20T12:01:00Z'),
        accepted('retry', '2026-09-20T12:05:00Z', '2026-09-20T12:15:00Z'),
        accepted('retry', '2026-09-20T12:04:00Z', '2026-09-20T12:10:00Z'),
        accepted('failed', '2026-09-21T12:00:00Z', '2026-09-21T12:00:01Z'),
        accepted('observing', '2026-09-23T00:00:00Z', '2026-09-23T00:05:00Z'),
      ],
    });
    expect(result).toMatchObject({ researchers: 3, maturedResearchers: 2, observingResearchers: 1,
      acceptedResearchers: 1, completionRate: 50, medianDeliveryMs: 600_000, invalidDeliveryTimings: 0 });
  });

  it('includes both window and 24-hour boundaries without accepting future delivery times', () => {
    const result = summarizeFirstResearch({ now, since,
      firstRequests: [first('boundary', '2026-09-22T12:00:00Z'), first('start', since.toISOString()), first('future', '2026-09-24T00:00:00Z')],
      acceptedRequests: [
        accepted('boundary', '2026-09-22T12:00:00Z', now.toISOString()),
        accepted('start', since.toISOString(), since.toISOString()),
      ],
    });
    expect(result).toMatchObject({ researchers: 2, maturedResearchers: 2, acceptedResearchers: 2,
      completionRate: 100, medianDeliveryMs: 43_200_000, p90DeliveryMs: 77_760_000 });
  });

  it.each([null, 'invalid', '2026-09-19T12:00:00Z', '2026-09-24T12:00:00Z'])('does not turn invalid accepted timestamps into instant success: %s', (time) => {
    expect(summarizeFirstResearch({ now, since,
      firstRequests: [first('user', '2026-09-20T12:00:00Z')],
      acceptedRequests: [accepted('user', '2026-09-20T12:00:00Z', time)],
    })).toMatchObject({ acceptedResearchers: 0, completionRate: 0, medianDeliveryMs: null, invalidDeliveryTimings: 1 });
  });

  it('shows no rate while every researcher is still in the observation period', () => {
    expect(summarizeFirstResearch({ now, since,
      firstRequests: [first('new', now.toISOString())], acceptedRequests: [],
    })).toMatchObject({ maturedResearchers: 0, observingResearchers: 1, completionRate: null, medianDeliveryMs: null });
  });
});
