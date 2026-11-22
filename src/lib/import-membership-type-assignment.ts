import type { StructuredAuditEvent } from "@/lib/audit";

/**
 * One import-sourced seasonal membership assignment, previewed then saved the
 * way an officer's own change is, with the per-member Xero contact-group sync
 * left to the caller's batched reconcile. Shared by the Xero member import
 * (#2108) and the member CSV import's Membership Type column (#4988).
 *
 * A refusal from either step comes back as its sentence; anything thrown is the
 * caller's to log and report.
 */
export async function saveImportMembershipTypeAssignment(input: {
  memberId: string;
  membershipTypeId: string;
  seasonYear: number;
  clubTodayDateOnly: Date;
  adminMemberId: string;
  reason: string;
  request?: StructuredAuditEvent["request"];
}): Promise<{ ok: true } | { ok: false; error: string }> {
  // Lazily loaded to keep the seasonal module (and its Xero/email graph) off
  // the import paths' module graph and out of the import cycle.
  const { getSeasonalMembershipChangePreview, saveSeasonalMembershipAssignment } =
    await import("@/lib/seasonal-membership-assignments");

  const previewResult = await getSeasonalMembershipChangePreview({
    memberId: input.memberId,
    seasonYear: input.seasonYear,
    membershipTypeId: input.membershipTypeId,
    now: input.clubTodayDateOnly,
    clubCurrentSeasonYear: input.seasonYear,
  });
  if (previewResult.init?.status && previewResult.init.status >= 400) {
    return {
      ok: false,
      error:
        (previewResult.body as { error?: string } | undefined)?.error ??
        "Failed to preview membership type assignment",
    };
  }
  const previewToken = (previewResult.body as { preview: { previewToken: string } }).preview.previewToken;

  const saveResult = await saveSeasonalMembershipAssignment({
    memberId: input.memberId,
    seasonYear: input.seasonYear,
    membershipTypeId: input.membershipTypeId,
    adminMemberId: input.adminMemberId,
    reason: input.reason,
    previewToken,
    source: "IMPORT",
    skipXeroContactGroupSync: true,
    request: input.request,
  });
  if (saveResult.init?.status && saveResult.init.status >= 400) {
    return {
      ok: false,
      error:
        (saveResult.body as { error?: string } | undefined)?.error ??
        "Failed to save membership type assignment",
    };
  }
  return { ok: true };
}
