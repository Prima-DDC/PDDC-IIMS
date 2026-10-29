/**
 * The client-safe half of the IAM module.
 *
 * Types, constants and pure rules only. No "server-only" marker, no database
 * client, no SDK, so a client component can import this without dragging
 * postgres into the browser bundle.
 *
 * The server-side half (the `iam()` factory and the repositories) lives in
 * ./index.ts, which re-exports everything here so server code needs one
 * import rather than two.
 *
 * Client components import from "@/modules/iam/shared"; server code imports
 * from "@/modules/iam".
 */

export {
  AI_EGRESS_CEILING,
  CLASSIFICATION_LABELS,
  CLASSIFICATION_LEVELS,
  classificationRank,
  clearsClassification,
  isClassificationLevel,
  mayLeaveForAi,
  type ClassificationLevel,
} from "./domain/classification";

export {
  ACCESS_REQUEST_KINDS,
  ACCESS_REQUEST_LABELS,
  PERMISSION_ACTIONS,
  PERMISSION_RESOURCES,
  PERMISSION_SCOPES,
  ROLE_SCOPE_TYPES,
  SCOPE_LABELS,
  USER_STATUS_LABELS,
  USER_STATUSES,
  allowedUserStatusTransitions,
  canTransitionUserStatus,
  scopeRank,
  type AccessChangeRequest,
  type AccessRequestKind,
  type AuditEntry,
  type EffectivePermission,
  type Feature,
  type IamUser,
  type Permission,
  type PermissionAction,
  type PermissionResource,
  type PermissionScope,
  type ProvisionableProfile,
  type Role,
  type RoleAssignment,
  type RoleScopeType,
  type UserStatus,
} from "./domain/types";

export {
  IAM_ERROR_STATUS,
  IamError,
  isIamError,
  type IamErrorCode,
} from "./domain/errors";

export {
  applyDenyOverrides,
  assertCompatibleRoles,
  assertNotSelfApproval,
  assertNotSelfApprovalOfWork,
  assertRoleIsRemovable,
  assertRoleNotInUse,
  assertUserStatusTransition,
  classifyHighRiskChange,
  explainPermission,
  findIncompatibleRolePair,
  isSelfPrivilegeEscalation,
  requiresSecondApproval,
  type PermissionExplanation,
} from "./domain/policies";
