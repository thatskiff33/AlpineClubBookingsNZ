/**
 * Shared admin-member display helpers.
 *
 * The lifecycle status (`getLifecycleStatusConfig`), the login badge
 * (`getLoginBadge`) and the short finance access labels the status chip
 * renders live here, so the members list, the member detail page and the
 * diagnostics booking-evidence pack cannot drift on a label or colour.
 */
import type { FinanceAccessLevel } from "@prisma/client";

// test seam
export const financeAccessShortLabels: Record<FinanceAccessLevel, string> = {
  NONE: "None",
  VIEWER: "Viewer",
  MANAGER: "Manager",
};

export type MemberLifecycleInput = {
  active: boolean;
  cancelledAt: Date | string | null;
  archivedAt: Date | string | null;
  /**
   * True when an approved deletion request has anonymised this member (#2620).
   * Supplied as a resolved boolean rather than the raw markers so this module
   * stays a dependency-free leaf safe to import from a client component — the
   * server computes it with `isDeletedAccountRecord` (src/lib/deleted-account.ts)
   * and the members-list response carries it.
   */
  deletedAccount?: boolean;
};

export type LifecycleStatusConfig = {
  label: "Active" | "Inactive" | "Cancelled" | "Archived" | "Deleted";
  className: string;
};

const LIFECYCLE_CONFIG = {
  Deleted: {
    label: "Deleted" as const,
    className: "bg-danger-3 text-danger-11 border-danger-6 hover:bg-danger-3",
  },
  Archived: {
    label: "Archived" as const,
    className: "bg-accent text-foreground border-border hover:bg-accent",
  },
  Cancelled: {
    label: "Cancelled" as const,
    className: "bg-warning-3 text-warning-11 border-warning-6 hover:bg-warning-3",
  },
  Active: {
    label: "Active" as const,
    className: "bg-success-3 text-success-11 hover:bg-success-4 border-success-6",
  },
  Inactive: {
    label: "Inactive" as const,
    className: "",
  },
} satisfies Record<LifecycleStatusConfig["label"], LifecycleStatusConfig>;

/**
 * Pick the badge label + colour class for a member's lifecycle state.
 * Deletion wins over everything; archive wins over cancellation; cancellation
 * wins over inactive.
 *
 * Deletion leads because it is the only terminal state and because it is
 * otherwise INVISIBLE (#2620): anonymisation sets `active: false` and stamps
 * neither `cancelledAt` nor `archivedAt`, so an erased account rendered
 * "Inactive" is indistinguishable in the list from a member someone deactivated
 * yesterday — which is how an officer undoing a mistaken bulk deactivate could
 * select one for Reactivate without meaning to.
 */
export function getLifecycleStatusConfig(
  member: MemberLifecycleInput,
): LifecycleStatusConfig {
  if (member.deletedAccount) return LIFECYCLE_CONFIG.Deleted;
  if (member.archivedAt) return LIFECYCLE_CONFIG.Archived;
  if (member.cancelledAt) return LIFECYCLE_CONFIG.Cancelled;
  if (member.active) return LIFECYCLE_CONFIG.Active;
  return LIFECYCLE_CONFIG.Inactive;
}

// test seam
export const LOGIN_BADGE = {
  className: "bg-muted text-muted-foreground border-border",
  label: "Can Login",
} as const;

// test seam
export const NON_LOGIN_BADGE = {
  className: "bg-cat1-3 text-cat1-11 border-cat1-6",
  label: "Non-Login",
} as const;

export function getLoginBadge(canLogin: boolean) {
  return canLogin ? LOGIN_BADGE : NON_LOGIN_BADGE;
}
