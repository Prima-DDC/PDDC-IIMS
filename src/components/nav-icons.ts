import {
  Bell,
  Briefcase,
  CheckSquare,
  Handshake,
  Inbox,
  ClipboardList,
  FileSearch,
  FileText,
  FolderLock,
  FolderOpen,
  Gauge,
  Home,
  Landmark,
  Network,
  Radio,
  Scale as ScaleIcon,
  Search,
  Scale,
  ShieldAlert,
  Users,
} from "lucide-react";

/**
 * Navigation icon registry, keyed by name.
 *
 * Navigation is assembled on the server from the signed-in user's effective
 * permissions, so a nav item has to survive serialisation across the
 * server/client boundary, and a React component cannot. Items therefore
 * carry an icon *name*, which the client component resolves here.
 *
 * A closed registry also means navigation can never reference an icon that
 * was not bundled.
 */
export const NAV_ICONS = {
  home: Home,
  dashboard: Gauge,
  cases: Briefcase,
  tasks: CheckSquare,
  evidence: FolderLock,
  documents: FolderOpen,
  findings: FileSearch,
  reports: FileText,
  clients: Landmark,
  intake: Inbox,
  engagements: Handshake,
  entities: Network,
  sources: Radio,
  information: ScaleIcon,
  activities: ClipboardList,
  notifications: Bell,
  search: Search,
  safety: ShieldAlert,
  users: Users,
  audit: Scale,
} as const;

export type NavIconName = keyof typeof NAV_ICONS;
