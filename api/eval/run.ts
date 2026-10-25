/**
 * Evaluation runner. Calls the Claude API (costs money):
 *   pnpm eval -- --yes [--models claude-sonnet-5-5,...] [--limit N] [--only id1,id2]
 * Uses a separate `clinic_eval` database next to DATABASE_URL, reset and seeded for every scenario
 * with a pinned clock (Sunday 2026-10-25 09:00 Riyadh).
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';
import { matchExpected } from './oracle.js';
import { DONE, nextPatientMessage } from './patient-sim.js';
import { type ScenarioScore, scoreScenario } from './score.js';
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

const { values: args } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'), // `pnpm eval -- --yes` passes the "--" through
  options: {
    models: { type: 'string', default: DEFAULT_MODELS.join(',') },
    limit: { type: 'string' },
    only: { type: 'string' },
    yes: { type: 'boolean', default: false },
    check: { type: 'boolean', default: false }, // free: build + setup only, no API calls
  },
});

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
  const estimate = models.reduce(
    (sum, m) => sum + (ESTIMATE_PER_SCENARIO[m] ?? 0.09) * scenarios.length,
    0,
  );
  console.log(
    `${scenarios.length} scenarios x ${models.length} models; estimated ~$${estimate.toFixed(2)}`,
  );
  if (!args.check) {
    if (!args.yes) throw new Error('Re-run with --yes to call the Claude API.');
    if (!process.env.ANTHROPIC_API_KEY?.trim())
      throw new Error('ANTHROPIC_API_KEY is not set (repo-root .env).');
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
    const otherPatients = await Promise.all(
      PATIENTS.filter((p) => p.id !== patient.id).map(async (p) => ({
        id: p.id,
        name: p.name,
        phone: p.phone,
        appointmentIds: (
          await prisma.appointment.findMany({ where: { patientId: p.id } })
        ).map((a) => a.id),
      })),
    );
    const turns: TurnEvent[] = [];
    const transcript: { from: 'patient' | 'clinic'; text: string }[] = [];
    const used = new Set<number>();
    let cost = 0;
    const started = Date.now();

    for (let i = 0; i < scenario.maxTurns; i++) {
      let patientText: string;
      if (scenario.messages) {
        if (i >= scenario.messages.length) break;
        patientText = scenario.messages[i];
      } else {
        const next = await nextPatientMessage(simulator, scenario, transcript);
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
      transcript.push({ from: 'clinic', text: agentText || '(no reply)' });
      const conversation = await prisma.conversation.findUniqueOrThrow({
        where: { id: conversationId },
      });
      if (conversation.status === 'handed_off' && !scenario.messages) break;
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
      ms: Date.now() - started,
    };
  }

  const results: Record<string, { logs: EventLog[]; scores: ScenarioScore[] }> =
    {};
  for (const model of models) {
    results[model] = { logs: [], scores: [] };
    for (const scenario of scenarios) {
      process.stdout.write(`${model} ${scenario.id} ... `);
      const log = await runScenario(scenario, model);
      const score = scoreScenario(scenario, log);
      results[model].logs.push(log);
      results[model].scores.push(score);
      console.log(
        score.success ? 'ok' : `FAIL (${score.failureReasons.join('; ')})`,
        `$${(log.costMicroUsd / 1e6).toFixed(4)}`,
      );
    }
  }
  await app.close();

  const summary = Object.fromEntries(
    Object.entries(results).map(([model, r]) => {
      const n = r.scores.length;
      const count = (f: (s: ScenarioScore) => boolean) =>
        r.scores.filter(f).length;
      return [
        model,
        {
          scenarios: n,
          success: count((s) => s.success),
          wrongProposals: r.scores.reduce((a, s) => a + s.wrongProposals, 0),
          unconfirmedChanges: r.scores.reduce(
            (a, s) => a + s.unconfirmedChanges,
            0,
          ),
          handoffCorrect: count((s) => s.handoffCorrect),
          crossPatientLeaks: count((s) => s.crossPatientLeak),
          errors: r.scores.reduce((a, s) => a + s.errors, 0),
          costUsd: r.logs.reduce((a, l) => a + l.costMicroUsd, 0) / 1e6,
        },
      ];
    }),
  );
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = join(EVAL_DIR, 'results');
  mkdirSync(out, { recursive: true });
  writeFileSync(
    join(out, `${stamp}.json`),
    JSON.stringify({ createdAt: stamp, models, summary, results }, null, 2),
  );
  console.table(summary);
  console.log(`results: eval/results/${stamp}.json`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
