import { describe, expect, it } from "vitest";
import { proposeClosureSchema } from "./schema";

/**
 * The closure form's own validation.
 *
 * Written because of one bug that nothing else could have caught, and that
 * made PRD 5.9's closure impossible to propose.
 *
 * An unticked checkbox posts no value at all: the key is absent from the
 * FormData, not present-and-empty. `contributeToKnowledgeBase` was declared
 * as `z.union([literal("on"), literal("true"), z.undefined()])`, which
 * accepts the VALUE `undefined` while still requiring the PROPERTY to exist,
 * so every submission without the box ticked failed with "expected
 * nonoptional, received undefined".
 *
 * What made it expensive was where the failure surfaced. The field has no
 * `Field` wrapper and therefore no error slot, so nothing was highlighted;
 * the form just said "Check the highlighted fields" with every field filled
 * in correctly. Three screens of the closure gate were investigated first,
 * because "6 requirements are not met" was on the page and looked like the
 * cause. It was not: the gate was satisfied.
 *
 * So the checkbox is tested in all three shapes a browser can post it, and
 * the fields that must be present are tested as present.
 */

const filled = {
  caseRecordId: "bf7a726c-663c-46e4-80e3-7caf3ad09490",
  objectivesOutcome: "Both objectives met: the payments were traced.",
  evidenceDisposition: "All exhibits retained in the evidence register.",
  outstandingIssues: "None.",
  financialStatus: "Invoiced in full; expenses settled.",
  retentionClass: "litigation_10",
  whatWorked: "Going to the bank statements before the interviews.",
};

describe("proposing a closure", () => {
  it("accepts a form whose knowledge-base box was never ticked", () => {
    // The key is absent, which is exactly what a browser posts.
    const result = proposeClosureSchema.safeParse(filled);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contributeToKnowledgeBase).toBe(false);
    }
  });

  it("reads a ticked box as true, in either spelling a form may use", () => {
    for (const value of ["on", "true"]) {
      const result = proposeClosureSchema.safeParse({
        ...filled,
        contributeToKnowledgeBase: value,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.contributeToKnowledgeBase).toBe(true);
      }
    }
  });

  it("reads an empty value as not ticked rather than rejecting it", () => {
    const result = proposeClosureSchema.safeParse({
      ...filled,
      contributeToKnowledgeBase: "",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contributeToKnowledgeBase).toBe(false);
    }
  });

  it("treats the empty lessons fields a form always posts as unanswered", () => {
    // Every lessons textarea posts "", not nothing, because they are
    // rendered. They have to read as null rather than as a validation error.
    const result = proposeClosureSchema.safeParse({
      ...filled,
      whatDidNotWork: "",
      challenges: "",
      newSources: "",
      newTypologies: "",
      methodologicalLessons: "",
      recommendations: "",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.whatDidNotWork).toBeNull();
      expect(result.data.recommendations).toBeNull();
    }
  });

  it("still requires the answers PRD 5.9 asks a proposer to give", () => {
    for (const field of [
      "objectivesOutcome",
      "evidenceDisposition",
      "financialStatus",
      "retentionClass",
    ] as const) {
      const result = proposeClosureSchema.safeParse({
        ...filled,
        [field]: "",
      });

      expect(result.success, `${field} should be required`).toBe(false);
    }
  });
});
