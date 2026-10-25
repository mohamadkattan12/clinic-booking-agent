"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";
import { closeHandoff, listAppointments, listHandoffs, type StaffAppointment } from "@/lib/api";
import { riyadhDateTime, riyadhDay, riyadhTime } from "@/lib/format";

export default function StaffPage() {
  const queryClient = useQueryClient();
  const handoffs = useQuery({ queryKey: ["handoffs"], queryFn: listHandoffs, refetchInterval: 10_000 });
  const appointments = useQuery({ queryKey: ["appointments"], queryFn: () => listAppointments(14), refetchInterval: 10_000 });
  const close = useMutation({
    mutationFn: closeHandoff,
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["handoffs"] }),
  });

  const byDay = new Map<string, StaffAppointment[]>();
  for (const a of appointments.data ?? []) {
    const day = riyadhDay(a.startsAt);
    byDay.set(day, [...(byDay.get(day) ?? []), a]);
  }

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold">Staff</h1>
        <p className="text-muted-foreground">
          Hand-offs from the assistant and the next 14 days of bookings. (Unauthenticated in this local demo.)
        </p>
      </div>

      <section aria-labelledby="handoffs" className="flex flex-col gap-3">
        <h2 id="handoffs" className="text-lg font-semibold">
          Open hand-offs
        </h2>
        {handoffs.error ? (
          <p role="alert" className="text-destructive">
            Couldn&apos;t load hand-offs: {handoffs.error.message}
          </p>
        ) : !handoffs.data ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : handoffs.data.length === 0 ? (
          <p className="text-muted-foreground">No open hand-offs. The assistant hands off medical questions and requests for a person.</p>
        ) : (
          <ul className="grid gap-3 md:grid-cols-2">
            {handoffs.data.map((h) => (
              <li key={h.id} className="rounded-lg border p-4">
                <p className="font-medium">
                  <bdi>{h.patient.name}</bdi> <span className="text-sm text-muted-foreground" dir="ltr">{h.patient.phone}</span>
                </p>
                <p className="text-sm text-muted-foreground">{riyadhDateTime(h.at)} · {h.reason}</p>
                <p dir="auto" className="mt-2">{h.summary}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Link href={`/?c=${h.conversationId}`} className={buttonVariants({ size: "sm", variant: "outline" })}>
                    Open chat
                  </Link>
                  <Button size="sm" disabled={close.isPending} onClick={() => close.mutate(h.id)}>
                    Close · the assistant resumes
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {close.error && <p role="alert" className="text-sm text-destructive">{close.error.message}</p>}
      </section>

      <section aria-labelledby="calendar" className="flex flex-col gap-3">
        <h2 id="calendar" className="text-lg font-semibold">
          Appointments
        </h2>
        {appointments.error ? (
          <p role="alert" className="text-destructive">Couldn&apos;t load appointments: {appointments.error.message}</p>
        ) : !appointments.data ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : appointments.data.length === 0 ? (
          <p className="text-muted-foreground">No bookings in the next 14 days.</p>
        ) : (
          [...byDay.entries()].map(([day, rows]) => (
            <div key={day}>
              <h3 className="mb-1 text-sm font-medium text-muted-foreground">{day}</h3>
              <ul className="divide-y rounded-lg border">
                {rows.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-3 py-2 text-sm">
                    <span className="w-24 font-medium tabular-nums">
                      {riyadhTime(a.startsAt)}–{riyadhTime(a.endsAt)}
                    </span>
                    <span className="min-w-40">{a.dentist.nameEn}</span>
                    <span className="min-w-36">{a.service.nameEn}</span>
                    <bdi>{a.patient.name}</bdi>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </section>
    </div>
  );
}
