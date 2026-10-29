import { AppLink } from "@/components/AppLink";
import { ArrowRight, Hammer } from "lucide-react";
import { Card, PageHeader } from "@/components/ui";

/**
 * Placeholder for a section whose milestone has not landed yet.
 *
 * Navigation is built from permissions, so a role that will eventually reach
 * Cases already sees the entry. Rather than let that 404, each unbuilt section
 * says plainly what it will contain and which milestone delivers it. Being
 * honest about what is not built yet is more useful than a dead link or a
 * fake screen with invented data in it.
 */
export function ComingInMilestone({
  title,
  milestone,
  summary,
  willInclude,
  prdSection,
}: {
  title: string;
  milestone: string;
  summary: string;
  willInclude: string[];
  prdSection: string;
}) {
  return (
    <div className="space-y-5">
      <PageHeader title={title} description={summary} />

      <Card>
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-warn/12 text-warn">
            <Hammer className="size-4.5" aria-hidden="true" />
          </span>

          <div className="min-w-0">
            <p className="text-sm font-semibold text-body">
              Arriving in {milestone}
            </p>
            <p className="mt-1 text-xs text-muted">
              Specified in PRD {prdSection}. The data model, permissions and
              audit trail this section needs are already in place, so it is the
              screens and workflow that remain.
            </p>

            <p className="mt-4 mb-2 text-[11px] font-semibold tracking-wide text-faint uppercase">
              What it will cover
            </p>
            <ul className="space-y-1.5">
              {willInclude.map((item) => (
                <li key={item} className="flex items-start gap-2 text-xs text-body">
                  <ArrowRight
                    className="mt-0.5 size-3.5 shrink-0 text-signal"
                    aria-hidden="true"
                  />
                  {item}
                </li>
              ))}
            </ul>

            <AppLink
              href="/dashboard"
              className="mt-5 inline-flex items-center gap-1.5 text-xs font-medium text-signal-dark hover:underline"
            >
              Back to the dashboard
              <ArrowRight className="size-3.5" aria-hidden="true" />
            </AppLink>
          </div>
        </div>
      </Card>
    </div>
  );
}
