import type { ActionPayload } from '../src/actions/actions.service.js';
import { riyadhParts } from '../src/common/time.js';
import type { ExpectedAction } from './types.js';

/** Does a proposal exactly fit what the patient wants? Decided from the scenario, never the agent. */
export function matches(
  payload: ActionPayload,
  expected: ExpectedAction,
): boolean {
  if (
    payload.type !== expected.type ||
    payload.serviceId !== expected.serviceId
  )
    return false;
  if (expected.type === 'cancel') return true;
  if (
    expected.type === 'book' &&
    expected.dentistId &&
    payload.dentistId !== expected.dentistId
  )
    return false;
  const start = riyadhParts(new Date(payload.startsAt));
  if (expected.date && start.date !== expected.date) return false;
  if (expected.fromMinute !== undefined && start.minute < expected.fromMinute)
    return false;
  if (expected.toMinute !== undefined && start.minute > expected.toMinute)
    return false;
  return true;
}

/** Index of the first not-yet-used expected action this proposal matches, or null. */
export function matchExpected(
  payload: ActionPayload,
  expected: ExpectedAction[],
  used: Set<number>,
): number | null {
  const index = expected.findIndex(
    (e, i) => !used.has(i) && matches(payload, e),
  );
  return index === -1 ? null : index;
}
