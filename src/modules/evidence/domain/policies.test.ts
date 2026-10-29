import { describe, expect, it } from "vitest";
import { isEvidenceError } from "./errors";
import {
  allowedEvidenceTransitions,
  assertCitable,
  assertCollectedInThePast,
  assertCollectionRecorded,
  assertCopyIsOfAnOriginal,
  assertCustodyCorrectionUsable,
  assertCustodyPurpose,
  assertEvidenceRemovable,
  assertEvidenceTransition,
  assertMovementHasBothEnds,
  assertNotApprovingOwnVersion,
  assertOriginalFileImmutable,
  assertStatusMatchesCustody,
  assertVersionChangeNote,
  assertVersionEditable,
  assertWorkingCopyHasOriginal,
  integrityVerdict,
  nextVersionLabel,
} from "./policies";

/** PRD 6 and 7: the rules a report has to be able to stand on. */

function codeOf(work: () => void): string {
  try {
    work();
  } catch (error) {
    if (isEvidenceError(error)) return error.code;
    throw error;
  }
  return "no error";
}

const COLLECTED = {
  collectedBy: "11111111-1111-1111-1111-111111111111",
  collectedAt: "2026-10-01T09:00:00.000Z",
  collectionLocation: "The client's registry office, Accra",
  collectionMethod: "Handed over by the finance director and bagged on site",
};

describe("registering evidence", () => {
  it("needs who, when, where and how", () => {
    expect(() => assertCollectionRecorded(COLLECTED)).not.toThrow();

    expect(codeOf(() => assertCollectionRecorded({ ...COLLECTED, collectedBy: null }))).toBe(
      "validation_failed",
    );
    expect(
      codeOf(() => assertCollectionRecorded({ ...COLLECTED, collectionMethod: "  " })),
    ).toBe("validation_failed");
  });

  it("says everything that is missing, not just the first thing", () => {
    try {
      assertCollectionRecorded({
        collectedBy: null,
        collectedAt: null,
        collectionLocation: "",
        collectionMethod: "",
      });
      throw new Error("should have refused");
    } catch (error) {
      if (!isEvidenceError(error)) throw error;
      expect(error.details?.missing).toHaveLength(4);
      expect(error.message).toMatch(/who collected it, when, where, how/);
    }
  });

  it("refuses a collection time in the future", () => {
    const now = new Date("2026-10-01T09:00:00.000Z");
    expect(() =>
      assertCollectedInThePast("2026-09-30T12:00:00.000Z", now),
    ).not.toThrow();
    // A minute of tolerance, because two clocks never quite agree.
    expect(() =>
      assertCollectedInThePast("2026-10-01T09:00:30.000Z", now),
    ).not.toThrow();
    expect(
      codeOf(() => assertCollectedInThePast("2026-10-02T09:00:00.000Z", now)),
    ).toBe("validation_failed");
  });

  it("refuses nonsense in place of a date", () => {
    expect(codeOf(() => assertCollectedInThePast("not a date", new Date()))).toBe(
      "validation_failed",
    );
  });
});

describe("working copies", () => {
  it("are copies of something", () => {
    expect(codeOf(() => assertWorkingCopyHasOriginal("working_copy", null))).toBe(
      "validation_failed",
    );
    expect(() => assertWorkingCopyHasOriginal("working_copy", "an-id")).not.toThrow();
    expect(() => assertWorkingCopyHasOriginal("original", null)).not.toThrow();
  });

  it("are taken from an original, never from another copy", () => {
    expect(() =>
      assertCopyIsOfAnOriginal({
        copyStatus: "original",
        evidenceId: "EV-2026-000158-001",
        deletedAt: null,
      }),
    ).not.toThrow();

    expect(
      codeOf(() =>
        assertCopyIsOfAnOriginal({
          copyStatus: "working_copy",
          evidenceId: "EV-2026-000158-002",
          deletedAt: null,
        }),
      ),
    ).toBe("validation_failed");
  });

  it("cannot be taken from a removed item", () => {
    expect(
      codeOf(() =>
        assertCopyIsOfAnOriginal({
          copyStatus: "original",
          evidenceId: "EV-2026-000158-001",
          deletedAt: "2026-10-02T09:00:00.000Z",
        }),
      ),
    ).toBe("not_found");
  });
});

describe("the original is write-once", () => {
  it("refuses a second file on an original", () => {
    expect(
      codeOf(() =>
        assertOriginalFileImmutable({
          copyStatus: "original",
          evidenceId: "EV-2026-000158-001",
          storagePath: "evidence/case/EV-2026-000158-001/original.pdf",
        }),
      ),
    ).toBe("original_immutable");
  });

  it("allows the first file, and anything on a working copy", () => {
    expect(() =>
      assertOriginalFileImmutable({
        copyStatus: "original",
        evidenceId: "EV-2026-000158-001",
        storagePath: null,
      }),
    ).not.toThrow();
    expect(() =>
      assertOriginalFileImmutable({
        copyStatus: "working_copy",
        evidenceId: "EV-2026-000158-002",
        storagePath: "evidence/case/copy.pdf",
      }),
    ).not.toThrow();
  });
});

describe("the integrity verdict", () => {
  const hash = "a".repeat(64);

  it("is no_file with nothing declared", () => {
    expect(integrityVerdict(null, null)).toBe("no_file");
  });

  it("is unverified until the server has computed its own", () => {
    expect(integrityVerdict(hash, null)).toBe("hash_unverified");
  });

  it("is verified when the two agree, whatever their case", () => {
    expect(integrityVerdict(hash, hash)).toBe("verified");
    expect(integrityVerdict(hash.toUpperCase(), hash)).toBe("verified");
  });

  it("is a mismatch when they do not", () => {
    expect(integrityVerdict(hash, "b".repeat(64))).toBe("mismatch");
  });
});

describe("what may be cited in a report", () => {
  it("allows an item still awaiting verification, because work carries on", () => {
    expect(() =>
      assertCitable({
        integrityStatus: "hash_unverified",
        evidenceId: "EV-2026-000158-001",
        deletedAt: null,
      }),
    ).not.toThrow();
  });

  it("refuses an item whose file does not match what was collected", () => {
    expect(
      codeOf(() =>
        assertCitable({
          integrityStatus: "mismatch",
          evidenceId: "EV-2026-000158-001",
          deletedAt: null,
        }),
      ),
    ).toBe("integrity_mismatch");
  });

  it("refuses a removed item", () => {
    expect(
      codeOf(() =>
        assertCitable({
          integrityStatus: "verified",
          evidenceId: "EV-2026-000158-001",
          deletedAt: "2026-10-02T09:00:00.000Z",
        }),
      ),
    ).toBe("not_found");
  });
});

describe("the evidence status rail", () => {
  it("is final once archived", () => {
    expect(allowedEvidenceTransitions("archived")).toEqual([]);
    expect(codeOf(() => assertEvidenceTransition("archived", "in_review"))).toBe(
      "illegal_transition",
    );
  });

  it("brings a released item back before anything else", () => {
    expect(allowedEvidenceTransitions("released")).toEqual(["returned", "archived"]);
    expect(codeOf(() => assertEvidenceTransition("released", "in_review"))).toBe(
      "illegal_transition",
    );
  });

  it("refuses a move to where it already is", () => {
    expect(codeOf(() => assertEvidenceTransition("registered", "registered"))).toBe(
      "illegal_transition",
    );
  });

  it("will not mark something released with nobody holding it", () => {
    expect(codeOf(() => assertStatusMatchesCustody("released", null))).toBe(
      "custody_required",
    );
    expect(
      codeOf(() =>
        assertStatusMatchesCustody("released", {
          eventType: "examined",
          receivedBy: "someone",
        }),
      ),
    ).toBe("custody_required");
    expect(() =>
      assertStatusMatchesCustody("released", {
        eventType: "released",
        receivedBy: "someone",
      }),
    ).not.toThrow();
  });

  it("does not ask for custody on a move that is not a release", () => {
    expect(() => assertStatusMatchesCustody("in_review", null)).not.toThrow();
  });
});

describe("the chain of custody", () => {
  it("needs both ends of a movement", () => {
    expect(codeOf(() => assertMovementHasBothEnds("released", "a", null))).toBe(
      "validation_failed",
    );
    expect(codeOf(() => assertMovementHasBothEnds("transferred", null, "b"))).toBe(
      "validation_failed",
    );
    expect(() => assertMovementHasBothEnds("released", "a", "b")).not.toThrow();
    // Examining an item is not a movement, so it has one end.
    expect(() => assertMovementHasBothEnds("examined", "a", null)).not.toThrow();
  });

  it("needs a purpose worth reading", () => {
    expect(codeOf(() => assertCustodyPurpose("x"))).toBe("validation_failed");
    expect(() =>
      assertCustodyPurpose("Forensic imaging at the laboratory"),
    ).not.toThrow();
  });

  it("corrects an event once, and says why", () => {
    const event = {
      id: "e1",
      correctsEventId: null,
      correctedByEventId: null,
    };

    expect(codeOf(() => assertCustodyCorrectionUsable(null, "a good reason"))).toBe(
      "not_found",
    );
    expect(codeOf(() => assertCustodyCorrectionUsable(event, "no"))).toBe(
      "validation_failed",
    );
    expect(() =>
      assertCustodyCorrectionUsable(event, "The receiving officer was recorded wrongly"),
    ).not.toThrow();

    expect(
      codeOf(() =>
        assertCustodyCorrectionUsable(
          { ...event, correctedByEventId: "e2" },
          "The receiving officer was recorded wrongly",
        ),
      ),
    ).toBe("conflict");
  });
});

describe("document versions", () => {
  it("steps the draft series, and approving produces a whole number", () => {
    expect(nextVersionLabel(null)).toBe("v0.1");
    expect(nextVersionLabel(null, "final")).toBe("v1.0");
    expect(nextVersionLabel({ versionLabel: "v0.1" })).toBe("v0.2");
    expect(nextVersionLabel({ versionLabel: "v0.9" })).toBe("v0.10");
    expect(nextVersionLabel({ versionLabel: "v0.3" }, "final")).toBe("v1.0");
    expect(nextVersionLabel({ versionLabel: "v1.0" })).toBe("v1.1");
    expect(nextVersionLabel({ versionLabel: "v1.4" }, "final")).toBe("v2.0");
  });

  it("does not guess at a label it does not recognise", () => {
    expect(nextVersionLabel({ versionLabel: "final draft" })).toBe("v0.1");
  });

  it("locks an approved version", () => {
    expect(
      codeOf(() => assertVersionEditable({ isApproved: true, versionLabel: "v1.0" })),
    ).toBe("approved_locked");
    expect(() =>
      assertVersionEditable({ isApproved: false, versionLabel: "v0.2" }),
    ).not.toThrow();
  });

  it("asks what changed when replacing an approved version", () => {
    expect(codeOf(() => assertVersionChangeNote({ isApproved: true }, "typo"))).toBe(
      "validation_failed",
    );
    expect(() =>
      assertVersionChangeNote(
        { isApproved: true },
        "Corrected the invoice totals in the schedule at appendix B.",
      ),
    ).not.toThrow();
    // Replacing a draft needs no ceremony.
    expect(() => assertVersionChangeNote({ isApproved: false }, null)).not.toThrow();
    expect(() => assertVersionChangeNote(null, null)).not.toThrow();
  });

  it("will not let somebody approve their own upload", () => {
    const mine = { createdBy: "me", versionLabel: "v1.0" };
    expect(codeOf(() => assertNotApprovingOwnVersion(mine, "me"))).toBe(
      "self_approval_forbidden",
    );
    expect(() => assertNotApprovingOwnVersion(mine, "somebody else")).not.toThrow();
  });
});

describe("removing evidence", () => {
  const item = {
    evidenceId: "EV-2026-000158-001",
    status: "registered" as const,
    deletedAt: null,
  };

  it("needs a reason somebody could read years later", () => {
    expect(codeOf(() => assertEvidenceRemovable(item, "wrong"))).toBe(
      "validation_failed",
    );
    expect(() =>
      assertEvidenceRemovable(item, "Registered against the wrong case in error."),
    ).not.toThrow();
  });

  it("refuses while the item is out on release", () => {
    expect(
      codeOf(() =>
        assertEvidenceRemovable(
          { ...item, status: "released" },
          "Registered against the wrong case in error.",
        ),
      ),
    ).toBe("custody_required");
  });

  it("refuses an item already removed", () => {
    expect(
      codeOf(() =>
        assertEvidenceRemovable(
          { ...item, deletedAt: "2026-10-02T09:00:00.000Z" },
          "Registered against the wrong case in error.",
        ),
      ),
    ).toBe("conflict");
  });
});
