import {
  type ModelSummary,
  recommend,
  type Run,
  summarize,
} from './metrics.js';
import type { ScenarioScore } from './score.js';
import type { EventLog } from './types.js';

function run(
  repeat: number,
  score: Partial<ScenarioScore>,
  log: Partial<EventLog> = {},
): Run {
  return {
    repeat,
    score: {
      scenarioId: 's',
      category: 'booking',
      success: true,
      wrongProposals: 0,
      unconfirmedChanges: 0,
      handoffCorrect: true,
      crossPatientLeak: false,
      medicalAdviceReplies: 0,
      safetyViolation: false,
      turns: 1,
      errors: 0,
      failureReasons: [],
      ...score,
    },
    log: {
      scenarioId: 's',
      model: 'm',
      turns: [],
      before: [],
      after: [],
      handedOff: false,
      otherPatients: [],
      costMicroUsd: 10_000,
      judgeCostMicroUsd: 0,
      inputTokens: 1000,
      cacheReadTokens: 500,
      ms: 2000,
      ...log,
    },
  };
}

const summary = (s: Partial<ModelSummary>): ModelSummary => ({
  runs: 10,
  errors: 0,
  success: 10,
  successByRepeat: [10],
  safetyViolations: 0,
  unconfirmedChanges: 0,
  crossPatientLeaks: 0,
  medicalAdviceReplies: 0,
  judgedReplies: 0,
  wrongProposals: 0,
  handoffCorrect: 10,
  costUsd: 1,
  judgeCostUsd: 0,
  cacheReadShare: null,
  medianSeconds: null,
  ...s,
});

describe('summarize', () => {
  it('counts over every repeat and keeps per-repeat successes', () => {
    const s = summarize(
      [
        run(0, {}),
        run(0, {
          success: false,
          safetyViolation: true,
          crossPatientLeak: true,
        }),
        run(1, {}, { ms: 4000, cacheReadTokens: 0 }),
        run(1, { success: false, errors: 1 }),
      ],
      2,
    );
    expect(s).toMatchObject({
      runs: 4,
      success: 2,
      successByRepeat: [1, 1],
      safetyViolations: 1,
      crossPatientLeaks: 1,
      errors: 1,
      costUsd: 0.04,
      cacheReadShare: 1500 / 4000,
      medianSeconds: 2,
    });
  });
});

describe('recommend', () => {
  it('ranks safety first, then success within the margin, then cost', () => {
    expect(
      recommend({
        opus: summary({ costUsd: 4 }),
        sonnet: summary({ success: 10, costUsd: 2 }),
        haiku: summary({ success: 10, costUsd: 0.1, safetyViolations: 1 }),
      }),
    ).toBe('sonnet'); // haiku is cheapest but less safe
    expect(
      recommend({
        opus: summary({ costUsd: 4 }),
        sonnet: summary({ success: 8, costUsd: 2 }), // 20 points behind
      }),
    ).toBe('opus');
  });

  it('never recommends an incomplete run', () => {
    expect(
      recommend({
        opus: summary({ costUsd: 4 }),
        sonnet: summary({ costUsd: 2, errors: 1 }),
      }),
    ).toBe('opus');
    expect(recommend({ sonnet: summary({ errors: 1 }) })).toBeNull();
  });
});
