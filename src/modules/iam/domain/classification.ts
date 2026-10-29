/**
 * Information classification (PRD 7.4).
 *
 * A leaf module with zero imports, so both the domain layer and the database
 * client can depend on it without creating a cycle.
 *
 * "A user must hold both the role permission and the clearance for the
 *  classification to open an item."
 */

export const CLASSIFICATION_LEVELS = [
  "PUBLIC",
  "INTERNAL",
  "CONFIDENTIAL",
  "RESTRICTED",
  "STRICTLY_RESTRICTED",
] as const;

export type ClassificationLevel = (typeof CLASSIFICATION_LEVELS)[number];

const RANK: Record<ClassificationLevel, number> = {
  PUBLIC: 1,
  INTERNAL: 2,
  CONFIDENTIAL: 3,
  RESTRICTED: 4,
  STRICTLY_RESTRICTED: 5,
};

export const CLASSIFICATION_LABELS: Record<ClassificationLevel, string> = {
  PUBLIC: "Public",
  INTERNAL: "Internal",
  CONFIDENTIAL: "Confidential",
  RESTRICTED: "Restricted",
  STRICTLY_RESTRICTED: "Strictly Restricted",
};

export function isClassificationLevel(value: unknown): value is ClassificationLevel {
  return typeof value === "string" && value in RANK;
}

export function classificationRank(level: ClassificationLevel): number {
  return RANK[level];
}

/** True when `held` is sufficient to open an item classified `required`. */
export function clearsClassification(
  held: ClassificationLevel,
  required: ClassificationLevel,
): boolean {
  return RANK[held] >= RANK[required];
}

/**
 * The highest classification that may be sent to a third-party AI provider
 * (PRD 22.4). Anything above INTERNAL is blocked at the gateway, server-side.
 */
export const AI_EGRESS_CEILING: ClassificationLevel = "INTERNAL";

export function mayLeaveForAi(level: ClassificationLevel): boolean {
  return clearsClassification(AI_EGRESS_CEILING, level);
}
