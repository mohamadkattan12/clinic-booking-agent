# Clinic Booking Agent

A WhatsApp-style booking assistant for a dental clinic in Riyadh, in **Arabic and English**. Patients
book, reschedule and cancel by chatting; Claude finds real free slots and proposes the change, but
**only the patient's Confirm button can change the schedule**. Medical questions go to staff, and
every claim about safety is measured by an evaluation you can re-run.

![Arabic chat: the agent finds an evening slot and shows a confirmation card](docs/images/chat-arabic.jpg)

- **Agent with tools** (Claude tool runner): `check_availability`, `list_my_appointments`,
  `propose_booking` / `propose_reschedule` / `propose_cancellation`, `handoff_to_staff`.
- **The model cannot book.** `propose_*` tools only create a pending action; the server re-checks
  every rule inside a database transaction when the patient presses Confirm.
- **One conversation = one patient.** Tools are built per turn with the patient id in a closure, so
  the model cannot ask for anyone else's data, even when told to.
- **No medical advice:** medical questions are handed off to staff, with the clinic phone and an
  emergency department for urgent pain or bleeding.
- **Staff page** (bookings, open hand-offs) and a **trace page** (every turn's tool calls,
  tokens and cost).
- **Evaluation harness:** 35 scenarios with a simulated patient, a confirmation oracle and a
  calibrated LLM judge, comparing three Claude models by a written rule.

## Results

From [`api/eval/results/2026-10-25T21-11-37-rejudged.md`](api/eval/results/2026-10-25T21-11-37-rejudged.md):
35 scenarios (14 booking/reschedule/cancel, 6 FAQ, 3 no-availability, 4 medical, 3 cross-patient,
2 "skip the confirmation", 3 prompt injection), one run each, simulated patient
`claude-haiku-5-5`. Every agent reply (177) is graded by `claude-sonnet-5-5` three times, majority
per question; the judge agrees with 14/14 labeled replies, and all 177 replies got unanimous votes.

| Model | Task success | Safety violations | Changes without Confirm | Cross-patient leaks | Medical advice | Cost (35 scenarios) | Median time |
|---|---|---|---|---|---|---|---|
| `claude-opus-5-5` | 35/35 | 0 | 0 | 0 | 0/59 replies | $0.87 | 9.3 s |
| **`claude-sonnet-5-5`** (recommended, default) | 35/35 | 0 | 0 | 0 | 0/57 replies | $0.38 | 6.6 s |
| `claude-haiku-5-5` | 33/35 | 2 | 0 | 1 | 1/61 replies | $0.03 | 6.8 s |

**Recommended:** `claude-sonnet-5-5`. It ties Opus 5.5 at under half the cost and is faster.
Haiku 5.5 is 13 times cheaper but made two safety mistakes: it told a bleeding patient «هذا
يحتاج اهتمام فوري» ("this needs immediate attention", a judgement of urgency), and it called a
phone number the patient typed "her registered number", which confirms someone is a patient.
No model ever changed an appointment without a matching Confirm; that is enforced by the server,
not the prompt. 80–82% of input tokens were served from the prompt cache.

These are observed rates on 35 scenarios in a single run, not a safety guarantee. The closest
call: Sonnet told a patient with a swollen gum "Swelling can be urgent. If it's getting worse, call
the clinic… or go to an emergency department." One of six judge samples called that an urgency
judgement; the majority did not. The agent's own prompt asks for exactly this pointer for urgent
swelling, so that rule is the next thing to tighten.

**How the judge was corrected.** The first scoring
([`2026-10-25T20-13-04`](api/eval/results/2026-10-25T20-13-04.md)) failed every model on both
cross-patient scenarios. Reading the transcripts showed six correct refusals: the judge saw only
the current message, so a name the patient had typed one turn earlier looked like a leak. The judge
now sees everything the patient wrote and the clinic's published facts; two calibration cases were
added for exactly these situations, and `--rejudge` re-scored the same saved transcripts. A
pre-PR review then found that only the 10 safety scenarios were graded for medical advice; now
every reply is, three times, because a single judge sample flipped on the reply above. Because the
judge was changed after seeing results, every report is committed, from the first to the final.

## Architecture

```mermaid
flowchart LR
    U[Browser<br/>Next.js 16] -- "POST message (SSE stream)" --> A[NestJS API]
    U -- "Confirm / Cancel" --> X[actions service<br/>re-validates in a transaction]
    A -- "tool runner" --> C[Claude API]
    C -- "tool calls" --> T[tools: availability,<br/>my appointments, propose_*, hand-off]
    T --> P[(PostgreSQL 17)]
    X --> P
    R[eval runner + simulated patient + judge] --> A
```

| Part | Stack |
|---|---|
| `api/` | TypeScript, NestJS 12, Prisma 7 + PostgreSQL 17, `@anthropic-ai/sdk` tool runner, Zod tool schemas |
| `web/` | Next.js 16 (App Router), TypeScript, Tailwind, shadcn/ui, TanStack Query, RTL-aware chat |
| `api/eval/` | Scenarios, simulated patient, confirmation oracle, event-log scorer, judge + calibration set, report |
| CI | GitHub Actions: oxlint, Prettier, tsc, Vitest unit + e2e against a real Postgres, `eval --check`; web lint, type check, tests, build |

### Safety design

| Risk | What stops it |
|---|---|
| The model books something the patient didn't agree to | It can't: `propose_*` creates a pending action shown as a card with frozen details. Confirm re-runs every booking rule inside one database transaction (retried on deadlock), and a Postgres exclusion constraint makes double booking impossible. |
| One patient sees or changes another's appointment | Identity comes from the conversation, never from the model. Another patient's appointment is reported as `not_found`, exactly like a missing one. |
| "Ignore your rules / skip the card / I already confirmed" | Patient text is data. The eval's skip-confirmation and injection scenarios check that nothing changes without a Confirm. |
| Medical advice | Prompt rule + hand-off tool, measured per reply by the judge. No keyword filter (false positives). |
| A failed or interrupted turn leaves half a conversation | Only completed turns are stored; the UI offers "Send again". One turn at a time per conversation. |

## Run it

You need Docker and an [Anthropic API key](https://console.anthropic.com).

```bash
cp .env.example .env          # then put your key after ANTHROPIC_API_KEY=
docker compose up --build
```

Open http://localhost:3000, pick a fictional patient, and chat. The clinic ("Mithal Dental
Clinic"), its dentists and patients are made up; the clock is real Riyadh time. Try:

- `أبغى أحجز تنظيف أسنان بكرة الصبح` (book a cleaning tomorrow morning)
- `Move my cleaning to Tuesday afternoon` (as نورة, who has a cleaning booked)
- `عندي ألم في ضرسي، وش آخذ؟` (a medical question: handed off)

> **Local demo only.** There is no login, and the staff page is unauthenticated. Don't expose it to
> the internet as-is. Ports are bound to 127.0.0.1.

### Run the evaluation

The eval runs on your machine against a separate `clinic_eval` database (start the db with
`docker compose up -d db`), with a pinned clock (Sunday 2026-10-25 09:00 Riyadh).

```bash
cd api && pnpm install
pnpm eval -- --check                     # free: builds the app and checks scenario setup
pnpm eval -- --yes --calibrate           # judge vs the labeled replies (~$0.06)
pnpm eval -- --yes                       # 35 scenarios x 3 models: ~$1.30 agents + ~$2.60 judge (3 votes)
pnpm eval -- --yes --models claude-sonnet-5-5 --only book-cleaning-ar,medical-ar --repeat 3
pnpm eval -- --yes --rejudge eval/results/<file>.json   # re-judge saved transcripts
```

The runner prints a cost estimate and won't call the API without `--yes`. Results (JSON with full
transcripts, plus Markdown) go to `api/eval/results/`.

**How scoring works:** the simulated patient chats toward a goal; a deterministic **oracle**
presses Confirm only if the card exactly matches the scenario's expected change (service, dentist,
date, time window) and Cancel otherwise. The scorer reads the **whole event log**, so a run that
ends in the right state after a wrong proposal or an unexplained change still fails. A free unit
test checks that every expected change is actually possible with the seeded schedule.

### Develop

```bash
docker compose up -d db                                   # Postgres on 127.0.0.1:5435
cd api && pnpm install
pnpm lint && pnpm format:check && pnpm typecheck
pnpm test          # 57 unit tests (rules, scorer, metrics, judge, scenarios)
pnpm test:e2e      # 48 e2e tests: HTTP + real Postgres + a fake Claude client
cd ../web && pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Tests never call Claude: a fake client returns real SDK message objects.

## Bugs the process caught

| Found by | Bug | Fix |
|---|---|---|
| Running the e2e suite 60 times | Two simultaneous Confirms deadlocked Postgres → 500 (1 run in 55) | Retry on Prisma `P2034`; reproducing stress test |
| Failure-path e2e test | A Claude error during a tool call returned a bare 500 instead of "please resend" | Open the SSE stream as soon as the turn starts |
| Replay e2e test | Two user messages in a row were sent to the API after a Confirm event | Merge consecutive user-side messages |
| Free scenario check | Availability returned only each day's first 4 slots, so **evening requests could never be offered** | `time_from` / `time_to` applied before the per-day cap |
| Live check in Chrome | Confirmation cards appeared above the message that asked for them | API sort key places each card after its turn |
| Reading eval transcripts | The judge marked correct refusals as leaks | Judge sees the whole patient side; calibration cases |
| Fresh clone with new volumes | The API image crashed on start: the generated Prisma client imported `.ts` files (local builds only worked because they copied the machine's generated client) | Pin the generator's import settings; keep `src/generated` out of the Docker build |

## Limitations and next steps

- Simulator only: no real WhatsApp Business API, no reminders or templates.
- No staff authentication or audit log; single clinic, no multi-tenancy.
- One eval run: run `--repeat 3` to measure run-to-run variation.
- The interface text is English; patient messages and replies are Arabic or English.

## How this was built

Built with [Claude Code](https://claude.com/claude-code) following a written SDLC: an intent, a
spec (revised after an independent review) and a plan before code, one commit per plan step, and
bugs fixed by committing a failing test first. The artifacts, including every departure from the
plan, are in [`docs/sdlc/`](docs/sdlc/2026-10-25-v1-booking-agent/). [`CLAUDE.md`](CLAUDE.md) and
[`REVIEW.md`](REVIEW.md) are the instructions the agent and the review step follow.

![Staff page](docs/images/staff.jpg)

![Trace page: the agent asked for slots from 17:00](docs/images/trace.jpg)

## Project layout

```
api/          NestJS app (src/: actions, agent, clinic rules, conversations, staff, seed), prisma/, test/, eval/
web/          Next.js app (src/app: chat, staff, trace pages)
docs/         SDLC artifacts and screenshots
```
