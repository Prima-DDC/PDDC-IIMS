import "server-only";
import { requireActor } from "@/lib/auth/session";
import {
  explainPermission,
  iam,
  type ClassificationLevel,
} from "@/modules/iam";

/**
 * Read models for the administration screens.
 *
 * Kept separate from actions.ts so the read path stays free of mutation
 * concerns, matching the command/query split in PRD 21.1.
 */

export async function listUsers(params: {
  search?: string;
  status?: string;
  roleKey?: string;
  officeId?: string;
  departmentId?: string;
  page?: number;
  perPage?: number;
  onlyDeleted?: boolean;
}) {
  const actor = await requireActor();
  const perPage = Math.min(params.perPage ?? 25, 100);
  const page = Math.max(params.page ?? 1, 1);

  const result = await iam(actor).users.list({
    search: params.search,
    status: (params.status as "all" | undefined) ?? "all",
    roleKey: params.roleKey,
    officeId: params.officeId,
    departmentId: params.departmentId,
    onlyDeleted: params.onlyDeleted,
    limit: perPage,
    offset: (page - 1) * perPage,
  });

  return {
    ...result,
    page,
    perPage,
    pageCount: Math.max(1, Math.ceil(result.total / perPage)),
  };
}

/** Everything one user's detail page needs, in parallel. */
export async function getUserDetail(userId: string) {
  const actor = await requireActor();
  const api = iam(actor);

  const user = await api.users.findById(userId);
  if (!user) return null;

  const [
    permissions,
    overrides,
    featureOverrides,
    sessions,
    loginHistory,
    roles,
    allPermissions,
    features,
    offices,
    departments,
    countries,
    levels,
  ] = await Promise.all([
    api.users.effectivePermissions(userId),
    api.users.listOverrides(userId),
    api.users.listFeatureOverrides(userId),
    api.users.sessions(userId).catch(() => []),
    api.users.loginHistory(userId, 20),
    api.roles.list(false),
    api.permissions.list(),
    api.features.list(),
    api.org.offices(),
    api.org.departments(),
    api.org.countries(),
    api.org.classificationLevels(),
  ]);

  const isAdministrator = permissions.some(
    (p) => p.resource === "*" && p.action === "*",
  );

  return {
    user,
    permissions,
    overrides,
    featureOverrides,
    sessions,
    loginHistory,
    roles,
    allPermissions,
    features,
    offices,
    departments,
    countries,
    levels,
    isAdministrator,
  };
}

/**
 * Answers "why can or can't this user do X?", naming the role or override
 * responsible (PRD 3.2, the Effective Permissions viewer).
 */
export async function explainUserPermission(
  userId: string,
  resource: string,
  action: string,
  classification?: ClassificationLevel,
) {
  const actor = await requireActor();
  const api = iam(actor);

  const [user, permissions] = await Promise.all([
    api.users.findById(userId),
    api.users.effectivePermissions(userId),
  ]);

  if (!user) return null;

  const isAdministrator = permissions.some(
    (p) => p.resource === "*" && p.action === "*",
  );

  return explainPermission(permissions, {
    resource,
    action,
    classification,
    clearance: user.clearance,
    isAdministrator,
    status: user.status,
    lockedUntil: user.lockedUntil,
  });
}

/** The shared staff directory, for the provisioning screen. */
export async function listDirectory(params: {
  search?: string;
  onlyUnlinked?: boolean;
  page?: number;
}) {
  const actor = await requireActor();
  const perPage = 25;
  const page = Math.max(params.page ?? 1, 1);

  const result = await iam(actor).users.directory({
    search: params.search,
    onlyUnlinked: params.onlyUnlinked,
    limit: perPage,
    offset: (page - 1) * perPage,
  });

  return {
    ...result,
    page,
    perPage,
    pageCount: Math.max(1, Math.ceil(result.total / perPage)),
  };
}

/** Reference data the provisioning and edit forms need. */
export async function getFormOptions() {
  const actor = await requireActor();
  const api = iam(actor);

  const [roles, offices, departments, countries, levels] = await Promise.all([
    api.roles.list(false),
    api.org.offices(),
    api.org.departments(),
    api.org.countries(),
    api.org.classificationLevels(),
  ]);

  return { roles, offices, departments, countries, levels };
}

export async function getAdminStats() {
  const actor = await requireActor();
  return iam(actor).users.stats();
}
