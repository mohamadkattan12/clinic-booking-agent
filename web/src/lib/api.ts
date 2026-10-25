import { parseSSE } from "./sse";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
// Required by the API on state-changing requests (blocks cross-site form posts).
const APP_HEADER = { "X-Requested-By": "clinic-booking-agent" };

export type Patient = { id: string; name: string; phone: string };

export type ActionPayload = {
  type: "book" | "reschedule" | "cancel";
  serviceNameAr: string;
  serviceNameEn: string;
  dentistNameAr: string;
  dentistNameEn: string;
  startsAt: string;
  endsAt: string;
  priceHalalas: number;
  previousStartsAt?: string;
};

export type Action = {
  id: string;
  status: "pending" | "confirmed" | "declined" | "expired" | "superseded" | "failed";
  payload: ActionPayload;
  expiresAt: string;
  at: string;
};

export type ChatMessage = { id: string; at: string; role: "patient" | "agent" | "event"; text: string };

export type Conversation = {
  id: string;
  status: "active" | "handed_off";
  patient: Patient;
  messages: ChatMessage[];
  actions: Action[];
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function fail(response: Response): Promise<never> {
  let message = `Request failed (${response.status}).`;
  try {
    const body = await response.json();
    if (typeof body.message === "string") message = body.message;
    else if (typeof body.message?.reason === "string") message = body.message.reason;
    else if (typeof body.reason === "string") message = body.reason;
  } catch {
    // not JSON
  }
  throw new ApiError(message, response.status);
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${API_URL}${path}`);
  if (!response.ok) await fail(response);
  return response.json();
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { ...APP_HEADER, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) await fail(response);
  return response.json();
}

export const listPatients = () => get<Patient[]>("/patients");
export const createConversation = (patientId: string) => post<{ id: string }>("/conversations", { patientId });
export const getConversation = (id: string) => get<Conversation>(`/conversations/${encodeURIComponent(id)}`);
export const confirmAction = (cid: string, aid: string) =>
  post(`/conversations/${encodeURIComponent(cid)}/actions/${encodeURIComponent(aid)}/confirm`);
export const declineAction = (cid: string, aid: string) =>
  post(`/conversations/${encodeURIComponent(cid)}/actions/${encodeURIComponent(aid)}/decline`);

export type TurnDone = { status: string; actionIds?: string[]; handedOff?: boolean };

/** Send a patient message and read the SSE reply: delta events, then done or error. */
export async function sendMessage(
  conversationId: string,
  clientMessageId: string,
  text: string,
  onDelta: (text: string) => void,
): Promise<TurnDone> {
  const response = await fetch(`${API_URL}/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: "POST",
    headers: { ...APP_HEADER, "Content-Type": "application/json" },
    body: JSON.stringify({ clientMessageId, text }),
  });
  if (!response.ok || !response.body) await fail(response);
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const parsed = parseSSE(buffer + value);
    buffer = parsed.rest;
    for (const { event, data } of parsed.events) {
      const payload = JSON.parse(data);
      if (event === "delta") onDelta(payload.text);
      else if (event === "done") return payload as TurnDone;
      else if (event === "error") throw new ApiError(payload.message, 0);
    }
  }
  throw new ApiError("The reply ended unexpectedly. Please send your message again.", 0);
}

export type StaffAppointment = {
  id: string;
  startsAt: string;
  endsAt: string;
  dentist: { id: string; nameEn: string; nameAr: string };
  service: { id: string; nameEn: string; nameAr: string };
  patient: { name: string; phone: string };
};
export type Handoff = {
  id: string;
  conversationId: string;
  reason: string;
  summary: string;
  at: string;
  patient: { name: string; phone: string };
};
export const listAppointments = (days = 14) => get<StaffAppointment[]>(`/staff/appointments?days=${days}`);
export const listHandoffs = () => get<Handoff[]>("/staff/handoffs");
export const closeHandoff = (id: string) => post(`/staff/handoffs/${encodeURIComponent(id)}/close`);

export type Trace = {
  id: string;
  status: string;
  patient: { name: string; phone: string };
  totals: { turns: number; inputTokens: number; outputTokens: number; costUsd: number };
  turns: {
    id: string;
    at: string;
    model: string;
    status: string;
    error: string | null;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    toolCalls: { name: string; input: unknown; result: unknown; ms: number }[];
  }[];
  actions: { id: string; type: string; status: string; payload: ActionPayload; at: string }[];
};
export const getTrace = (id: string) => get<Trace>(`/trace/${encodeURIComponent(id)}`);
