import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";

export const MEMBERSHIP_CANCELLATION_SETTINGS_ID = "default";

export const DEFAULT_MEMBERSHIP_CANCELLATION_WARNING_TEXT =
  "Cancelling membership removes member booking access once approved. Existing bookings, credits, refunds, and unpaid invoices still need separate committee review.";

export const DEFAULT_MEMBERSHIP_REJOIN_PROCESS_TEXT =
  "Former members can reapply through the normal membership process. The committee will confirm any outstanding balances and restore access only after the rejoin process is approved.";

export interface MembershipCancellationXeroContactGroupSetting {
  groupId: string;
  groupName: string | null;
}

export interface MembershipCancellationSettings {
  warningText: string;
  rejoinProcessText: string;
  xeroArchiveContactsOnCancellation: boolean;
  xeroContactGroups: MembershipCancellationXeroContactGroupSetting[];
}

export interface PersistedMembershipCancellationSettings {
  warningText: string | null;
  rejoinProcessText: string | null;
  xeroArchiveContactsOnCancellation: boolean;
  updatedAt?: Date | string | null;
  updatedByMemberId?: string | null;
  xeroContactGroups?:
    | readonly Partial<MembershipCancellationXeroContactGroupSetting>[]
    | null;
}

function trimOptional(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function normalizeMembershipCancellationXeroGroups(
  groups?: readonly Partial<MembershipCancellationXeroContactGroupSetting>[] | null,
): MembershipCancellationXeroContactGroupSetting[] {
  const seen = new Set<string>();
  const normalized: MembershipCancellationXeroContactGroupSetting[] = [];

  for (const group of groups ?? []) {
    const groupId = trimOptional(group.groupId);
    if (!groupId || seen.has(groupId)) {
      continue;
    }

    seen.add(groupId);
    normalized.push({
      groupId,
      groupName: trimOptional(group.groupName) ?? null,
    });
  }

  return normalized;
}

export function getDefaultMembershipCancellationSettings(): MembershipCancellationSettings {
  return {
    warningText: DEFAULT_MEMBERSHIP_CANCELLATION_WARNING_TEXT,
    rejoinProcessText: DEFAULT_MEMBERSHIP_REJOIN_PROCESS_TEXT,
    xeroArchiveContactsOnCancellation: false,
    xeroContactGroups: [],
  };
}

export function normalizeMembershipCancellationSettings(
  persisted?: Partial<PersistedMembershipCancellationSettings> | null,
): MembershipCancellationSettings {
  const defaults = getDefaultMembershipCancellationSettings();
  return {
    warningText: trimOptional(persisted?.warningText) ?? defaults.warningText,
    rejoinProcessText:
      trimOptional(persisted?.rejoinProcessText) ?? defaults.rejoinProcessText,
    xeroArchiveContactsOnCancellation: Boolean(
      persisted?.xeroArchiveContactsOnCancellation,
    ),
    xeroContactGroups: normalizeMembershipCancellationXeroGroups(
      persisted?.xeroContactGroups,
    ),
  };
}

export async function loadPersistedMembershipCancellationSettings(): Promise<
  PersistedMembershipCancellationSettings | null
> {
  // Some unit tests stub @/lib/prisma with a partial client that omits
  // this delegate. Keep an existence check so those tests still run, but
  // do not use it as a catch-all for generic database errors.
  const delegate = prisma.membershipCancellationSetting;
  if (!delegate) return null;

  try {
    return await delegate.findUnique({
      where: { id: MEMBERSHIP_CANCELLATION_SETTINGS_ID },
      include: {
        xeroContactGroups: {
          orderBy: [{ groupName: "asc" }, { groupId: "asc" }],
        },
      },
    });
  } catch (err) {
    logger.warn(
      { err },
      "membership cancellation settings load failed",
    );
    return null;
  }
}

export async function loadMembershipCancellationSettings(): Promise<MembershipCancellationSettings> {
  return normalizeMembershipCancellationSettings(
    await loadPersistedMembershipCancellationSettings(),
  );
}
