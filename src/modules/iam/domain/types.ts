import type { ClassificationLevel } from "./classification";

/** Lifecycle of an IIMS user record (PRD 3.3). */
export const USER_STATUSES = [
  "invited",
  "active",
  "suspended",
  "deactivated",
  "archived",
] as const;

export type UserStatus = (typeof USER_STATUSES)[number];

export const USER_STATUS_LABELS: Record<UserStatus, string> = {
  invited: "Invited",
  active: "Active",
  suspended: "Suspended",
  deactivated: "Deactivated",
  archived: "Archived",
};

/**
 * Permitted status transitions. A status change that is not listed here is
 * rejected by the domain, so the lifecycle cannot be short-circuited.
 */
const STATUS_TRANSITIONS: Record<UserStatus, readonly UserStatus[]> = {
  invited: ["active", "deactivated", "archived"],
  active: ["suspended", "deactivated", "archived"],
  suspended: ["active", "deactivated", "archived"],
  deactivated: ["active", "archived"],
  archived: [],
};

export function canTransitionUserStatus(from: UserStatus, to: UserStatus): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}

export function allowedUserStatusTransitions(from: UserStatus): readonly UserStatus[] {
  return STATUS_TRANSITIONS[from];
}

/** The eleven actions a permission can carry (PRD 3.3). */
export const PERMISSION_ACTIONS = [
  "view",
  "create",
  "edit",
  "upload",
  "download",
  "share",
  "approve",
  "delete",
  "export",
  "assign",
  "configure",
] as const;

export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

/** Scopes, narrowest to broadest (PRD 3.3). */
export const PERMISSION_SCOPES = [
  "own",
  "assigned",
  "team",
  "department",
  "office",
  "country",
  "all",
] as const;

export type PermissionScope = (typeof PERMISSION_SCOPES)[number];

export const SCOPE_LABELS: Record<PermissionScope, string> = {
  own: "Own records",
  assigned: "Assigned",
  team: "Team",
  department: "Department",
  office: "Office",
  country: "Country",
  all: "All",
};

export function scopeRank(scope: PermissionScope): number {
  return PERMISSION_SCOPES.indexOf(scope) + 1;
}

/**
 * Resources the permission builder knows about (PRD 3.3).
 *
 * This list drives the admin interface only. Authorization itself never
 * validates against it, because the Administrator wildcard must keep working
 * for modules added later.
 */
export const PERMISSION_RESOURCES = [
  "profile",
  "notifications",
  "users",
  "clients",
  "engagements",
  "conflicts",
  "cases",
  "entities",
  "plans",
  "tasks",
  "sources",
  "information",
  "evidence",
  "custody",
  "documents",
  "findings",
  "reports",
  "qa",
  "financials",
  "time",
  "audit",
  "settings",
  "dashboards",
] as const;

export type PermissionResource = (typeof PERMISSION_RESOURCES)[number] | string;

export interface Permission {
  id: string;
  resource: string;
  action: PermissionAction | "*";
  scope: PermissionScope;
  classificationCeiling: ClassificationLevel;
  description: string | null;
}

/** One resolved permission, with the role or override that produced it. */
export interface EffectivePermission {
  resource: string;
  action: string;
  scope: PermissionScope;
  classificationCeiling: ClassificationLevel;
  /** "role:supervisor" or "override:allow", for the "why can they?" viewer. */
  source: string;
}

export interface Role {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isBaseline: boolean;
  isAdministrator: boolean;
  isActive: boolean;
  version: number;
  memberCount?: number;
  permissionCount?: number;
}

export const ROLE_SCOPE_TYPES = [
  "all",
  "office",
  "country",
  "department",
  "team",
  "case",
] as const;

export type RoleScopeType = (typeof ROLE_SCOPE_TYPES)[number];

export interface RoleAssignment {
  id: string;
  userId: string;
  roleId: string;
  roleKey: string;
  roleName: string;
  scopeType: RoleScopeType;
  scopeId: string | null;
  isPrimary: boolean;
  validFrom: string;
  validTo: string | null;
  reason: string | null;
}

export interface IamUser {
  id: string;
  /** From the shared directory (public.profiles), owned by the website. */
  fullName: string | null;
  email: string;
  photoPath: string | null;
  employeeId: string | null;
  workPhone: string | null;
  jobTitle: string | null;
  officeId: string | null;
  officeName: string | null;
  departmentId: string | null;
  departmentName: string | null;
  countryCode: string | null;
  clearance: ClassificationLevel;
  status: UserStatus;
  permissionsVersion: number;
  failedLoginCount: number;
  lockedUntil: string | null;
  sessionTimeoutMinutes: number;
  mfaEnrolledAt: string | null;
  lastSeenAt: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  deletedAt: string | null;
  roles: RoleAssignment[];
}

/** A person in the shared directory who has no IIMS account yet. */
export interface ProvisionableProfile {
  id: string;
  email: string;
  fullName: string | null;
  websiteRole: string | null;
}

export const ACCESS_REQUEST_KINDS = [
  "grant_administrator",
  "grant_strictly_restricted",
  "grant_delete",
  "grant_export_all",
  "change_audit_settings",
  "change_retention",
  "purge_record",
  "remove_administrator",
] as const;

export type AccessRequestKind = (typeof ACCESS_REQUEST_KINDS)[number];

export const ACCESS_REQUEST_LABELS: Record<AccessRequestKind, string> = {
  grant_administrator: "Grant the Administrator role",
  grant_strictly_restricted: "Grant Strictly Restricted clearance",
  grant_delete: "Grant delete permission",
  grant_export_all: "Grant export-all permission",
  change_audit_settings: "Change audit settings",
  change_retention: "Change retention rules",
  purge_record: "Permanently purge a record",
  remove_administrator: "Remove the Administrator role",
};

export interface AccessChangeRequest {
  id: string;
  kind: AccessRequestKind;
  targetUserId: string | null;
  targetUserName: string | null;
  targetRecord: string | null;
  payload: Record<string, unknown>;
  reason: string;
  requestedBy: string;
  requestedByName: string | null;
  requestedAt: string;
  status: "pending" | "approved" | "rejected" | "applied" | "expired";
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  expiresAt: string;
}

export interface Feature {
  key: string;
  name: string;
  description: string | null;
  isActive: boolean;
}

export interface AuditEntry {
  auditId: string;
  seq: string;
  actorUserId: string | null;
  actorEmail: string | null;
  action: string;
  occurredAt: string;
  recordType: string | null;
  recordId: string | null;
  caseId: string | null;
  ip: string | null;
  userAgent: string | null;
  beforeValue: unknown;
  afterValue: unknown;
  reason: string | null;
  correlationId: string | null;
  classification: string | null;
  prevHash: string;
  rowHash: string;
}
