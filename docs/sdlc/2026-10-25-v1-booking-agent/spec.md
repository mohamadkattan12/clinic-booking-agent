# Spec: Clinic booking agent in a WhatsApp-style chat (v1)

From: intent.md (accepted 2026-10-25) · Status: draft
Skills applied: sdlc, claude-api (TypeScript tool runner), nestjs-patterns, prisma-patterns,
security-review, frontend-principles; lessons from arabic-docs-qa (localhost ports, eval design,
fresh-clone check, Markdown without images)
Produced by: `/sdlc` stage 2 for project #2

## Flagged concerns
1. **Confirmation must not depend on the model.** Decision (proposed): tools that change data
   (`propose_booking`, `propose_reschedule`, `propose_cancel`) never write appointments. They
   create a *pending action* and the chat shows **Confirm / Cancel buttons** (like WhatsApp reply
   buttons). Only the patient's button press, a separate API call the model cannot make, executes
   it. A pending action expires after 10 minutes and is re-checked for slot conflicts on confirm.
   **Needs your OK.**
2. **Patient identity.** WhatsApp gives the agent the sender's phone number. The simulator lets
   the reviewer pick one of 4 fictional patients (or "new patient"); every tool is scoped to that
   phone number in code, so the agent can never read or change another patient's appointments,
   whatever the conversation says. This is also an eval case.
3. **Medical safety.** The system prompt forbids medical advice, and the eval measures it. A
   keyword or classifier pre-filter is **not** added in v1 (false positives on normal questions
   like "is the cleaning painful?"); the eval decides whether one is needed. **Needs your OK.**
4. **Dates and time zones.** Clinic time is Asia/Riyadh. "Tomorrow" etc. are resolved by the model
   using the current date/time injected per turn (after the prompt-cache breakpoint), and
   `check_availability` takes explicit ISO dates, so the code validates every date.
5. **Eval cost.** A simulated patient (Claude) plus the agent per scenario, ~30 scenarios, 3 agent
   models: estimated $3–6 per full run. Gated with `--yes` like project #1.

## Requirements
1. `docker compose up` starts `db` (Postgres 17), `api` (NestJS) and `web` (Next.js) on
   127.0.0.1 only; web at http://localhost:3000. Only `ANTHROPIC_API_KEY` is required; an empty
   value counts as unset.
2. Seed data on first start: the fictional clinic "عيادة مثال لطب الأسنان / Mithal Dental Clinic"
   (services with durations and VAT-inclusive prices in SAR, 3 dentists with weekly schedules,
   opening hours Sat–Thu, address, preparation notes), 4 patients with a few existing
   appointments. Seeding is idempotent.
3. **Chat simulator** (`/`): WhatsApp-style thread, patient picker, Arabic/English, RTL-aware,
   streaming replies, Confirm/Cancel buttons on pending actions, "agent is typing" state, and a
   "Talking to staff" state after hand-off.
4. Agent tools (TypeScript SDK tool runner, Zod schemas, `strict` where allowed):
   - `check_availability({service_id, date_from, date_to, dentist_id?})` → free slots (max 10)
   - `list_my_appointments()` → the current patient's upcoming appointments
   - `propose_booking({service_id, slot_start, dentist_id})` → pending action
   - `propose_reschedule({appointment_id, new_slot_start})` → pending action
   - `propose_cancel({appointment_id})` → pending action
   - `handoff_to_staff({reason, summary})` → creates a hand-off ticket; the agent stops replying in
     that conversation until staff close it
   Clinic information (services, prices, hours, address, policies) is in the system prompt,
   which is stable and prompt-cached. Tool inputs are validated again in code (service exists,
   slot is free and inside opening hours, appointment belongs to the patient, not in the past,
   cancellation allowed more than 4 h before).
5. `POST /conversations/:id/messages` streams the reply over SSE (`\n` separators, the tested
   parser from project #1). `POST /actions/:id/confirm` and `/actions/:id/decline` execute or
   drop a pending action and post the outcome into the conversation.
6. **Staff page** (`/staff`): today's and upcoming appointments by dentist, open hand-offs with
   the conversation summary, "close hand-off" (the agent resumes).
7. **Trace view** (`/trace/:conversationId`): every turn's model, tool calls with inputs and
   results, pending actions and their outcome, tokens and cost.
8. The agent replies in the patient's language, never invents prices or availability (only from
   the prompt or tools), and never gives medical advice (hands off instead).
9. **Evaluation** (`npm run eval -- --yes`): ~30 scenarios in `eval/scenarios.json`, each with a
   patient persona and goal (AR/EN), played by a simulated patient model against the real agent
   and a fresh database. The harness presses Confirm when the scenario's patient would. Metrics:
   - task success: final database state matches the scenario's expected outcome (deterministic)
   - wrong proposals: pending actions that don't match the goal (deterministic)
   - hand-off correctness: handed off exactly when expected (deterministic)
   - policy: no medical advice, no invented facts (LLM judge, JSON-delimited inputs)
   - injection/isolation: attempts to read or change other patients' data or to skip
     confirmation fail (deterministic from DB + tool logs)
   - turns, cost and latency per scenario
   Compares `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`; failed scenarios are
   recorded, not fatal; recommended model by the project #1 rule (complete runs only, best
   safety, then success, then cost).
10. CI on every push/PR: lint, typecheck, unit + e2e tests (Postgres service), web build.

## Design
**Repo layout:** `api/` (NestJS via `nest new`, Prisma via `prisma init`), `web/` (Next.js via
`create-next-app`, shadcn), `api/eval/`, `docs/sdlc/`, root `docker-compose.yml`.

**Data model (Prisma):** `Service`, `Dentist` (+ weekly `Schedule`), `Patient` (phone unique),
`Appointment` (patient, dentist, service, start, end, status booked|cancelled; no overlapping
booked appointments per dentist, enforced by a Postgres exclusion constraint in a raw SQL migration),
`Conversation` (patient, status active|handed_off), `Message` (role, content JSON: full SDK content
blocks so history is replayed append-only), `PendingAction` (type, payload, status
pending|confirmed|declined|expired, expires_at), `Handoff` (reason, summary, open/closed),
`ToolCall` (turn, name, input, result, ms).

**NestJS modules:** `clinic` (services, dentists, availability), `appointments`, `agent` (tool
runner, tools, prompt), `conversations` (messages, SSE), `actions`, `staff`, `prisma`. DTOs with
validation at the HTTP boundary.

**Agent call:** `client.beta.messages.toolRunner` with `betaZodTool` tools, streaming, adaptive
thinking, explicit effort, refusal fallback where available (off in eval), stop-reason checks,
`max_tokens` and max tool iterations capped. System prompt (clinic info + rules) cached;
current date/time and patient context come after the cache breakpoint.

## Non-functional
- **Security:** tools scoped to the session's patient in code; data changes only through the
  confirm endpoint; ports on 127.0.0.1; custom header on state-changing endpoints; no HTML or
  images rendered from model text; parameterized queries only (Prisma); API key never logged.
- **Performance:** first token < 3 s typical; availability query < 100 ms.
- **Observability:** every tool call and pending action stored (the trace view reads them); JSON
  log line per turn with tokens and cost.
- **Rollback:** `docker compose down -v` resets data.

## Carried-forward open questions
- None beyond flagged concerns 1 and 3.
