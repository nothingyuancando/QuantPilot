import { describe, expect, it, vi } from 'vitest';

import {
  getProductHealthDashboard,
  summarizeProductHealth,
  type ProductHealthRequestSnapshot,
} from './product-health';

const now = new Date('2026-09-05T12:00:00.000Z');

function receipt() {
  return {
    id: 'receipt-a',
    missionId: 'mission-a',
    candidateVersion: 2,
    receiptType: 'acceptance',
    verdict: 'accepted',
  };
}

function mission(overrides: Partial<NonNullable<ProductHealthRequestSnapshot['agentMission']>> = {}) {
  return {
    id: 'mission-a',
    status: 'completed',
    candidateVersion: 2,
    acceptedReceiptId: 'receipt-a',
    completedAt: new Date('2026-09-05T10:10:00.000Z'),
    acceptedReceipt: receipt(),
    ...overrides,
  };
}

function request(
  overrides: Partial<ProductHealthRequestSnapshot> = {},
): ProductHealthRequestSnapshot {
  return {
    projectId: 'project-a',
    actorUserId: 'user-a',
    status: 'completed',
    createdAt: new Date('2026-09-05T10:00:00.000Z'),
    completedAt: new Date('2026-09-05T10:10:00.000Z'),
    agentMission: mission(),
    generationJob: null,
    ...overrides,
  };
}

describe('product health metrics', () => {
  it('separates active work from terminal success rates', () => {
    const dashboard = summarizeProductHealth({
      generatedAt: now,
      reports: 2,
      requests: [
        request(),
        request({ projectId: 'project-b', status: 'failed', agentMission: mission({ status: 'failed', acceptedReceiptId: null, completedAt: now }) }),
        request({ actorUserId: 'user-b', status: 'processing', completedAt: null, agentMission: mission({ status: 'running', acceptedReceiptId: null, completedAt: null }) }),
      ],
    });

    expect(dashboard.summary).toMatchObject({
      requests: 3,
      activeProjects: 2,
      completedRequests: 1,
      failedRequests: 1,
      activeRequests: 1,
      acceptedDeliveries: 1,
      terminalMissions: 2,
      reports: 2,
      uniqueResearchers: 2,
      repeatResearchers: 1,
      requestCompletionRate: 50,
      missionAcceptanceRate: 50,
      repeatResearcherRate: 50,
    });
    expect(dashboard.summary.medianDeliveryMs).toBe(600_000);
  });

  it.each([
    null,
    { ...receipt(), id: 'other-receipt' },
    { ...receipt(), missionId: 'other-mission' },
    { ...receipt(), candidateVersion: 1 },
    { ...receipt(), receiptType: 'validation' },
    { ...receipt(), verdict: 'rejected' },
  ])('excludes missing, stale or unrelated evidence from accepted delivery: %j', (acceptedReceipt) => {
    const { summary } = summarizeProductHealth({
      generatedAt: now,
      reports: 0,
      requests: [request(), request({ agentMission: mission({ acceptedReceipt }) })],
    });

    expect(summary).toMatchObject({
      completedRequests: 2,
      completedMissions: 2,
      acceptedDeliveries: 1,
      unverifiedCompletedMissions: 1,
      missionAcceptanceRate: 50,
      evidenceCompletenessRate: 50,
      deliveryTimingSamples: 1,
      medianDeliveryMs: 600_000,
    });
  });

  it('does not turn absent or invalid delivery timestamps into instant deliveries', () => {
    const { summary } = summarizeProductHealth({
      generatedAt: now,
      reports: 0,
      requests: [
        request(),
        ...[null, new Date('invalid'), new Date('2026-09-04'), new Date('2026-09-06')]
          .map((completedAt) => request({ agentMission: mission({ completedAt }) })),
      ],
    });

    expect(summary).toMatchObject({
      acceptedDeliveries: 5,
      deliveryTimingSamples: 1,
      invalidDeliveryTimings: 4,
      medianDeliveryMs: 600_000,
      p90DeliveryMs: 600_000,
      p95DeliveryMs: 600_000,
    });
  });

  it('computes latency percentiles from accepted deliveries only', () => {
    const { summary } = summarizeProductHealth({
      generatedAt: now,
      reports: 0,
      requests: [
        ...[120_000, 0, 180_000, 60_000].map((duration) => request({
          agentMission: mission({ completedAt: new Date(new Date('2026-09-05T10:00:00Z').getTime() + duration) }),
        })),
        request({ agentMission: mission({ acceptedReceiptId: null, completedAt: now }) }),
      ],
    });

    expect(summary).toMatchObject({
      medianDeliveryMs: 90_000,
      p90DeliveryMs: 162_000,
      p95DeliveryMs: 171_000,
      deliveryTimingSamples: 4,
    });
  });

  it('counts cancellation as terminal and excludes anonymous actors from repeat usage', () => {
    const { summary } = summarizeProductHealth({
      generatedAt: now,
      reports: 0,
      requests: [
        request(),
        request({ status: 'cancelled', agentMission: mission({ status: 'cancelled' }) }),
        request({ actorUserId: null, status: 'needs_clarification', agentMission: null }),
        request({ actorUserId: null, status: 'pending', agentMission: null }),
      ],
    });

    expect(summary).toMatchObject({
      cancelledRequests: 1,
      activeRequests: 1,
      clarificationRequests: 1,
      terminalMissions: 2,
      requestCompletionRate: 50,
      missionAcceptanceRate: 50,
      uniqueResearchers: 1,
      repeatResearchers: 1,
      repeatResearcherRate: 100,
    });
  });

  it.each([10_000, 10_001])('marks the latest-request cutoff accurately for %i rows', async (count) => {
    const findMany = vi.fn().mockResolvedValue(Array.from({ length: count }, () => request()));
    const countReports = vi.fn().mockResolvedValue(15_000);
    const dashboard = await getProductHealthDashboard({
      now,
      client: { userRequest: { findMany, groupBy: vi.fn().mockResolvedValue([]) }, researchReport: { count: countReports } },
    });
    const range = { gte: new Date('2026-08-29T12:00:00.000Z'), lte: now };

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { createdAt: range },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 10_001,
    }));
    expect(countReports).toHaveBeenCalledWith({ where: { reportDate: range } });
    expect(dashboard.summary.requests).toBe(10_000);
    expect(dashboard.summary.reports).toBe(15_000);
    expect(dashboard.sampled).toBe(count > 10_000);
  });

  it('does not report waiting-only requests as running work or terminal failures', () => {
    const { summary } = summarizeProductHealth({
      generatedAt: now, reports: 0,
      requests: [request({ status: 'needs_clarification', agentMission: null })],
    });
    expect(summary).toMatchObject({
      requests: 1, activeRequests: 0, clarificationRequests: 1,
      failedRequests: 0, requestCompletionRate: null, missionAcceptanceRate: null,
    });
  });

  it('uses null rates when there is no eligible denominator', () => {
    const dashboard = summarizeProductHealth({ generatedAt: now, reports: 0, requests: [] });

    expect(dashboard.summary.requestCompletionRate).toBeNull();
    expect(dashboard.summary.missionAcceptanceRate).toBeNull();
    expect(dashboard.summary.repeatResearcherRate).toBeNull();
    expect(dashboard.summary.medianDeliveryMs).toBeNull();
  });

  it('reads earliest submissions across history and counts an accepted retry in the first cohort', async () => {
    const createdAt = new Date('2026-09-03T10:00:00Z');
    const groupBy = vi.fn().mockResolvedValue([{ actorUserId: 'user-a', _min: { createdAt } }]);
    const dashboard = await getProductHealthDashboard({ now,
      client: {
        userRequest: { findMany: async () => [request({ createdAt,
          agentMission: mission({ completedAt: new Date('2026-09-03T10:10:00Z') }),
        })], groupBy }, researchReport: { count: async () => 0 },
      },
    });
    expect(groupBy).toHaveBeenCalledWith({ by: ['actorUserId'],
      where: { actorUserId: { in: ['user-a'] }, createdAt: { lte: now } }, _min: { createdAt: true } });
    expect(dashboard.firstResearch).toMatchObject({ available: true, maturedResearchers: 1,
      acceptedResearchers: 1, completionRate: 100, medianDeliveryMs: 600_000 });
  });

  it('isolates historical lookup failures from available window metrics', async () => {
    const dashboard = await getProductHealthDashboard({ now,
      client: { userRequest: { findMany: async () => [request()],
        groupBy: async () => { throw new Error('postgres secret connection'); },
      }, researchReport: { count: async () => 2 } },
    });
    expect(dashboard.available).toBe(true);
    expect(dashboard.summary.requests).toBe(1);
    expect(dashboard.firstResearch.available).toBe(false);
    expect(dashboard.firstResearch.error).not.toContain('secret');
  });

  it('does not infer first submissions from a truncated request window', async () => {
    const groupBy = vi.fn();
    const dashboard = await getProductHealthDashboard({ now,
      client: { userRequest: { findMany: async () => Array.from({ length: 10_001 }, () => request()), groupBy },
        researchReport: { count: async () => 0 } },
    });
    expect(groupBy).not.toHaveBeenCalled();
    expect(dashboard.firstResearch).toMatchObject({ available: false, completionRate: null });
    expect(dashboard.firstResearch.error).toContain('截断');
  });

  it('measures only valid first dispatch waits without treating pending tasks as instant starts', () => {
    const queuedAt = new Date('2026-09-05T10:00:00Z');
    const jobs = [null, 60_000, 0, 120_000, -1, 86_400_000, NaN].map((delay) => ({
      queuedAt, startedAt: delay === null ? null : new Date(queuedAt.getTime() + delay),
    }));
    const { summary } = summarizeProductHealth({ generatedAt: now, reports: 0,
      requests: jobs.map((generationJob) => request({ generationJob })),
    });
    expect(summary).toMatchObject({ queueTimingSamples: 3, invalidQueueTimings: 3,
      medianQueueWaitMs: 60_000, p90QueueWaitMs: 108_000 });
  });

  it('degrades without leaking database errors', async () => {
    const dashboard = await getProductHealthDashboard({
      now,
      client: {
        userRequest: { findMany: async () => { throw new Error('postgres password leaked'); }, groupBy: vi.fn() },
        researchReport: { count: async () => 0 },
      },
    });

    expect(dashboard.available).toBe(false);
    expect(dashboard.error).not.toContain('password');
  });

  it('does not access the database when it is disabled', async () => {
    let queried = false;
    const dashboard = await getProductHealthDashboard({
      now,
      enabled: false,
      client: {
        userRequest: { findMany: async () => { queried = true; return []; }, groupBy: vi.fn() },
        researchReport: { count: async () => { queried = true; return 0; } },
      },
    });

    expect(queried).toBe(false);
    expect(dashboard.available).toBe(false);
    expect(dashboard.error).toContain('停用');
  });
});
