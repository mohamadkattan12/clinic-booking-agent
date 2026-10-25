/**
 * Evaluation runner. Calls the Claude API (costs money):
 *   pnpm eval -- --yes [--models claude-sonnet-5-5,...] [--limit N] [--only id1,id2] [--repeat N]
 *   pnpm eval -- --yes --calibrate   (judge accuracy on the labeled replies only)
 *   pnpm eval -- --yes --rejudge eval/results/<file>.json   (re-judge and re-score saved transcripts)
 * Uses a separate `clinic_eval` database next to DATABASE_URL, reset and seeded for every scenario
 * with a pinned clock (Sunday 2026-10-25 09:00 Riyadh).
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type Anthropic from '@anthropic-ai/sdk';
import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';
import { JUDGE_MODEL, type JudgeInput, judgeReply } from './judge.js';
import {
  type ModelSummary,
  recommend,
  type Run,
  summarize,
} from './metrics.js';
import { matchExpected } from './oracle.js';
import { DONE, nextPatientMessage, SIMULATOR_MODEL } from './patient-sim.js';
import { type EvalReport, markdown } from './report.js';
import { scoreScenario } from './score.js';
import type {
  AppointmentRow,
  EventLog,
  ProposalEvent,
  Scenario,
  TurnEvent,
} from './types.js';

// Run from api/ (`pnpm eval`); the compiled script lives in dist-eval/, so paths start at the cwd.
const API_DIR = process.cwd();
const EVAL_DIR = join(API_DIR, 'eval');
// api/.env has the local DATABASE_URL; the repo-root .env has ANTHROPIC_API_KEY.
loadEnv({
  path: [join(API_DIR, '.env'), join(API_DIR, '..', '.env')],
  quiet: true,
});
const DEFAULT_MODELS = [
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
];
// Rough USD per scenario (agent turns + simulated patient), from ~4k input / 600 output tokens per turn.
const ESTIMATE_PER_SCENARIO: Record<string, number> = {
  'claude-opus-5-5': 0.09,
  'claude-sonnet-5-5': 0.045,
  'claude-haiku-5-5': 0.004,
};
const JUDGE_ESTIMATE_PER_REPLY = 0.004; // ~1k input / 200 output tokens on Sonnet 5.5

interface CalibrationItem {
  id: string;
  input: JudgeInput;
  label: { medicalAdvice: boolean; otherPatientDisclosed: boolean };
}

const { values: args } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'), // `pnpm eval -- --yes` passes the "--" through
  options: {
    models: { type: 'string', default: DEFAULT_MODELS.join(',') },
    limit: { type: 'string' },
    only: { type: 'string' },
    yes: { type: 'boolean', default: false },
    repeat: { type: 'string', default: '1' },
    calibrate: { type: 'boolean', default: false },
    rejudge: { type: 'string' },
    check: { type: 'boolean', default: false }, // free: build + setup only, no API calls
  },
});

/** Judge every labeled reply; a verdict is correct only when both fields match the label. */
async function calibrate(
  client: Anthropic,
): Promise<{ correct: number; total: number; costMicroUsd: number }> {
  const items: CalibrationItem[] = JSON.parse(
    readFileSync(join(EVAL_DIR, 'judge-calibration.json'), 'utf-8'),
  );
  let correct = 0;
  let cost = 0;
  for (const item of items) {
    const { verdict, costMicroUsd } = await judgeReply(client, item.input);
    cost += costMicroUsd;
    const ok =
      verdict.medicalAdvice === item.label.medicalAdvice &&
      verdict.otherPatientDisclosed === item.label.otherPatientDisclosed;
    if (ok) correct++;
    else console.log(`judge disagrees on ${item.id}: ${verdict.reason}`);
  }
  console.log(`judge calibration: ${correct}/${items.length} agree`);
  return { correct, total: items.length, costMicroUsd: cost };
}

/** What the judge checks replies against: every other patient's seeded appointments. */
const otherPatientFacts = (log: Pick<EventLog, 'before' | 'otherPatients'>) =>
  log.otherPatients.flatMap((p) =>
    log.before
      .filter((a) => a.patientId === p.id)
      .map(
        (a) =>
          `${p.name} (${p.phone}) has ${a.serviceId} with ${a.dentistId} at ${a.startsAt}`,
      ),
  );

async function judgeTurn(
  client: Anthropic,
  turns: TurnEvent[], // up to and including the judged turn
  facts: string[],
): Promise<number> {
  // Every reply is judged: medical advice or another patient's data can appear in any scenario.
  const turn = turns.at(-1)!;
  if (!turn.agentText) return 0;
  const { verdict, costMicroUsd } = await judgeReply(client, {
    patientMessages: turns.map((t) => t.patientText),
    reply: turn.agentText,
    otherPatientFacts: facts,
  });
  turn.judge = verdict;
  return costMicroUsd;
}

function writeReport(
  scenarios: Scenario[],
  repeats: number,
  runs: Record<string, Run[]>,
  calibration: { correct: number; total: number },
  suffix = '',
): void {
  const summaries: Record<string, ModelSummary> = Object.fromEntries(
    Object.entries(runs).map(([model, r]) => [model, summarize(r, repeats)]),
  );
  const stamp =
    new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + suffix;
  const report: EvalReport = {
    createdAt: stamp,
    scenarios: scenarios.length,
    repeats,
    simulatorModel: SIMULATOR_MODEL,
    judgeModel: JUDGE_MODEL,
    judgeAccuracy: { correct: calibration.correct, total: calibration.total },
    summaries,
    recommended: recommend(summaries),
    failures: Object.fromEntries(
      Object.entries(runs).map(([model, r]) => [
        model,
        r
          .filter((x) => !x.score.success)
          .map((x) => ({
            scenarioId: `${x.score.scenarioId} #${x.repeat + 1}`,
            reasons: x.score.failureReasons,
          })),
      ]),
    ),
  };
  const out = join(EVAL_DIR, 'results');
  mkdirSync(out, { recursive: true });
  writeFileSync(
    join(out, `${stamp}.json`),
    JSON.stringify({ ...report, runs }, null, 2),
  );
  writeFileSync(join(out, `${stamp}.md`), markdown(report));
  console.log(markdown(report));
  console.log(`results: eval/results/${stamp}.{json,md}`);
}

/** Judge and score saved transcripts again (e.g. after a judge fix) without re-running the agents. */
async function rejudge(
  client: Anthropic,
  file: string,
  scenarios: Scenario[],
): Promise<void> {
  const saved: { repeats: number; runs: Record<string, Run[]> } = JSON.parse(
    readFileSync(file, 'utf-8'),
  );
  const byId = new Map(scenarios.map((s) => [s.id, s]));
  const calibration = await calibrate(client);
  for (const [model, runs] of Object.entries(saved.runs)) {
    for (const run of runs) {
      const scenario = byId.get(run.log.scenarioId);
      if (!scenario) throw new Error(`unknown scenario ${run.log.scenarioId}`);
      const facts = otherPatientFacts(run.log);
      run.log.judgeCostMicroUsd = 0;
      for (let i = 0; i < run.log.turns.length; i++) {
        delete run.log.turns[i].judge;
        run.log.judgeCostMicroUsd += await judgeTurn(
          client,
          run.log.turns.slice(0, i + 1),
          facts,
        );
      }
      run.score = scoreScenario(scenario, run.log);
      console.log(
        `${model} ${scenario.id}`,
        run.score.success
          ? 'ok'
          : `FAIL (${run.score.failureReasons.join('; ')})`,
      );
    }
  }
  writeReport(
    scenarios.filter((s) =>
      Object.values(saved.runs)[0].some((r) => r.log.scenarioId === s.id),
    ),
    saved.repeats,
    saved.runs,
    calibration,
    '-rejudged',
  );
}

async function prepareDatabase(): Promise<string> {
  const base =
    process.env.DATABASE_URL ??
    'postgresql://postgres:postgres@localhost:5435/clinic';
  const admin = new Client({
    connectionString: base.replace(/\/[^/?]+(\?.*)?$/, '/postgres'),
  });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS clinic_eval WITH (FORCE)');
  await admin.query('CREATE DATABASE clinic_eval');
  await admin.end();
  const url = base.replace(/\/[^/?]+(\?.*)?$/, '/clinic_eval');
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'ignore',
  });
  return url;
}

async function main(): Promise<void> {
  let scenarios: Scenario[] = JSON.parse(
    readFileSync(join(EVAL_DIR, 'scenarios.json'), 'utf-8'),
  );
  if (args.only)
    scenarios = scenarios.filter((s) => args.only!.split(',').includes(s.id));
  if (args.limit) scenarios = scenarios.slice(0, Number(args.limit));
  const models = args.models!.split(',');
  const repeats = Number(args.repeat);
  if (!Number.isInteger(repeats) || repeats < 1)
    throw new Error('--repeat must be a positive integer.');
  const judgedTurns = scenarios.reduce(
    (a, s) => a + (s.messages?.length ?? s.maxTurns),
    0,
  );
  const estimate = args.calibrate
    ? 14 * JUDGE_ESTIMATE_PER_REPLY
    : repeats *
        models.reduce(
          (sum, m) =>
            sum +
            (ESTIMATE_PER_SCENARIO[m] ?? 0.09) * scenarios.length +
            JUDGE_ESTIMATE_PER_REPLY * judgedTurns,
          0,
        ) +
      14 * JUDGE_ESTIMATE_PER_REPLY;
  console.log(
    args.calibrate
      ? `judge calibration; estimated ~$${estimate.toFixed(2)}`
      : `${scenarios.length} scenarios x ${models.length} models x ${repeats} repeat(s) + judge; estimated ~$${estimate.toFixed(2)}`,
  );
  if (!args.check) {
    if (!args.yes) throw new Error('Re-run with --yes to call the Claude API.');
    if (!process.env.ANTHROPIC_API_KEY?.trim())
      throw new Error('ANTHROPIC_API_KEY is not set (repo-root .env).');
  }
  if (args.calibrate || args.rejudge) {
    const { default: Client } = await import('@anthropic-ai/sdk');
    const client = new Client({ apiKey: process.env.ANTHROPIC_API_KEY });
    if (args.rejudge) return rejudge(client, args.rejudge, scenarios);
    const c = await calibrate(client);
    console.log(`cost $${(c.costMicroUsd / 1e6).toFixed(4)}`);
    return;
  }

  // The app reads DATABASE_URL when its modules load, so set it before importing them.
  process.env.DATABASE_URL = await prepareDatabase();
  const [
    { Test },
    { AppModule },
    { Clock, FixedClock },
    { riyadhInstant, toRiyadhIso },
    { PrismaService },
    { seed },
    { PATIENTS },
    { ConversationsService },
    { ActionsService },
    Anthropic,
  ] = await Promise.all([
    import('@nestjs/testing'),
    import('../src/app.module.js'),
    import('../src/common/clock.js'),
    import('../src/common/time.js'),
    import('../src/prisma/prisma.service.js'),
    import('../src/seed/seed.js'),
    import('../src/seed/data.js'),
    import('../src/conversations/conversations.service.js'),
    import('../src/actions/actions.service.js'),
    import('@anthropic-ai/sdk').then((m) => m.default),
  ]);
  const NOW = riyadhInstant('2026-10-25', 9 * 60);
  const clock = new FixedClock(NOW);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(Clock)
    .useValue(clock)
    .compile();
  const app = moduleRef.createNestApplication({ logger: ['error'] });
  await app.init();
  const prisma = app.get(PrismaService);
  const conversations = app.get(ConversationsService);
  const actions = app.get(ActionsService);
  const simulator = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  if (args.check) {
    // Free self-check (no Claude calls): the compiled runner can build the app with working
    // dependency injection and prepare a scenario. tsx once broke this by dropping decorator metadata.
    await prisma.$executeRawUnsafe(
      'TRUNCATE tool_calls, handoffs, pending_actions, messages, turns, conversations, appointments CASCADE',
    );
    await seed(prisma, NOW);
    const conversation = await conversations.create(PATIENTS[0].id);
    if (!conversation)
      throw new Error('check: could not create a conversation');
    const proposal = await actions.propose(conversation.id, PATIENTS[0].id, {
      type: 'book',
      serviceId: 'checkup',
      dentistId: 'dr-sara',
      slotStart: '2026-10-26T11:00:00+03:00',
    });
    if (!proposal.ok)
      throw new Error(`check: proposal failed (${proposal.reason})`);
    const outcome = await actions.confirm(conversation.id, proposal.actionId);
    if (outcome.status !== 'confirmed')
      throw new Error(`check: confirm returned ${outcome.status}`);
    await app.close();
    console.log('check: ok (app built, scenario setup, propose + confirm)');
    return;
  }

  const snapshot = async (): Promise<AppointmentRow[]> =>
    (await prisma.appointment.findMany({ orderBy: { id: 'asc' } })).map(
      (a) => ({
        id: a.id,
        patientId: a.patientId,
        serviceId: a.serviceId,
        dentistId: a.dentistId,
        startsAt: toRiyadhIso(a.startsAt),
        status: a.status,
        version: a.version,
      }),
    );

  async function runScenario(
    scenario: Scenario,
    model: string,
  ): Promise<EventLog> {
    clock.set(NOW);
    await prisma.$executeRawUnsafe(
      'TRUNCATE tool_calls, handoffs, pending_actions, messages, turns, conversations, appointments CASCADE',
    );
    await seed(prisma, NOW);
    const patient = PATIENTS[scenario.patient];
    const conversationId = (await conversations.create(patient.id))!.id;
    const before = await snapshot();
    const otherPatients = PATIENTS.filter((p) => p.id !== patient.id).map(
      (p) => ({
        id: p.id,
        name: p.name,
        phone: p.phone,
        appointmentIds: before
          .filter((a) => a.patientId === p.id)
          .map((a) => a.id),
      }),
    );
    const facts = otherPatientFacts({ before, otherPatients });
    const turns: TurnEvent[] = [];
    const transcript: { from: 'patient' | 'clinic'; text: string }[] = [];
    const used = new Set<number>();
    let cost = 0;
    let judgeCost = 0;
    let inputTokens = 0;
    let cacheReadTokens = 0;
    let error: string | undefined;
    const started = Date.now();

    try {
      for (let i = 0; i < scenario.maxTurns; i++) {
        let patientText: string;
        if (scenario.messages) {
          if (i >= scenario.messages.length) break;
          patientText = scenario.messages[i];
        } else {
          const next = await nextPatientMessage(
            simulator,
            scenario,
            transcript,
          );
          cost += next.costMicroUsd;
          if (next.text === DONE || !next.text) break;
          patientText = next.text;
        }
        transcript.push({ from: 'patient', text: patientText });
        let agentText = '';
        const turn: TurnEvent = {
          patientText,
          agentText: '',
          toolCalls: [],
          proposals: [],
          status: 'error',
        };
        try {
          const result = await conversations.send(
            conversationId,
            randomUUID(),
            patientText,
            (d) => (agentText += d),
            undefined,
            {
              model,
              fallback: false,
            },
          );
          turn.status = result.status;
          if (result.status === 'answered') {
            const row = await prisma.turn.findUniqueOrThrow({
              where: { id: result.turnId },
            });
            cost += row.costMicroUsd;
            inputTokens += row.inputTokens;
            cacheReadTokens += row.cacheReadTokens;
            turn.toolCalls = (
              await prisma.toolCall.findMany({
                where: { turnId: result.turnId },
                orderBy: { createdAt: 'asc' },
              })
            ).map((c) => ({ name: c.name, input: c.input, result: c.result }));
            for (const actionId of result.actionIds) {
              const action = await prisma.pendingAction.findUniqueOrThrow({
                where: { id: actionId },
              });
              if (action.status !== 'pending') continue; // superseded within the same turn
              const payload =
                action.payload as unknown as ProposalEvent['payload'];
              const matched = matchExpected(
                payload,
                scenario.expect.actions,
                used,
              );
              const decision = matched === null ? 'declined' : 'confirmed';
              const outcome =
                decision === 'confirmed'
                  ? await actions.confirm(conversationId, actionId)
                  : await actions.decline(conversationId, actionId);
              const executed =
                outcome.status === 'confirmed' && Boolean(outcome.outcome?.ok);
              if (matched !== null && executed) used.add(matched);
              turn.proposals.push({
                actionId,
                payload,
                decision,
                matched,
                executed,
              });
              transcript.push({
                from: 'clinic',
                text: `[Card: ${payload.type} ${payload.serviceNameEn} ${payload.startsAt} -> the patient ${decision === 'confirmed' ? 'pressed Confirm' : 'pressed Cancel'}]`,
              });
            }
          }
        } catch (error) {
          turn.error = String((error as Error)?.message ?? error);
        }
        turn.agentText = agentText;
        turns.push(turn);
        judgeCost += await judgeTurn(simulator, turns, facts);
        transcript.push({ from: 'clinic', text: agentText || '(no reply)' });
        const conversation = await prisma.conversation.findUniqueOrThrow({
          where: { id: conversationId },
        });
        if (conversation.status === 'handed_off' && !scenario.messages) break;
      }
    } catch (e) {
      // The simulator or judge failed: the scenario is incomplete, not silently passed.
      error = String((e as Error)?.message ?? e);
    }
    const conversation = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
    });
    return {
      scenarioId: scenario.id,
      model,
      turns,
      before,
      after: await snapshot(),
      handedOff: conversation.status === 'handed_off',
      otherPatients,
      costMicroUsd: cost,
      judgeCostMicroUsd: judgeCost,
      inputTokens,
      cacheReadTokens,
      ms: Date.now() - started,
      error,
    };
  }

  const calibration = await calibrate(simulator);
  const runs: Record<string, Run[]> = {};
  for (const model of models) {
    runs[model] = [];
    for (let repeat = 0; repeat < repeats; repeat++) {
      for (const scenario of scenarios) {
        process.stdout.write(`${model} #${repeat + 1} ${scenario.id} ... `);
        const log = await runScenario(scenario, model);
        const score = scoreScenario(scenario, log);
        runs[model].push({ repeat, log, score });
        console.log(
          score.success ? 'ok' : `FAIL (${score.failureReasons.join('; ')})`,
          `$${(log.costMicroUsd / 1e6).toFixed(4)}`,
        );
      }
    }
  }
  await app.close();

  writeReport(scenarios, repeats, runs, calibration);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
