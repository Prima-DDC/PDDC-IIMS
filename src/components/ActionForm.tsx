"use client";

import { useActionState, useEffect, useRef, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { EMPTY_FORM_STATE, IDEMPOTENCY_FIELD, type FormState } from "@/lib/forms";
import { Alert, Button } from "./ui";

type Action = (
  state: FormState,
  formData: FormData,
) => Promise<FormState>;

/**
 * Sets a field's value the way a person would, so React notices.
 *
 * Assigning to `.value` directly is invisible to a controlled component:
 * React compares against its own tracked value and concludes nothing
 * changed. Going through the prototype's setter clears that tracker, and the
 * dispatched events then run whatever `onChange` the field has, so state that
 * depends on the value stays in step.
 */
function setValue(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
) {
  if (element.value === value) return;

  const prototype =
    element instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLSelectElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (setter) setter.call(element, value);
  else element.value = value;

  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * Ticks or unticks a box, the way a person would.
 *
 * A real `click()` rather than assigning to `.checked`: React maps a
 * checkbox's `onChange` to the click event, so an assignment would move the
 * box without telling the component, and a dispatched click on top of an
 * assignment would toggle it straight back.
 */
function setChecked(element: HTMLInputElement, checked: boolean) {
  if (element.checked !== checked) element.click();
}

/**
 * Wraps a server action in a form with pending state, error and success
 * reporting, and per-field errors.
 *
 * Every administration screen needs the same shape, and repeating it a dozen
 * times would be the bulk of this feature. `children` receives the current
 * state so a field can render its own error.
 *
 * The submit button is disabled while pending, which is the double-click
 * protection PRD 21.6 asks for.
 */
export function ActionForm({
  action,
  submitLabel,
  submitTone = "primary",
  submitSize = "md",
  pendingLabel,
  children,
  hidden,
  confirm,
  className = "",
  compact = false,
  idempotencyKey,
}: {
  action: Action;
  submitLabel: ReactNode;
  submitTone?: "primary" | "secondary" | "ghost" | "danger";
  submitSize?: "sm" | "md";
  pendingLabel?: string;
  children?: ReactNode | ((state: FormState) => ReactNode);
  /** Fixed values posted with the form, such as the record id. */
  hidden?: Record<string, string | number | boolean | null | undefined>;
  /** Shown in a browser confirm before an irreversible-looking action. */
  confirm?: string;
  className?: string;
  /** Hides the success and error banners, for inline row actions. */
  compact?: boolean;
  /**
   * A token from the server component rendering this form, for the mutations
   * that mint a record (PRD 21.7). See the note where it is rendered.
   */
  idempotencyKey?: string;
}) {
  const [state, formAction, pending] = useActionState(action, EMPTY_FORM_STATE);

  const formRef = useRef<HTMLFormElement>(null);
  /** The latest values anybody has entered, kept for the restore below. */
  const live = useRef<Array<[string, string]> | null>(null);
  const wasPending = useRef(false);
  const router = useRouter();

  function remember(form: HTMLFormElement) {
    live.current = [...new FormData(form)].filter(
      (pair): pair is [string, string] => typeof pair[1] === "string",
    );
  }

  /**
   * Puts the fields back after a refused submission.
   *
   * React resets a form when its action's transition completes, which is the
   * right thing after a successful save. The trouble is when it happens: a
   * server action in Next also refreshes the route, so the transition ends
   * two to four seconds after the reply arrives. Somebody who reads the
   * validation error, corrects the field and clicks save in that window
   * submits the reset values instead of their own, which on a status form
   * means the record moves somewhere nobody asked for. Measured against the
   * real server, not theorised.
   *
   * So on a refusal the values are restored from the latest thing entered,
   * not from a snapshot taken at submit time: that way a correction typed
   * while the reply was in flight survives too. A successful save still
   * clears the form, which is what an "add another" form should do.
   */
  useEffect(() => {
    const finished = wasPending.current && !pending;
    wasPending.current = pending;
    if (!finished) return;

    /**
     * A write landed, so bring the screen behind the form up to date.
     *
     * This used to be the server's job: every action called
     * `revalidatePath`, and Next appended a fresh render of the route to the
     * action's own reply. On a route of this size that wedged about one
     * action in two: the row was written, the reply came back complete, and
     * the button sat on "Saving" with no error anywhere. The measurements
     * are in `@/lib/revalidate`.
     *
     * Doing it here costs one extra request and cannot take the reply down
     * with it, so the confirmation appears at once and the panel catches up
     * a moment later. Only after a success: a refusal changed nothing, and
     * refreshing then would throw away the values the restore below has just
     * put back.
     */
    if (state.success) router.refresh();
    if (!state.error) return;

    const form = formRef.current;
    const values = live.current;
    if (!form || !values) return;

    const seen = new Set(values.map(([name]) => name));
    for (const element of Array.from(form.elements)) {
      if (
        !(
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement ||
          element instanceof HTMLSelectElement
        ) ||
        !element.name ||
        element.type === "hidden" ||
        element.type === "file" ||
        element.type === "submit"
      ) {
        continue;
      }

      if (element instanceof HTMLInputElement && element.type === "checkbox") {
        setChecked(
          element,
          values.some(([name, value]) => name === element.name && value === element.value),
        );
        continue;
      }
      if (element instanceof HTMLInputElement && element.type === "radio") {
        if (seen.has(element.name)) {
          setChecked(
            element,
            values.some(
              ([name, value]) => name === element.name && value === element.value,
            ),
          );
        }
        continue;
      }

      const entry = values.find(([name]) => name === element.name);
      if (entry) setValue(element, entry[1]);
    }
  }, [pending, state, router]);

  return (
    <form
      ref={formRef}
      action={formAction}
      className={`space-y-3 ${className}`}
      noValidate
      // Recorded on every change rather than only on submit, so a correction
      // made while the reply is in flight is what gets restored.
      onInput={(event) => remember(event.currentTarget)}
      onChange={(event) => remember(event.currentTarget)}
      onSubmit={(event) => {
        if (confirm && !window.confirm(confirm)) {
          event.preventDefault();
          return;
        }
        remember(event.currentTarget);
      }}
    >
      {/*
        The idempotency key, when the caller supplied one (PRD 14, 21.7).

        Generated by the SERVER component that renders this form, and that is
        the only correct place for it. `useId` looks right and is not: it is
        stable across page loads, so submitting this form today and again
        tomorrow would present the same key with a different body and be
        refused as a conflict. A value generated on the client differs from
        the server's HTML and breaks hydration. A server-generated token is
        unique per render and identical for every submission of that render,
        which is exactly the property wanted.

        Forms that pass none still work. The protection they rely on instead
        is the disabled button, optimistic concurrency on every update, and
        state machines that refuse a repeated transition; what a key adds is
        for the mutations that MINT something, where a duplicate is a second
        record rather than a refused one.
      */}
      {idempotencyKey && (
        <input type="hidden" name={IDEMPOTENCY_FIELD} value={idempotencyKey} />
      )}

      {hidden &&
        Object.entries(hidden).map(([name, value]) =>
          value === null || value === undefined ? null : (
            <input key={name} type="hidden" name={name} value={String(value)} />
          ),
        )}

      {/*
        `data-action-outcome` marks that this form has reported back, either
        way. It carries no styling and says nothing a reader can see; it
        exists so that "the action has finished" is a state something can
        wait for rather than a moment that has to be guessed at.

        That guessing was worth removing. Waiting for the submit button to
        come back enabled looks equivalent and is not: the callback runs
        before React has marked the form pending, so it sees an enabled
        button and a settled page and returns before the action has even
        started. Waiting for the button to disappear is worse again, because
        a refreshing panel is briefly blank. Both are absences; this is a
        presence, and only a completed action can produce it.
      */}
      {state.error && (
        <span data-action-outcome="error" hidden aria-hidden="true" />
      )}
      {state.success && (
        <span data-action-outcome="success" hidden aria-hidden="true" />
      )}

      {!compact && state.error && <Alert tone="danger">{state.error}</Alert>}
      {!compact && state.success && <Alert tone="ok">{state.success}</Alert>}

      {typeof children === "function" ? children(state) : children}

      {compact && state.error && (
        <p role="alert" className="text-[11px] font-medium text-danger">
          {state.error}
        </p>
      )}

      <Button type="submit" tone={submitTone} size={submitSize} disabled={pending}>
        {pending ? (
          <>
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            {pendingLabel ?? "Saving"}
          </>
        ) : (
          submitLabel
        )}
      </Button>
    </form>
  );
}
