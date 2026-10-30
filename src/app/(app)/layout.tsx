import { AppLink } from "@/components/AppLink";
import type { ReactNode } from "react";
import { FolderLock } from "lucide-react";
import { BottomNavBar } from "@/components/BottomNavBar";
import { CommandPalette } from "@/components/CommandPalette";
import { GlassTopBar } from "@/components/GlassTopBar";
import { ThemeToggle } from "@/components/ThemeToggle";
import { requireActor } from "@/lib/auth/session";
import { buildNavigation } from "@/features/site-layout/navigation";
import { NotificationBell } from "@/features/notifications/NotificationBell";
import { getUnreadNotificationCount } from "@/features/notifications/queries";
import { SideNav } from "@/features/site-layout/SideNav";
import { UserMenu } from "@/features/site-layout/UserMenu";

/**
 * The signed-in application shell.
 *
 * requireActor() runs the full per-request gate here: authentication, MFA,
 * IIMS access, account status, lockout and session liveness. Every page below
 * this layout can therefore assume a valid actor.
 *
 * Navigation is assembled from that actor's effective permissions, so the menu
 * never offers a destination that would 403.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const actor = await requireActor();
  const [nav, unread] = await Promise.all([
    buildNavigation(actor),
    getUnreadNotificationCount(actor),
  ]);

  return (
    <div className="min-h-dvh">
      <GlassTopBar>
        <AppLink href="/dashboard" className="flex items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-md bg-ink text-on-ink">
            <FolderLock className="size-4" aria-hidden="true" />
          </span>
          <span className="leading-tight">
            <span className="block text-sm font-semibold text-body">PDDC IIMS</span>
            <span className="block text-[10px] tracking-wide text-faint uppercase">
              Investigation platform
            </span>
          </span>
        </AppLink>

        <div className="ml-auto flex items-center gap-1.5 sm:gap-2.5">
          {/*
            Already filtered by this actor's effective permissions, so the
            palette cannot offer a destination that would then refuse them.
          */}
          <CommandPalette
            entries={nav.all.map((entry) => ({
              href: entry.href,
              label: entry.label,
              icon: entry.icon,
            }))}
          />
          <NotificationBell unread={unread} />
          <ThemeToggle />
          <UserMenu
            fullName={actor.fullName}
            email={actor.email}
            clearance={actor.clearance}
            primaryRole={actor.primaryRole}
            isAdministrator={actor.isAdministrator}
          />
        </div>
      </GlassTopBar>

      <div className="mx-auto flex max-w-[1600px]">
        <SideNav entries={nav.all} />

        <main className="mb-bottom-nav min-w-0 flex-1 px-4 py-6 sm:px-6 md:mb-0">
          {children}
        </main>
      </div>

      {/* Required on every dashboard at tablet and phone width. */}
      <BottomNavBar
        items={nav.primary.map((e) => ({
          href: e.href,
          label: e.label,
          icon: e.icon,
        }))}
        moreItems={nav.secondary.map((e) => ({
          href: e.href,
          label: e.label,
          icon: e.icon,
        }))}
      />
    </div>
  );
}
