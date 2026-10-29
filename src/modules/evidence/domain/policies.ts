import { EvidenceError } from "./errors";
import {
  CUSTODY_MOVEMENTS,
  type CustodyEvent,
  type CustodyEventType,
  type DocumentVersion,
  type EvidenceItem,
  type EvidenceStatus,
  type IntegrityStatus,
} from "./types";

/**
 * Evidence and document rules (PRD 6, 7).
 *
 * Pure functions with no imports beyond this folder, so every rule is
 * testable without a database and is the same rule wherever it is applied.
 * The database holds the same constraints: a CHECK cannot explain itself to
 * somebody filling in a form, and a rule in TypeScript cannot stop a
 * careless script.
 */

/* ------------------------------------------------- registering evidence */

/**
 * PRD 6.1 marks the collection facts mandatory.
 *
 * Evidence nobody can say who collected, when, where or how is not evidence
 * anybody can rely on, and a report that cites it cannot be defended.
 */
export function assertCollectionRecorded(input: {
  collectedBy: string | null | undefined;
  collectedAt: string | null | undefined;
  collectionLocation: string | null | undefined;
  collectionMethod: string | null | undefined;
}): void {
  const missing: string[] = [];
  if (!input.collectedBy) missing.push("who collected it");
  if (!input.collectedAt) missing.push("when");
  if ((input.collectionLocation ?? "").trim().length === 0) missing.push("where");
  if ((input.collectionMethod ?? "").trim().length === 0) missing.push("how");

  if (missing.length === 0) return;

  throw new EvidenceError(
    "validation_failed",
    `Evidence needs ${missing.join(", ")}. Without it the item cannot be relied on in a report.`,
    { missing },
  );
}

/** Evidence cannot have been collected in the future. */
export function assertCollectedInThePast(collectedAt: string, now: Date): void {
  const at = new Date(collectedAt);
  if (Number.isNaN(at.getTime())) {
    throw new EvidenceError("validation_failed", "That is not a valid date and time.");
  }
  // A minute of tolerance, because a laptop clock and the server's rarely
  // agree to the second and refusing an item over that would be absurd.
  if (at.getTime() <= now.getTime() + 60_000) return;

  throw new EvidenceError(
    "validation_failed",
    "That collection time is in the future. Record the item once it has been collected.",
  );
}

/** A working copy is a copy of something (PRD 6.3). */
export function assertWorkingCopyHasOriginal(
  copyStatus: string,
  originalEvidenceId: string | null | undefined,
): void {
  if (copyStatus !== "working_copy") return;
  if (originalEvidenceId) return;

  throw new EvidenceError(
    "validation_failed",
    "Say which original this is a working copy of. A copy of nothing is just another item.",
  );
}

/**
 * A working copy is taken from an original, never from another copy.
 *
 * Otherwise the provenance of the thing an analyst is looking at is a chain
 * of copies nobody can walk back to the original.
 */
export function assertCopyIsOfAnOriginal(
  original: Pick<EvidenceItem, "copyStatus" | "evidenceId" | "deletedAt">,
): void {
  if (original.deletedAt !== null) {
    throw new EvidenceError(
      "not_found",
      `${original.evidenceId} has been removed, so a copy cannot be taken from it.`,
    );
  }
  if (original.copyStatus === "original") return;

  throw new EvidenceError(
    "validation_failed",
    `${original.evidenceId} is itself a working copy. Take the copy from the original, so its provenance is one step rather than a chain.`,
  );
}

/**
 * The original is never edited in place (PRD 6.3: "originals are
 * write-protected; analysts work on working copies").
 *
 * The write-once Storage policy is what enforces it for the file. This is the
 * rule for the record, and it names the alternative rather than just refusing.
 */
export function assertOriginalFileImmutable(
  item: Pick<EvidenceItem, "copyStatus" | "evidenceId" | "storagePath">,
): void {
  if (item.copyStatus !== "original" || item.storagePath === null) return;

  throw new EvidenceError(
    "original_immutable",
    `${item.evidenceId} is an original with a file already attached. An original is write-once: take a working copy and work on that.`,
  );
}

/* --------------------------------------------------------- the integrity */

/**
 * What the two hashes say about an item.
 *
 * Returned rather than thrown: a mismatch is a finding to record, not an
 * error to swallow. PRD 6.3 wants it permanently recorded and alerted on,
 * which cannot happen if the comparison throws before anything is written.
 */
export function integrityVerdict(
  declared: string | null,
  computed: string | null,
): IntegrityStatus {
  if (!declared) return "no_file";
  if (!computed) return "hash_unverified";
  return declared.toLowerCase() === computed.toLowerCase() ? "verified" : "mismatch";
}

/**
 * Whether an item may be cited in a report.
 *
 * An unverified hash is not a refusal: verification is asynchronous and work
 * carries on. A mismatch is, because citing an item whose file does not match
 * what was collected is the one thing that would discredit the whole report.
 */
export function assertCitable(
  item: Pick<EvidenceItem, "integrityStatus" | "evidenceId" | "deletedAt">,
): void {
  if (item.deletedAt !== null) {
    throw new EvidenceError(
      "not_found",
      `${item.evidenceId} has been removed and cannot be cited.`,
    );
  }
  if (item.integrityStatus !== "mismatch") return;

  throw new EvidenceError(
    "integrity_mismatch",
    `${item.evidenceId} failed its integrity check: the stored file does not match the hash recorded when it was collected. It cannot be cited until that is resolved.`,
  );
}

/* ------------------------------------------------------- the status rail */

const EVIDENCE_TRANSITIONS: Record<EvidenceStatus, readonly EvidenceStatus[]> = {
  registered: ["in_review", "released", "archived"],
  in_review: ["registered", "released", "archived"],
  released: ["returned", "archived"],
  returned: ["in_review", "released", "archived"],
  // Archived is where an item comes to rest with its case.
  archived: [],
};

export function allowedEvidenceTransitions(
  from: EvidenceStatus,
): readonly EvidenceStatus[] {
  return EVIDENCE_TRANSITIONS[from];
}

export function assertEvidenceTransition(
  from: EvidenceStatus,
  to: EvidenceStatus,
): void {
  if (from === to) {
    throw new EvidenceError(
      "illegal_transition",
      "The item is already at that status.",
    );
  }
  if (!EVIDENCE_TRANSITIONS[from].includes(to)) {
    throw new EvidenceError(
      "illegal_transition",
      EVIDENCE_TRANSITIONS[from].length === 0
        ? `An archived item stays archived. It is readable, and its custody record is complete.`
        : `An item that is ${from.replace(/_/g, " ")} can only move to: ${EVIDENCE_TRANSITIONS[
            from
          ]
            .map((s) => s.replace(/_/g, " "))
            .join(", ")}.`,
      { from, to },
    );
  }
}

/**
 * Releasing an item needs the custody event that goes with it.
 *
 * PRD 6.2 makes every movement a custody event, so a status that says
 * "released" with nothing in the ledger saying who took it is the gap the
 * whole module exists to close.
 */
export function assertStatusMatchesCustody(
  to: EvidenceStatus,
  event: { eventType: CustodyEventType; receivedBy: string | null } | null,
): void {
  if (to !== "released") return;

  if (!event || !CUSTODY_MOVEMENTS.includes(event.eventType) || !event.receivedBy) {
    throw new EvidenceError(
      "custody_required",
      "Record who the item was released to. A status of released with nobody holding it is exactly the gap a chain of custody is for.",
    );
  }
}

/* ------------------------------------------------------ chain of custody */

/** A movement has two ends (PRD 6.2). */
export function assertMovementHasBothEnds(
  eventType: CustodyEventType,
  releasedBy: string | null | undefined,
  receivedBy: string | null | undefined,
): void {
  if (!CUSTODY_MOVEMENTS.includes(eventType)) return;
  if (releasedBy && receivedBy) return;

  throw new EvidenceError(
    "validation_failed",
    "Say who released the item and who received it. A movement with one end is not a movement.",
  );
}

/** Every custody event says why (PRD 6.2's purpose). */
export function assertCustodyPurpose(purpose: string | null | undefined): void {
  if ((purpose ?? "").trim().length >= 5) return;

  throw new EvidenceError(
    "validation_failed",
    "Say what the item was moved for, in at least 5 characters. A ledger of movements with no purposes explains nothing.",
  );
}

/**
 * A correction corrects an event, and only once (PRD 6.2).
 *
 * The same shape as the activity log's rule: a chain of corrections of
 * corrections is unreadable, so a second correction goes against the
 * correcting event instead.
 */
export function assertCustodyCorrectionUsable(
  original: Pick<CustodyEvent, "id" | "correctsEventId" | "correctedByEventId"> | null,
  reason: string | null | undefined,
): void {
  if (!original) {
    throw new EvidenceError(
      "not_found",
      "The custody event being corrected no longer exists.",
    );
  }
  if (original.correctedByEventId !== null) {
    throw new EvidenceError(
      "conflict",
      "That event has already been corrected. Correct the correcting event instead, so the ledger reads as one sequence.",
    );
  }
  if ((reason ?? "").trim().length < 5) {
    throw new EvidenceError(
      "validation_failed",
      "Say what was wrong with the original event, in at least 5 characters.",
    );
  }
}

/* --------------------------------------------------------- the documents */

/**
 * The next version label (PRD 7.2: v0.1, v0.2, v1.0 ...).
 *
 * Drafts step the minor number; approving is what produces a whole number.
 * The label is derived rather than typed, so a document's history cannot
 * acquire two v1.0s.
 */
export function nextVersionLabel(
  previous: { versionLabel: string } | null,
  intent: "draft" | "final" = "draft",
): string {
  if (!previous) return intent === "final" ? "v1.0" : "v0.1";

  const match = /^v(\d+)\.(\d+)$/.exec(previous.versionLabel.trim());
  if (!match) {
    // An unrecognised label is not worth guessing at: step the draft series
    // from the start rather than inventing a successor to something unknown.
    return intent === "final" ? "v1.0" : "v0.1";
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  return intent === "final" ? `v${major + 1}.0` : `v${major}.${minor + 1}`;
}

/**
 * An approved version is locked (PRD 7.2).
 *
 * "A new version requires a recorded reason and re-approval", so the refusal
 * names that route rather than just saying no.
 */
export function assertVersionEditable(
  version: Pick<DocumentVersion, "isApproved" | "versionLabel">,
): void {
  if (!version.isApproved) return;

  throw new EvidenceError(
    "approved_locked",
    `${version.versionLabel} is approved and locked. Upload the next version with a note saying what changed, and have it approved again.`,
  );
}

/** A new version of an approved document says what changed and why. */
export function assertVersionChangeNote(
  previous: Pick<DocumentVersion, "isApproved"> | null,
  changeNote: string | null | undefined,
): void {
  if (!previous?.isApproved) return;
  if ((changeNote ?? "").trim().length >= 10) return;

  throw new EvidenceError(
    "validation_failed",
    "The version you are replacing was approved, so say what changed, in at least 10 characters.",
  );
}

/** PRD 16: nobody approves their own work. */
export function assertNotApprovingOwnVersion(
  version: Pick<DocumentVersion, "createdBy" | "versionLabel">,
  actorId: string,
): void {
  if (version.createdBy !== actorId) return;

  throw new EvidenceError(
    "self_approval_forbidden",
    `You uploaded ${version.versionLabel}, so somebody else has to approve it.`,
  );
}

/**
 * Removing evidence is an administrative act under a second pair of eyes.
 *
 * PRD 16: "evidence is never silently hard-deleted: only the Administrator
 * can remove it, as a recoverable soft-delete with reason and
 * second-administrator approval, never while under Legal Hold." The legal
 * hold itself is M1's register; this is the reason and the custody condition.
 */
export function assertEvidenceRemovable(
  item: Pick<EvidenceItem, "evidenceId" | "status" | "deletedAt">,
  reason: string | null | undefined,
): void {
  if (item.deletedAt !== null) {
    throw new EvidenceError("conflict", `${item.evidenceId} is already removed.`);
  }
  if ((reason ?? "").trim().length < 10) {
    throw new EvidenceError(
      "validation_failed",
      "Removing evidence needs a reason of at least 10 characters. It goes in the audit trail and may be read years later.",
    );
  }
  if (item.status === "released") {
    throw new EvidenceError(
      "custody_required",
      `${item.evidenceId} is out on release. Record its return before removing the record, so the chain of custody does not end mid-movement.`,
    );
  }
}
