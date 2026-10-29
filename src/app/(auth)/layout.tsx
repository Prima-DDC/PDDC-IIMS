import type { ReactNode } from "react";
import { ShieldCheck } from "lucide-react";
import { ThemeToggle } from "@/components/ThemeToggle";

/**
 * Shell for the sign-in screens.
 *
 * Carries the PDDC mark and the same calm palette as the rest of the platform,
 * so the first screen already looks like the product rather than a generic
 * form. No navigation: there is nowhere to go until you are signed in.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center justify-between px-5 py-4">
        <div className="flex items-center gap-2.5">
          <span className="grid size-9 place-items-center rounded-lg bg-ink text-on-ink">
            <ShieldCheck className="size-5" aria-hidden="true" />
          </span>
          <div className="leading-tight">
            <p className="text-sm font-semibold text-body">PDDC IIMS</p>
            <p className="text-[10px] tracking-wide text-faint uppercase">
              Prima Due Diligence Consult
            </p>
          </div>
        </div>
        <ThemeToggle />
      </header>

      <main className="flex flex-1 items-center justify-center px-5 py-8">
        <div className="w-full max-w-sm">{children}</div>
      </main>

      <footer className="px-5 py-5 text-center text-[11px] text-faint">
        <p>
          Authorised use only. All access to this system is recorded in an
          append-only audit trail.
        </p>
      </footer>
    </div>
  );
}
