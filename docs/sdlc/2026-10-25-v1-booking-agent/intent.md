# Intent: Clinic booking agent in a WhatsApp-style chat (portfolio project #2)

Author: Mohamad Nour · Source: conversation (portfolio plan after LinkedIn KSA research) · Date: 2026-10-25
Status: draft

## Problem
Project #1 (arabic-docs-qa) shows RAG, citations and evaluation, but not **agents**: a model that
plans, calls tools, changes real data and hands off to people. In the 25 KSA AI posts read on
2026-10-25, agents appeared in 14 and customer-facing conversational AI in several (Sarj's Agent
Engineer, Lucidya's voice/chat pipeline). The portfolio also has no **TypeScript/Node** backend,
which the software posts asked for often (Node 7/25, TypeScript 6/25).

## Proposed outcome
A public repo (`mohamadkattan12`) where a reviewer runs `docker compose up` and:
1. Opens a **WhatsApp-style chat simulator** in the browser and chats as a patient of a fictional
   clinic, in Arabic or English.
2. The agent answers clinic questions (services, prices with VAT, opening hours, location,
   preparation instructions) from the clinic's own information, never inventing any.
3. The agent **checks availability and books, reschedules or cancels appointments** in a real
   database, asking the patient to confirm before any change.
4. The agent **hands off to a human** when asked, when it can't help, or for anything medical
   (it never gives medical advice or a diagnosis). A staff page shows hand-offs and the
   appointment calendar.
5. A **trace view** shows each conversation's tool calls, inputs, results and cost, so a reviewer
   can see how the agent decided.
6. An **evaluation** runs scripted multi-turn conversations (a simulated patient) and scores task
   success, wrong actions, hand-off correctness, policy compliance and prompt-injection resistance
   across Claude models, like project #1.

## Affected users and systems
- Recruiters and hiring engineers at KSA companies (readers of the repo).
- Mohamad (owner).
- New standalone repo: `~/dev/projects/portfolio/clinic-booking-agent`. Nothing else is touched.

## Constraints
- Stack: TypeScript, NestJS backend, Claude via the official Anthropic TypeScript SDK and its
  tool runner, PostgreSQL. Scaffolded with official CLIs.
- No real WhatsApp integration in this cycle: the chat is a simulator.
- Fictional clinic and patients only. No real patient data; nothing from Mohamad's employer work
  (CXOne, WhatsApp Business, commerce platform) is copied into the repo.
- The agent must never give medical advice, diagnoses or medication guidance; it hands those to staff.
- Every action that changes data (book, reschedule, cancel) needs an explicit patient confirmation
  in the conversation, enforced in code, not only in the prompt.
- API key only via `.env`; local Docker demo; ports bound to 127.0.0.1 (lesson from project #1).
- Same engineering bar as project #1: tests, CI, typed code, SDLC artifacts, one commit per step,
  commits authored by Mohamad only.

## Out of scope
- Real WhatsApp Cloud API, voice, SMS or email reminders.
- Payments, insurance claims, multiple clinics or branches, staff login.
- Hosting a public demo.

## Success measure
- A fresh clone + `.env` + `docker compose up` works end to end.
- In the evaluation, the recommended model completes at least 90% of booking scenarios correctly,
  makes zero unconfirmed data changes, and hands off 100% of medical-advice requests.
- CI green; README shows the evaluation results and the trace view.

## Open questions
1. Repo name: proposed `clinic-booking-agent`.
2. Database layer: proposed Prisma (common with NestJS; schema and migrations by CLI).
3. Front end: proposed Next.js in the same repo (chat simulator, staff page, trace view, evaluation
   page), reusing project #1's patterns.
4. Answer model: start with `claude-sonnet-5-5` (project #1's recommendation) and let this
   project's evaluation decide, since tool use is a different task.
