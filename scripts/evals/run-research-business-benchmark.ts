import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { researchBusinessCases } from '../../benchmarks/quantpilot/research-business-cases';

async function main() {
  const results = researchBusinessCases.map((testCase) => {
    const durations: number[] = [];
    try {
      testCase.check();
      for (let repeat = 0; repeat < 20; repeat++) {
        const start = performance.now();
        testCase.check();
        durations.push(performance.now() - start);
      }
      durations.sort((a, b) => a - b);
      return { id: testCase.id, category: testCase.category, passed: true, p50Ms: durations[10], p95Ms: durations[18] };
    } catch (error) {
      return { id: testCase.id, category: testCase.category, passed: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  const fixture = await fs.readFile(path.resolve('benchmarks/quantpilot/research-business-cases.ts'));
  const report = { schemaVersion: 1, executionClass: 'deterministic_business_contract', generatedAt: new Date().toISOString(), fixtureSha256: createHash('sha256').update(fixture).digest('hex'), measuredModelQuality: false, total: results.length, passed: results.filter((result) => result.passed).length, results };
  const outputPath = path.resolve('reports/evals/research-business-benchmark.json');
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`${report.passed}/${report.total} deterministic business cases passed; report: ${outputPath}`);
  for (const result of results.filter((result) => !result.passed)) console.error(`${result.id}: ${result.error}`);
  if (report.passed !== report.total) process.exitCode = 1;
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
