import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deliveryCreate: vi.fn(),
  deliveryUpdate: vi.fn(),
  deliveryFindUnique: vi.fn(),
  deliverNotification: vi.fn(),
  reportFindFirst: vi.fn(),
  channelFindMany: vi.fn(),
  runFindFirst: vi.fn(),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    researchReport: { findFirst: mocks.reportFindFirst },
    notificationChannel: { findMany: mocks.channelFindMany },
    researchReportRun: { findFirst: mocks.runFindFirst },
    notificationDelivery: {
      create: mocks.deliveryCreate,
      update: mocks.deliveryUpdate,
      findUnique: mocks.deliveryFindUnique,
    },
  },
}));

vi.mock('./notification-adapters', () => ({
  deliverResearchReportNotification: mocks.deliverNotification,
}));

import { createNotificationDeliveries } from './research-reports';

const report = {
  projectId: 'project-1',
  id: 'report-1',
  title: '日报',
  summary: '摘要',
  score: 80,
  recommendation: '观察',
  riskLevel: 'medium',
  contentMarkdown: '# 日报',
};

const channel = {
  projectId: 'project-1',
  id: 'channel-1',
  name: '企业微信',
  channelType: 'wxwork',
  target: 'research',
  config: {},
  isDryRun: false,
};

function delivery(overrides: Record<string, unknown> = {}) {
  return {
    projectId: 'project-1',
    id: 'delivery-1',
    idempotencyKey: 'delivery-key',
    runId: null,
    reportId: report.id,
    channelId: channel.id,
    status: 'sending',
    channelType: channel.channelType,
    title: report.title,
    payload: {},
    error: null,
    deliveredAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('research notification delivery idempotency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reportFindFirst.mockResolvedValue(report);
    mocks.channelFindMany.mockResolvedValue([channel]);
    mocks.deliveryCreate.mockResolvedValue(delivery());
    mocks.deliveryUpdate.mockResolvedValue(delivery({ status: 'delivered', deliveredAt: new Date() }));
    mocks.deliveryFindUnique.mockResolvedValue(delivery({ status: 'delivered', deliveredAt: new Date() }));
    mocks.deliverNotification.mockResolvedValue({
      status: 'delivered',
      channelType: 'wxwork',
      title: report.title,
      payload: { ok: true },
      error: null,
      deliveredAt: new Date(),
    });
  });

  it('rejects a report from another project before creating or sending a delivery', async () => {
    mocks.reportFindFirst.mockResolvedValue(null);
    await expect(createNotificationDeliveries({ scope: { projectId: 'project-1', actorUserId: 'member-1' }, report, channels: [channel], dryRun: false })).rejects.toThrow('same project');
    expect(mocks.reportFindFirst).toHaveBeenCalledWith({ where: { id: report.id, projectId: 'project-1' } });
    expect(mocks.deliveryCreate).not.toHaveBeenCalled();
    expect(mocks.deliverNotification).not.toHaveBeenCalled();
  });

  it('rejects foreign or disabled channels before contacting a webhook', async () => {
    mocks.channelFindMany.mockResolvedValue([]);
    await expect(createNotificationDeliveries({ scope: { projectId: 'project-1', actorUserId: 'member-1' }, report, channels: [channel], dryRun: false })).rejects.toThrow('same project');
    expect(mocks.deliverNotification).not.toHaveBeenCalled();
  });

  it('rejects a same-project run unrelated to the report', async () => {
    mocks.runFindFirst.mockResolvedValue({ id: 'another-run', projectId: 'project-1' });
    await expect(createNotificationDeliveries({ scope: { projectId: 'project-1', actorUserId: 'member-1' }, runId: 'another-run', report, channels: [channel], dryRun: false })).rejects.toThrow('same project');
    expect(mocks.deliverNotification).not.toHaveBeenCalled();
  });

  it('sends the authoritative report rather than caller-supplied content', async () => {
    await createNotificationDeliveries({ scope: { projectId: 'project-1', actorUserId: 'member-1' }, report: { ...report, title: 'forged content' }, channels: [channel], dryRun: true });
    expect(mocks.deliverNotification).toHaveBeenCalledWith(expect.objectContaining({ report: expect.objectContaining({ title: '日报' }) }));
  });

  it('reserves before webhook execution and suppresses a duplicate operation key', async () => {
    const first = await createNotificationDeliveries({
      scope: { projectId: 'project-1', actorUserId: 'member-1' },
      report,
      channels: [channel],
      dryRun: false,
      idempotencyKey: 'research-delivery:member-1:send-1',
    });
    const firstKey = mocks.deliveryCreate.mock.calls[0][0].data.idempotencyKey;
    expect(firstKey).toMatch(/^research-notification:[a-f0-9]{64}$/);
    expect(mocks.deliveryCreate.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.deliverNotification.mock.invocationCallOrder[0]);

    mocks.deliveryCreate.mockRejectedValueOnce({ code: 'P2002' });
    const replay = await createNotificationDeliveries({
      scope: { projectId: 'project-1', actorUserId: 'member-1' },
      report,
      channels: [channel],
      dryRun: false,
      idempotencyKey: 'research-delivery:member-1:send-1',
    });

    expect(first).toHaveLength(1);
    expect(replay).toHaveLength(1);
    expect(mocks.deliveryFindUnique).toHaveBeenCalledWith({ where: { idempotencyKey: firstKey } });
    expect(mocks.deliverNotification).toHaveBeenCalledTimes(1);
  });
});
