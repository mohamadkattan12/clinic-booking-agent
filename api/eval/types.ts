import type { ActionPayload } from '../src/actions/actions.service.js';
import type { Verdict } from './judge.js';

/** What the scenario's patient actually wants changed. The oracle confirms only matching proposals. */
export type ExpectedAction =
  | {
      type: 'book';
      serviceId: string;
      dentistId?: string;
      date?: string;
      fromMinute?: number;
      toMinute?: number;
    }
  | {
      type: 'reschedule';
      serviceId: string;
      date?: string;
      fromMinute?: number;
      toMinute?: number;
    }
  | { type: 'cancel'; serviceId: string };

export interface Scenario {
  id: string;
  lang: 'ar' | 'en';
  category:
    | 'booking'
    | 'reschedule'
    | 'cancel'
    | 'faq'
    | 'no_availability'
    | 'medical'
    | 'cross_patient'
    | 'skip_confirmation'
    | 'injection';
  patient: number; // index into seed PATIENTS
  /** Scripted cases send these messages in order; persona cases use the simulated patient. */
  messages?: string[];
  persona?: { goal: string; style: string };
  maxTurns: number;
  expect: {
    actions: ExpectedAction[]; // must all end up confirmed and executed
    handoff: boolean | 'any'; // 'any': either is acceptable for this case
    medical?: boolean; // contains a medical question: no reply may give medical advice
    /** Facts the replies must state: each inner list is alternatives (e.g. "250" or "٢٥٠"). */
    mentions?: string[][];
  };
}

export interface ProposalEvent {
  actionId: string;
  payload: ActionPayload;
  decision: 'confirmed' | 'declined';
  matched: number | null; // index of the expected action it matched
  executed: boolean; // the confirm actually changed the database
}

export interface TurnEvent {
  patientText: string;
  agentText: string;
  toolCalls: { name: string; input: unknown; result: unknown }[];
  proposals: ProposalEvent[];
  status: string; // answered | handed_off | error ...
  error?: string;
  judge?: Verdict; // set for judged scenarios (medical or cross-patient)
}

export interface AppointmentRow {
  id: string;
  patientId: string;
  serviceId: string;
  dentistId: string;
  startsAt: string;
  status: string;
  version: number;
}

/** Everything that happened in one scenario run: the scorer reads only this. */
export interface EventLog {
  scenarioId: string;
  model: string;
  turns: TurnEvent[];
  before: AppointmentRow[];
  after: AppointmentRow[];
  handedOff: boolean;
  otherPatients: {
    id: string;
    name: string;
    phone: string;
    appointmentIds: string[];
  }[];
  costMicroUsd: number; // agent + simulated patient
  judgeCostMicroUsd: number;
  inputTokens: number; // agent input tokens, including cache reads
  cacheReadTokens: number;
  ms: number;
  error?: string; // the scenario could not finish (API or harness error)
}
