import { FileQuestion } from "lucide-react";
import { ButtonLink, Card } from "@/components/ui";

/**
 * The 404 page.
 *
 * Also what a signed-in user sees when they reach a section they have no
 * administration rights for at all: the existence of that section is not
 * information they need, so the layout returns notFound() rather than a 403.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4 py-10">
      <div className="w-full max-w-md animate-fade-up">
        <Card>
          <div className="flex flex-col items-center text-center">
            <span className="mb-4 grid size-12 place-items-center rounded-full bg-surface-sunken text-muted">
              <FileQuestion className="size-6" aria-hidden="true" />
            </span>

            <h1 className="text-lg font-semibold tracking-tight text-body">
              Page not found
            </h1>
            <p className="mt-2 text-sm text-muted">
              That address does not match anything you can reach. It may have
              moved, or the record may have been removed.
            </p>

            <div className="mt-6">
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
