import "server-only";
import type postgres from "postgres";
import { applyActorSettings, withActor, type ActorContext } from "@/lib/db/client";
import { CaseworkError } from "../domain/errors";
import type {
  CaseType,
  WorkflowDefinition,
  WorkflowStage,
  WorkflowTransition,
} from "../domain/types";
import type { WorkflowRepository } from "../application/ports";

/**
 * The configurable lifecycle (PRD 4.3).
 *
 * Read on nearly every casework screen and changed almost never, which is why
 * it is its own repository rather than part of the case repository: the case
 * list needs the stage names once, not once per row.
 *
 * Reordering is the only operation here that is less than obvious. Stage
 * positions carry a UNIQUE constraint per definition, so writing the new
 * positions one at a time collides with whatever currently holds the target
 * number. The positions are therefore moved out of the way first, which is
 * what the two-pass update below is doing.
 */

interface StageRow {
  id: string;
  definition_id: string;
  key: string;
  name: string;
  position: number;
  methodology_stage: string | null;
  is_terminal: boolean;
  requires_approval: boolean;
  description: string | null;
}

function toStage(row: StageRow): WorkflowStage {
  return {
    id: row.id,
    definitionId: row.definition_id,
    key: row.key,
    name: row.name,
    position: row.position,
    methodologyStage: row.methodology_stage,
    isTerminal: row.is_terminal,
    requiresApproval: row.requires_approval,
    description: row.description,
  };
}

export function createWorkflowRepository(
  actor: ActorContext,
  existing?: postgres.TransactionSql,
): WorkflowRepository {
  const tx = async <T>(
    work: (sql: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> => {
    if (!existing) return withActor(actor, work) as Promise<T>;
    await applyActorSettings(existing, actor);
    return work(existing);
  };

  /** One definition with its stages, ordered as the rail shows them. */
  const loadDefinition = async (
    sql: postgres.TransactionSql,
    where: { id?: string; isDefault?: boolean },
  ): Promise<WorkflowDefinition | null> => {
    const definitions = await sql<
      {
        id: string;
        key: string;
        name: string;
        description: string | null;
        is_default: boolean;
        is_active: boolean;
      }[]
    >`
      select id, key, name, description, is_default, is_active
      from config.workflow_definitions
      where (${where.id ?? null}::uuid is null or id = ${where.id ?? null}::uuid)
        and (${where.isDefault ?? false} = false or is_default)
      order by is_default desc
      limit 1
    `;
    if (definitions.length === 0) return null;

    const stages = await sql<StageRow[]>`
      select * from config.workflow_stages
      where definition_id = ${definitions[0].id}::uuid
      order by position
    `;

    return {
      id: definitions[0].id,
      key: definitions[0].key,
      name: definitions[0].name,
      description: definitions[0].description,
      isDefault: definitions[0].is_default,
      isActive: definitions[0].is_active,
      stages: stages.map(toStage),
    };
  };

  return {
    async defaultDefinition(): Promise<WorkflowDefinition> {
      return tx(async (sql) => {
        const definition = await loadDefinition(sql, { isDefault: true });
        if (!definition) {
          // Seeded by migration 0023, so this means the lifecycle was
          // deliberately removed rather than that something is merely missing.
          throw new CaseworkError(
            "not_found",
            "No default case lifecycle is configured. An administrator has to mark one as the default before cases can be opened.",
          );
        }
        return definition;
      });
    },

    async definition(id: string): Promise<WorkflowDefinition | null> {
      return tx((sql) => loadDefinition(sql, { id }));
    },

    async listDefinitions(): Promise<WorkflowDefinition[]> {
      return tx(async (sql) => {
        const rows = await sql<{ id: string }[]>`
          select id from config.workflow_definitions order by is_default desc, name
        `;
        const out: WorkflowDefinition[] = [];
        for (const row of rows) {
          const definition = await loadDefinition(sql, { id: row.id });
          if (definition) out.push(definition);
        }
        return out;
      });
    },

    async transitionsFrom(stageId: string): Promise<WorkflowTransition[]> {
      return tx(async (sql) => {
        const rows = await sql<
          {
            id: string;
            to_stage_id: string;
            to_stage_key: string;
            to_stage_name: string;
            required_permission: string | null;
            requires_reason: boolean;
          }[]
        >`
          select t.id, t.to_stage_id, s.key as to_stage_key, s.name as to_stage_name,
                 t.required_permission, t.requires_reason
          from config.workflow_transitions t
          join config.workflow_stages s on s.id = t.to_stage_id
          where t.from_stage_id = ${stageId}::uuid
          order by s.position
        `;
        return rows.map((r) => ({
          id: r.id,
          toStageId: r.to_stage_id,
          toStageKey: r.to_stage_key,
          toStageName: r.to_stage_name,
          requiredPermission: r.required_permission,
          requiresReason: r.requires_reason,
        }));
      });
    },

    async stage(id: string): Promise<WorkflowStage | null> {
      return tx(async (sql) => {
        const rows = await sql<StageRow[]>`
          select * from config.workflow_stages where id = ${id}::uuid
        `;
        return rows.length > 0 ? toStage(rows[0]) : null;
      });
    },

    async caseTypes(includeInactive = false): Promise<CaseType[]> {
      return tx(async (sql) => {
        const rows = await sql<
          {
            key: string;
            name: string;
            description: string | null;
            is_active: boolean;
            position: number;
          }[]
        >`
          select key, name, description, is_active, position
          from config.case_types
          where ${includeInactive} or is_active
          order by position, name
        `;
        return rows.map((r) => ({
          key: r.key,
          name: r.name,
          description: r.description,
          isActive: r.is_active,
          position: r.position,
        }));
      });
    },

    /* ------------------------------------------------- administration */

    async createStage(input): Promise<WorkflowStage> {
      return tx(async (sql) => {
        const rows = await sql<StageRow[]>`
          insert into config.workflow_stages (
            definition_id, key, name, position, methodology_stage,
            is_terminal, requires_approval, description
          ) values (
            ${input.definitionId}::uuid, ${input.key}, ${input.name},
            ${input.position}, ${input.methodologyStage ?? null},
            ${input.isTerminal ?? false}, ${input.requiresApproval ?? false},
            ${input.description ?? null}
          )
          returning *
        `;

        await sql`
          select audit.write(
            'workflow_stage.created', 'config.workflow_stages', ${rows[0].id},
            null, null,
            ${sql.json({ key: input.key, name: input.name, position: input.position })},
            'lifecycle stage added'
          )
        `;

        return toStage(rows[0]);
      });
    },

    async renameStage(id: string, name: string): Promise<WorkflowStage> {
      return tx(async (sql) => {
        const before = await sql<StageRow[]>`
          select * from config.workflow_stages where id = ${id}::uuid
        `;
        if (before.length === 0) {
          throw new CaseworkError("not_found", "That lifecycle stage no longer exists.");
        }

        const rows = await sql<StageRow[]>`
          update config.workflow_stages set name = ${name}
          where id = ${id}::uuid
          returning *
        `;

        // The key is deliberately not renameable: cases reference the stage by
        // id, but the key appears in permission grants and in saved filters,
        // so renaming it would break them silently. PRD 4.3 asks for renaming,
        // which is what the display name is for.
        await sql`
          select audit.write(
            'workflow_stage.renamed', 'config.workflow_stages', ${id}, null,
            ${sql.json({ name: before[0].name })},
            ${sql.json({ name })},
            'lifecycle stage renamed'
          )
        `;

        return toStage(rows[0]);
      });
    },

    async reorderStages(definitionId: string, orderedStageIds: string[]): Promise<void> {
      await tx(async (sql) => {
        const existingStages = await sql<{ id: string }[]>`
          select id from config.workflow_stages
          where definition_id = ${definitionId}::uuid
        `;
        const known = new Set(existingStages.map((s) => s.id));
        if (orderedStageIds.length !== known.size) {
          throw new CaseworkError(
            "validation_failed",
            "Reordering has to list every stage of the lifecycle exactly once.",
            { given: orderedStageIds.length, expected: known.size },
          );
        }
        for (const id of orderedStageIds) {
          if (!known.has(id)) {
            throw new CaseworkError(
              "validation_failed",
              "That stage does not belong to this lifecycle.",
            );
          }
        }

        // Position is UNIQUE per definition, so assigning the new numbers
        // directly would collide with whatever holds them now. Moving every
        // row into a range nothing occupies first avoids needing to work out
        // a collision-free order.
        await sql`
          update config.workflow_stages
          set position = position + 100000
          where definition_id = ${definitionId}::uuid
        `;

        for (const [index, id] of orderedStageIds.entries()) {
          await sql`
            update config.workflow_stages
            set position = ${(index + 1) * 10}
            where id = ${id}::uuid
          `;
        }

        await sql`
          select audit.write(
            'workflow.reordered', 'config.workflow_definitions', ${definitionId},
            null, null, ${sql.json({ order: orderedStageIds })},
            'lifecycle stages reordered'
          )
        `;
      });
    },

    async addTransition(input): Promise<void> {
      await tx(async (sql) => {
        if (input.fromStageId === input.toStageId) {
          throw new CaseworkError(
            "validation_failed",
            "A transition has to go somewhere other than where it starts.",
          );
        }

        await sql`
          insert into config.workflow_transitions (
            definition_id, from_stage_id, to_stage_id,
            required_permission, requires_reason
          ) values (
            ${input.definitionId}::uuid, ${input.fromStageId}::uuid,
            ${input.toStageId}::uuid, ${input.requiredPermission ?? null},
            ${input.requiresReason ?? true}
          )
          on conflict (definition_id, from_stage_id, to_stage_id) do nothing
        `;

        await sql`
          select audit.write(
            'workflow_transition.added', 'config.workflow_transitions',
            ${input.fromStageId}, null, null,
            ${sql.json({ to: input.toStageId, permission: input.requiredPermission ?? null })},
            'lifecycle transition added'
          )
        `;
      });
    },

    async removeTransition(id: string): Promise<void> {
      await tx(async (sql) => {
        const rows = await sql`
          delete from config.workflow_transitions where id = ${id}::uuid
          returning from_stage_id, to_stage_id
        `;
        if (rows.count === 0) {
          throw new CaseworkError("not_found", "That transition no longer exists.");
        }
        await sql`
          select audit.write(
            'workflow_transition.removed', 'config.workflow_transitions', ${id},
            null, ${sql.json(rows[0])}, null, 'lifecycle transition removed'
          )
        `;
      });
    },

    async transition(id: string) {
      return tx(async (sql) => {
        const rows = await sql<
          {
            id: string;
            from_stage_id: string;
            from_stage_name: string;
            from_stage_is_terminal: boolean;
            to_stage_id: string;
            to_stage_name: string;
            sibling_count: string;
          }[]
        >`
          select t.id,
                 t.from_stage_id,
                 src.name as from_stage_name,
                 src.is_terminal as from_stage_is_terminal,
                 t.to_stage_id,
                 dst.name as to_stage_name,
                 (
                   select count(*) from config.workflow_transitions other
                   where other.from_stage_id = t.from_stage_id
                 ) as sibling_count
          from config.workflow_transitions t
          join config.workflow_stages src on src.id = t.from_stage_id
          join config.workflow_stages dst on dst.id = t.to_stage_id
          where t.id = ${id}::uuid
        `;
        if (rows.length === 0) return null;
        const row = rows[0];
        return {
          id: row.id,
          fromStageId: row.from_stage_id,
          fromStageName: row.from_stage_name,
          fromStageIsTerminal: row.from_stage_is_terminal,
          toStageId: row.to_stage_id,
          toStageName: row.to_stage_name,
          siblingCount: Number(row.sibling_count),
        };
      });
    },

    async stageUsage(definitionId: string) {
      return tx(async (sql) => {
        const rows = await sql<{ stage_id: string; cases: string }[]>`
          select s.id as stage_id, count(c.id) as cases
          from config.workflow_stages s
          left join casework.cases c
            on c.stage_id = s.id and c.deleted_at is null
          where s.definition_id = ${definitionId}::uuid
          group by s.id
        `;
        return rows.map((row) => ({
          stageId: row.stage_id,
          cases: Number(row.cases),
        }));
      });
    },

    async upsertCaseType(input): Promise<CaseType> {
      return tx(async (sql) => {
        const rows = await sql<
          {
            key: string;
            name: string;
            description: string | null;
            is_active: boolean;
            position: number;
          }[]
        >`
          insert into config.case_types (key, name, description, is_active, position)
          values (${input.key}, ${input.name}, ${input.description ?? null},
                  ${input.isActive ?? true}, ${input.position ?? 0})
          on conflict (key) do update
            set name = excluded.name,
                description = excluded.description,
                is_active = excluded.is_active,
                position = excluded.position
          returning *
        `;

        await sql`
          select audit.write(
            'case_type.saved', 'config.case_types', ${input.key}, null, null,
            ${sql.json({ name: input.name, isActive: input.isActive ?? true })},
            'case type configured'
          )
        `;

        return {
          key: rows[0].key,
          name: rows[0].name,
          description: rows[0].description,
          isActive: rows[0].is_active,
          position: rows[0].position,
        };
      });
    },

    async setCaseTypeActive(key: string, isActive: boolean): Promise<void> {
      await tx(async (sql) => {
        // Deactivating rather than deleting: cases reference the type, and a
        // type that is no longer offered for new cases still has to render on
        // the old ones.
        const rows = await sql`
          update config.case_types set is_active = ${isActive}
          where key = ${key}
          returning key
        `;
        if (rows.count === 0) {
          throw new CaseworkError("not_found", "That case type no longer exists.");
        }
        await sql`
          select audit.write(
            'case_type.availability_changed', 'config.case_types', ${key}, null,
            ${sql.json({ isActive: !isActive })}, ${sql.json({ isActive })},
            ${isActive ? "case type enabled" : "case type retired"}
          )
        `;
      });
    },
  };
}
