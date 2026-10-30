import { describe, expect, it } from "vitest";
import { NotifyError } from "./errors";
import {
  MAX_SEND_ATTEMPTS,
  assertCanBeDisabled,
  assertDeliveryTransition,
  assertEmailCarriesNoCaseContent,
  idempotencyKeyFor,
  isDeadLettered,
  isMandatory,
  nextAttemptDelayMs,
  shouldDeliver,
} from "./policies";

/**
 * The rules of PRD 12, tested as rules rather than as code paths.
 *
 * The confidentiality one gets the most attention here because it is the only
 * one whose failure leaves the platform: everything else goes wrong inside a
 * system that still has permissions, and an email does not.
 */

describe("what an email may carry (PRD 12.2)", () => {
  it("accepts a case identifier and a link, which is the whole point", () => {
    expect(() =>
      assertEmailCarriesNoCaseContent({
        caseReference: "PDDC-2026-000014",
        link: "/cases/8f1c",
        categoryLabel: "New task",
        recipientName: "Ama Darko",
        dueAt: "2026-11-02",
      }),
    ).not.toThrow();
  });

  it("accepts nothing at all", () => {
    expect(() => assertEmailCarriesNoCaseContent({})).not.toThrow();
  });

  it.each([
    ["a subject's name", { subjectName: "Kofi Mensah" }],
    ["a finding", { findingText: "The payments were authorised without a PO" }],
    ["a case title", { caseTitle: "Suspected supplier fraud" }],
    ["an exhibit", { evidenceId: "EV-2026-000014-001" }],
    ["a bare note", { note: "see attached" }],
  ])("refuses %s", (_label, params) => {
    expect(() =>
      assertEmailCarriesNoCaseContent(params as Record<string, string>),
    ).toThrow(NotifyError);
  });

  it("names the offending key, so the caller can see what to remove", () => {
    try {
      assertEmailCarriesNoCaseContent({
        caseReference: "PDDC-2026-000014",
        subjectName: "Kofi Mensah",
      } as Record<string, string>);
      expect.unreachable("it should have refused");
    } catch (error) {
      expect((error as NotifyError).code).toBe("email_would_leak");
      expect((error as NotifyError).message).toContain("subjectName");
      // And it says where the detail belongs instead.
      expect((error as NotifyError).message).toMatch(/screen the link points at/i);
    }
  });
});

describe("preferences (PRD 12.2)", () => {
  it("treats absence as on, so a new employee is not silently unreachable", () => {
    expect(shouldDeliver("task_assigned", "email", undefined)).toBe(true);
    expect(shouldDeliver("task_assigned", "inApp", undefined)).toBe(true);
  });

  it("honours a choice to switch something off", () => {
    expect(
      shouldDeliver("task_assigned", "email", { inApp: true, email: false }),
    ).toBe(false);
    expect(
      shouldDeliver("task_assigned", "inApp", { inApp: true, email: false }),
    ).toBe(true);
  });

  it.each(["security_alert", "safety_check_in_missed", "integrity_failure"] as const)(
    "delivers %s even when it has been switched off",
    (category) => {
      expect(isMandatory(category)).toBe(true);
      expect(
        shouldDeliver(category, "email", { inApp: false, email: false }),
      ).toBe(true);
      expect(() => assertCanBeDisabled(category)).toThrow(NotifyError);
    },
  );

  it("lets an ordinary category be switched off", () => {
    expect(() => assertCanBeDisabled("case_status_change")).not.toThrow();
  });
});

describe("retrying a send (PRD 12.2)", () => {
  it("backs off exponentially: 1, 4, 16 and 64 minutes", () => {
    expect(nextAttemptDelayMs(1)).toBe(60_000);
    expect(nextAttemptDelayMs(2)).toBe(4 * 60_000);
    expect(nextAttemptDelayMs(3)).toBe(16 * 60_000);
    expect(nextAttemptDelayMs(4)).toBe(64 * 60_000);
  });

  it("dead-letters rather than retrying for ever", () => {
    expect(isDeadLettered(MAX_SEND_ATTEMPTS - 1)).toBe(false);
    expect(isDeadLettered(MAX_SEND_ATTEMPTS)).toBe(true);
  });
});

describe("delivery status", () => {
  it("allows what a provider actually reports", () => {
    expect(() => assertDeliveryTransition("queued", "sent")).not.toThrow();
    expect(() => assertDeliveryTransition("sent", "delivered")).not.toThrow();
    expect(() => assertDeliveryTransition("sent", "bounced")).not.toThrow();
  });

  it("will not move a delivered message, because it has arrived", () => {
    expect(() => assertDeliveryTransition("delivered", "bounced")).toThrow(
      /delivered message cannot change state/i,
    );
  });

  it("lets a bounce or a dead letter be queued again deliberately", () => {
    expect(() => assertDeliveryTransition("bounced", "queued")).not.toThrow();
    expect(() => assertDeliveryTransition("failed", "queued")).not.toThrow();
  });

  it("refuses to skip the send", () => {
    expect(() => assertDeliveryTransition("queued", "delivered")).toThrow(
      NotifyError,
    );
  });
});

describe("idempotency (PRD 12.2)", () => {
  it("is stable for one notification, so a retry cannot send twice", () => {
    const key = idempotencyKeyFor("8f1c0b2e-0000-4000-8000-000000000001");
    expect(idempotencyKeyFor("8f1c0b2e-0000-4000-8000-000000000001")).toBe(key);
  });

  it("differs between notifications, so a second alert is not swallowed", () => {
    // The thing a recipient-and-category key would have got wrong: two
    // genuine alerts about the same kind of event would have collapsed.
    expect(idempotencyKeyFor("aaaa0b2e-0000-4000-8000-000000000001")).not.toBe(
      idempotencyKeyFor("bbbb0b2e-0000-4000-8000-000000000002"),
    );
  });
});
