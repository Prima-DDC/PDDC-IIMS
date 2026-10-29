import { AppLink } from "@/components/AppLink";
import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { Alert, Badge, Card, Id, PageHeader, Table, Td, Th } from "@/components/ui";
import { can, requireActor } from "@/lib/auth/session";
import { ACCESS_REQUEST_LABELS, iam } from "@/modules/iam";
import { DecideRequest } from "@/features/admin-org/DecideRequest";

export const metadata: Metadata = { title: "Overrides and approvals" };

/**
 * The two-person approval queue (PRD 3.4, screen 28).
 *
 * High-risk changes are not applied when requested: they land here for a
 * second administrator. The requester can never be the approver, which the
 * database enforces with a check constraint, so this screen cannot be the
 * only thing standing in the way.
 */
export default async function OverridesPage() {
  const actor = await requireActor();
  if (!(await can(actor, "users", "view"))) {
    forbidden();
  }

  const api = iam(actor);
  const requests = await api.accessRequests.list({ limit: 100 });

  const pending = requests.filter((r) => r.status === "pending");
  const decided = requests.filter((r) => r.status !== "pending");

  return (
    <div className="space-y-5">
      <PageHeader
        title="Overrides and approvals"
        description="High-risk access changes, waiting on a second administrator."
        breadcrumb={[
          { label: "Administration", href: "/admin" },
          { label: "Overrides and approvals" },
        ]}
      />

      <Alert tone="info" title="What needs two people">
        Granting the Administrator role, granting Strictly Restricted
        clearance, granting delete or export-all permission, changing audit or
        retention settings, and permanently purging a record. An administrator
        can never raise their own privileges, and can never approve their own
        request.
      </Alert>

      <Card
        title={`Pending (${pending.length})`}
        description="Approving records the decision. The requesting administrator then repeats the change on the user's record, which applies it and closes the request."
      >
        {pending.length === 0 ? (
          <p className="text-xs text-muted">Nothing is waiting for approval.</p>
        ) : (
          <div className="space-y-3">
            {pending.map((request) => {
              const mine = request.requestedBy === actor.userId;

              return (
                <div key={request.id} className="rounded-lg border border-line p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-body">
                        {ACCESS_REQUEST_LABELS[request.kind]}
                      </p>
                      <p className="mt-0.5 text-xs text-muted">
                        For{" "}
                        {request.targetUserId ? (
                          <AppLink
                            href={`/admin/users/${request.targetUserId}`}
                            className="text-signal-dark hover:underline"
                          >
                            {request.targetUserName ?? "a user"}
                          </AppLink>
                        ) : (
                          (request.targetRecord ?? "a record")
                        )}
                        , requested by {request.requestedByName ?? "an administrator"} on{" "}
                        {new Date(request.requestedAt).toLocaleString("en-GB")}
                      </p>
                      <p className="mt-1.5 text-xs text-body">{request.reason}</p>
                    </div>

                    <Badge tone="warn">Pending</Badge>
                  </div>

                  <div className="mt-3 border-t border-line pt-3">
                    {mine ? (
                      <p className="text-xs text-muted">
                        You raised this request, so you cannot approve it. Another
                        administrator must decide.
                      </p>
                    ) : (
                      <DecideRequest id={request.id} />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card title="Decided" description="The last 100 decisions, newest first.">
        {decided.length === 0 ? (
          <p className="text-xs text-muted">No decisions recorded yet.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Change</Th>
                <Th>For</Th>
                <Th>Requested by</Th>
                <Th>Decided by</Th>
                <Th>Outcome</Th>
              </tr>
            </thead>
            <tbody>
              {decided.map((request) => (
                <tr key={request.id}>
                  <Td className="text-xs text-body">
                    {ACCESS_REQUEST_LABELS[request.kind]}
                  </Td>
                  <Td className="text-xs text-muted">
                    {request.targetUserName ?? request.targetRecord ?? "not set"}
                  </Td>
                  <Td className="text-xs text-muted">
                    {request.requestedByName ?? <Id>{request.requestedBy}</Id>}
                  </Td>
                  <Td className="text-xs text-muted">
                    {request.decidedByName ?? "not set"}
                  </Td>
                  <Td>
                    <Badge
                      tone={
                        request.status === "approved" || request.status === "applied"
                          ? "ok"
                          : request.status === "rejected"
                            ? "danger"
                            : "neutral"
                      }
                    >
                      {request.status}
                    </Badge>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
