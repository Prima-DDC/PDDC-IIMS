import { ShieldX } from "lucide-react";
import { ButtonLink, Card } from "@/components/ui";

/**
 * The 403 page, rendered whenever a server component calls forbidden().
 *
 * It says plainly that the person is signed in and recognised but lacks one
 * specific permission, because that is a correctable situation and a 404 would
 * hide it. Navigation is already permission-filtered, so reaching this page
 * normally means a hand-typed URL or a stale bookmark.
 */
export default function Forbidden() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4 py-10">
      <div className="w-full max-w-md animate-fade-up">
        <Card>
          <div className="flex flex-col items-center text-center">
            <span className="mb-4 grid size-12 place-items-center rounded-full bg-danger/12 text-danger">
              <ShieldX className="size-6" aria-hidden="true" />
            </span>

            <h1 className="text-lg font-semibold tracking-tight text-body">
              You do not have permission for this
            </h1>
            <p className="mt-2 text-sm text-muted">
              Your account is recognised, but it does not hold the permission
              this screen needs. If you should have it, an administrator can
              grant it, and the change takes effect without signing in again.
            </p>

            <p className="mt-4 text-xs text-muted">
              The attempt has been recorded in the audit trail.
            </p>

            <div className="mt-6 flex flex-wrap justify-center gap-2">
              <ButtonLink href="/dashboard" tone="primary" size="sm">
                Back to the dashboard
              </ButtonLink>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
