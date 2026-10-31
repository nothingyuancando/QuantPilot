import { createHash } from 'node:crypto';

import type { PiAgentSpecialistRole } from './specialist-contracts';

export interface FinanceEvidenceDocument {
  path: string;
  content: string;
}

export interface FinanceEvidencePassage {
  id: string;
  source: string;
  jsonPath: string;
  text: string;
  score: number;
}

const ROLE_QUERY: Record<PiAgentSpecialistRole, string> = {
  fundamental_research: 'revenue profit margin cash flow dividend valuation balance sheet income financial report period',
  technical_analysis: 'price close open high low volume return trend momentum volatility moving average drawdown date',
  risk_precheck: 'missing null stale source quality timestamp asOf gap lookahead survivorship concentration warning error',
  risk_crosscheck: 'claim evidence conflict unsupported risk hash uncertainty',
  synthesis: 'consensus disputed claim evidence dashboard risk',
};

const MAX_PASSAGES = 4_000;
const MAX_DEPTH = 10;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function tokens(value: string): string[] {
  const normalized = value.toLowerCase();
  const latinMatches = normalized.match(/[a-z0-9_.%-]{2,}/gu) ?? [];
  const latin = latinMatches.flatMap((part) => [
    part,
    ...part.split(/[._%-]+/u).filter((token) => token.length >= 2),
  ]);
  const han = normalized.match(/[\p{Script=Han}]+/gu) ?? [];
  const grams = han.flatMap((part) => {
    if (part.length <= 2) return [part];
    return Array.from({ length: part.length - 1 }, (_, index) => part.slice(index, index + 2));
  });
  return [...new Set([...latin, ...grams])];
}

function flattenJson(source: string, value: unknown): Array<Omit<FinanceEvidencePassage, 'score'>> {
  const passages: Array<Omit<FinanceEvidencePassage, 'score'>> = [];
  const visit = (current: unknown, segments: string[], depth: number, recordContext = '') => {
    if (passages.length >= MAX_PASSAGES || depth > MAX_DEPTH) return;
    if (Array.isArray(current)) {
      current.slice(0, MAX_PASSAGES - passages.length).forEach((item, index) => visit(item, [...segments, String(index)], depth + 1));
      return;
    }
    if (current && typeof current === 'object') {
      const entries = Object.entries(current as Record<string, unknown>);
      // Keep dates, symbols and units beside the numeric value they qualify.
      // Never combine unrelated rows from an array into one evidence passage.
      const context = JSON.stringify(Object.fromEntries(entries.filter(([, item]) => item === null || ['string', 'number', 'boolean'].includes(typeof item)))).slice(0, 1400);
      entries.forEach(([key, item]) => visit(item, [...segments, key], depth + 1, context));
      return;
    }
    if (current === null || ['string', 'number', 'boolean'].includes(typeof current)) {
      const jsonPath = segments.length ? `$.${segments.join('.')}` : '$';
      const valueText = `${jsonPath} = ${String(current)}`.slice(0, 600);
      const text = `${valueText}${recordContext && recordContext !== '{}' ? `; recordContext=${recordContext}` : ''}`.slice(0, 2_048);
      passages.push({
        id: `evidence:${sha256(`${source}\0${text}`).slice(0, 24)}`,
        source,
        jsonPath,
        text,
      });
    }
  };
  visit(value, [], 0);
  return passages;
}

function documentPassages(document: FinanceEvidenceDocument) {
  try {
    return flattenJson(document.path, JSON.parse(document.content));
  } catch {
    return document.content.split(/\r?\n/u).slice(0, MAX_PASSAGES).map((line, index) => {
      const text = line.slice(0, 2_048);
      return {
        id: `evidence:${sha256(`${document.path}\0${index}\0${text}`).slice(0, 24)}`,
        source: document.path,
        jsonPath: `$line.${index + 1}`,
        text,
      };
    });
  }
}

/** Deterministic bounded lexical retrieval over frozen finance artifacts. */
export function retrieveFinanceEvidence(input: {
  role: PiAgentSpecialistRole;
  question?: string;
  documents: readonly FinanceEvidenceDocument[];
  limit?: number;
}): FinanceEvidencePassage[] {
  const passages = input.documents.flatMap(documentPassages).filter((passage) => passage.text.trim());
  const query = tokens(`${input.question?.slice(0, 8000) ?? ''} ${ROLE_QUERY[input.role]}`);
  const passageTokens = passages.map((passage) => tokens(`${passage.jsonPath} ${passage.text}`));
  const documentFrequency = new Map<string, number>();
  passageTokens.forEach((items) => items.forEach((token) => documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1)));
  const scored = passages.map((passage, index) => {
    const itemTokens = passageTokens[index];
    const frequencies = new Map<string, number>();
    itemTokens.forEach((token) => frequencies.set(token, (frequencies.get(token) ?? 0) + 1));
    const score = query.reduce((total, token) => {
      const frequency = frequencies.get(token) ?? 0;
      if (!frequency) return total;
      const inverseFrequency = Math.log(1 + (passages.length + 1) / ((documentFrequency.get(token) ?? 0) + 1));
      return total + frequency * inverseFrequency;
    }, 0);
    const qualityBoost = /source|citation|asof|timestamp|period|date|报告期|数据源/iu.test(passage.jsonPath)
      ? 0.35
      : 0;
    const pathTokens = new Set(tokens(passage.jsonPath));
    const fieldBoost = query.reduce((total, token) => total + (pathTokens.has(token) ? 2 : 0), 0);
    return { ...passage, score: Number((score + qualityBoost + fieldBoost).toFixed(6)) };
  });
  return scored
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, Math.min(Math.max(input.limit ?? 48, 1), 100));
}
