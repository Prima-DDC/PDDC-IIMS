import { ArrowRight, Lock } from "lucide-react";

/**
 * Chain-of-custody timeline, styled like a bound ledger (PRD §23).
 *
 * The visual metaphor is doing real work here. Custody events are append-only
 * at the database level: no role can edit or delete one, and a correction is
 * a new entry referencing the original (PRD §6.2). A ledger is what that
 * actually is, so it should look like one: a ruled rail, sequential entries,
 * and a seal on each.
 *
 * Corrections render indented beneath the entry they correct, so the original
 * is never hidden, which is the whole point of an append-only register.
 */
export interface CustodyEvent {
  id: string;
  occurredAt: string;
  releasedBy: string;
  receivedBy: string;
  purpose: string;
  location: string;
  condition: string;
  /** Set when this entry corrects an earlier one. */
  correctsEventId?: string;
  inTransit?: boolean;
}

export function CustodyLedger({ events }: { events: CustodyEvent[] }) {
  if (events.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-line-strong p-4 text-sm text-muted">
        No custody events recorded. Registering this item will create its first
        entry.
      </p>
    );
  }

  const corrections = new Map<string, CustodyEvent[]>();
  for (const e of events) {
    if (!e.correctsEventId) continue;
    const list = corrections.get(e.correctsEventId) ?? [];
    list.push(e);
    corrections.set(e.correctsEventId, list);
  }

  const primary = events.filter((e) => !e.correctsEventId);

  return (
    <ol className="ledger-rail space-y-4 pl-0">
      {primary.map((event, index) => (
        <li key={event.id} className="relative pl-9">
          {/* Seal marker on the rail. */}
          <span
            aria-hidden="true"
            className={`absolute top-1 left-0 grid size-6 place-items-center rounded-full border-2 bg-surface ${
              event.inTransit
                ? "border-signal text-signal"
                : "border-line-strong text-faint"
            }`}
          >
            <Lock className="size-3" />
          </span>

          <article
            className={`card rounded-lg p-3 ${
              event.inTransit ? "marching-ants" : ""
            }`}
          >
            <header className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-[10px] font-semibold tracking-[0.14em] text-faint uppercase">
                Entry {index + 1}
              </span>
              <time className="font-id text-[11px] text-muted">
                {event.occurredAt}
              </time>
            </header>

            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium text-body">{event.releasedBy}</span>
              <ArrowRight className="size-3.5 text-faint" aria-hidden="true" />
              <span className="font-medium text-body">{event.receivedBy}</span>
              {event.inTransit && (
                <span className="rounded-full bg-signal/12 px-2 py-0.5 text-[10px] font-semibold text-signal-dark uppercase">
                  In transit
                </span>
              )}
            </div>

            <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
              <Field label="Purpose" value={event.purpose} />
              <Field label="Location" value={event.location} />
              <Field label="Condition" value={event.condition} />
            </dl>
          </article>

          {(corrections.get(event.id) ?? []).map((correction) => (
            <article
              key={correction.id}
              className="mt-2 ml-5 rounded-lg border border-warn/40 bg-warn/5 p-3"
            >
              <header className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-[10px] font-semibold tracking-[0.14em] text-warn uppercase">
                  Correcting entry {index + 1}
                </span>
                <time className="font-id text-[11px] text-muted">
                  {correction.occurredAt}
                </time>
              </header>
              <p className="mt-1.5 text-xs text-body">{correction.purpose}</p>
              <p className="mt-1 text-[11px] text-muted">
                The original entry above is retained and remains part of the
                record.
              </p>
            </article>
          ))}
        </li>
      ))}
    </ol>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] tracking-wide text-faint uppercase">{label}</dt>
      <dd className="text-body">{value}</dd>
    </div>
  );
}
