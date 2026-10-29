import { describe, expect, it } from "vitest";
import { isCaseworkError } from "./errors";
import {
  allowedIncidentTransitions,
  assertCheckInNote,
  assertIncidentClosableBy,
  assertIncidentResolution,
  assertIncidentTransition,
  assertInjuryDetail,
  assertPoliceReference,
  assertSafetySchedule,
  checkInLateness,
  nextCheckInDue,
} from "./safety-policies";

/** PRD 5.8's rules, which are the ones somebody's safety rests on. */

function codeOf(work: () => void): string {
  try {
    work();
  } catch (error) {
    if (isCaseworkError(error)) return error.code;
    throw error;
  }
  return "no error";
}

describe("the check-in schedule", () => {
  it("accepts no schedule at all", () => {
    expect(() => assertSafetySchedule(null, null)).not.toThrow();
  });

  it("refuses a schedule nobody knows how to follow", () => {
    expect(codeOf(() => assertSafetySchedule(4, ""))).toBe("validation_failed");
    expect(codeOf(() => assertSafetySchedule(4, "   "))).toBe("validation_failed");
  });

  it("accepts a schedule with instructions", () => {
    expect(() =>
      assertSafetySchedule(4, "Ring the duty supervisor on the office line."),
    ).not.toThrow();
  });

  it("refuses an interval outside an hour to a week", () => {
    expect(codeOf(() => assertSafetySchedule(0, "x"))).toBe("validation_failed");
    expect(codeOf(() => assertSafetySchedule(200, "x"))).toBe("validation_failed");
  });
});

describe("when the next check-in falls due", () => {
  const plan = { checkInFrequencyHours: 4, isActive: true };

  it("is the interval after checking in", () => {
    expect(nextCheckInDue(plan, "check_in", "2026-10-22T08:00:00.000Z")).toBe(
      "2026-10-22T12:00:00.000Z",
    );
  });

  it("is nothing after checking out, because leaving ends the schedule", () => {
    expect(nextCheckInDue(plan, "check_out", "2026-10-22T08:00:00.000Z")).toBeNull();
  });

  it("is nothing when the plan has no schedule or is stood down", () => {
    expect(
      nextCheckInDue({ checkInFrequencyHours: null, isActive: true }, "check_in", "2026-10-22T08:00:00.000Z"),
    ).toBeNull();
    expect(
      nextCheckInDue({ checkInFrequencyHours: 4, isActive: false }, "check_in", "2026-10-22T08:00:00.000Z"),
    ).toBeNull();
    expect(nextCheckInDue(null, "check_in", "2026-10-22T08:00:00.000Z")).toBeNull();
  });
});

describe("an unsafe check-in", () => {
  it("has to say what is wrong", () => {
    expect(codeOf(() => assertCheckInNote(false, null))).toBe("validation_failed");
    expect(codeOf(() => assertCheckInNote(false, "bad"))).toBe("validation_failed");
  });

  it("is accepted with a note", () => {
    expect(() =>
      assertCheckInNote(false, "Two men have been following the vehicle since the port."),
    ).not.toThrow();
  });

  it("does not apply when all is well", () => {
    expect(() => assertCheckInNote(true, null)).not.toThrow();
  });
});

describe("lateness", () => {
  const now = new Date("2026-10-22T13:00:00.000Z");

  it("is nothing when nobody has checked in", () => {
    expect(checkInLateness(null, now)).toEqual({ isOverdue: false, minutesLate: null });
  });

  it("is nothing after a check-out", () => {
    expect(
      checkInLateness({ event: "check_out", nextDueAt: null }, now),
    ).toEqual({ isOverdue: false, minutesLate: null });
  });

  it("counts the minutes past the due time", () => {
    expect(
      checkInLateness(
        { event: "check_in", nextDueAt: "2026-10-22T12:30:00.000Z" },
        now,
      ),
    ).toEqual({ isOverdue: true, minutesLate: 30 });
  });

  it("is nothing before the due time", () => {
    expect(
      checkInLateness(
        { event: "check_in", nextDueAt: "2026-10-22T14:00:00.000Z" },
        now,
      ),
    ).toEqual({ isOverdue: false, minutesLate: null });
  });
});

describe("an incident report", () => {
  it("says how somebody was hurt, if they were", () => {
    expect(codeOf(() => assertInjuryDetail(true, null))).toBe("validation_failed");
    expect(() => assertInjuryDetail(true, "Cut to the left hand")).not.toThrow();
    expect(() => assertInjuryDetail(false, null)).not.toThrow();
  });

  it("refuses a police reference without a police notification", () => {
    expect(codeOf(() => assertPoliceReference(false, "CR/2026/4411"))).toBe(
      "validation_failed",
    );
    expect(() => assertPoliceReference(true, "CR/2026/4411")).not.toThrow();
    expect(() => assertPoliceReference(false, null)).not.toThrow();
  });
});

describe("the incident lifecycle", () => {
  it("offers review or closure from open", () => {
    expect(allowedIncidentTransitions("open")).toEqual(["under_review", "closed"]);
  });

  it("is final once closed", () => {
    expect(allowedIncidentTransitions("closed")).toEqual([]);
    expect(codeOf(() => assertIncidentTransition("closed", "open"))).toBe(
      "illegal_transition",
    );
  });

  it("refuses a move to the status it is already at", () => {
    expect(codeOf(() => assertIncidentTransition("open", "open"))).toBe(
      "illegal_transition",
    );
  });

  it("needs a resolution to close", () => {
    expect(codeOf(() => assertIncidentResolution("closed", "done"))).toBe(
      "validation_failed",
    );
    expect(() =>
      assertIncidentResolution("closed", "Escorted off site and reported to the client."),
    ).not.toThrow();
    expect(() => assertIncidentResolution("under_review", null)).not.toThrow();
  });
});

describe("who may close an incident", () => {
  const incident = {
    incidentId: "INC-2026-000001",
    affectedUserId: "11111111-1111-1111-1111-111111111111",
    reportedBy: "22222222-2222-2222-2222-222222222222",
  };

  it("is not the person it happened to", () => {
    expect(codeOf(() => assertIncidentClosableBy(incident, incident.affectedUserId))).toBe(
      "self_approval_forbidden",
    );
  });

  it("is not the person who reported it", () => {
    expect(codeOf(() => assertIncidentClosableBy(incident, incident.reportedBy))).toBe(
      "self_approval_forbidden",
    );
  });

  it("is anybody else with the permission", () => {
    expect(() =>
      assertIncidentClosableBy(incident, "33333333-3333-3333-3333-333333333333"),
    ).not.toThrow();
  });
});
