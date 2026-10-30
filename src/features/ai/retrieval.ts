import "server-only";
import type { Actor } from "@/lib/auth/session";
import { gateByClassification, type RetrievalPort } from "@/modules/ai";
import { evidence } from "@/modules/evidence";
import { intel } from "@/modules/intel";

/**
 * What the assistant is allowed to read (PRD 22.3 "grounded answers only").
 *
 * This lives in the feature layer rather than in the ai module, and the
 * reason is both architectural and practical. Architecturally, grounding
 * needs four other bounded contexts and a module may not reach into
 * another's internals, so the ai module declares a port and this supplies it.
 * Practically, that means retrieval runs through the SAME repositories the
 * screens use, under the asker's own actor, so the assistant can never ground
 * an answer in a record its user could not open. An index built for AI would
 * have had to re-implement assignment, clearance and classification in its
 * own filter, and the day that drifted it would disclose the one thing this
 * platform exists to protect.
 *
 * WHAT IT RETRIEVES, and why in this order. Findings first, because a finding
 * is the firm's own conclusion and the most useful thing to answer from.
 * Then information, which is what a source said. Then evidence and document
 * descriptions, which are metadata rather than content: the files themselves
 * are never sent, which PRD 22.4 requires in as many words.
 *
 * SELECTION IS BY THE PLATFORM'S OWN SEARCH, not by a vector index. The
 * question's words are put through the same `search` filter the screens use,
 * which is a real full-text match over the records the asker can see. It is
 * less clever than embeddings and it has two properties embeddings would
 * cost: nothing has to be sent to a provider to compute it, and every passage
 * returned is one the user could have found themselves.
 */

/** Words too common to narrow anything, and too common to be a name. */
const STOP_WORDS = new Set([
  "what", "which", "when", "where", "who", "whom", "whose", "why", "how",
  "the", "a", "an", "and", "or", "but", "if", "then", "than", "that", "this",
  "these", "those", "is", "are", "was", "were", "be", "been", "being", "do",
  "does", "did", "have", "has", "had", "can", "could", "should", "would",
  "will", "shall", "may", "might", "must", "of", "in", "on", "at", "to",
  "for", "with", "about", "from", "by", "as", "it", "its", "any", "all",
  "there", "here", "we", "us", "our", "they", "them", "their", "me", "my",
  "you", "your", "he", "she", "his", "her", "him", "not", "no", "yes",
  "case", "evidence", "finding", "findings", "please", "tell", "show",
]);

/**
 * Turns a question into search terms.
 *
 * The longest words first, because a long word in a question is almost always
 * the subject of it: "warehouse" narrows, "the" does not. Three terms at
 * most, because each one is a separate search and the free database is in
 * another region.
 */
export function termsFrom(question: string): string[] {
  const words = question
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !STOP_WORDS.has(word));

  const unique = [...new Set(words)];
  unique.sort((a, b) => b.length - a.length);
  return unique.slice(0, 3);
}

const PER_TERM = 4;

export function createRetrieval(actor: Actor): RetrievalPort {
  return {
    async passagesFor({ caseId, question, limit = 12 }) {
      const terms = termsFrom(question);
      const intelligence = intel(actor);
      const files = evidence(actor);

      // Nothing matched a word in the question: fall back to the case's most
      // recent records rather than to nothing. A question whose words appear
      // nowhere is usually a general one ("what is the position on this
      // case"), and the honest answer to that is the latest findings.
      const searches = terms.length > 0 ? terms : [undefined];

      const found = await Promise.all(
        searches.flatMap((term) => [
          intelligence.findings
            .list({ caseId, search: term, limit: PER_TERM })
            .then((page) =>
              page.rows.map((row) => ({
                recordType: "finding" as const,
                recordId: row.id,
                reference: row.findingId,
                classification: row.classification,
                text: row.statement,
              })),
            ),
          intelligence.information
            .list({ caseId, search: term, limit: PER_TERM })
            .then((page) =>
              page.rows.map((row) => ({
                recordType: "information" as const,
                recordId: row.id,
                reference: row.informationId,
                classification: row.classification,
                text: row.description,
              })),
            ),
          files.items
            .list({ caseId, search: term, limit: PER_TERM })
            .then((page) =>
              page.rows.map((row) => ({
                recordType: "evidence" as const,
                recordId: row.id,
                reference: row.evidenceId,
                classification: row.classification,
                // The DESCRIPTION, never the file. PRD 22.4 blocks evidence
                // files from leaving, and this is where that is true rather
                // than merely intended.
                text: row.description,
              })),
            ),
          files.documents
            .list({ caseId, search: term, limit: PER_TERM })
            .then((page) =>
              page.rows.map((row) => ({
                recordType: "document" as const,
                recordId: row.id,
                reference: row.documentId,
                classification: row.classification,
                // A document has a title and a type and no prose of its own;
                // the content is in its versions, which are files and never
                // leave (PRD 22.4).
                text: `${row.title} (${row.documentType.replace(/_/g, " ")})`,
              })),
            ),
        ]),
      );

      // One passage per record however many terms matched it, and the first
      // match wins so the longest, most specific term's results come first.
      const seen = new Set<string>();
      const all = found.flat().filter((passage) => {
        if (passage.text.trim().length === 0) return false;
        if (seen.has(passage.recordId)) return false;
        seen.add(passage.recordId);
        return true;
      });

      const { sendable, withheld } = gateByClassification(all);

      // The names the redactor substitutes, read from the case's own subject
      // register rather than guessed at by pattern. This is why redaction
      // here is reliable where a general-purpose anonymiser would not be: the
      // platform knows exactly who is on the case.
      const subjects = await intelligence.entities.list({
        caseId,
        limit: 200,
      });

      const knownNames = subjects.rows.flatMap((entity) => {
        // Only `person` is a person. Director, shareholder and beneficial
        // owner are RELATIONSHIP types in PRD 15, not entity types, so an
        // entity holding one of those roles is still a person or a company
        // in its own right.
        const kind =
          entity.entityType === "person"
            ? ("person" as const)
            : ("organisation" as const);

        // The aliases too, and this is not a nicety: PRD 8.3's conflict
        // screening exists precisely because people appear under more than
        // one name, so a redactor that caught only the primary one would
        // leave the alias in the clear.
        return [
          { name: entity.name, kind },
          ...entity.aliases.map((alias) => ({ name: alias.alias, kind })),
        ];
      });

      return {
        passages: sendable.slice(0, limit),
        knownNames,
        withheld,
      };
    },
  };
}
