"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Suspense } from "react";
import { getTrace } from "@/lib/api";
import { riyadhDateTime } from "@/lib/format";

export default function TracePage() {
  // useParams needs a Suspense boundary under Cache Components.
  return (
    <Suspense fallback={<p className="text-muted-foreground">Loading trace…</p>}>
      <TraceView />
    </Suspense>
  );
}

function TraceView() {
  const { id } = useParams<{ id: string }>();
  const trace = useQuery({ queryKey: ["trace", id], queryFn: () => getTrace(id) });

  if (trace.error) {
    return (
      <p role="alert" className="text-destructive">
        Couldn&apos;t load the trace: {trace.error.message}
      </p>
    );
  }
  if (!trace.data) return <p className="text-muted-foreground">Loading trace…</p>;
  const t = trace.data;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">Trace</h1>
          <p className="text-muted-foreground">
            <bdi>{t.patient.name}</bdi> · {t.totals.turns} {t.totals.turns === 1 ? "turn" : "turns"} · {t.totals.inputTokens.toLocaleString()} in /{" "}
            {t.totals.outputTokens.toLocaleString()} out tokens · ${t.totals.costUsd.toFixed(4)}
          </p>
        </div>
        <Link href={`/?c=${t.id}`} className="text-sm underline">
          Back to the chat
        </Link>
      </div>

      {t.turns.length === 0 ? (
        <p className="text-muted-foreground">No turns yet. Send a message in the chat.</p>
      ) : (
        <ol className="flex flex-col gap-4">
          {t.turns.map((turn, i) => (
            <li key={turn.id} className="rounded-lg border p-4">
              <p className="font-medium">
                Turn {i + 1} · {turn.model} · {turn.status}
              </p>
              <p className="text-sm text-muted-foreground">
                {riyadhDateTime(turn.at)} · {turn.inputTokens.toLocaleString()} in / {turn.outputTokens.toLocaleString()} out · $
                {turn.costUsd.toFixed(4)}
              </p>
              {turn.error && <p className="mt-2 text-sm text-destructive">{turn.error}</p>}
              {turn.toolCalls.length > 0 && (
                <ul className="mt-3 flex flex-col gap-2">
                  {turn.toolCalls.map((call, j) => (
                    <li key={j}>
                      <details className="rounded border bg-muted/40 p-2">
                        <summary className="cursor-pointer text-sm font-medium">
                          {call.name} <span className="text-muted-foreground">({call.ms} ms)</span>
                        </summary>
                        <p className="mt-2 text-xs font-medium">Input</p>
                        <pre className="overflow-x-auto text-xs">{JSON.stringify(call.input, null, 2)}</pre>
                        <p className="mt-2 text-xs font-medium">Result</p>
                        <pre className="overflow-x-auto text-xs">{JSON.stringify(call.result, null, 2)}</pre>
                      </details>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}

      <section aria-labelledby="actions">
        <h2 id="actions" className="mb-2 text-lg font-semibold">
          Proposed changes
        </h2>
        {t.actions.length === 0 ? (
          <p className="text-muted-foreground">None.</p>
        ) : (
          <ul className="divide-y rounded-lg border text-sm">
            {t.actions.map((a) => (
              <li key={a.id} className="flex flex-wrap gap-x-4 px-3 py-2">
                <span className="font-medium">{a.type}</span>
                <span>{a.payload.serviceNameEn}</span>
                <span>{riyadhDateTime(a.payload.startsAt)}</span>
                <span className="text-muted-foreground">{a.status}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
