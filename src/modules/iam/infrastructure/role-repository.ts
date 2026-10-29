import "server-only";
import type postgres from "postgres";
import { applyActorSettings, withActor, type ActorContext } from "@/lib/db/client";
import type { ClassificationLevel } from "../domain/classification";
import { IamError } from "../domain/errors";
import type { Permission, Role } from "../domain/types";
import type {
  FeatureRepository,
  OrgRepository,
  PermissionRepository,
  RoleRepository,
} from "../application/ports";

/**
 * Roles, permissions, features and organisation units.
 *
 * Role changes are versioned with a reason, an author and a before/after
 * comparison, and can be rolled back (PRD 3.3). That history is written in the
 * same transaction as the change itself.
 */
export function createRoleRepository(
  actor: ActorContext,
  existing?: postgres.TransactionSql,
): RoleRepository {
  const tx = async <T>(
    work: (sql: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> => {
    if (!existing) return withActor(actor, work) as Promise<T>;
    await applyActorSettings(existing, actor);
    return work(existing);
  };

  return {
    async list(includeInactive: boolean): Promise<Role[]> {
      return tx(async (sql) => {
        const rows = await sql<RoleRow[]>`
          select r.*,
                 (select count(*) from iam.user_roles ur
                  where ur.role_id = r.id
                    and ur.valid_from <= now()
                    and (ur.valid_to is null or ur.valid_to > now()))::int as member_count,
                 (select count(*) from iam.role_permissions rp
                  where rp.role_id = r.id)::int as permission_count
          from iam.roles r
          where r.deleted_at is null
            and (${includeInactive} or r.is_active)
          order by r.is_administrator desc, r.is_baseline, r.name
        `;
        return rows.map(toRole);
      });
    },

    async findById(id: string): Promise<Role | null> {
      return tx(async (sql) => {
        const rows = await sql<RoleRow[]>`
          select r.*,
                 (select count(*) from iam.user_roles ur where ur.role_id = r.id)::int as member_count,
                 (select count(*) from iam.role_permissions rp where rp.role_id = r.id)::int as permission_count
          from iam.roles r where r.id = ${id}::uuid and r.deleted_at is null
        `;
        return rows.length > 0 ? toRole(rows[0]) : null;
      });
    },

    async findByKey(key: string): Promise<Role | null> {
      return tx(async (sql) => {
        const rows = await sql<RoleRow[]>`
          select r.*, 0 as member_count, 0 as permission_count
          from iam.roles r where r.key = ${key} and r.deleted_at is null
        `;
        return rows.length > 0 ? toRole(rows[0]) : null;
      });
    },

    async create(input): Promise<Role> {
      return tx(async (sql) => {
        const clash = await sql`select 1 from iam.roles where key = ${input.key}`;
        if (clash.count > 0) {
          throw new IamError("conflict", `A role with the key "${input.key}" already exists.`);
        }

        const rows = await sql<RoleRow[]>`
          insert into iam.roles (key, name, description, is_administrator, created_by)
          values (${input.key}, ${input.name}, ${input.description ?? null},
                  ${input.isAdministrator ?? false}, ${actor.userId}::uuid)
          returning *, 0 as member_count, 0 as permission_count
        `;

        await sql`
          insert into iam.role_versions (role_id, version, reason, before_value, after_value, changed_by)
          values (${rows[0].id}::uuid, 1, 'role created', null,
                  ${sql.json({ key: input.key, name: input.name, description: input.description ?? null })},
                  ${actor.userId}::uuid)
        `;

        await sql`
          select audit.write('role.created', 'iam.roles', ${rows[0].id}, null, null,
                             ${sql.json({ key: input.key, name: input.name })}, 'role created')
        `;

        return toRole(rows[0]);
      });
    },

    async update(id, input): Promise<Role> {
      return tx(async (sql) => {
        const before = await sql<RoleRow[]>`
          select *, 0 as member_count, 0 as permission_count
          from iam.roles where id = ${id}::uuid and deleted_at is null
        `;
        if (before.length === 0) throw new IamError("not_found", "Role not found.");
        if (before[0].version !== input.expectedVersion) {
          throw new IamError(
            "stale_version",
            "This role changed since you opened it. Reload and try again.",
          );
        }

        const rows = await sql<RoleRow[]>`
          update iam.roles set
            name        = coalesce(${input.name ?? null}, name),
            description = ${input.description === undefined ? sql`description` : input.description},
            is_active   = coalesce(${input.isActive ?? null}, is_active)
          where id = ${id}::uuid and version = ${input.expectedVersion}
          returning *, 0 as member_count, 0 as permission_count
        `;
        if (rows.length === 0) {
          throw new IamError("stale_version", "This role changed while saving.");
        }

        await sql`
          insert into iam.role_versions (role_id, version, reason, before_value, after_value, changed_by)
          values (${id}::uuid, ${rows[0].version}, ${input.reason},
                  ${sql.json(roleShape(before[0]))}, ${sql.json(roleShape(rows[0]))},
                  ${actor.userId}::uuid)
        `;

        await sql`
          select audit.write('role.updated', 'iam.roles', ${id}, null,
                             ${sql.json(roleShape(before[0]))},
                             ${sql.json(roleShape(rows[0]))}, ${input.reason})
        `;

        return toRole(rows[0]);
      });
    },

    async clone(id, key, name): Promise<Role> {
      return tx(async (sql) => {
        const source = await sql<RoleRow[]>`
          select *, 0 as member_count, 0 as permission_count
          from iam.roles where id = ${id}::uuid and deleted_at is null
        `;
        if (source.length === 0) throw new IamError("not_found", "Role to clone not found.");

        const clash = await sql`select 1 from iam.roles where key = ${key}`;
        if (clash.count > 0) {
          throw new IamError("conflict", `A role with the key "${key}" already exists.`);
        }

        const created = await sql<RoleRow[]>`
          insert into iam.roles (key, name, description, created_by)
          values (${key}, ${name},
                  ${`Cloned from ${source[0].name}.`}, ${actor.userId}::uuid)
          returning *, 0 as member_count, 0 as permission_count
        `;

        // A clone is only useful if it carries the permissions and features.
        await sql`
          insert into iam.role_permissions (role_id, permission_id, granted_by)
          select ${created[0].id}::uuid, rp.permission_id, ${actor.userId}::uuid
          from iam.role_permissions rp where rp.role_id = ${id}::uuid
        `;
        await sql`
          insert into iam.role_features (role_id, feature_key, enabled)
          select ${created[0].id}::uuid, rf.feature_key, rf.enabled
          from iam.role_features rf where rf.role_id = ${id}::uuid
        `;

        await sql`
          insert into iam.role_versions (role_id, version, reason, before_value, after_value, changed_by)
          values (${created[0].id}::uuid, 1, ${`cloned from ${source[0].key}`}, null,
                  ${sql.json({ key, name, clonedFrom: source[0].key })}, ${actor.userId}::uuid)
        `;

        await sql`
          select audit.write('role.cloned', 'iam.roles', ${created[0].id}, null,
                             ${sql.json({ from: source[0].key })},
                             ${sql.json({ key, name })}, 'role cloned')
        `;

        return toRole(created[0]);
      });
    },

    async remove(id, reason): Promise<void> {
      await tx(async (sql) => {
        const rows = await sql<{ key: string; is_baseline: boolean }[]>`
          select key, is_baseline from iam.roles where id = ${id}::uuid and deleted_at is null
        `;
        if (rows.length === 0) throw new IamError("not_found", "Role not found.");

        await sql`update iam.roles set deleted_at = now(), is_active = false where id = ${id}::uuid`;

        await sql`
          select audit.write('role.deleted', 'iam.roles', ${id}, null,
                             ${sql.json({ key: rows[0].key })}, null, ${reason})
        `;
      });
    },

    async memberCount(id): Promise<number> {
      return tx(async (sql) => {
        const rows = await sql<{ n: number }[]>`
          select count(*)::int as n from iam.user_roles
          where role_id = ${id}::uuid
            and valid_from <= now() and (valid_to is null or valid_to > now())
        `;
        return rows[0].n;
      });
    },

    async members(id) {
      return tx(async (sql) => {
        // Through iam.profile_basics for the same reason as the user list: the
        // website's RLS policy on public.profiles filters this connection out
        // entirely (migration 0014).
        const rows = await sql<{ user_id: string; full_name: string | null; email: string }[]>`
          with members as (
            select user_id from iam.user_roles where role_id = ${id}::uuid
          ),
          names as (
            select user_id, email, full_name
            from iam.profile_basics(
              (select coalesce(array_agg(user_id), '{}'::uuid[]) from members)
            )
          )
          select m.user_id, n.full_name, n.email
          from members m
          left join names n on n.user_id = m.user_id
          order by n.full_name nulls last, n.email
        `;
        return rows.map((r) => ({
          userId: r.user_id,
          fullName: r.full_name,
          email: r.email ?? "",
        }));
      });
    },

    async permissionsOf(roleId): Promise<Permission[]> {
      return tx(async (sql) => {
        const rows = await sql<PermissionRow[]>`
          select p.* from iam.role_permissions rp
          join iam.permissions p on p.id = rp.permission_id
          where rp.role_id = ${roleId}::uuid
          order by p.resource, p.action
        `;
        return rows.map(toPermission);
      });
    },

    async setPermissions(roleId, permissionIds, reason): Promise<void> {
      // Replace wholesale, so the builder's checkbox grid maps directly onto
      // one call and cannot leave stale grants behind.
      await tx(async (sql) => {
        const before = await sql<{ permission_id: string }[]>`
          select permission_id from iam.role_permissions where role_id = ${roleId}::uuid
        `;

        await sql`delete from iam.role_permissions where role_id = ${roleId}::uuid`;

        if (permissionIds.length > 0) {
          await sql`
            insert into iam.role_permissions (role_id, permission_id, granted_by)
            select ${roleId}::uuid, unnest(${permissionIds}::uuid[]), ${actor.userId}::uuid
          `;
        }

        await sql`
          select audit.write('role.permissions_changed', 'iam.roles', ${roleId}, null,
                             ${sql.json({ permissionIds: before.map((b) => b.permission_id) })},
                             ${sql.json({ permissionIds })}, ${reason})
        `;
      });
    },

    async featuresOf(roleId) {
      return tx(async (sql) => {
        const rows = await sql<{ feature_key: string; enabled: boolean }[]>`
          select feature_key, enabled from iam.role_features where role_id = ${roleId}::uuid
        `;
        return rows.map((r) => ({ featureKey: r.feature_key, enabled: r.enabled }));
      });
    },

    async setFeatures(roleId, enabledKeys): Promise<void> {
      await tx(async (sql) => {
        await sql`delete from iam.role_features where role_id = ${roleId}::uuid`;
        if (enabledKeys.length > 0) {
          await sql`
            insert into iam.role_features (role_id, feature_key, enabled)
            select ${roleId}::uuid, unnest(${enabledKeys}::text[]), true
          `;
        }
        await sql`
          select audit.write('role.features_changed', 'iam.roles', ${roleId}, null, null,
                             ${sql.json({ enabledKeys })}, null)
        `;
      });
    },

    async versions(roleId) {
      return tx(async (sql) => {
        const rows = await sql<
          {
            id: string;
            version: number;
            reason: string;
            before_value: unknown;
            after_value: unknown;
            changed_by: string | null;
            changed_at: string;
          }[]
        >`
          select id, version, reason, before_value, after_value, changed_by, changed_at
          from iam.role_versions where role_id = ${roleId}::uuid
          order by version desc
        `;
        return rows.map((r) => ({
          id: r.id,
          version: r.version,
          reason: r.reason,
          beforeValue: r.before_value,
          afterValue: r.after_value,
          changedBy: r.changed_by,
          changedAt: r.changed_at,
        }));
      });
    },

    async rollback(roleId, versionId, reason): Promise<Role> {
      return tx(async (sql) => {
        const target = await sql<{ after_value: Record<string, unknown> }[]>`
          select after_value from iam.role_versions
          where id = ${versionId}::uuid and role_id = ${roleId}::uuid
        `;
        if (target.length === 0) {
          throw new IamError("not_found", "That role version does not exist.");
        }

        const shape = target[0].after_value;
        const before = await sql<RoleRow[]>`
          select *, 0 as member_count, 0 as permission_count
          from iam.roles where id = ${roleId}::uuid
        `;

        const rows = await sql<RoleRow[]>`
          update iam.roles set
            name        = coalesce(${(shape.name as string) ?? null}, name),
            description = ${(shape.description as string) ?? null}
          where id = ${roleId}::uuid
          returning *, 0 as member_count, 0 as permission_count
        `;

        await sql`
          insert into iam.role_versions (role_id, version, reason, before_value, after_value, changed_by)
          values (${roleId}::uuid, ${rows[0].version},
                  ${`rolled back: ${reason}`},
                  ${sql.json(roleShape(before[0]))}, ${sql.json(roleShape(rows[0]))},
                  ${actor.userId}::uuid)
        `;

        await sql`
          select audit.write('role.rolled_back', 'iam.roles', ${roleId}, null,
                             ${sql.json(roleShape(before[0]))},
                             ${sql.json(roleShape(rows[0]))}, ${reason})
        `;

        return toRole(rows[0]);
      });
    },

    async incompatibilities() {
      return tx(async (sql) => {
        const rows = await sql<
          {
            role_a_id: string;
            role_b_id: string;
            role_a_name: string;
            role_b_name: string;
            reason: string;
          }[]
        >`
          select i.role_a_id, i.role_b_id, a.name as role_a_name, b.name as role_b_name, i.reason
          from iam.role_incompatibilities i
          join iam.roles a on a.id = i.role_a_id
          join iam.roles b on b.id = i.role_b_id
          order by a.name, b.name
        `;
        return rows.map((r) => ({
          roleAId: r.role_a_id,
          roleBId: r.role_b_id,
          roleAName: r.role_a_name,
          roleBName: r.role_b_name,
          reason: r.reason,
        }));
      });
    },

    async addIncompatibility(roleAId, roleBId, reason): Promise<void> {
      await tx(async (sql) => {
        if (roleAId === roleBId) {
          throw new IamError("validation_failed", "A role cannot be incompatible with itself.");
        }
        await sql`
          insert into iam.role_incompatibilities (role_a_id, role_b_id, reason)
          values (${roleAId}::uuid, ${roleBId}::uuid, ${reason})
          on conflict (role_a_id, role_b_id) do update set reason = excluded.reason
        `;
        await sql`
          select audit.write('role.incompatibility_added', 'iam.role_incompatibilities',
                             ${roleAId}, null, null,
                             ${sql.json({ roleAId, roleBId })}, ${reason})
        `;
      });
    },

    async removeIncompatibility(roleAId, roleBId): Promise<void> {
      await tx(async (sql) => {
        await sql`
          delete from iam.role_incompatibilities
          where role_a_id = ${roleAId}::uuid and role_b_id = ${roleBId}::uuid
        `;
        await sql`
          select audit.write('role.incompatibility_removed', 'iam.role_incompatibilities',
                             ${roleAId}, null, ${sql.json({ roleAId, roleBId })}, null, null)
        `;
      });
    },
  };
}

export function createPermissionRepository(
  actor: ActorContext,
  existing?: postgres.TransactionSql,
): PermissionRepository {
  const tx = async <T>(
    work: (sql: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> => {
    if (!existing) return withActor(actor, work) as Promise<T>;
    await applyActorSettings(existing, actor);
    return work(existing);
  };

  return {
    async list(filter): Promise<Permission[]> {
      return tx(async (sql) => {
        const rows = await sql<PermissionRow[]>`
          select * from iam.permissions
          where (${filter?.resource ?? null}::text is null or resource = ${filter?.resource ?? null})
            and (${filter?.action ?? null}::text is null or action = ${filter?.action ?? null})
          order by resource, action, scope
        `;
        return rows.map(toPermission);
      });
    },

    async ensure(input): Promise<Permission> {
      return tx(async (sql) => {
        const rows = await sql<PermissionRow[]>`
          insert into iam.permissions (resource, action, scope, classification_ceiling, description)
          values (${input.resource}, ${input.action}, ${input.scope},
                  ${input.classificationCeiling}, ${input.description ?? null})
          on conflict (resource, action, scope, classification_ceiling)
            do update set description = coalesce(excluded.description, iam.permissions.description)
          returning *
        `;
        return toPermission(rows[0]);
      });
    },

    async remove(id): Promise<void> {
      await tx(async (sql) => {
        const inUse = await sql`
          select 1 from iam.role_permissions where permission_id = ${id}::uuid limit 1
        `;
        if (inUse.count > 0) {
          throw new IamError(
            "conflict",
            "This permission is granted to at least one role. Remove it from those roles first.",
          );
        }
        await sql`delete from iam.permissions where id = ${id}::uuid`;
        await sql`
          select audit.write('permission.deleted', 'iam.permissions', ${id}, null, null, null, null)
        `;
      });
    },

    async resources(): Promise<string[]> {
      return tx(async (sql) => {
        const rows = await sql<{ resource: string }[]>`
          select distinct resource from iam.permissions order by resource
        `;
        return rows.map((r) => r.resource);
      });
    },
  };
}

export function createFeatureRepository(
  actor: ActorContext,
  existing?: postgres.TransactionSql,
): FeatureRepository {
  const tx = async <T>(
    work: (sql: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> => {
    if (!existing) return withActor(actor, work) as Promise<T>;
    await applyActorSettings(existing, actor);
    return work(existing);
  };

  return {
    async list() {
      return tx(async (sql) => {
        const rows = await sql<
          { key: string; name: string; description: string | null; is_active: boolean }[]
        >`select key, name, description, is_active from iam.features order by key`;
        return rows.map((r) => ({
          key: r.key,
          name: r.name,
          description: r.description,
          isActive: r.is_active,
        }));
      });
    },

    async upsert(input) {
      return tx(async (sql) => {
        const rows = await sql<
          { key: string; name: string; description: string | null; is_active: boolean }[]
        >`
          insert into iam.features (key, name, description, is_active)
          values (${input.key}, ${input.name}, ${input.description ?? null},
                  ${input.isActive ?? true})
          on conflict (key) do update
          set name = excluded.name, description = excluded.description,
              is_active = excluded.is_active
          returning key, name, description, is_active
        `;
        await sql`
          select audit.write('feature.saved', 'iam.features', ${input.key}, null, null,
                             ${sql.json({ name: input.name, isActive: input.isActive ?? true })}, null)
        `;
        return {
          key: rows[0].key,
          name: rows[0].name,
          description: rows[0].description,
          isActive: rows[0].is_active,
        };
      });
    },

    async remove(key) {
      await tx(async (sql) => {
        await sql`delete from iam.features where key = ${key}`;
        await sql`
          select audit.write('feature.deleted', 'iam.features', ${key}, null, null, null, null)
        `;
      });
    },
  };
}

export function createOrgRepository(
  actor: ActorContext,
  existing?: postgres.TransactionSql,
): OrgRepository {
  const tx = async <T>(
    work: (sql: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> => {
    if (!existing) return withActor(actor, work) as Promise<T>;
    await applyActorSettings(existing, actor);
    return work(existing);
  };

  return {
    async countries() {
      return tx(async (sql) => {
        const rows = await sql<{ code: string; name: string; is_active: boolean }[]>`
          select code, name, is_active from iam.countries order by name
        `;
        return rows.map((r) => ({ code: r.code, name: r.name, isActive: r.is_active }));
      });
    },

    async offices() {
      return tx(async (sql) => {
        const rows = await sql<
          {
            id: string;
            code: string;
            name: string;
            country_code: string;
            timezone: string;
            is_active: boolean;
          }[]
        >`
          select id, code, name, country_code, timezone, is_active
          from iam.offices order by name
        `;
        return rows.map((r) => ({
          id: r.id,
          code: r.code,
          name: r.name,
          countryCode: r.country_code,
          timezone: r.timezone,
          isActive: r.is_active,
        }));
      });
    },

    async departments() {
      return tx(async (sql) => {
        const rows = await sql<{ id: string; code: string; name: string; is_active: boolean }[]>`
          select id, code, name, is_active from iam.departments order by name
        `;
        return rows.map((r) => ({
          id: r.id,
          code: r.code,
          name: r.name,
          isActive: r.is_active,
        }));
      });
    },

    async classificationLevels() {
      return tx(async (sql) => {
        const rows = await sql<
          { code: string; name: string; rank: number; description: string | null }[]
        >`
          select code, name, rank, description from iam.classification_levels
          where is_active order by rank
        `;
        return rows;
      });
    },

    async createCountry(input) {
      await tx(async (sql) => {
        await sql`
          insert into iam.countries (code, name, residency_note)
          values (${input.code.toUpperCase()}, ${input.name}, ${input.residencyNote ?? null})
          on conflict (code) do update set name = excluded.name
        `;
        await sql`select audit.write('country.saved', 'iam.countries', ${input.code}, null, null,
                                     ${sql.json({ name: input.name })}, null)`;
      });
    },

    async updateCountry(code, input) {
      await tx(async (sql) => {
        await sql`
          update iam.countries set
            name = coalesce(${input.name ?? null}, name),
            is_active = coalesce(${input.isActive ?? null}, is_active)
          where code = ${code}
        `;
        await sql`select audit.write('country.updated', 'iam.countries', ${code}, null, null,
                                     ${sql.json(input)}, null)`;
      });
    },

    async createOffice(input) {
      await tx(async (sql) => {
        const rows = await sql<{ id: string }[]>`
          insert into iam.offices (code, name, country_code, timezone)
          values (${input.code}, ${input.name}, ${input.countryCode.toUpperCase()},
                  ${input.timezone ?? "UTC"})
          returning id
        `;
        await sql`select audit.write('office.created', 'iam.offices', ${rows[0].id}, null, null,
                                     ${sql.json({ code: input.code, name: input.name })}, null)`;
      });
    },

    async updateOffice(id, input) {
      await tx(async (sql) => {
        await sql`
          update iam.offices set
            code = coalesce(${input.code ?? null}, code),
            name = coalesce(${input.name ?? null}, name),
            country_code = coalesce(${input.countryCode ?? null}, country_code),
            timezone = coalesce(${input.timezone ?? null}, timezone),
            is_active = coalesce(${input.isActive ?? null}, is_active)
          where id = ${id}::uuid
        `;
        await sql`select audit.write('office.updated', 'iam.offices', ${id}, null, null,
                                     ${sql.json(input)}, null)`;
      });
    },

    async removeOffice(id) {
      await tx(async (sql) => {
        const inUse = await sql`select 1 from iam.users where office_id = ${id}::uuid limit 1`;
        if (inUse.count > 0) {
          throw new IamError(
            "conflict",
            "Users are assigned to this office. Move them before deleting it.",
          );
        }
        await sql`delete from iam.offices where id = ${id}::uuid`;
        await sql`select audit.write('office.deleted', 'iam.offices', ${id}, null, null, null, null)`;
      });
    },

    async createDepartment(input) {
      await tx(async (sql) => {
        const rows = await sql<{ id: string }[]>`
          insert into iam.departments (code, name) values (${input.code}, ${input.name})
          returning id
        `;
        await sql`select audit.write('department.created', 'iam.departments', ${rows[0].id},
                                     null, null, ${sql.json(input)}, null)`;
      });
    },

    async updateDepartment(id, input) {
      await tx(async (sql) => {
        await sql`
          update iam.departments set
            code = coalesce(${input.code ?? null}, code),
            name = coalesce(${input.name ?? null}, name),
            is_active = coalesce(${input.isActive ?? null}, is_active)
          where id = ${id}::uuid
        `;
        await sql`select audit.write('department.updated', 'iam.departments', ${id}, null, null,
                                     ${sql.json(input)}, null)`;
      });
    },

    async removeDepartment(id) {
      await tx(async (sql) => {
        const inUse = await sql`select 1 from iam.users where department_id = ${id}::uuid limit 1`;
        if (inUse.count > 0) {
          throw new IamError(
            "conflict",
            "Users are assigned to this department. Move them before deleting it.",
          );
        }
        await sql`delete from iam.departments where id = ${id}::uuid`;
        await sql`select audit.write('department.deleted', 'iam.departments', ${id},
                                     null, null, null, null)`;
      });
    },
  };
}

/* ------------------------------------------------------------------ mapping */

interface RoleRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  is_baseline: boolean;
  is_administrator: boolean;
  is_active: boolean;
  version: number;
  member_count: number;
  permission_count: number;
}

function toRole(row: RoleRow): Role {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    isBaseline: row.is_baseline,
    isAdministrator: row.is_administrator,
    isActive: row.is_active,
    version: row.version,
    memberCount: row.member_count,
    permissionCount: row.permission_count,
  };
}

interface PermissionRow {
  id: string;
  resource: string;
  action: string;
  scope: Permission["scope"];
  classification_ceiling: ClassificationLevel;
  description: string | null;
}

function toPermission(row: PermissionRow): Permission {
  return {
    id: row.id,
    resource: row.resource,
    action: row.action as Permission["action"],
    scope: row.scope,
    classificationCeiling: row.classification_ceiling,
    description: row.description,
  };
}

function roleShape(row: RoleRow) {
  return {
    key: row.key,
    name: row.name,
    description: row.description,
    isActive: row.is_active,
  };
}
