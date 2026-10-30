import { AiError } from "./errors";
import type { Passage, Redaction, Sendable, Suggestion } from "./types";

/**
 * The rules that make cloud AI defensible (PRD 22.3, 22.4).
 *
 * Pure functions over plain data, and every one of them is a rule somebody at
 * PDDC would recognise. They are here rather than in a prompt because a
 * prompt is a request and these are requirements: a model asked not to reveal
 * a subject's name is being asked, and a gateway that never sends the name
 * has decided.
 */

/* ----------------------------------------------- the classification gate */

/**
 * PRD 22.4: only PUBLIC and INTERNAL material may reach a free cloud
 * provider.
 *
 * Written as an allow-list of two rather than a block-list of three. The
 * block-list version is the same thing today and the wrong shape tomorrow: a
 * sixth classification added to the catalogue would be sendable by default,
 * which is precisely backwards for a list whose members are added when
 * something more sensitive turns up.
 */
export const SENDABLE_CLASSIFICATIONS: readonly string[] = ["PUBLIC", "INTERNAL"];

export function maySend(classification: string): boolean {
  return SENDABLE_CLASSIFICATIONS.includes(classification);
}

/**
 * Splits retrieved passages into what may leave and what may not.
 *
 * Returns both halves rather than throwing on the first refusal, because the
 * useful answer is usually "we can work with four of these seven, and here is
 * why the other three stayed": an assistant that refuses a whole question
 * because one exhibit is RESTRICTED is an assistant nobody uses, and PRD 22
 * makes AI assistive.
 */
export function gateByClassification(passages: Passage[]): {
  sendable: Passage[];
  withheld: Array<{ reference: string; classification: string }>;
} {
  const sendable: Passage[] = [];
  const withheld: Array<{ reference: string; classification: string }> = [];

  for (const passage of passages) {
    if (maySend(passage.classification)) sendable.push(passage);
    else
      withheld.push({
        reference: passage.reference,
        classification: passage.classification,
      });
  }

  return { sendable, withheld };
}

/**
 * The last check before anything leaves, and it throws.
 *
 * `gateByClassification` is the useful, forgiving version used while
 * assembling a request. This is the unforgiving one called on the assembled
 * result, and the two exist separately on purpose: the first is a filter and
 * can be got wrong by a caller that ignores its second return value, and this
 * one cannot be got wrong because there is nothing to ignore.
 */
export function assertNothingAboveInternal(passages: Passage[]): void {
  const offending = passages.filter((passage) => !maySend(passage.classification));
  if (offending.length === 0) return;

  throw new AiError(
    "classification_blocked",
    `PRD 22.4 allows only PUBLIC and INTERNAL material to reach a cloud provider. ${offending
      .map((passage) => `${passage.reference} is ${passage.classification}`)
      .join(", ")}.`,
    { offending: offending.map((passage) => passage.reference) },
  );
}

/* ------------------------------------------------------------ redaction */

/**
 * Replaces the things PRD 22.4 names with tokens.
 *
 * Two mechanisms, and both are needed:
 *
 *   KNOWN NAMES are substituted by lookup. The platform has a register of
 *   every subject and organisation on the case, so the names that matter are
 *   not guessed at: they are known exactly, which is far better than any
 *   pattern could be. Longest first, so "ABC Holdings Ghana Limited" is
 *   replaced whole rather than leaving "Ghana Limited" behind after "ABC
 *   Holdings" went.
 *
 *   PATTERNS catch what the register does not hold: identifiers, account
 *   numbers, telephone numbers and email addresses, which appear inside the
 *   text of a statement rather than as records of their own.
 *
 * The map is returned, never sent. One token per distinct original, so the
 * model can still reason that [PERSON_1] appears twice, which is most of what
 * makes a redacted passage usable at all.
 *
 * What this does NOT claim: it is not anonymisation. A passage can identify
 * somebody by circumstance with every name removed, and PRD 22.4's real
 * protection is the classification gate above, which keeps confidential
 * material in the platform entirely. This reduces what an INTERNAL passage
 * discloses; it does not make disclosure safe.
 */
export function redact(
  text: string,
  knownNames: Array<{ name: string; kind: Redaction["kind"] }>,
): { text: string; redactions: Redaction[] } {
  const redactions: Redaction[] = [];
  const byOriginal = new Map<string, string>();
  const counters: Record<string, number> = {};

  function tokenFor(original: string, kind: Redaction["kind"]): string {
    const existing = byOriginal.get(original.toLowerCase());
    if (existing) return existing;

    const prefix = kind.toUpperCase();
    counters[prefix] = (counters[prefix] ?? 0) + 1;
    const token = `[${prefix}_${counters[prefix]}]`;

    byOriginal.set(original.toLowerCase(), token);
    redactions.push({ token, original, kind });
    return token;
  }

  let out = text;

  // Longest first. A shorter name that is a prefix of a longer one would
  // otherwise leave the tail of the longer one in the clear.
  const names = [...knownNames]
    .filter((entry) => entry.name.trim().length >= 3)
    .sort((a, b) => b.name.length - a.name.length);

  for (const entry of names) {
    const pattern = new RegExp(escapeForRegExp(entry.name.trim()), "gi");
    // Only tokenised if it is actually there, so the map does not list the
    // whole case register for a passage that mentions nobody.
    if (!pattern.test(out)) continue;
    pattern.lastIndex = 0;
    const token = tokenFor(entry.name.trim(), entry.kind);
    out = out.replace(pattern, token);
  }

  const patterns: Array<{ kind: Redaction["kind"]; regex: RegExp }> = [
    // Email, before the number patterns: an address can contain digits.
    { kind: "contact", regex: /\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b/g },
    // Ghana Card, passport and similar: letters, then digits, with dashes.
    { kind: "identifier", regex: /\b[A-Z]{2,4}[- ]?\d{6,12}[- ]?\d{0,2}\b/g },
    // An account or long reference number: eight digits or more together.
    { kind: "account", regex: /\b\d{8,}\b/g },
    // A telephone number, which is shorter than an account and may carry a
    // country code.
    { kind: "contact", regex: /\+?\d[\d\s()-]{7,15}\d/g },
  ];

  for (const { kind, regex } of patterns) {
    out = out.replace(regex, (match) => {
      // A token already substituted must not be re-matched: "[ACCOUNT_1]"
      // contains no digits, but a name token might sit beside one.
      if (/^\[[A-Z]+_\d+\]$/.test(match.trim())) return match;
      return tokenFor(match.trim(), kind);
    });
  }

  return { text: out, redactions };
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Puts the real values back when the answer returns (PRD 22.4). */
export function restore(text: string, redactions: Redaction[]): string {
  let out = text;
  for (const redaction of redactions) {
    out = out.split(redaction.token).join(redaction.original);
  }
  return out;
}

/* ------------------------------------------------------------- grounding */

/**
 * PRD 22.3: an answer with nothing behind it is not shown.
 *
 * The model is asked to cite a reference for every statement, and this is
 * what happens when it does not. A statement citing nothing is discarded
 * rather than shown with a caveat, because a caveat beside a plausible
 * sentence is read as a formality and the sentence is read as a finding.
 *
 * A citation also has to name a reference that was actually sent. A model
 * that invents "F-007" has invented a finding, and that is the single most
 * dangerous thing it can do in an evidentiary platform: it would look exactly
 * like a traceable statement.
 */
export function keepOnlyGrounded(
  suggestion: { statements: Array<{ text: string; cites: string[] }>; notes?: string | null },
  available: string[],
): Suggestion {
  const known = new Set(available.map((reference) => reference.toUpperCase()));
  const statements: Suggestion["statements"] = [];
  const discarded: string[] = [];

  for (const statement of suggestion.statements) {
    const cites = statement.cites
      .map((reference) => reference.trim().toUpperCase())
      .filter((reference) => known.has(reference));

    if (cites.length === 0) {
      discarded.push(statement.text);
      continue;
    }
    statements.push({ text: statement.text, cites });
  }

  return { statements, discarded, notes: suggestion.notes ?? null };
}

/**
 * Refuses a request there is nothing to answer from.
 *
 * Called before anything is sent. Asking a model to answer from no passages
 * is asking it to answer from its training data, which in this platform is
 * the definition of an ungrounded answer.
 */
export function assertSomethingToGroundOn(passages: Passage[]): void {
  if (passages.length > 0) return;

  throw new AiError(
    "nothing_to_ground_on",
    "There is nothing on this case that may be sent to answer that. Either the case has no records matching it yet, or everything that matches is above INTERNAL and PRD 22.4 keeps it here. The assistant will not answer from anything but the case's own records.",
  );
}

/* --------------------------------------------------------------- quotas */

/**
 * PRD 22.1: one user cannot exhaust the shared free allowance.
 *
 * Daily rather than per-minute, and per user AND per case. The per-user limit
 * is the fairness one; the per-case limit is the one that stops a single
 * investigation from consuming the firm's day, which is the more likely
 * accident. Both are generous enough that somebody working normally never
 * meets them and low enough that a loop does.
 *
 * Numbers chosen against the free tiers PRD 22.1 tabulates: roughly 200
 * requests a day across all providers is the conservative floor, so fifty per
 * person and eighty per case leaves room for several people working at once.
 */
export const DAILY_JOBS_PER_USER = 50;
export const DAILY_JOBS_PER_CASE = 80;

export function assertWithinQuota(used: { byUser: number; byCase: number }): void {
  if (used.byUser >= DAILY_JOBS_PER_USER) {
    throw new AiError(
      "quota_exceeded",
      `You have used today's ${DAILY_JOBS_PER_USER} AI requests. The free provider allowances are shared across PDDC, so this limit is what stops one person's day from being everybody's. It resets at midnight UTC.`,
      { limit: DAILY_JOBS_PER_USER, used: used.byUser, scope: "user" },
    );
  }

  if (used.byCase >= DAILY_JOBS_PER_CASE) {
    throw new AiError(
      "quota_exceeded",
      `This case has used today's ${DAILY_JOBS_PER_CASE} AI requests. It resets at midnight UTC.`,
      { limit: DAILY_JOBS_PER_CASE, used: used.byCase, scope: "case" },
    );
  }
}

/* ------------------------------------------------- the router's decisions */

/**
 * Whether a provider may be tried right now (PRD 22.1 circuit breaker).
 *
 * A free tier that has just answered 429 will answer 429 again, so trying it
 * is worse than skipping it: it spends a request from an allowance that is
 * already exhausted and delays the fallback that would have worked.
 */
export function providerIsAvailable(
  provider: { isEnabled: boolean; nextAttemptAt: string | null },
  now = Date.now(),
): boolean {
  if (!provider.isEnabled) return false;
  if (!provider.nextAttemptAt) return true;
  return new Date(provider.nextAttemptAt).getTime() <= now;
}

/**
 * How long to shut a provider out for after a failure.
 *
 * One, four and sixteen minutes, then an hour. Free tiers reset on the minute
 * and on the day, so the early steps are short enough to catch a per-minute
 * limit lifting, and the cap is long enough not to hammer a provider whose
 * daily allowance has gone.
 */
export function breakerDelayMs(consecutiveFailures: number): number {
  const steps = [60_000, 4 * 60_000, 16 * 60_000];
  // Clamping the INDEX into the steps was the first version, and it never
  // reached the cap: a fourth failure resolved to the last step rather than
  // to the hour, so a provider whose daily allowance had gone was retried
  // every sixteen minutes for the rest of the day. The clamp belongs on the
  // decision, not on the lookup.
  if (consecutiveFailures > steps.length) return 60 * 60_000;
  return steps[Math.max(consecutiveFailures, 1) - 1];
}

/**
 * Whether a provider failure is worth moving on from, or worth giving up on.
 *
 * A 429 or a 5xx is the provider's problem and the next one may work. A 400
 * is ours: the request was malformed, and sending the same malformed request
 * to three more providers would produce three more identical refusals and
 * spend three more requests of a free allowance.
 */
export function shouldTryNextProvider(status: number | undefined): boolean {
  if (status === undefined) return true;
  if (status === 408 || status === 429) return true;
  return status >= 500;
}

/* ----------------------------------------------------- the prompt itself */

/**
 * The prompt version.
 *
 * Part of the cache key, so changing anything below invalidates every answer
 * the old wording produced rather than mixing two generations of output.
 * Bump it whenever the system prompt changes, including a change that looks
 * cosmetic: a different instruction is a different answer.
 */
export const PROMPT_VERSION = "pddc-assist-1";

/**
 * The system prompt.
 *
 * Short, and it does not try to do the work the gateway already does. There
 * is nothing here asking the model to protect confidential material, because
 * confidential material is not in the request: the classification gate kept
 * it out, which is a guarantee rather than an instruction. What is left is
 * the part only the model can do, which is to stay inside what it was given
 * and to say where each sentence came from.
 */
export const SYSTEM_PROMPT = [
  "You assist investigators at a corporate investigation firm.",
  "",
  "Answer ONLY from the numbered passages supplied with the question. They are the entire body of material you may use. If they do not answer it, say so plainly and stop.",
  "",
  "Every sentence you write must cite the reference of the passage it comes from, in square brackets, for example [F-001] or [EV-2026-000014-001]. A sentence you cannot cite is a sentence you must not write.",
  "",
  "Do not infer, conclude or speculate beyond what a passage states. You are suggesting, never asserting: a human investigator decides what becomes a finding.",
  "",
  "Some names and numbers have been replaced with tokens such as [PERSON_1] or [ACCOUNT_2]. Use the tokens exactly as they appear. Do not guess what they stand for.",
  "",
  "Answer only about this case and the firm's procedures. Decline anything else in one sentence.",
  "",
  "Reply as JSON: {\"statements\":[{\"text\":\"...\",\"cites\":[\"F-001\"]}],\"notes\":\"optional\"}",
].join("\n");

/** PRD 22.1 token discipline: a per-call budget, not an open tap. */
export const MAX_OUTPUT_TOKENS = 700;
export const MAX_PASSAGE_CHARS = 1_200;
export const MAX_PASSAGES = 12;

/**
 * Builds the request, and is the only way to make a `Sendable`.
 *
 * Every protection is applied here, in one place, in this order: the gate
 * refuses anything above INTERNAL, the passages are trimmed to a budget, and
 * the redactor substitutes what is left. A caller cannot skip a step because
 * there is no other path to the type the transport accepts.
 */
export function buildRequest(input: {
  question: string;
  passages: Passage[];
  knownNames: Array<{ name: string; kind: Redaction["kind"] }>;
}): { sendable: Sendable; redactions: Redaction[]; cited: string[] } {
  assertSomethingToGroundOn(input.passages);
  assertNothingAboveInternal(input.passages);

  const passages = input.passages.slice(0, MAX_PASSAGES);
  const redactions: Redaction[] = [];
  const seen = new Map<string, Redaction>();

  const numbered = passages.map((passage, index) => {
    const trimmed = passage.text.slice(0, MAX_PASSAGE_CHARS);
    const result = redact(trimmed, input.knownNames);

    // One map across the whole request, so the same name is the same token in
    // every passage. Two passages about one person must not look like two
    // people.
    for (const redaction of result.redactions) {
      const already = seen.get(redaction.original.toLowerCase());
      if (already) {
        result.text = result.text.split(redaction.token).join(already.token);
        continue;
      }
      seen.set(redaction.original.toLowerCase(), redaction);
      redactions.push(redaction);
    }

    return `[${index + 1}] reference ${passage.reference} (${passage.recordType})\n${result.text}`;
  });

  const questionResult = redact(input.question, input.knownNames);
  for (const redaction of questionResult.redactions) {
    if (!seen.has(redaction.original.toLowerCase())) {
      seen.set(redaction.original.toLowerCase(), redaction);
      redactions.push(redaction);
    }
  }

  const highest = passages.some((passage) => passage.classification === "INTERNAL")
    ? "INTERNAL"
    : "PUBLIC";

  return {
    sendable: {
      system: SYSTEM_PROMPT,
      user: [
        `Question: ${questionResult.text}`,
        "",
        "Passages:",
        ...numbered,
      ].join("\n"),
      classification: highest,
      redactionCount: redactions.length,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    },
    redactions,
    cited: passages.map((passage) => passage.reference),
  };
}

/**
 * Reads what the model sent back.
 *
 * Tolerant about the envelope and strict about the content. A model that
 * wraps its JSON in prose, or in a fenced code block, has still answered; a
 * model whose statements cite nothing has not, and `keepOnlyGrounded` throws
 * those away. Returning an empty suggestion rather than an error is correct:
 * "the model produced nothing usable" is an answer the screen can show, and
 * it is the honest one.
 */
export function parseSuggestion(raw: string, available: string[]): Suggestion {
  const json = extractJson(raw);

  if (!json) {
    return {
      statements: [],
      discarded: [raw.slice(0, 2_000)],
      notes: "The model did not reply in the requested format.",
    };
  }

  const statements = Array.isArray(json.statements) ? json.statements : [];

  return keepOnlyGrounded(
    {
      statements: statements
        .filter(
          (entry): entry is { text: string; cites: unknown } =>
            typeof entry === "object" &&
            entry !== null &&
            typeof (entry as { text?: unknown }).text === "string",
        )
        .map((entry) => ({
          text: entry.text,
          cites: Array.isArray(entry.cites)
            ? entry.cites.filter(
                (reference): reference is string => typeof reference === "string",
              )
            : [],
        })),
      notes: typeof json.notes === "string" ? json.notes : null,
    },
    available,
  );
}

function extractJson(
  raw: string,
): { statements?: unknown[]; notes?: unknown } | null {
  const trimmed = raw.trim();

  // The whole reply, a fenced block, or the first brace-delimited object in
  // it. Three attempts rather than one, because all three happen.
  const candidates = [
    trimmed,
    trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""),
    trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1),
  ];

  for (const candidate of candidates) {
    if (!candidate.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed === "object" && parsed !== null) {
        return parsed as { statements?: unknown[]; notes?: unknown };
      }
    } catch {
      // Next candidate.
    }
  }

  return null;
}
