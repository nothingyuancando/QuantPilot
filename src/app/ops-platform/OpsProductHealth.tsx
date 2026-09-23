"use client";

import { FileCheck2, ListChecks, ScrollText, Target, Timer, Users } from "lucide-react";
import type { ProductHealthDashboard } from "@/lib/ops/product-health";
import { OpsMetricCard, OpsSectionHeader, OpsStatusBadge } from "./OpsConsolePrimitives";

function duration(value: number | null): string {
  if (value === null) return "暂无";
  if (value < 60_000) return `${Math.round(value / 1_000)} 秒`;
  if (value < 3_600_000) return `${Math.round(value / 6_000) / 10} 分钟`;
  return `${Math.round(value / 360_000) / 10} 小时`;
}

function rate(value: number | null): string {
  return value === null ? "暂无" : `${value}%`;
}

export function OpsProductHealth({ data }: { data: ProductHealthDashboard }) {
  const { summary, firstResearch } = data;
  return (
    <section className="space-y-4" aria-label="研究闭环指标">
      <OpsSectionHeader
        eyebrow="PRODUCT OUTCOMES"
        title={`最近 ${data.windowDays} 天研究闭环`}
        description="按请求创建时间观察研究结果；进行中和等待澄清的请求不进入终态完成率，交付耗时只统计有有效验收回执的 Mission。"
        action={!data.available
          ? <OpsStatusBadge status="warning" label="指标降级" />
          : data.sampled
            ? <OpsStatusBadge status="warning" label="最近 10,000 条请求" />
            : <OpsStatusBadge status="ok" label="完整窗口" />}
      />
      {!data.available ? (
        <div role="status" className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-600 dark:text-amber-400">
          {data.error ?? "产品闭环指标暂不可用。"}
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <OpsMetricCard icon={<ListChecks className="h-4 w-4" />} label="研究请求" value={summary.requests} helper={`${summary.activeProjects} 个活跃项目 · ${summary.activeRequests} 个进行中 · ${summary.clarificationRequests} 个等待澄清 · 终态完成率 ${rate(summary.requestCompletionRate)}`} tone="blue" />
            <OpsMetricCard icon={<Target className="h-4 w-4" />} label="Mission 验收率" value={rate(summary.missionAcceptanceRate)} helper={`${summary.acceptedDeliveries}/${summary.terminalMissions} 个终态 Mission 通过验收`} tone="blue" />
            <OpsMetricCard icon={<FileCheck2 className="h-4 w-4" />} label="验收证据完整率" value={rate(summary.evidenceCompletenessRate)} helper={`${summary.acceptedDeliveries}/${summary.completedMissions} 个已完成 Mission 有匹配的有效回执`} tone={summary.unverifiedCompletedMissions ? "amber" : "blue"} />
            <OpsMetricCard icon={<Timer className="h-4 w-4" />} label="交付中位耗时" value={duration(summary.medianDeliveryMs)} helper={`${summary.deliveryTimingSamples} 个有效样本 · P90 ${duration(summary.p90DeliveryMs)} · P95 ${duration(summary.p95DeliveryMs)}`} tone="blue" />
            <OpsMetricCard icon={<Users className="h-4 w-4" />} label="窗口内重复研究率" value={rate(summary.repeatResearcherRate)} helper={`${summary.repeatResearchers}/${summary.uniqueResearchers} 位已识别研究者提交至少 2 次请求`} tone="blue" />
            <OpsMetricCard icon={<ScrollText className="h-4 w-4" />} label="结构化研究报告" value={summary.reports} helper="按报告日期统计完整窗口内的报告数量" tone="blue" />
            <OpsMetricCard icon={<Target className="h-4 w-4" />} label="首次研究 24 小时完成率" value={firstResearch.available ? rate(firstResearch.completionRate) : "不可用"} helper={firstResearch.available ? `${firstResearch.acceptedResearchers}/${firstResearch.maturedResearchers} 位已观察满 24 小时的研究者完成交付 · ${firstResearch.observingResearchers} 位仍在观察 · 首次交付中位耗时 ${duration(firstResearch.medianDeliveryMs)}` : firstResearch.error ?? "首次研究历史暂不可用。"} tone={firstResearch.available ? "blue" : "amber"} />
            <OpsMetricCard icon={<Timer className="h-4 w-4" />} label="Worker 首次排队耗时" value={duration(summary.medianQueueWaitMs)} helper={`${summary.queueTimingSamples} 个已启动任务 · P90 ${duration(summary.p90QueueWaitMs)} · 未启动任务不计入耗时`} tone="blue" />
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            {data.sampled ? "请求、Mission、耗时和研究者指标仅基于窗口内最近 10,000 条请求，不能代表整个窗口。" : "请求与 Mission 的状态会随任务推进更新。"}
            窗口内重复研究率衡量重复使用，不代表第 7 日留存。
            首次研究以已识别用户的全历史首次提交划定首次研究人群；完整观察 24 小时后计入分母，期间的重试验收可计为首次交付。
          </p>
          {(summary.unverifiedCompletedMissions > 0 || summary.invalidDeliveryTimings > 0) && (
            <p role="status" className="text-xs leading-5 text-amber-600 dark:text-amber-400">
              {summary.unverifiedCompletedMissions} 个已完成 Mission 缺少匹配的有效验收回执；
              {summary.invalidDeliveryTimings} 个已验收 Mission 的时间缺失或异常，已从耗时统计中排除。
            </p>
          )}
          {(summary.invalidQueueTimings > 0 || firstResearch.invalidDeliveryTimings > 0) && (
            <p role="status" className="text-xs leading-5 text-amber-600 dark:text-amber-400">
              {summary.invalidQueueTimings} 个排队时间异常；{firstResearch.invalidDeliveryTimings} 个首次交付时间异常，已排除异常时间样本。
            </p>
          )}
        </>
      )}
    </section>
  );
}
