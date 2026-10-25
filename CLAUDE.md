# Clinic Booking Agent

Public portfolio project: Arabic/English WhatsApp-style booking agent for a fictional dental clinic
(Claude tool runner, NestJS, Prisma, Next.js) with an evaluation harness. Local demo only; no auth.
Owner: mohamadkattan12.

## Commands
- Run: `docker compose up --build` → web http://localhost:3000, `curl -s localhost:8000/health/ready` → `{"status":"ready","migrations":3,"services":7}`
- DB for dev/tests: `docker compose up -d db` (Postgres 17 on 127.0.0.1:5435)
- API (in `api/`): `pnpm lint && pnpm format:check && pnpm typecheck` → exit 0; `pnpm test` → `56 passed`; `pnpm test:e2e` → `44 passed` (throwaway `clinic_test` database)
- Web (in `web/`): `pnpm lint && pnpm typecheck && pnpm test && pnpm build` → exit 0, `10 passed`, routes `/`, `/staff`, `/trace/[id]`
- Eval (in `api/`, costs money): `pnpm eval -- --yes [--models ..] [--only ids] [--repeat N]`; free: `pnpm eval -- --check` (runs in CI); judge only: `--calibrate`; re-score saved transcripts: `--rejudge <file>`
- Migrations: `pnpm exec prisma migrate dev --name <slug>` then `pnpm exec prisma generate`

## Verifying your work
Run lint, types and both test suites before reporting done and paste the output tails. If a test
fails, fix the code, not the test. UI changes: check the page in Chrome (chat, staff, trace). Never
spend API money (eval, live chat) without the owner's OK in chat.

## Conventions
- Scaffold and add dependencies with commands (`nest g`, `pnpm add`, `pnpm dlx shadcn add`, `prisma migrate dev`), not by hand-writing boilerplate.
- Commits are authored by the owner only: no `Claude-Session` or `Co-Authored-By` trailers.
- The model never changes data: `propose_*` tools create pending actions; only `ActionsService.confirm` (the patient's button) writes appointments, re-checking every rule in `clinic/booking-rules.ts`.
- Tools get the patient id from the conversation (closure in `agent/tools.ts`), never from model input. Another patient's appointment is `not_found`.
- Times: clinic-local `Asia/Riyadh`, fixed UTC+03:00 (`common/time.ts`); prices are integer halalas incl. VAT. Code reads time only through `Clock`.
- Eval changes to metrics, oracle or the recommendation rule need a spec amendment; judge changes need a calibration run, and calibration labels are never edited to match a verdict.
- Next.js 16 differs from older versions: read `web/node_modules/next/dist/docs/` before writing web code. Model text is rendered as Markdown without HTML or images.
- Changes follow the `sdlc` skill: intent, spec, plan in `docs/sdlc/<date>-<slug>/`, one commit per plan step, departures recorded in plan.md. Bugs: failing test committed first.

## Architecture
- `api/src/actions/`: pending actions (propose / confirm / decline), the only writer of appointments
- `api/src/agent/`: system prompt, tools, `AgentService` (tool runner, cost, cache usage)
- `api/src/conversations/`: turns (one at a time, dedupe by client message id, SSE), chat view
- `api/src/clinic/booking-rules.ts`: pure booking rules; `api/src/staff/`: staff + trace endpoints
- `api/eval/`: scenarios, simulated patient, oracle, scorer, judge, metrics, report; results in `api/eval/results/`
- `web/src/app/`: chat (`/?c=<conversation>`), `/staff`, `/trace/[id]`; `web/src/lib/api.ts` is the only API client, `sse.ts` the only SSE parser
- Generated: `api/src/generated/prisma` (git-ignored), `web/AGENTS.md` (written by `next dev`), lockfiles

## Deploy
None: local Docker only. Reset data: `docker compose down -v`.

## Things Claude gets wrong
- Text replacements written before Prettier/ruff format silently miss reformatted lines: check that each edit applied.
- A judge or scorer "failure" is not a model failure until the transcript is read; re-score with `--rejudge` instead of re-running agents.
- Running tsx for code that relies on Nest decorators: it drops decorator metadata. The eval is compiled with `tsc -p tsconfig.eval.json`.
- Removing a pnpm build decision (`allowBuilds` in `pnpm-workspace.yaml`) breaks the Docker build: pnpm 11 refuses to install while one is open.
