import "server-only";
import type postgres from "postgres";
import { applyActorSettings, withActor, type ActorContext } from "@/lib/db/client";
import type { ClassificationLevel } from "../domain/classification";
import { IamError } from "../domain/errors";
import type {
  EffectivePermission,
  IamUser,
  RoleAssignment,
  UserStatus,
} from "../domain/types";
import type {
  CreateUserInput,
  ListUsersFilter,
  Page,
  UpdateUserInput,
  UserRepository,
} from "../application/ports";

/**
 * Postgres implementation of UserRepository.
 *
 * Every method opens its own transaction through withActor, so the actor's
 * identity is published for RLS and the audit triggers, and each operation is
 * atomic. Mutations call audit.write in the SAME transaction as the change,
 * which is what makes the trail impossible to desynchronise from the data.
 *
 * `existing` lets a caller supply a transaction to run inside instead. Tests
 * use it to drive the repository against fixtures in a transaction they then
 * roll back, so the shared production database is never written to. In the
 * application it is always omitted.
 */
export function createUserRepository(
  actor: ActorContext,
  existing?: postgres.TransactionSql,
): UserRepository {
  const tx = async <T>(
    work: (sql: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> => {
    if (!existing) return withActor(actor, work) as Promise<T>;
    // An injected transaction still has to carry the actor, or audit.write
    // and the RLS policies see an anonymous caller and refuse. Establishing
    // it here means the injected path behaves exactly like production.
    await applyActorSettings(existing, actor);
    return work(existing);
  };

  return {
    async list(filter: ListUsersFilter): Promise<Page<IamUser>> {
      const limit = Math.min(filter.limit ?? 25, 200);
      const offset = Math.max(filter.offset ?? 0, 0);

      return tx(async (sql) => {
        // public.profiles is NOT joined here. The website's RLS policy on that
        // table reads `id = auth.uid() or public.is_admin()`, and auth.uid()
        // is null on a direct Postgres connection, so the join silently
        // matched nothing and every name and email came back empty. The
        // directory is read through iam.profile_basics instead, and the search
        // term is matched against it (migration 0014).
        const rows = await sql<(UserRow & { total_count: string })[]>`
          with directory as (
            select user_id, email, full_name, photo_path
            from iam.profile_basics(
              (select coalesce(array_agg(id), '{}'::uuid[]) from iam.users)
            )
          ),
          filtered as (
            select u.*, dir.email, dir.full_name, dir.photo_path,
                   o.name as office_name, d.name as department_name
            from iam.users u
            left join directory dir on dir.user_id = u.id
            left join iam.offices o on o.id = u.office_id
            left join iam.departments d on d.id = u.department_id
            where (
                    ${filter.onlyDeleted ?? false} and u.deleted_at is not null
                    or ${filter.includeDeleted ?? false}
                    or (not ${filter.onlyDeleted ?? false} and u.deleted_at is null)
                  )
              and (${filter.status ?? "all"} = 'all' or u.status = ${filter.status ?? "all"})
              and (${filter.clearance ?? null}::text is null or u.clearance = ${filter.clearance ?? null})
              and (${filter.officeId ?? null}::uuid is null or u.office_id = ${filter.officeId ?? null}::uuid)
              and (${filter.departmentId ?? null}::uuid is null or u.department_id = ${filter.departmentId ?? null}::uuid)
              and (
                ${filter.search ?? null}::text is null
                or coalesce(dir.email, '') ilike '%' || ${filter.search ?? ""} || '%'
                or coalesce(dir.full_name, '') ilike '%' || ${filter.search ?? ""} || '%'
                or coalesce(u.employee_id, '') ilike '%' || ${filter.search ?? ""} || '%'
              )
              and (
                ${filter.roleKey ?? null}::text is null
                or exists (
                  select 1 from iam.user_roles ur
                  join iam.roles r on r.id = ur.role_id
                  where ur.user_id = u.id and r.key = ${filter.roleKey ?? ""}
                    and ur.valid_from <= now()
                    and (ur.valid_to is null or ur.valid_to > now())
                )
              )
          )
          select f.*, count(*) over () as total_count
          from filtered f
          order by
            case when ${filter.sort ?? "name"} = 'status'    then f.status end,
            case when ${filter.sort ?? "name"} = 'created'   then f.created_at end desc,
            case when ${filter.sort ?? "name"} = 'last_seen' then f.last_seen_at end desc nulls last,
            f.full_name nulls last, f.email
          limit ${limit} offset ${offset}
        `;

        const total = rows.length > 0 ? Number(rows[0].total_count) : 0;
        const users = rows.map(toUser);
        await attachRoles(sql, users);
        return { rows: users, total };
      });
    },

    async findById(id: string): Promise<IamUser | null> {
      return tx(async (sql) => {
        const user = await loadUser(sql, id);
        if (user) {
          // Opening a user record is itself an access event (PRD 13).
          await sql`select audit.record_access('users', ${id}, null, 'view')`;
        }
        return user;
      });
    },

    async create(input: CreateUserInput): Promise<IamUser> {
      return tx(async (sql) => {
        const existing = await sql<{ id: string; deleted_at: string | null }[]>`
          select id, deleted_at from iam.users where id = ${input.userId}::uuid
        `;
        if (existing.length > 0 && existing[0].deleted_at === null) {
          throw new IamError(
            "conflict",
            "This person already has access to the platform.",
          );
        }

        // Re-provisioning someone previously removed revives their record
        // rather than creating a second one, so history stays in one place.
        if (existing.length > 0) {
          await sql`
            update iam.users
            set deleted_at = null, status = ${input.status},
                clearance = ${input.clearance},
                employee_id = ${input.employeeId ?? null},
                work_phone = ${input.workPhone ?? null},
                job_title = ${input.jobTitle ?? null},
                office_id = ${input.officeId ?? null}::uuid,
                department_id = ${input.departmentId ?? null}::uuid,
                country_code = ${input.countryCode ?? null},
                session_timeout_minutes = ${input.sessionTimeoutMinutes ?? 480},
                notes = ${input.notes ?? null}
            where id = ${input.userId}::uuid
          `;
        } else {
          await sql`
            insert into iam.users (
              id, employee_id, work_phone, job_title, office_id, department_id,
              country_code, clearance, status, session_timeout_minutes, notes, created_by
            ) values (
              ${input.userId}::uuid, ${input.employeeId ?? null}, ${input.workPhone ?? null},
              ${input.jobTitle ?? null}, ${input.officeId ?? null}::uuid,
              ${input.departmentId ?? null}::uuid, ${input.countryCode ?? null},
              ${input.clearance}, ${input.status}, ${input.sessionTimeoutMinutes ?? 480},
              ${input.notes ?? null}, ${actor.userId}::uuid
            )
          `;
        }

        // The baseline role is always held and cannot be removed (PRD 3.1).
        const roleIds = new Set(input.roleIds);
        const baseline = await sql<{ id: string }[]>`
          select id from iam.roles where is_baseline limit 1
        `;
        if (baseline.length > 0) roleIds.add(baseline[0].id);

        for (const roleId of roleIds) {
          await sql`
            insert into iam.user_roles (user_id, role_id, assigned_by, reason)
            values (${input.userId}::uuid, ${roleId}::uuid, ${actor.userId}::uuid, 'initial provisioning')
            on conflict (user_id, role_id, scope_type, scope_id) do nothing
          `;
        }

        await sql`
          select audit.write(
            'user.provisioned', 'iam.users', ${input.userId}, null, null,
            ${sql.json({ clearance: input.clearance, status: input.status, roleIds: [...roleIds] })},
            'IIMS access granted'
          )
        `;

        const user = await loadUser(sql, input.userId);
        if (!user) {
          throw new IamError("not_found", "User not found after provisioning.");
        }
        return user;
      });
    },

    async update(id: string, input: UpdateUserInput): Promise<IamUser> {
      return tx(async (sql) => {
        const before = await sql<UserRow[]>`
          select u.*, null::text as email, null::text as full_name,
                 null::text as photo_path, null::text as office_name,
                 null::text as department_name
          from iam.users u
          where u.id = ${id}::uuid and u.deleted_at is null
        `;
        if (before.length === 0) {
          throw new IamError("not_found", "User not found.");
        }
        if (before[0].version !== input.expectedVersion) {
          throw new IamError(
            "stale_version",
            "This record changed since you opened it. Reload and try again.",
            { expected: input.expectedVersion, actual: before[0].version },
          );
        }

        const updated = await sql<UserRow[]>`
          update iam.users set
            employee_id = coalesce(${input.employeeId ?? null}, employee_id),
            work_phone  = ${input.workPhone === undefined ? sql`work_phone` : input.workPhone},
            job_title   = ${input.jobTitle === undefined ? sql`job_title` : input.jobTitle},
            office_id   = ${input.officeId === undefined ? sql`office_id` : sql`${input.officeId}::uuid`},
            department_id = ${input.departmentId === undefined ? sql`department_id` : sql`${input.departmentId}::uuid`},
            country_code = ${input.countryCode === undefined ? sql`country_code` : input.countryCode},
            clearance   = coalesce(${input.clearance ?? null}, clearance),
            session_timeout_minutes = coalesce(${input.sessionTimeoutMinutes ?? null}, session_timeout_minutes),
            notes       = ${input.notes === undefined ? sql`notes` : input.notes}
          where id = ${id}::uuid and version = ${input.expectedVersion}
          returning *, null::text as email, null::text as full_name,
                    null::text as photo_path, null::text as office_name,
                    null::text as department_name
        `;

        if (updated.length === 0) {
          throw new IamError("stale_version", "This record changed while saving. Reload and try again.");
        }

        await sql`
          select audit.write(
            'user.updated', 'iam.users', ${id}, null,
            ${sql.json(auditShape(before[0]))},
            ${sql.json(auditShape(updated[0]))},
            null
          )
        `;

        const after = await loadUser(sql, id);
        if (!after) throw new IamError("not_found", "User not found after update.");
        return after;
      });
    },

    async setStatus(id: string, status: UserStatus, reason: string): Promise<IamUser> {
      return tx(async (sql) => {
        const before = await sql<{ status: UserStatus }[]>`
          select status from iam.users where id = ${id}::uuid and deleted_at is null
        `;
        if (before.length === 0) throw new IamError("not_found", "User not found.");

        await sql`update iam.users set status = ${status} where id = ${id}::uuid`;

        await sql`
          select audit.write(
            'user.status_changed', 'iam.users', ${id}, null,
            ${sql.json({ status: before[0].status })},
            ${sql.json({ status })},
            ${reason}
          )
        `;

        const after = await loadUser(sql, id);
        if (!after) {
          throw new IamError("not_found", "User not found after status change.");
        }
        return after;
      });
    },

    async unlock(id: string, reason: string): Promise<void> {
      await tx(async (sql) => {
        const rows = await sql<{ locked_until: string | null; failed: number }[]>`
          select locked_until, failed_login_count as failed
          from iam.users where id = ${id}::uuid
        `;
        if (rows.length === 0) throw new IamError("not_found", "User not found.");

        await sql`
          update iam.users
          set failed_login_count = 0, locked_until = null
          where id = ${id}::uuid
        `;

        await sql`
          select audit.write('user.unlocked', 'iam.users', ${id}, null,
                             ${sql.json({ lockedUntil: rows[0].locked_until, failedAttempts: rows[0].failed })},
                             ${sql.json({ lockedUntil: null, failedAttempts: 0 })},
                             ${reason})
        `;
      });
    },

    async softDelete(id: string, reason: string): Promise<void> {
      // Recoverable by default (PRD 3.5). Open work must be reassigned first,
      // which the use case checks before calling this.
      await tx(async (sql) => {
        // No RETURNING. A soft delete hides the row, and most of these
        // tables have a SELECT policy that excludes hidden rows, so asking
        // the database to hand the row back is asking it to show something
        // it has just been told to conceal: Postgres refuses with "new row
        // violates row-level security policy", which reads like a permission
        // fault on the write. The row count says everything the caller needs.
        const rows = await sql`
          update iam.users
          set deleted_at = now(), status = 'archived'
          where id = ${id}::uuid and deleted_at is null
        `;
        if (rows.count === 0) throw new IamError("not_found", "User not found.");

        await sql`
          select audit.write('user.removed', 'iam.users', ${id}, null, null, null, ${reason})
        `;
      });
    },

    async restore(id: string, reason: string): Promise<void> {
      await tx(async (sql) => {
        const rows = await sql`
          update iam.users
          set deleted_at = null, status = 'deactivated'
          where id = ${id}::uuid and deleted_at is not null
          returning id
        `;
        if (rows.count === 0) {
          throw new IamError("not_found", "No removed user with that id.");
        }
        await sql`
          select audit.write('user.restored', 'iam.users', ${id}, null, null, null, ${reason})
        `;
      });
    },

    async assignRole(input) {
      await tx(async (sql) => {
        if (input.isPrimary) {
          await sql`
            update iam.user_roles set is_primary = false where user_id = ${input.userId}::uuid
          `;
        }

        await sql`
          insert into iam.user_roles (
            user_id, role_id, scope_type, scope_id, is_primary,
            valid_from, valid_to, assigned_by, reason
          ) values (
            ${input.userId}::uuid, ${input.roleId}::uuid, ${input.scopeType},
            ${input.scopeId ?? null}, ${input.isPrimary ?? false},
            coalesce(${input.validFrom ?? null}::timestamptz, now()),
            ${input.validTo ?? null}::timestamptz,
            ${actor.userId}::uuid, ${input.reason ?? null}
          )
          on conflict (user_id, role_id, scope_type, scope_id) do update
          set valid_from = excluded.valid_from,
              valid_to   = excluded.valid_to,
              is_primary = excluded.is_primary,
              reason     = excluded.reason
        `;

        await sql`
          select audit.write(
            'user.role_assigned', 'iam.user_roles', ${input.userId}, null, null,
            ${sql.json({ roleId: input.roleId, scopeType: input.scopeType, scopeId: input.scopeId ?? null, validTo: input.validTo ?? null })},
            ${input.reason ?? null}
          )
        `;
      });
    },

    async removeRole(assignmentId: string, reason: string) {
      await tx(async (sql) => {
        const removed = await sql<{ user_id: string; role_id: string }[]>`
          delete from iam.user_roles where id = ${assignmentId}::uuid
          returning user_id, role_id
        `;
        if (removed.length === 0) {
          throw new IamError("not_found", "Role assignment not found.");
        }
        await sql`
          select audit.write(
            'user.role_removed', 'iam.user_roles', ${removed[0].user_id}, null,
            ${sql.json({ roleId: removed[0].role_id })}, null, ${reason}
          )
        `;
      });
    },

    async setPrimaryRole(userId: string, assignmentId: string) {
      await tx(async (sql) => {
        await sql`update iam.user_roles set is_primary = false where user_id = ${userId}::uuid`;
        await sql`
          update iam.user_roles set is_primary = true
          where id = ${assignmentId}::uuid and user_id = ${userId}::uuid
        `;
        await sql`
          select audit.write('user.primary_role_set', 'iam.user_roles', ${userId},
                             null, null, ${sql.json({ assignmentId })}, null)
        `;
      });
    },

    async effectivePermissions(userId: string): Promise<EffectivePermission[]> {
      return tx(async (sql) => {
        const rows = await sql<
          {
            resource: string;
            action: string;
            scope: EffectivePermission["scope"];
            classification_ceiling: ClassificationLevel;
            source: string;
          }[]
        >`
          select resource, action, scope, classification_ceiling, source
          from iam.effective_permissions(${userId}::uuid)
          order by resource, action
        `;
        return rows.map((r) => ({
          resource: r.resource,
          action: r.action,
          scope: r.scope,
          classificationCeiling: r.classification_ceiling,
          source: r.source,
        }));
      });
    },

    async roleIdsOf(userId: string): Promise<string[]> {
      return tx(async (sql) => {
        const rows = await sql<{ role_id: string }[]>`
          select role_id from iam.user_roles
          where user_id = ${userId}::uuid
            and valid_from <= now() and (valid_to is null or valid_to > now())
        `;
        return rows.map((r) => r.role_id);
      });
    },

    async listOverrides(userId: string) {
      return tx(async (sql) => {
        const rows = await sql<
          {
            id: string;
            permission_id: string;
            resource: string;
            action: string;
            scope: EffectivePermission["scope"];
            classification_ceiling: ClassificationLevel;
            effect: "allow" | "deny";
            reason: string;
            expires_at: string | null;
            granted_at: string;
          }[]
        >`
          select o.id, o.permission_id, p.resource, p.action, p.scope,
                 p.classification_ceiling, o.effect, o.reason, o.expires_at, o.granted_at
          from iam.user_permission_overrides o
          join iam.permissions p on p.id = o.permission_id
          where o.user_id = ${userId}::uuid
          order by o.effect, p.resource, p.action
        `;
        return rows.map((r) => ({
          id: r.id,
          permissionId: r.permission_id,
          resource: r.resource,
          action: r.action,
          scope: r.scope,
          classificationCeiling: r.classification_ceiling,
          effect: r.effect,
          reason: r.reason,
          expiresAt: r.expires_at,
          grantedAt: r.granted_at,
        }));
      });
    },

    async addOverride(input) {
      await tx(async (sql) => {
        await sql`
          insert into iam.user_permission_overrides
            (user_id, permission_id, effect, reason, expires_at, granted_by)
          values (${input.userId}::uuid, ${input.permissionId}::uuid, ${input.effect},
                  ${input.reason}, ${input.expiresAt ?? null}::timestamptz, ${actor.userId}::uuid)
          on conflict (user_id, permission_id, effect) do update
          set reason = excluded.reason, expires_at = excluded.expires_at
        `;
        await sql`
          select audit.write(
            'user.override_added', 'iam.user_permission_overrides', ${input.userId},
            null, null,
            ${sql.json({ permissionId: input.permissionId, effect: input.effect, expiresAt: input.expiresAt ?? null })},
            ${input.reason}
          )
        `;
      });
    },

    async removeOverride(id: string, reason: string) {
      await tx(async (sql) => {
        const removed = await sql<{ user_id: string; effect: string }[]>`
          delete from iam.user_permission_overrides where id = ${id}::uuid
          returning user_id, effect
        `;
        if (removed.length === 0) throw new IamError("not_found", "Override not found.");
        await sql`
          select audit.write('user.override_removed', 'iam.user_permission_overrides',
                             ${removed[0].user_id}, null,
                             ${sql.json({ effect: removed[0].effect })}, null, ${reason})
        `;
      });
    },

    async listFeatureOverrides(userId: string) {
      return tx(async (sql) => {
        const rows = await sql<
          { feature_key: string; enabled: boolean; reason: string; expires_at: string | null }[]
        >`
          select feature_key, enabled, reason, expires_at
          from iam.user_features where user_id = ${userId}::uuid
          order by feature_key
        `;
        return rows.map((r) => ({
          featureKey: r.feature_key,
          enabled: r.enabled,
          reason: r.reason,
          expiresAt: r.expires_at,
        }));
      });
    },

    async setFeatureOverride(input) {
      await tx(async (sql) => {
        await sql`
          insert into iam.user_features (user_id, feature_key, enabled, reason, expires_at, granted_by)
          values (${input.userId}::uuid, ${input.featureKey}, ${input.enabled},
                  ${input.reason}, ${input.expiresAt ?? null}::timestamptz, ${actor.userId}::uuid)
          on conflict (user_id, feature_key) do update
          set enabled = excluded.enabled, reason = excluded.reason,
              expires_at = excluded.expires_at
        `;
        await sql`
          select audit.write('user.feature_override_set', 'iam.user_features',
                             ${input.userId}, null, null,
                             ${sql.json({ featureKey: input.featureKey, enabled: input.enabled })},
                             ${input.reason})
        `;
      });
    },

    async clearFeatureOverride(userId: string, featureKey: string) {
      await tx(async (sql) => {
        await sql`
          delete from iam.user_features
          where user_id = ${userId}::uuid and feature_key = ${featureKey}
        `;
        await sql`
          select audit.write('user.feature_override_cleared', 'iam.user_features',
                             ${userId}, null, ${sql.json({ featureKey })}, null, null)
        `;
      });
    },

    async sessions(userId: string) {
      return tx(async (sql) => {
        const rows = await sql<
          {
            session_id: string;
            created_at: string;
            updated_at: string | null;
            not_after: string | null;
            user_agent: string | null;
            ip: string | null;
          }[]
        >`select * from iam.user_sessions(${userId}::uuid)`;
        return rows.map((r) => ({
          sessionId: r.session_id,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          notAfter: r.not_after,
          userAgent: r.user_agent,
          ip: r.ip,
        }));
      });
    },

    async revokeAllSessions(userId: string, reason: string): Promise<number> {
      return tx(async (sql) => {
        const rows = await sql<{ n: number }[]>`
          select iam.revoke_user_sessions(${userId}::uuid, ${reason}) as n
        `;
        return rows[0].n;
      });
    },

    async revokeSession(sessionId: string, reason: string): Promise<boolean> {
      return tx(async (sql) => {
        const rows = await sql<{ ok: boolean }[]>`
          select iam.revoke_session(${sessionId}::uuid, ${reason}) as ok
        `;
        return rows[0].ok;
      });
    },

    async syncMfaEnrolment(userId: string): Promise<string | null> {
      return tx(async (sql) => {
        const rows = await sql<{ at: string | null }[]>`
          select iam.sync_mfa_enrolment(${userId}::uuid) as at
        `;
        return rows[0].at;
      });
    },

    async loginHistory(userId: string, limit: number) {
      return tx(async (sql) => {
        const rows = await sql<
          {
            id: string;
            succeeded: boolean;
            failure_kind: string | null;
            ip: string | null;
            user_agent: string | null;
            attempted_at: string;
          }[]
        >`
          select id, succeeded, failure_kind, host(ip) as ip, user_agent, attempted_at
          from iam.login_attempts
          where user_id = ${userId}::uuid
          order by attempted_at desc
          limit ${Math.min(limit, 200)}
        `;
        return rows.map((r) => ({
          id: r.id,
          succeeded: r.succeeded,
          failureKind: r.failure_kind,
          ip: r.ip,
          userAgent: r.user_agent,
          attemptedAt: r.attempted_at,
        }));
      });
    },

    async directory(input) {
      const limit = Math.min(input.limit ?? 50, 200);
      return tx(async (sql) => {
        const rows = await sql<
          {
            user_id: string;
            email: string;
            full_name: string | null;
            website_role: string | null;
            iims_status: UserStatus | null;
            iims_clearance: ClassificationLevel | null;
            has_iims_access: boolean;
            total_count: string;
          }[]
        >`
          select * from iam.directory_profiles(
            ${input.search ?? null}, ${input.onlyUnlinked ?? false},
            ${limit}, ${input.offset ?? 0}
          )
        `;
        return {
          total: rows.length > 0 ? Number(rows[0].total_count) : 0,
          rows: rows.map((r) => ({
            userId: r.user_id,
            email: r.email,
            fullName: r.full_name,
            websiteRole: r.website_role,
            iimsStatus: r.iims_status,
            iimsClearance: r.iims_clearance,
            hasIimsAccess: r.has_iims_access,
          })),
        };
      });
    },

    async stats() {
      return tx(async (sql) => {
        const rows = await sql<
          {
            total: string;
            active: string;
            invited: string;
            suspended: string;
            deactivated: string;
            deleted: string;
            locked_out: string;
            without_mfa: string;
            administrators: string;
          }[]
        >`
          select
            count(*) filter (where deleted_at is null)                              as total,
            count(*) filter (where deleted_at is null and status = 'active')         as active,
            count(*) filter (where deleted_at is null and status = 'invited')        as invited,
            count(*) filter (where deleted_at is null and status = 'suspended')      as suspended,
            count(*) filter (where deleted_at is null and status = 'deactivated')    as deactivated,
            count(*) filter (where deleted_at is not null)                           as deleted,
            count(*) filter (where deleted_at is null and locked_until > now())      as locked_out,
            count(*) filter (where deleted_at is null and status = 'active'
                                   and mfa_enrolled_at is null)                      as without_mfa,
            count(*) filter (where deleted_at is null and iam.is_administrator(id))  as administrators
          from iam.users
        `;
        const r = rows[0];
        return {
          total: Number(r.total),
          active: Number(r.active),
          invited: Number(r.invited),
          suspended: Number(r.suspended),
          deactivated: Number(r.deactivated),
          deleted: Number(r.deleted),
          lockedOut: Number(r.locked_out),
          withoutMfa: Number(r.without_mfa),
          administrators: Number(r.administrators),
        };
      });
    },
  };
}

/* ------------------------------------------------------------------ mapping */

interface UserRow {
  id: string;
  email: string | null;
  full_name: string | null;
  photo_path: string | null;
  employee_id: string | null;
  work_phone: string | null;
  job_title: string | null;
  office_id: string | null;
  office_name: string | null;
  department_id: string | null;
  department_name: string | null;
  country_code: string | null;
  clearance: ClassificationLevel;
  status: UserStatus;
  permissions_version: string;
  failed_login_count: number;
  locked_until: string | null;
  session_timeout_minutes: number;
  mfa_enrolled_at: string | null;
  last_seen_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  version: number;
  deleted_at: string | null;
}

function toUser(row: UserRow): IamUser {
  return {
    id: row.id,
    email: row.email ?? "",
    fullName: row.full_name,
    photoPath: row.photo_path,
    employeeId: row.employee_id,
    workPhone: row.work_phone,
    jobTitle: row.job_title,
    officeId: row.office_id,
    officeName: row.office_name,
    departmentId: row.department_id,
    departmentName: row.department_name,
    countryCode: row.country_code,
    clearance: row.clearance,
    status: row.status,
    permissionsVersion: Number(row.permissions_version),
    failedLoginCount: row.failed_login_count,
    lockedUntil: row.locked_until,
    sessionTimeoutMinutes: row.session_timeout_minutes,
    mfaEnrolledAt: row.mfa_enrolled_at,
    lastSeenAt: row.last_seen_at,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
    deletedAt: row.deleted_at,
    roles: [],
  };
}

/**
 * Loads one user inside an EXISTING transaction.
 *
 * Used by findById, create, update and setStatus. It matters that this takes
 * the transaction rather than opening its own: the connection pool is sized at
 * one per instance, so a nested withActor() would wait for a connection the
 * surrounding transaction is already holding, and deadlock.
 */
async function loadUser(
  sql: postgres.TransactionSql,
  id: string,
): Promise<IamUser | null> {
  const rows = await sql<UserRow[]>`
    select u.*, dir.email, dir.full_name, dir.photo_path,
           o.name as office_name, d.name as department_name
    from iam.users u
    left join iam.profile_basics(array[${id}::uuid]) dir on dir.user_id = u.id
    left join iam.offices o on o.id = u.office_id
    left join iam.departments d on d.id = u.department_id
    where u.id = ${id}::uuid
  `;
  if (rows.length === 0) return null;

  const user = toUser(rows[0]);
  await attachRoles(sql, [user]);
  return user;
}

/** One query for all role assignments, rather than one per user. */
async function attachRoles(
  sql: postgres.TransactionSql,
  users: IamUser[],
): Promise<void> {
  if (users.length === 0) return;

  const rows = await sql<
    {
      id: string;
      user_id: string;
      role_id: string;
      role_key: string;
      role_name: string;
      scope_type: RoleAssignment["scopeType"];
      scope_id: string | null;
      is_primary: boolean;
      valid_from: string;
      valid_to: string | null;
      reason: string | null;
    }[]
  >`
    select ur.id, ur.user_id, ur.role_id, r.key as role_key, r.name as role_name,
           ur.scope_type, ur.scope_id, ur.is_primary, ur.valid_from, ur.valid_to, ur.reason
    from iam.user_roles ur
    join iam.roles r on r.id = ur.role_id
    where ur.user_id = any(${users.map((u) => u.id)}::uuid[])
    order by ur.is_primary desc, r.name
  `;

  const byUser = new Map<string, RoleAssignment[]>();
  for (const r of rows) {
    const list = byUser.get(r.user_id) ?? [];
    list.push({
      id: r.id,
      userId: r.user_id,
      roleId: r.role_id,
      roleKey: r.role_key,
      roleName: r.role_name,
      scopeType: r.scope_type,
      scopeId: r.scope_id,
      isPrimary: r.is_primary,
      validFrom: r.valid_from,
      validTo: r.valid_to,
      reason: r.reason,
    });
    byUser.set(r.user_id, list);
  }

  for (const user of users) {
    user.roles = byUser.get(user.id) ?? [];
  }
}

/** The subset of a user row worth recording in a before/after audit value. */
function auditShape(row: UserRow) {
  return {
    employeeId: row.employee_id,
    workPhone: row.work_phone,
    jobTitle: row.job_title,
    officeId: row.office_id,
    departmentId: row.department_id,
    countryCode: row.country_code,
    clearance: row.clearance,
    status: row.status,
    sessionTimeoutMinutes: row.session_timeout_minutes,
    notes: row.notes,
  };
}
