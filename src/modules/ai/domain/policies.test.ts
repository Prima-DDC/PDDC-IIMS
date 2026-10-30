import { describe, expect, it } from "vitest";
import { AiError } from "./errors";
import {
  DAILY_JOBS_PER_CASE,
  DAILY_JOBS_PER_USER,
  MAX_PASSAGES,
  SENDABLE_CLASSIFICATIONS,
  assertNothingAboveInternal,
  assertSomethingToGroundOn,
  assertWithinQuota,
  breakerDelayMs,
  buildRequest,
  gateByClassification,
  keepOnlyGrounded,
  maySend,
  parseSuggestion,
  providerIsAvailable,
  redact,
  restore,
  shouldTryNextProvider,
} from "./policies";
import type { Passage } from "./types";

/**
 * The rules of PRD 22, tested as rules.
 *
 * This file gets more attention than any other domain test in the platform,
 * because it is the only layer whose failure sends PDDC's material to a third
 * party. Everything else goes wrong inside a system that still has
 * permissions. A prompt does not come back.
 */

function passage(over: Partial<Passage> = {}): Passage {
  return {
    recordType: "finding",
    recordId: "8f1c0b2e-0000-4000-8000-000000000001",
    reference: "F-001",
    classification: "INTERNAL",
    text: "The payments were authorised without a purchase order.",
    ...over,
  };
}

describe("the classification gate (PRD 22.4)", () => {
  it("allows exactly PUBLIC and INTERNAL, and nothing else ever", () => {
    expect([...SENDABLE_CLASSIFICATIONS].sort()).toEqual(["INTERNAL", "PUBLIC"]);
    expect(maySend("PUBLIC")).toBe(true);
    expect(maySend("INTERNAL")).toBe(true);
    expect(maySend("CONFIDENTIAL")).toBe(false);
    expect(maySend("RESTRICTED")).toBe(false);
    expect(maySend("STRICTLY_RESTRICTED")).toBe(false);
  });

  it("refuses a classification it has never heard of", () => {
    // The allow-list shape is the point: a sixth level added to the
    // catalogue must be refused until somebody decides otherwise, not
    // permitted because nobody remembered to block it.
    expect(maySend("COSMIC_TOP_SECRET")).toBe(false);
    expect(maySend("")).toBe(false);
  });

  it("separates what may go from what may not, and names the withheld", () => {
    const { sendable, withheld } = gateByClassification([
      passage({ reference: "F-001", classification: "INTERNAL" }),
      passage({ reference: "F-002", classification: "CONFIDENTIAL" }),
      passage({ reference: "EV-1", classification: "PUBLIC" }),
      passage({ reference: "SRC-1", classification: "STRICTLY_RESTRICTED" }),
    ]);

    expect(sendable.map((p) => p.reference)).toEqual(["F-001", "EV-1"]);
    expect(withheld).toEqual([
      { reference: "F-002", classification: "CONFIDENTIAL" },
      { reference: "SRC-1", classification: "STRICTLY_RESTRICTED" },
    ]);
  });

  it("throws on the assembled request, which is the check that cannot be ignored", () => {
    expect(() =>
      assertNothingAboveInternal([passage({ classification: "CONFIDENTIAL" })]),
    ).toThrow(AiError);

    try {
      assertNothingAboveInternal([
        passage({ reference: "F-009", classification: "RESTRICTED" }),
      ]);
      expect.unreachable("it should have refused");
    } catch (error) {
      expect((error as AiError).code).toBe("classification_blocked");
      expect((error as AiError).message).toContain("F-009 is RESTRICTED");
    }
  });

  it("will not answer from nothing", () => {
    // Asking a model to answer with no passages is asking it to answer from
    // its training data, which is the definition of ungrounded here.
    expect(() => assertSomethingToGroundOn([])).toThrow(/nothing on this case/i);
  });
});

describe("redaction (PRD 22.4)", () => {
  const names = [
    { name: "Kofi Mensah", kind: "person" as const },
    { name: "ABC Holdings Ghana Limited", kind: "organisation" as const },
    { name: "ABC Holdings", kind: "organisation" as const },
  ];

  it("replaces a known name wherever it appears", () => {
    const { text, redactions } = redact(
      "Kofi Mensah signed it. Kofi Mensah also approved it.",
      names,
    );

    expect(text).not.toContain("Kofi Mensah");
    expect(text).toBe("[PERSON_1] signed it. [PERSON_1] also approved it.");
    // One token for one person, so the model can still see it is the same
    // person twice. That is most of what makes a redacted passage usable.
    expect(redactions).toHaveLength(1);
  });

  it("replaces the longest name first, so no tail is left behind", () => {
    const { text } = redact("ABC Holdings Ghana Limited owns the warehouse.", names);

    // The bug this guards: substituting "ABC Holdings" first would leave
    // "Ghana Limited" in the clear, which names the company almost as well.
    expect(text).not.toContain("Ghana Limited");
    expect(text).toBe("[ORGANISATION_1] owns the warehouse.");
  });

  it("is case insensitive, because a document is not", () => {
    const { text } = redact("KOFI MENSAH and kofi mensah", names);
    expect(text).toBe("[PERSON_1] and [PERSON_1]");
  });

  it("catches identifiers, accounts, telephone numbers and addresses", () => {
    const { text, redactions } = redact(
      "Paid into 1234567890123 from GHA-123456789-0, contact kofi@example.com or +233 24 123 4567.",
      [],
    );

    expect(text).not.toMatch(/1234567890123/);
    expect(text).not.toMatch(/GHA-123456789/);
    expect(text).not.toContain("kofi@example.com");
    expect(text).not.toMatch(/233 24 123 4567/);
    expect(redactions.length).toBeGreaterThanOrEqual(4);
  });

  it("does not name anybody the passage never mentions", () => {
    // The register can hold two hundred subjects. A passage about one of them
    // must not ship a map of the other hundred and ninety-nine.
    const { redactions } = redact("The warehouse was empty.", names);
    expect(redactions).toHaveLength(0);
  });

  it("restores exactly what it replaced", () => {
    const original =
      "Kofi Mensah of ABC Holdings Ghana Limited used account 1234567890123.";
    const { text, redactions } = redact(original, names);

    expect(text).not.toContain("Kofi Mensah");
    expect(restore(text, redactions)).toBe(original);
  });

  it("restores a token the model used in its own sentence", () => {
    const { redactions } = redact("Kofi Mensah signed it.", names);
    expect(
      restore("[PERSON_1] appears in three of the payments.", redactions),
    ).toBe("Kofi Mensah appears in three of the payments.");
  });
});

describe("grounding (PRD 22.3)", () => {
  it("keeps a statement that cites a reference it was given", () => {
    const result = keepOnlyGrounded(
      { statements: [{ text: "No purchase order existed.", cites: ["F-001"] }] },
      ["F-001", "EV-1"],
    );

    expect(result.statements).toEqual([
      { text: "No purchase order existed.", cites: ["F-001"] },
    ]);
    expect(result.discarded).toEqual([]);
  });

  it("discards a statement that cites nothing", () => {
    const result = keepOnlyGrounded(
      {
        statements: [
          { text: "No purchase order existed.", cites: ["F-001"] },
          { text: "This was probably fraud.", cites: [] },
        ],
      },
      ["F-001"],
    );

    expect(result.statements).toHaveLength(1);
    expect(result.discarded).toEqual(["This was probably fraud."]);
  });

  it("discards a statement citing a reference that was never sent", () => {
    // The most dangerous thing a model can do here: invent "F-007" and
    // produce a sentence that looks exactly like a traceable finding.
    const result = keepOnlyGrounded(
      { statements: [{ text: "The director was disqualified.", cites: ["F-007"] }] },
      ["F-001"],
    );

    expect(result.statements).toEqual([]);
    expect(result.discarded).toEqual(["The director was disqualified."]);
  });

  it("keeps the citations that are real and drops the ones that are not", () => {
    const result = keepOnlyGrounded(
      { statements: [{ text: "Two payments match.", cites: ["F-001", "F-099"] }] },
      ["F-001"],
    );

    expect(result.statements).toEqual([
      { text: "Two payments match.", cites: ["F-001"] },
    ]);
  });

  it("matches a reference whatever case the model wrote it in", () => {
    const result = keepOnlyGrounded(
      { statements: [{ text: "It was authorised.", cites: ["f-001"] }] },
      ["F-001"],
    );
    expect(result.statements).toHaveLength(1);
  });
});

describe("building a request", () => {
  it("applies the gate, the budget and the redactor, in that order", () => {
    const { sendable, redactions, cited } = buildRequest({
      question: "What did Kofi Mensah authorise?",
      passages: [
        passage({
          reference: "F-001",
          text: "Kofi Mensah authorised the payment on 2 March.",
        }),
      ],
      knownNames: [{ name: "Kofi Mensah", kind: "person" }],
    });

    expect(sendable.user).not.toContain("Kofi Mensah");
    expect(sendable.user).toContain("[PERSON_1]");
    // The question is redacted too: it is part of the request that leaves.
    expect(sendable.user).toContain("Question: What did [PERSON_1] authorise?");
    expect(sendable.user).toContain("reference F-001");
    expect(sendable.classification).toBe("INTERNAL");
    expect(sendable.redactionCount).toBe(redactions.length);
    expect(cited).toEqual(["F-001"]);
  });

  it("refuses outright if anything above INTERNAL reached it", () => {
    expect(() =>
      buildRequest({
        question: "What happened?",
        passages: [passage({ classification: "CONFIDENTIAL" })],
        knownNames: [],
      }),
    ).toThrow(/PRD 22.4/);
  });

  it("gives one person one token across every passage", () => {
    const { sendable } = buildRequest({
      question: "Who signed?",
      passages: [
        passage({ reference: "F-001", text: "Kofi Mensah signed the first." }),
        passage({ reference: "F-002", text: "Kofi Mensah signed the second." }),
      ],
      knownNames: [{ name: "Kofi Mensah", kind: "person" }],
    });

    // Two passages about one person must not look like two people, which is
    // what a per-passage counter would have produced.
    expect(sendable.user).not.toContain("[PERSON_2]");
    expect(sendable.user.match(/\[PERSON_1\]/g)).toHaveLength(2);
  });

  it("keeps to its passage budget", () => {
    const many = Array.from({ length: MAX_PASSAGES + 5 }, (_, index) =>
      passage({ reference: `F-${index + 1}` }),
    );
    const { cited } = buildRequest({
      question: "Summarise",
      passages: many,
      knownNames: [],
    });
    expect(cited).toHaveLength(MAX_PASSAGES);
  });

  it("says PUBLIC when nothing internal was sent", () => {
    const { sendable } = buildRequest({
      question: "What is on the register?",
      passages: [passage({ classification: "PUBLIC" })],
      knownNames: [],
    });
    expect(sendable.classification).toBe("PUBLIC");
  });
});

describe("reading the reply", () => {
  it("reads plain JSON", () => {
    const result = parseSuggestion(
      '{"statements":[{"text":"It was authorised.","cites":["F-001"]}],"notes":"n"}',
      ["F-001"],
    );
    expect(result.statements).toHaveLength(1);
    expect(result.notes).toBe("n");
  });

  it("reads JSON in a fenced block, which models produce constantly", () => {
    const result = parseSuggestion(
      '```json\n{"statements":[{"text":"It was authorised.","cites":["F-001"]}]}\n```',
      ["F-001"],
    );
    expect(result.statements).toHaveLength(1);
  });

  it("reads JSON wrapped in prose", () => {
    const result = parseSuggestion(
      'Certainly. {"statements":[{"text":"It was authorised.","cites":["F-001"]}]} I hope that helps.',
      ["F-001"],
    );
    expect(result.statements).toHaveLength(1);
  });

  it("returns nothing usable rather than throwing when the reply is prose", () => {
    // An honest empty answer is something a screen can show. An exception
    // here would read to the user as a platform fault rather than as a model
    // that did not cooperate.
    const result = parseSuggestion("I think this was probably fraud.", ["F-001"]);
    expect(result.statements).toEqual([]);
    expect(result.notes).toMatch(/did not reply in the requested format/i);
  });

  it("drops ungrounded statements from a well-formed reply", () => {
    const result = parseSuggestion(
      '{"statements":[{"text":"Grounded.","cites":["F-001"]},{"text":"Invented.","cites":["F-404"]}]}',
      ["F-001"],
    );
    expect(result.statements.map((s) => s.text)).toEqual(["Grounded."]);
    expect(result.discarded).toEqual(["Invented."]);
  });

  it("survives a statement with no cites field at all", () => {
    const result = parseSuggestion(
      '{"statements":[{"text":"No citation key."}]}',
      ["F-001"],
    );
    expect(result.statements).toEqual([]);
    expect(result.discarded).toEqual(["No citation key."]);
  });
});

describe("quotas (PRD 22.1)", () => {
  it("lets ordinary use through", () => {
    expect(() => assertWithinQuota({ byUser: 3, byCase: 11 })).not.toThrow();
  });

  it("stops one person from spending everybody's allowance", () => {
    expect(() =>
      assertWithinQuota({ byUser: DAILY_JOBS_PER_USER, byCase: 0 }),
    ).toThrow(/today's 50 AI requests/i);
  });

  it("stops one case from spending the firm's day", () => {
    expect(() =>
      assertWithinQuota({ byUser: 0, byCase: DAILY_JOBS_PER_CASE }),
    ).toThrow(/This case has used/i);
  });

  it("reports which limit was met, so the message can be specific", () => {
    try {
      assertWithinQuota({ byUser: DAILY_JOBS_PER_USER, byCase: 0 });
      expect.unreachable("it should have refused");
    } catch (error) {
      expect((error as AiError).details?.scope).toBe("user");
    }
  });
});

describe("the router (PRD 22.1)", () => {
  it("skips a provider nobody enabled", () => {
    expect(providerIsAvailable({ isEnabled: false, nextAttemptAt: null })).toBe(
      false,
    );
  });

  it("skips a provider whose breaker is open", () => {
    const soon = new Date(Date.now() + 60_000).toISOString();
    expect(providerIsAvailable({ isEnabled: true, nextAttemptAt: soon })).toBe(
      false,
    );
  });

  it("tries a provider again once its breaker has expired", () => {
    const past = new Date(Date.now() - 1_000).toISOString();
    expect(providerIsAvailable({ isEnabled: true, nextAttemptAt: past })).toBe(
      true,
    );
  });

  it("backs off 1, 4 and 16 minutes, then an hour", () => {
    expect(breakerDelayMs(1)).toBe(60_000);
    expect(breakerDelayMs(2)).toBe(4 * 60_000);
    expect(breakerDelayMs(3)).toBe(16 * 60_000);
    expect(breakerDelayMs(4)).toBe(60 * 60_000);
    expect(breakerDelayMs(40)).toBe(60 * 60_000);
  });

  it("moves to the next provider for a rate limit or an outage", () => {
    expect(shouldTryNextProvider(429)).toBe(true);
    expect(shouldTryNextProvider(408)).toBe(true);
    expect(shouldTryNextProvider(500)).toBe(true);
    expect(shouldTryNextProvider(503)).toBe(true);
    expect(shouldTryNextProvider(undefined)).toBe(true);
  });

  it("gives up on a request the provider says is malformed", () => {
    // Sending the same bad request to three more providers produces three
    // more identical refusals and spends three more of a free allowance.
    expect(shouldTryNextProvider(400)).toBe(false);
    expect(shouldTryNextProvider(401)).toBe(false);
    expect(shouldTryNextProvider(422)).toBe(false);
  });
});
