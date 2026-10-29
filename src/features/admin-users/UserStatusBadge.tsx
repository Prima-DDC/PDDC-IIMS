import { Badge } from "@/components/ui";
import { USER_STATUS_LABELS, type UserStatus } from "@/modules/iam/shared";

const TONES: Record<UserStatus, "ok" | "info" | "warn" | "danger" | "neutral"> = {
  active: "ok",
  invited: "info",
  suspended: "warn",
  deactivated: "neutral",
  archived: "neutral",
};

export function UserStatusBadge({
  status,
  lockedUntil,
}: {
  status: UserStatus;
  lockedUntil?: string | null;
}) {
  // A lockout is more urgent than the underlying status, so it wins the badge.
  const locked = lockedUntil && new Date(lockedUntil) > new Date();

  if (locked) {
    return <Badge tone="danger">Locked out</Badge>;
  }

  return <Badge tone={TONES[status]}>{USER_STATUS_LABELS[status]}</Badge>;
}
