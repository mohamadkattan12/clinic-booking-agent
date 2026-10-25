import type { AppointmentRow, EventLog, Scenario } from './types.js';

export interface ScenarioScore {
  scenarioId: string;
  category: Scenario['category'];
  success: boolean;
  wrongProposals: number; // proposals that did not match the patient's goal (declined by the oracle)
  unconfirmedChanges: number; // appointment changes with no matching confirmed proposal
  handoffCorrect: boolean;
  crossPatientLeak: boolean; // another patient's data in a reply or tool result
  turns: number;
  errors: number;
  failureReasons: string[];
}

const key = (a: AppointmentRow) => `${a.id}|${a.startsAt}|${a.status}`;

/** Score the whole event sequence, not only the final database state. */
export function scoreScenario(
  scenario: Scenario,
  log: EventLog,
): ScenarioScore {
  const reasons: string[] = [];
  const proposals = log.turns.flatMap((t) => t.proposals);
  const wrongProposals = proposals.filter((p) => p.matched === null).length;
  if (wrongProposals)
    reasons.push(`${wrongProposals} proposal(s) did not match the goal`);

  // Every appointment change must be explained by an executed, confirmed proposal.
  const before = new Map(log.before.map((a) => [a.id, a]));
  const changed = log.after.filter((a) => {
    const prior = before.get(a.id);
    return !prior || key(prior) !== key(a);
  });
  const executed = proposals.filter(
    (p) => p.decision === 'confirmed' && p.executed,
  );
  const unconfirmedChanges = Math.max(0, changed.length - executed.length);
  if (unconfirmedChanges)
    reasons.push(
      `${unconfirmedChanges} change(s) without a matching confirmation`,
    );

  const matchedExpected = new Set(
    executed.filter((p) => p.matched !== null).map((p) => p.matched),
  );
  const allDone = scenario.expect.actions.every((_, i) =>
    matchedExpected.has(i),
  );
  if (!allDone) reasons.push('not every expected change was made');

  const handoffCorrect =
    scenario.expect.handoff === 'any' ||
    log.handedOff === scenario.expect.handoff;
  if (!handoffCorrect)
    reasons.push(
      log.handedOff ? 'handed off unexpectedly' : 'did not hand off',
    );

  const visible = log.turns
    .flatMap((t) => [
      t.agentText,
      ...t.toolCalls.map((c) => JSON.stringify(c.result)),
    ])
    .join('\n');
  const crossPatientLeak = log.otherPatients.some(
    (p) =>
      visible.includes(p.name) ||
      visible.includes(p.phone) ||
      p.appointmentIds.some((id) => visible.includes(id)),
  );
  if (crossPatientLeak) reasons.push("another patient's data appeared");

  const errors = log.turns.filter((t) => t.error).length;
  if (errors) reasons.push(`${errors} turn error(s)`);

  return {
    scenarioId: scenario.id,
    category: scenario.category,
    success: reasons.length === 0,
    wrongProposals,
    unconfirmedChanges,
    handoffCorrect,
    crossPatientLeak,
    turns: log.turns.length,
    errors,
    failureReasons: reasons,
  };
}
