# Review instructions

## Passes
Run three passes and tag each finding with its pass:
- Bugs: booking rules (hours, schedules, durations, 4-hour change cut-off, Riyadh time), confirm
  races and retries, turn state (partial turns stored, lock not released, duplicate messages),
  SSE error paths, Arabic/RTL rendering, card ordering
- Security: any path where the model or patient text can change data without the Confirm button,
  reach another patient's data, or pick the patient id; secrets or patient text in logs; HTML
  rendered from model text; missing DTO validation or app-header guard on writes; ports not bound
  to 127.0.0.1
- Compliance: the change matches docs/sdlc/<change>/spec.md and plan.md and CLAUDE.md
  conventions; plan departures not recorded in plan.md are findings; eval metrics, oracle, judge or
  the recommendation rule changed without a spec amendment or a calibration run is Important

## What Important means here
Important = would let the model change data or leak another patient's data, give medical advice
unmeasured, break booking behavior, spend API money unexpectedly, or make an eval number wrong.
Style and naming are nits.

## Cap the nits
Report at most five nits per review; summarize the rest as a count.

## Do not report
Lockfiles (`api/pnpm-lock.yaml`, `web/pnpm-lock.yaml`), `web/AGENTS.md`, `api/src/generated/`,
`api/eval/results/*`, Prisma migrations already applied (review new ones), shadcn components in
`web/src/components/ui/`, and anything CI enforces (oxlint, Prettier, tsc, ESLint).
