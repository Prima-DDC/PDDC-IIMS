import "server-only";
import type postgres from "postgres";
import { applyActorSettings, withActor, type ActorContext } from "@/lib/db/client";
import { ReportingError } from "../domain/errors";
import type {
  Delivery,
  QaChecklistItem,
  QaReview,
  QaReviewItem,
} from "../domain/types";
import type { DeliveryRepository, QaRepository } from "../application/ports";

/**
 * QA review and client delivery (PRD 10.2, 10.3).
 *
 * Two repositories in one file because they are the last two gates before a
 * client reads the work, and both are small.
 *
 * The QA result is never written from what a reviewer clicked: `complete`
 * takes the result the application derived from the items, and the database
 * refuses an approval with a failed item. Three places say the same thing,
 * which for the last gate before a client is the right number.
 */

const DIRECTORY = (sql: postgres.TransactionSql) => sql`
  select user_id, full_name
  from iam.profile_basics(
    (select coalesce(array_agg(id), '{}'::uuid[]) from iam.users)
  )
`;

function transactor(actor: ActorContext, existing?: postgres.TransactionSql) {
  return async <T>(
    work: (sql: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> => {
    if (!existing) return withActor(actor, work) as Promise<T>;
    await applyActorSettings(existing, actor);
    return work(existing);
  };
}

interface ReviewRow {
  id: string;
  report_id: string;
  version_id: string;
  version_label: string;
  reviewer: string;
  reviewer_name: string | null;
  result: "approved" | "returned" | null;
  summary: string | null;
  started_at: string;
  completed_at: string | null;
  version: number;
}

interface ItemRow {
  id: string;
  review_id: string;
  item_key: string;
  label: string;
  guidance: string | null;
  position: number;
  result: QaReviewItem["result"];
  comment: string | null;
}

export function createQaRepository(
  actor: ActorContext,
  existing?: postgres.TransactionSql,
): QaRepository {
  const tx = transactor(actor, existing);

  const itemsFor = async (
    sql: postgres.TransactionSql,
    reviewIds: string[],
  ): Promise<Map<string, QaReviewItem[]>> => {
    if (reviewIds.length === 0) return new Map();

    const rows = await sql<ItemRow[]>`
      select
        i.id, i.review_id, i.item_key, c.label, c.guidance, c.position,
        i.result, i.comment
      from reporting.qa_review_items i
      join config.qa_checklist_items c on c.key = i.item_key
      where i.review_id = any(${reviewIds}::uuid[])
      order by c.position
    `;

    const grouped = new Map<string, QaReviewItem[]>();
    for (const row of rows) {
      const list = grouped.get(row.review_id) ?? [];
      list.push({
        id: row.id,
        reviewId: row.review_id,
        itemKey: row.item_key,
        label: row.label,
        guidance: row.guidance,
        position: row.position,
        result: row.result,
        comment: row.comment,
      });
      grouped.set(row.review_id, list);
    }
    return grouped;
  };

  const toReview = (row: ReviewRow, items: QaReviewItem[]): QaReview => ({
    id: row.id,
    reportId: row.report_id,
    versionId: row.version_id,
    versionLabel: row.version_label,
    reviewer: row.reviewer,
    reviewerName: row.reviewer_name,
    result: row.result,
    summary: row.summary,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    items,
    version: row.version,
  });

  const REVIEW_SELECT = (sql: postgres.TransactionSql) => sql`
    select
      q.id, q.report_id, q.version_id, v.version_label,
      q.reviewer, rv.full_name as reviewer_name,
      q.result, q.summary, q.started_at, q.completed_at, q.version
    from reporting.qa_reviews q
    join reporting.report_versions v on v.id = q.version_id
    left join directory rv on rv.user_id = q.reviewer
  `;

  const load = async (
    sql: postgres.TransactionSql,
    reviewId: string,
  ): Promise<QaReview | null> => {
    const rows = await sql<ReviewRow[]>`
      with directory as (${DIRECTORY(sql)})
      ${REVIEW_SELECT(sql)}
      where q.id = ${reviewId}::uuid
    `;
    if (rows.length === 0) return null;
    const items = await itemsFor(sql, [reviewId]);
    return toReview(rows[0], items.get(reviewId) ?? []);
  };

  return {
    async checklist() {
      return tx(async (sql) => {
        const rows = await sql<QaChecklistItem[]>`
          select key, label, guidance, position
          from config.qa_checklist_items
          where is_active
          order by position
        `;
        return rows;
      });
    },

    async reviews(reportId) {
      return tx(async (sql) => {
        const rows = await sql<ReviewRow[]>`
          with directory as (${DIRECTORY(sql)})
          ${REVIEW_SELECT(sql)}
          where q.report_id = ${reportId}::uuid
          order by q.started_at desc
        `;
        const items = await itemsFor(
          sql,
          rows.map((row) => row.id),
        );
        return rows.map((row) => toReview(row, items.get(row.id) ?? []));
      });
    },

    async findReview(reviewId) {
      return tx((sql) => load(sql, reviewId));
    },

    /**
     * Opens a review, or hands back the one already open on this version.
     *
     * Idempotent on purpose: a reviewer who reloads the screen should not
     * start a second review and lose the answers in the first.
     */
    async open(input) {
      return tx(async (sql) => {
        const existingReview = await sql<{ id: string }[]>`
          select id from reporting.qa_reviews
          where version_id = ${input.versionId}::uuid
            and reviewer = ${actor.userId}::uuid
            and completed_at is null
          limit 1
        `;

        if (existingReview.length > 0) {
          const review = await load(sql, existingReview[0].id);
          if (review) return review;
        }

        const [created] = await sql<{ id: string }[]>`
          insert into reporting.qa_reviews (
            report_id, version_id, reviewer, created_by, updated_by
          ) values (
            ${input.reportId}::uuid, ${input.versionId}::uuid,
            ${actor.userId}::uuid, ${actor.userId}::uuid, ${actor.userId}::uuid
          )
          returning id
        `;

        await sql`
          select audit.write(
            'qa.review_opened', 'reporting.qa_reviews', ${created.id},
            null, null, ${sql.json({ versionId: input.versionId })}, null, null
          )
        `;

        const review = await load(sql, created.id);
        if (!review) {
          throw new ReportingError(
            "not_found",
            "That review was opened but cannot be read back.",
          );
        }
        return review;
      });
    },

    async answer(input) {
      await tx(async (sql) => {
        await sql`
          insert into reporting.qa_review_items (
            review_id, item_key, result, comment, created_by, updated_by
          ) values (
            ${input.reviewId}::uuid, ${input.itemKey}, ${input.result},
            ${input.comment ?? null}, ${actor.userId}::uuid, ${actor.userId}::uuid
          )
          on conflict (review_id, item_key) do update
            set result = excluded.result,
                comment = excluded.comment,
                updated_by = ${actor.userId}::uuid
        `;
      });
    },

    async complete(input) {
      return tx(async (sql) => {
        const result = await sql`
          update reporting.qa_reviews set
            result = ${input.result},
            summary = ${input.summary ?? null},
            completed_at = now(),
            updated_by = ${actor.userId}::uuid
          where id = ${input.reviewId}::uuid and completed_at is null
        `;
        if (result.count === 0) {
          throw new ReportingError(
            "conflict",
            "That review has already been completed, or no longer exists.",
          );
        }

        await sql`
          select audit.write(
            'qa.review_completed', 'reporting.qa_reviews', ${input.reviewId},
            null, null, ${sql.json({ result: input.result })},
            ${input.summary ?? null}, null
          )
        `;

        const review = await load(sql, input.reviewId);
        if (!review) {
          throw new ReportingError("not_found", "That review no longer exists.");
        }
        return review;
      });
    },

    async returnRate(filter) {
      return tx(async (sql) => {
        const [row] = await sql<{ completed: string; returned: string }[]>`
          select
            count(*) as completed,
            count(*) filter (where result = 'returned') as returned
          from reporting.qa_reviews
          where completed_at is not null
            and (${filter.since ?? null}::timestamptz is null
                 or completed_at >= ${filter.since ?? null}::timestamptz)
        `;

        const completed = Number(row.completed);
        return {
          reviewsCompleted: completed,
          returned: Number(row.returned),
          // Null rather than zero when nothing has been reviewed: a return
          // rate of 0% reads as "we never send anything back", which is a
          // different claim from "we have not reviewed anything".
          rate: completed === 0 ? null : Number(row.returned) / completed,
        };
      });
    },
  };
}

/* -------------------------------------------------------------- delivery */

interface DeliveryRow {
  id: string;
  report_id: string;
  version_id: string;
  version_label: string;
  delivered_to: string;
  delivery_method: Delivery["deliveryMethod"];
  delivered_at: string;
  delivered_by: string;
  delivered_by_name: string | null;
  acknowledgement: string | null;
  acknowledged_at: string | null;
  acknowledged_by_name: string | null;
  notes: string | null;
  version: number;
}

function toDelivery(row: DeliveryRow): Delivery {
  return {
    id: row.id,
    reportId: row.report_id,
    versionId: row.version_id,
    versionLabel: row.version_label,
    deliveredTo: row.delivered_to,
    deliveryMethod: row.delivery_method,
    deliveredAt: row.delivered_at,
    deliveredBy: row.delivered_by,
    deliveredByName: row.delivered_by_name,
    acknowledgement: row.acknowledgement,
    acknowledgedAt: row.acknowledged_at,
    acknowledgedByName: row.acknowledged_by_name,
    notes: row.notes,
    version: row.version,
  };
}

export function createDeliveryRepository(
  actor: ActorContext,
  existing?: postgres.TransactionSql,
): DeliveryRepository {
  const tx = transactor(actor, existing);

  const DELIVERY_SELECT = (sql: postgres.TransactionSql) => sql`
    select
      d.id, d.report_id, d.version_id, v.version_label,
      d.delivered_to, d.delivery_method, d.delivered_at,
      d.delivered_by, db.full_name as delivered_by_name,
      d.acknowledgement, d.acknowledged_at, d.acknowledged_by_name,
      d.notes, d.version
    from reporting.deliveries d
    join reporting.report_versions v on v.id = d.version_id
    left join directory db on db.user_id = d.delivered_by
  `;

  return {
    async forReport(reportId) {
      return tx(async (sql) => {
        const rows = await sql<DeliveryRow[]>`
          with directory as (${DIRECTORY(sql)})
          ${DELIVERY_SELECT(sql)}
          where d.report_id = ${reportId}::uuid
          order by d.delivered_at desc
        `;
        return rows.map(toDelivery);
      });
    },

    async record(input) {
      return tx(async (sql) => {
        const [created] = await sql<{ id: string }[]>`
          insert into reporting.deliveries (
            report_id, version_id, delivered_to, delivery_method,
            delivered_by, notes, created_by, updated_by
          ) values (
            ${input.reportId}::uuid, ${input.versionId}::uuid,
            ${input.deliveredTo}, ${input.deliveryMethod},
            ${actor.userId}::uuid, ${input.notes ?? null},
            ${actor.userId}::uuid, ${actor.userId}::uuid
          )
          returning id
        `;

        await sql`
          select audit.write(
            'report.delivered', 'reporting.deliveries', ${created.id},
            null, null,
            ${sql.json({
              deliveredTo: input.deliveredTo,
              method: input.deliveryMethod,
            })},
            null, null
          )
        `;

        const rows = await sql<DeliveryRow[]>`
          with directory as (${DIRECTORY(sql)})
          ${DELIVERY_SELECT(sql)}
          where d.id = ${created.id}::uuid
        `;
        if (rows.length === 0) {
          throw new ReportingError(
            "not_found",
            "That delivery was recorded but cannot be read back.",
          );
        }
        return toDelivery(rows[0]);
      });
    },

    async acknowledge(input) {
      return tx(async (sql) => {
        const result = await sql`
          update reporting.deliveries set
            acknowledgement = ${input.acknowledgement},
            acknowledged_at = now(),
            acknowledged_by_name = ${input.acknowledgedByName ?? null},
            updated_by = ${actor.userId}::uuid
          where id = ${input.deliveryId}::uuid
        `;
        if (result.count === 0) {
          throw new ReportingError("not_found", "That delivery no longer exists.");
        }

        const rows = await sql<DeliveryRow[]>`
          with directory as (${DIRECTORY(sql)})
          ${DELIVERY_SELECT(sql)}
          where d.id = ${input.deliveryId}::uuid
        `;
        return toDelivery(rows[0]);
      });
    },

    async anyForCase(caseId) {
      return tx(async (sql) => {
        const [row] = await sql<{ any: boolean }[]>`
          select exists (
            select 1 from reporting.deliveries d
            join reporting.reports r on r.id = d.report_id
            where r.case_id = ${caseId}::uuid and r.deleted_at is null
          ) as any
        `;
        return row.any;
      });
    },
  };
}
