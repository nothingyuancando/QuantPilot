import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { requireAction } from '@/lib/auth/action';
import { requireAuthSession, isPlatformAdmin } from '@/lib/auth/authorization';
import { getProjectAuthConfig } from '@/lib/config/auth';
import { getAllProjects } from '@/lib/services/project';
import { getResearchAutomationDashboard } from '@/lib/quant/research-reports';
import ResearchReportsClient, { type ResearchView } from './ResearchReportsClient';

export const metadata: Metadata = {
  title: '投研情报中心 · QuantPilot',
  description: '统一管理观察池、研究证据、结构化报告、主题洞察与推送回执。',
};

type Props = { searchParams?: Promise<{ view?: string; projectId?: string }> };

export default async function ResearchReportsPage({ searchParams }: Props) {
  const params = await searchParams;
  const requestHeaders = await headers();
  const session = getProjectAuthConfig().enabled ? await requireAuthSession(requestHeaders) : null;
  const projects = await getAllProjects(session ? { userId: session.user.id, isAdmin: isPlatformAdmin(session.user) } : undefined);
  const projectId = params?.projectId ?? projects[0]?.id;
  if (!projectId) return <p className="p-8">请先创建项目，再进入投研情报中心。</p>;
  const context = await requireAction({ headers: requestHeaders, action: 'research.report.read', projectId });
  const dashboard = await getResearchAutomationDashboard({ projectId, actorUserId: context.actorUserId });
  const requestedView = params?.view;
  const view: ResearchView = requestedView === 'reports' || requestedView === 'insights' || requestedView === 'automation' ? requestedView : 'overview';
  return <><nav className="flex flex-wrap gap-3 px-6 pt-4" aria-label="研究项目">{projects.map((project) => <a key={project.id} href={`?projectId=${encodeURIComponent(project.id)}&view=${view}`} aria-current={project.id === projectId ? 'page' : undefined}>{project.name}</a>)}</nav><ResearchReportsClient initialData={dashboard} initialView={view} /></>;
}

export const dynamic = 'force-dynamic';
