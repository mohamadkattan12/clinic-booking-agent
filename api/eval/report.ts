import type { ModelSummary } from './metrics.js';

export interface EvalReport {
  createdAt: string;
  scenarios: number;
  repeats: number;
  simulatorModel: string;
  judgeModel: string;
  judgeAccuracy: { correct: number; total: number } | null;
  summaries: Record<string, ModelSummary>;
  recommended: string | null;
  failures: Record<string, { scenarioId: string; reasons: string[] }[]>;
}

const of = (part: number, whole: number) =>
  `${part}/${whole}${whole ? ` (${Math.round((100 * part) / whole)}%)` : ''}`;

export function markdown(r: EvalReport): string {
  const lines = [
    `# Evaluation ${r.createdAt}`,
    '',
    `${r.scenarios} scenarios × ${r.repeats} repeat(s) · simulated patient \`${r.simulatorModel}\` · judge \`${r.judgeModel}\`` +
      (r.judgeAccuracy
        ? ` (agrees with ${of(r.judgeAccuracy.correct, r.judgeAccuracy.total)} labeled replies)`
        : ' (not calibrated in this run)'),
    '',
    '| Model | Task success | Safety violations | Unconfirmed changes | Cross-patient leaks | Medical advice (replies) | Wrong proposals | Hand-off correct | Errors | Cost (USD) | Cache reads | Median time |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const [model, s] of Object.entries(r.summaries)) {
    lines.push(
      `| \`${model}\` | ${of(s.success, s.runs)} | ${s.safetyViolations} | ${s.unconfirmedChanges} | ${s.crossPatientLeaks} | ${of(s.medicalAdviceReplies, s.judgedReplies)} | ${s.wrongProposals} | ${of(s.handoffCorrect, s.runs)} | ${s.errors} | $${s.costUsd.toFixed(2)} | ${s.cacheReadShare === null ? 'n/a' : `${Math.round(100 * s.cacheReadShare)}%`} | ${s.medianSeconds === null ? 'n/a' : `${s.medianSeconds.toFixed(1)} s`} |`,
    );
  }
  if (r.repeats > 1) {
    lines.push('', 'Successes per repeat (run-to-run variation):', '');
    for (const [model, s] of Object.entries(r.summaries))
      lines.push(`- \`${model}\`: ${s.successByRepeat.join(', ')}`);
  }
  lines.push(
    '',
    `**Recommended model:** ${r.recommended ? `\`${r.recommended}\`` : 'none (no complete run)'}`,
    '',
    'Rule: complete runs only; fewest safety violations; then success within 5 points of the best; then lowest cost. These are observed rates on this scenario set, not a safety guarantee.',
  );
  const failed = Object.entries(r.failures).filter(([, f]) => f.length);
  if (failed.length) {
    lines.push('', '## Failed scenarios', '');
    for (const [model, list] of failed)
      for (const f of list)
        lines.push(`- \`${model}\` ${f.scenarioId}: ${f.reasons.join('; ')}`);
  }
  return lines.join('\n') + '\n';
}
