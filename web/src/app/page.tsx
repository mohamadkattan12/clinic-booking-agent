"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useRef, useState } from "react";
import { Markdown } from "@/components/markdown";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  type Action,
  ApiError,
  type ChatMessage,
  confirmAction,
  createConversation,
  declineAction,
  getConversation,
  listPatients,
  sendMessage,
} from "@/lib/api";
import { riyadhDateTime, riyadhTime, sar } from "@/lib/format";

export default function ChatPage() {
  // useSearchParams needs a Suspense boundary in Next 16.
  return (
    <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
      <Chat />
    </Suspense>
  );
}

function Chat() {
  const conversationId = useSearchParams().get("c");
  return conversationId ? <Thread conversationId={conversationId} /> : <PatientPicker />;
}

function PatientPicker() {
  const router = useRouter();
  const patients = useQuery({ queryKey: ["patients"], queryFn: listPatients });
  const start = useMutation({
    mutationFn: createConversation,
    onSuccess: ({ id }) => router.push(`/?c=${id}`),
  });

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold">Chat with the clinic</h1>
        <p className="text-muted-foreground">
          WhatsApp gives the assistant the sender&apos;s phone number. Pick a fictional patient to chat as; each choice
          starts a new conversation that only sees that patient&apos;s appointments.
        </p>
      </div>
      {patients.error ? (
        <div role="alert" className="rounded-lg border border-destructive/50 p-4">
          <p className="text-destructive">Couldn&apos;t load patients: {patients.error.message}</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => patients.refetch()}>
            Try again
          </Button>
        </div>
      ) : !patients.data ? (
        <p className="text-muted-foreground">Loading patients…</p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {patients.data.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                disabled={start.isPending}
                onClick={() => start.mutate(p.id)}
                className="w-full rounded-lg border p-4 text-start hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
              >
                <bdi className="block font-medium">{p.name}</bdi>
                <span className="text-sm text-muted-foreground" dir="ltr">
                  {p.phone}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {start.error && <p className="text-sm text-destructive">Couldn&apos;t start the chat: {start.error.message}</p>}
    </div>
  );
}

type Pending = { clientMessageId: string; text: string; reply: string; error?: string };

function Thread({ conversationId }: { conversationId: string }) {
  const queryClient = useQueryClient();
  const conversation = useQuery({ queryKey: ["conversation", conversationId], queryFn: () => getConversation(conversationId) });
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const busy = Boolean(pending && !pending.error);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });

  async function send(text: string, clientMessageId: string = crypto.randomUUID()) {
    if (!text.trim() || busy) return;
    setPending({ clientMessageId, text, reply: "" });
    setDraft("");
    try {
      await sendMessage(conversationId, clientMessageId, text, (delta) =>
        setPending((p) => (p ? { ...p, reply: p.reply + delta } : p)),
      );
      await refresh();
      setPending(null);
    } catch (e) {
      const message = e instanceof ApiError ? e.message : String(e);
      setPending((p) => (p ? { ...p, error: message } : p));
      await refresh();
    }
    inputRef.current?.focus();
  }

  if (conversation.error) {
    return (
      <div role="alert" className="rounded-lg border border-destructive/50 p-4">
        <p className="text-destructive">Couldn&apos;t load this conversation: {conversation.error.message}</p>
        <Link href="/" className="mt-2 inline-block underline">
          Start a new chat
        </Link>
      </div>
    );
  }
  if (!conversation.data) return <p className="text-muted-foreground">Loading conversation…</p>;
  const c = conversation.data;
  const items = [
    // Clinic events (confirm/decline outcomes) are for the model; the card already shows them.
    ...c.messages
      .filter((m) => m.role !== "event")
      .map((m) => ({ kind: "message" as const, sortKey: m.sortKey, message: m })),
    ...c.actions.map((a) => ({ kind: "action" as const, sortKey: a.sortKey, action: a })),
  ].sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  const handedOff = c.status === "handed_off";

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">
            Chatting as <bdi>{c.patient.name}</bdi>
          </h1>
          <p className="text-sm text-muted-foreground" dir="ltr">
            {c.patient.phone}
          </p>
        </div>
        <div className="flex gap-2 text-sm">
          <Link href={`/trace/${c.id}`} className="underline">
            View trace
          </Link>
          <Link href="/" className="underline">
            Switch patient
          </Link>
        </div>
      </div>

      <ol aria-label="Conversation" className="flex flex-col gap-2 rounded-xl bg-muted/40 p-3">
        {items.length === 0 && !pending && (
          <li className="py-6 text-center text-sm text-muted-foreground">
            Say hello in Arabic or English, e.g. «أبغى أحجز تنظيف أسنان بكرة الصبح».
          </li>
        )}
        {items.map((item) =>
          item.kind === "message" ? (
            <Bubble key={item.message.id} message={item.message} />
          ) : (
            <ActionCard key={item.action.id} action={item.action} conversationId={c.id} onDone={refresh} />
          ),
        )}
        {pending && (
          <>
            <Bubble message={{ id: "pending", at: "", sortKey: "", role: "patient", text: pending.text }} />
            {pending.error ? (
              <li role="alert" className="self-start rounded-lg border border-destructive/50 bg-background px-3 py-2 text-sm">
                <p className="text-destructive">{pending.error}</p>
                <Button variant="outline" size="sm" className="mt-2" onClick={() => send(pending.text, pending.clientMessageId)}>
                  Send again
                </Button>
              </li>
            ) : (
              <li aria-live="polite" className="max-w-[80%] self-start rounded-lg bg-background px-3 py-2 shadow-sm">
                {pending.reply ? <Markdown>{pending.reply}</Markdown> : <span className="text-muted-foreground">typing…</span>}
              </li>
            )}
          </>
        )}
      </ol>

      {handedOff && (
        <p role="status" className="rounded-lg border bg-background px-3 py-2 text-sm">
          A staff member will reply in this chat. The assistant is paused until staff close the hand-off.
        </p>
      )}

      <form
        className="sticky bottom-0 flex flex-col gap-2 border-t bg-background py-3"
        onSubmit={(e) => {
          e.preventDefault();
          send(draft);
        }}
      >
        <label htmlFor="message" className="sr-only">
          Message
        </label>
        <Textarea
          id="message"
          ref={inputRef}
          dir="auto"
          rows={2}
          maxLength={2000}
          value={draft}
          placeholder="Type a message"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send(draft);
            }
          }}
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">Enter to send, Shift+Enter for a new line</span>
          <Button type="submit" disabled={busy || !draft.trim()}>
            {busy ? "Waiting for reply…" : "Send"}
          </Button>
        </div>
      </form>
    </div>
  );
}

function Bubble({ message }: { message: ChatMessage }) {
  const mine = message.role === "patient";
  return (
    <li
      className={
        mine
          ? "max-w-[80%] self-end rounded-lg bg-bubble-mine px-3 py-2 shadow-sm"
          : "max-w-[80%] self-start rounded-lg bg-background px-3 py-2 shadow-sm"
      }
    >
      {mine ? <p dir="auto" className="whitespace-pre-wrap">{message.text}</p> : <Markdown>{message.text}</Markdown>}
      {message.at && <span className="mt-1 block text-end text-[11px] text-muted-foreground">{riyadhTime(message.at)}</span>}
    </li>
  );
}

const TITLES = { book: "New appointment · موعد جديد", reschedule: "Move appointment · تغيير الموعد", cancel: "Cancel appointment · إلغاء الموعد" };
const STATUS: Record<Exclude<Action["status"], "pending">, string> = {
  confirmed: "Confirmed ✓",
  declined: "You cancelled this request",
  expired: "Expired: ask again for a fresh card",
  superseded: "Replaced by a newer proposal",
  failed: "Couldn't be done: the time was taken, the appointment changed, or it starts too soon to change. Ask again.",
};

function ActionCard({ action, conversationId, onDone }: { action: Action; conversationId: string; onDone: () => Promise<unknown> }) {
  const p = action.payload;
  const [now] = useState(() => Date.now());
  const expired = action.status === "pending" && new Date(action.expiresAt).getTime() < now;
  const resolve = useMutation({
    mutationFn: (choice: "confirm" | "decline") =>
      choice === "confirm" ? confirmAction(conversationId, action.id) : declineAction(conversationId, action.id),
    onSettled: onDone,
  });
  const actionable = action.status === "pending" && !expired;

  return (
    <li className="w-full max-w-sm self-start rounded-lg border bg-background p-3 shadow-sm">
      <p className="text-sm font-semibold">{TITLES[p.type]}</p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Service</dt>
        <dd>
          {p.serviceNameEn} · <bdi>{p.serviceNameAr}</bdi>
        </dd>
        <dt className="text-muted-foreground">Dentist</dt>
        <dd>
          {p.dentistNameEn} · <bdi>{p.dentistNameAr}</bdi>
        </dd>
        {p.previousStartsAt && (
          <>
            <dt className="text-muted-foreground">From</dt>
            <dd>{riyadhDateTime(p.previousStartsAt)}</dd>
          </>
        )}
        <dt className="text-muted-foreground">{p.type === "reschedule" ? "To" : "When"}</dt>
        <dd>
          {riyadhDateTime(p.startsAt)}
          <bdi className="block text-muted-foreground">{riyadhDateTime(p.startsAt, "ar")}</bdi>
        </dd>
        {p.type !== "cancel" && (
          <>
            <dt className="text-muted-foreground">Price</dt>
            <dd>{sar(p.priceHalalas)} (VAT included)</dd>
          </>
        )}
      </dl>
      {actionable ? (
        <div className="mt-3 flex gap-2">
          <Button size="sm" disabled={resolve.isPending} onClick={() => resolve.mutate("confirm")}>
            {resolve.isPending && resolve.variables === "confirm" ? "Confirming…" : "Confirm · تأكيد"}
          </Button>
          <Button size="sm" variant="outline" disabled={resolve.isPending} onClick={() => resolve.mutate("decline")}>
            Cancel · إلغاء
          </Button>
        </div>
      ) : (
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          {expired ? STATUS.expired : STATUS[action.status as Exclude<Action["status"], "pending">]}
        </p>
      )}
      {resolve.error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {resolve.error.message}
        </p>
      )}
    </li>
  );
}
