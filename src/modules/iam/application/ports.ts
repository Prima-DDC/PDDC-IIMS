import type { ClassificationLevel } from "../domain/classification";
import type {
  AccessChangeRequest,
  AccessRequestKind,
  AuditEntry,
  EffectivePermission,
  Feature,
  IamUser,
  Permission,
  PermissionScope,
  Role,
  RoleScopeType,
  UserStatus,
} from "../domain/types";

/**
 * Ports: what the application layer needs from the outside world, expressed as
 * interfaces so the use cases never import a concrete adapter (PRD 21.1,
 * "repository pattern for persistence, ports and adapters for external
 * services, so providers can be swapped").
 *
 * Implementations live in ../infrastructure and are wired together in the
 * module's index.ts, which is the composition root.
 */

export interface ListUsersFilter {
  search?: string;
  status?: UserStatus | "all";
  roleKey?: string;
  officeId?: string;
  departmentId?: string;
  clearance?: ClassificationLevel;
  /** Include soft-deleted rows. Used by the recycle bin. */
  includeDeleted?: boolean;
  onlyDeleted?: boolean;
  limit?: number;
  offset?: number;
  sort?: "name" | "status" | "created" | "last_seen";
  direction?: "asc" | "desc";
}

export interface Page<T> {
  rows: T[];
  total: number;
}

export interface CreateUserInput {
  /** Existing auth.users id, for provisioning someone already in the directory. */
  userId: string;
  employeeId?: string | null;
  workPhone?: string | null;
  jobTitle?: string | null;
  officeId?: string | null;
  departmentId?: string | null;
  countryCode?: string | null;
  clearance: ClassificationLevel;
  status: UserStatus;
  sessionTimeoutMinutes?: number;
  notes?: string | null;
  roleIds: string[];
}

export interface UpdateUserInput {
  employeeId?: string | null;
  workPhone?: string | null;
  jobTitle?: string | null;
  officeId?: string | null;
  departmentId?: string | null;
  countryCode?: string | null;
  clearance?: ClassificationLevel;
  sessionTimeoutMinutes?: number;
  notes?: string | null;
  /** Optimistic concurrency (PRD 21.7). */
  expectedVersion: number;
}

export interface UserRepository {
  list(filter: ListUsersFilter): Promise<Page<IamUser>>;
  findById(id: string): Promise<IamUser | null>;
  create(input: CreateUserInput): Promise<IamUser>;
  update(id: string, input: UpdateUserInput): Promise<IamUser>;
  setStatus(id: string, status: UserStatus, reason: string): Promise<IamUser>;
  /** Clears the failed-attempt counter and the lockout. */
  unlock(id: string, reason: string): Promise<void>;
  softDelete(id: string, reason: string): Promise<void>;
  restore(id: string, reason: string): Promise<void>;

  assignRole(input: {
    userId: string;
    roleId: string;
    scopeType: RoleScopeType;
    scopeId?: string | null;
    isPrimary?: boolean;
    validFrom?: string | null;
    validTo?: string | null;
    reason?: string | null;
  }): Promise<void>;
  removeRole(assignmentId: string, reason: string): Promise<void>;
  setPrimaryRole(userId: string, assignmentId: string): Promise<void>;

  effectivePermissions(userId: string): Promise<EffectivePermission[]>;
  roleIdsOf(userId: string): Promise<string[]>;

  listOverrides(userId: string): Promise<
    Array<{
      id: string;
      permissionId: string;
      resource: string;
      action: string;
      scope: PermissionScope;
      classificationCeiling: ClassificationLevel;
      effect: "allow" | "deny";
      reason: string;
      expiresAt: string | null;
      grantedAt: string;
    }>
  >;
  addOverride(input: {
    userId: string;
    permissionId: string;
    effect: "allow" | "deny";
    reason: string;
    expiresAt?: string | null;
  }): Promise<void>;
  removeOverride(id: string, reason: string): Promise<void>;

  listFeatureOverrides(userId: string): Promise<
    Array<{ featureKey: string; enabled: boolean; reason: string; expiresAt: string | null }>
  >;
  setFeatureOverride(input: {
    userId: string;
    featureKey: string;
    enabled: boolean;
    reason: string;
    expiresAt?: string | null;
  }): Promise<void>;
  clearFeatureOverride(userId: string, featureKey: string): Promise<void>;

  sessions(userId: string): Promise<
    Array<{
      sessionId: string;
      createdAt: string;
      updatedAt: string | null;
      notAfter: string | null;
      userAgent: string | null;
      ip: string | null;
    }>
  >;
  /** Deletes the user's sessions and refresh tokens. Returns how many. */
  revokeAllSessions(userId: string, reason: string): Promise<number>;
  revokeSession(sessionId: string, reason: string): Promise<boolean>;
  /** Refreshes mfa_enrolled_at from the user's verified Supabase factors. */
  syncMfaEnrolment(userId: string): Promise<string | null>;

  loginHistory(userId: string, limit: number): Promise<
    Array<{
      id: string;
      succeeded: boolean;
      failureKind: string | null;
      ip: string | null;
      userAgent: string | null;
      attemptedAt: string;
    }>
  >;

  /** People in the shared directory, with whether they have IIMS access. */
  directory(input: {
    search?: string;
    onlyUnlinked?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<
    Page<{
      userId: string;
      email: string;
      fullName: string | null;
      websiteRole: string | null;
      iimsStatus: UserStatus | null;
      iimsClearance: ClassificationLevel | null;
      hasIimsAccess: boolean;
    }>
  >;

  /** Counts for the admin landing page. */
  stats(): Promise<{
    total: number;
    active: number;
    invited: number;
    suspended: number;
    deactivated: number;
    deleted: number;
    lockedOut: number;
    withoutMfa: number;
    administrators: number;
  }>;
}

export interface RoleRepository {
  list(includeInactive: boolean): Promise<Role[]>;
  findById(id: string): Promise<Role | null>;
  findByKey(key: string): Promise<Role | null>;
  create(input: {
    key: string;
    name: string;
    description?: string | null;
    isAdministrator?: boolean;
  }): Promise<Role>;
  update(
    id: string,
    input: {
      name?: string;
      description?: string | null;
      isActive?: boolean;
      expectedVersion: number;
      reason: string;
    },
  ): Promise<Role>;
  clone(id: string, key: string, name: string): Promise<Role>;
  remove(id: string, reason: string): Promise<void>;
  memberCount(id: string): Promise<number>;
  members(id: string): Promise<Array<{ userId: string; fullName: string | null; email: string }>>;

  permissionsOf(roleId: string): Promise<Permission[]>;
  setPermissions(roleId: string, permissionIds: string[], reason: string): Promise<void>;

  featuresOf(roleId: string): Promise<Array<{ featureKey: string; enabled: boolean }>>;
  setFeatures(roleId: string, enabledKeys: string[]): Promise<void>;

  versions(roleId: string): Promise<
    Array<{
      id: string;
      version: number;
      reason: string;
      beforeValue: unknown;
      afterValue: unknown;
      changedBy: string | null;
      changedAt: string;
    }>
  >;
  rollback(roleId: string, versionId: string, reason: string): Promise<Role>;

  incompatibilities(): Promise<
    Array<{ roleAId: string; roleBId: string; roleAName: string; roleBName: string; reason: string }>
  >;
  addIncompatibility(roleAId: string, roleBId: string, reason: string): Promise<void>;
  removeIncompatibility(roleAId: string, roleBId: string): Promise<void>;
}

export interface PermissionRepository {
  list(filter?: { resource?: string; action?: string }): Promise<Permission[]>;
  ensure(input: {
    resource: string;
    action: string;
    scope: PermissionScope;
    classificationCeiling: ClassificationLevel;
    description?: string | null;
  }): Promise<Permission>;
  remove(id: string): Promise<void>;
  /** Distinct resources currently present, for the builder's pickers. */
  resources(): Promise<string[]>;
}

export interface FeatureRepository {
  list(): Promise<Feature[]>;
  upsert(input: {
    key: string;
    name: string;
    description?: string | null;
    isActive?: boolean;
  }): Promise<Feature>;
  remove(key: string): Promise<void>;
}

export interface AccessRequestRepository {
  list(filter: { status?: string; limit?: number }): Promise<AccessChangeRequest[]>;
  findById(id: string): Promise<AccessChangeRequest | null>;
  create(input: {
    kind: AccessRequestKind;
    targetUserId?: string | null;
    targetRecord?: string | null;
    payload: Record<string, unknown>;
    reason: string;
  }): Promise<AccessChangeRequest>;
  decide(input: {
    id: string;
    approve: boolean;
    note?: string | null;
  }): Promise<AccessChangeRequest>;
  markApplied(id: string): Promise<void>;
}

export interface OrgRepository {
  countries(): Promise<Array<{ code: string; name: string; isActive: boolean }>>;
  offices(): Promise<
    Array<{ id: string; code: string; name: string; countryCode: string; timezone: string; isActive: boolean }>
  >;
  departments(): Promise<Array<{ id: string; code: string; name: string; isActive: boolean }>>;
  classificationLevels(): Promise<
    Array<{ code: string; name: string; rank: number; description: string | null }>
  >;

  createCountry(input: { code: string; name: string; residencyNote?: string | null }): Promise<void>;
  updateCountry(code: string, input: { name?: string; isActive?: boolean }): Promise<void>;
  createOffice(input: {
    code: string;
    name: string;
    countryCode: string;
    timezone?: string;
  }): Promise<void>;
  updateOffice(
    id: string,
    input: { code?: string; name?: string; countryCode?: string; timezone?: string; isActive?: boolean },
  ): Promise<void>;
  removeOffice(id: string): Promise<void>;
  createDepartment(input: { code: string; name: string }): Promise<void>;
  updateDepartment(id: string, input: { code?: string; name?: string; isActive?: boolean }): Promise<void>;
  removeDepartment(id: string): Promise<void>;
}

export interface AuditRepository {
  read(filter: {
    caseId?: string | null;
    actorUserId?: string | null;
    action?: string | null;
    from?: string | null;
    to?: string | null;
    limit?: number;
    beforeSeq?: string | null;
  }): Promise<AuditEntry[]>;
  verifyChain(): Promise<{ checked: number; ok: boolean; firstBadSeq: string | null }>;
  distinctActions(): Promise<string[]>;
}

/**
 * Supabase Auth admin operations. Separate port because they are the only
 * things that legitimately need the service-role key, and because the whole
 * surface should be swappable if identity ever moves.
 */
export interface AuthAdminPort {
  invite(email: string, redirectTo: string): Promise<{ userId: string }>;
  /**
   * Blocks future sign-ins. Does NOT revoke live sessions, which is why
   * UserRepository exposes session revocation separately and the session layer
   * re-checks status on every request.
   */
  setBanned(userId: string, banned: boolean): Promise<void>;
  sendPasswordReset(email: string, redirectTo: string): Promise<void>;
  listMfaFactors(userId: string): Promise<Array<{ id: string; type: string; status: string }>>;
  deleteMfaFactor(userId: string, factorId: string): Promise<void>;
}
