import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { matchesWhere, type WhereInput } from "./support/prisma-where";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/audit", () => ({ createAuditLog: vi.fn() }));
vi.mock("@/lib/club-time/server", () => ({ clubTime: async () => ({ calendarDateOf: () => "2026-07-01" }) }));
vi.mock("@/lib/member-lifecycle-lock", () => ({ acquireMemberLifecycleLocks: vi.fn() }));
vi.mock("@/lib/member-credit", () => ({ getMemberCreditBalance: vi.fn(async () => 0), lockMemberCreditLedger: vi.fn() }));
vi.mock("@/lib/xero-contact-create-recovery", () => ({
  hasMemberContactChangeMergeBlocker: vi.fn(async () => false),
  lockMemberForAccountDeletionXeroFence: vi.fn(), DELETED_ACCOUNT_PASSWORD_HASH: "disabled-password",
}));
vi.mock("@/lib/member-dietary", () => ({ DIETARY_ERASURE_PATCH: { dietaryRequirements: null } }));
vi.mock("@/lib/member-photo", () => ({ deleteOwnedMemberPhotoBlobs: vi.fn() }));
vi.mock("@/lib/member-email-inheritance", () => ({ retireInheritedEmailCopies: vi.fn(), reconcileEmailInheritanceForMemberChange: vi.fn() }));

import { getPrivacyRetentionPreview } from "@/lib/privacy-retention";
import { runFormerMemberAnonymisationJob, runPersonalDataPruneJob } from "@/lib/privacy-retention-jobs";
import { DEFAULT_PRIVACY_RETENTION_SETTINGS } from "@/lib/privacy-retention-shared";
import { createAuditLog } from "@/lib/audit";
import { deleteOwnedMemberPhotoBlobs } from "@/lib/member-photo";
import { getMemberCreditBalance } from "@/lib/member-credit";
import { addUtcYears } from "@/lib/retention-calendar";
import { reconcileEmailInheritanceForMemberChange } from "@/lib/member-email-inheritance";

type Row = Record<string, unknown> & { id: string };
type Args = { where?: WhereInput; data?: Record<string, unknown>; take?: number; skip?: number; select?: Record<string, boolean> };
const NOW = new Date("2026-07-01T00:00:00.000Z");
const BEFORE = new Date("2019-06-30T00:00:00.000Z");
const EMAIL_BOUNDARY = new Date("2024-07-01T00:00:00.000Z");
const APPLICATION_BOUNDARY = new Date("2025-07-01T00:00:00.000Z");

/** Apply the real predicates through the shared evaluator, rather than returning canned candidates. */
function store() {
  const data: Record<string, Row[]> = {
    privacyRetentionSettings: [{ id: "default", ...DEFAULT_PRIVACY_RETENTION_SETTINGS, pruneStartedAt: null, anonymiseStartedAt: null }],
    member: [], emailLog: [], memberApplication: [], familyGroupMember: [], booking: [], memberSubscription: [],
    membershipSubscriptionCharge: [], refundRequest: [], xeroObjectLink: [], bookingGuest: [], xeroContactCache: [],
    magicLinkToken: [], passwordResetToken: [], emailVerificationToken: [], emailChangeToken: [],
    twoFactorEmailCode: [], twoFactorRecoveryCode: [], twoFactorSessionChallenge: [],
  };
  const hooks: { beforeApplicationDelete?: () => void; beforeMemberUpdate?: () => void } = {};
  const delegates = Object.fromEntries(Object.keys(data).map(name => {
    const selected = (args: Args = {}) => data[name].filter(row => matchesWhere(row, args.where));
    const project = (row: Row | undefined, args: Args) => row && args.select
      ? Object.fromEntries(Object.keys(args.select).filter(key => args.select![key]).map(key => [key, row[key]]))
      : row ?? null;
    return [name, {
      findUnique: vi.fn(async (args: Args) => project(selected(args)[0], args)),
      findFirst: vi.fn(async (args: Args) => project(selected(args)[0], args)),
      findMany: vi.fn(async (args: Args = {}) => selected(args).sort((a, b) => a.id.localeCompare(b.id)).slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? Infinity)).map(row => project(row, args))),
      count: vi.fn(async (args: Args) => selected(args).length),
      updateMany: vi.fn(async (args: Args) => {
        if (name === "member") hooks.beforeMemberUpdate?.();
        const rows = selected(args);
        rows.forEach(row => Object.assign(row, args.data));
        return { count: rows.length };
      }),
      deleteMany: vi.fn(async (args: Args) => {
        if (name === "memberApplication") hooks.beforeApplicationDelete?.();
        const removed = selected(args);
        data[name] = data[name].filter(row => !removed.includes(row));
        return { count: removed.length };
      }),
    }];
  }));
  const db = {
    ...delegates, $executeRaw: vi.fn(async () => 1),
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(db)),
  } as unknown as PrismaClient;
  return { db, data, hooks, settings: data.privacyRetentionSettings[0] };
}

function member(id: string, overrides: Record<string, unknown> = {}): Row {
  return {
    id, firstName: "Former", lastName: "Person", email: `${id}@example.invalid`,
    active: false, deletedAt: null, leavingDate: BEFORE, familyGroupId: null, billingFamilyGroupId: null,
    photoImageId: null, xeroContactId: `contact-${id}`, canLogin: true, dietaryRequirements: "Sensitive",
    inheritEmailFromId: null, inheritEmailChoiceId: null, ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getMemberCreditBalance).mockResolvedValue(0);
});

describe("privacy retention selection and execution", () => {
  it("returns the same settings snapshot that selected the preview", async () => {
    const s = store();
    s.settings.emailLogRetentionYears = 5;
    s.data.emailLog.push({ id: "three-years", createdAt: new Date("2023-06-30Z") });
    const preview = await getPrivacyRetentionPreview({ db: s.db, now: NOW });
    expect(preview.settings.emailLogRetentionYears).toBe(5);
    expect(preview.emailLogs.count).toBe(0);
    expect(s.db.privacyRetentionSettings.findUnique).toHaveBeenCalledOnce();
  });

  it("bounds blocker reads to one candidate page and traverses the same job population", async () => {
    const s = store();
    s.data.member.push(...Array.from({ length: 120 }, (_, i) => member(`member-${String(i).padStart(3, "0")}`)));
    s.data.familyGroupMember.push({ id: "family", memberId: "member-001" });
    const first = await getPrivacyRetentionPreview({ db: s.db, now: NOW, pageSize: 25 });
    expect(first.formerMemberCandidateCount).toBe(120);
    expect(first.formerMembers.count).toBe(24);
    expect(first.blockedMembers.count).toBe(1);
    expect(first.memberHasMore).toBe(true);
    expect(first.memberNextCursor).toBe("member-024");
    expect(getMemberCreditBalance).toHaveBeenCalledTimes(26);
    const ids = [...first.formerMembers.rows, ...first.blockedMembers.rows].map(row => row.id);
    let cursor = first.memberNextCursor;
    for (let page = 2; page <= 5; page++) {
      const next = await getPrivacyRetentionPreview({ db: s.db, now: NOW, pageSize: 25, page, memberAfter: cursor ?? undefined });
      ids.push(...next.formerMembers.rows.map(row => row.id), ...next.blockedMembers.rows.map(row => row.id));
      cursor = next.memberNextCursor;
      expect(next.memberHasMore).toBe(page < 5);
    }
    expect(new Set(ids).size).toBe(120);
    expect(ids).toHaveLength(120);
    s.settings.anonymiseMembersEnabled = true;
    expect(await runFormerMemberAnonymisationJob({ db: s.db, now: NOW })).toMatchObject({ anonymised: 119, blocked: 1 });
  });

  it("ships both jobs off and performs no transaction or destructive side effect", async () => {
    const s = store();
    s.data.member.push(member("off"));
    s.data.emailLog.push({ id: "old", createdAt: new Date("2020-01-01Z") });
    expect(await runPersonalDataPruneJob({ db: s.db, now: NOW })).toMatchObject({ skipped: "disabled", deletedEmailLogs: 0 });
    expect(await runFormerMemberAnonymisationJob({ db: s.db, now: NOW })).toMatchObject({ skipped: "disabled", anonymised: 0 });
    expect(s.db.$transaction).not.toHaveBeenCalled();
    expect(s.data.emailLog).toHaveLength(1);
    expect(s.data.member[0].deletedAt).toBeNull();
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  it("previews exactly what pruning deletes, preserving anniversary and unreviewed rows", async () => {
    const s = store();
    s.data.emailLog.push(...Array.from({ length: 101 }, (_, i) => ({ id: `old-${i}`, createdAt: new Date(EMAIL_BOUNDARY.getTime() - 1) })), { id: "boundary", createdAt: EMAIL_BOUNDARY });
    s.data.memberApplication.push(
      { id: "rejected", status: "REJECTED", reviewedAt: new Date(APPLICATION_BOUNDARY.getTime() - 1) },
      { id: "boundary", status: "REJECTED", reviewedAt: APPLICATION_BOUNDARY },
      { id: "approved", status: "APPROVED", reviewedAt: new Date("2020-01-01Z") },
      { id: "unreviewed", status: "REJECTED", reviewedAt: null },
    );
    const preview = await getPrivacyRetentionPreview({ db: s.db, now: NOW, page: 2, pageSize: 100 });
    expect(preview.emailLogs.count).toBe(101);
    expect(preview.emailLogs.rows).toHaveLength(1);
    expect(preview.rejectedApplications.count).toBe(1);
    s.settings.pruneLogsAndApplicationsEnabled = true;
    const result = await runPersonalDataPruneJob({ db: s.db, now: NOW });
    expect(result).toMatchObject({ deletedEmailLogs: preview.emailLogs.count, deletedApplications: preview.rejectedApplications.count });
    expect(s.data.emailLog.map(row => row.id)).toEqual(["boundary"]);
    expect(s.data.memberApplication.map(row => row.id)).toEqual(["boundary", "approved", "unreviewed"]);
    expect(await runPersonalDataPruneJob({ db: s.db, now: NOW })).toMatchObject({ deletedEmailLogs: 0, deletedApplications: 0 });
    expect(s.settings.pruneStartedAt).toBeNull();
  });

  it("honours club-specific retention periods and clamps leap-year anniversaries", async () => {
    const s = store();
    s.settings.emailLogRetentionYears = 3;
    s.data.emailLog.push({ id: "two-years", createdAt: new Date("2024-01-01Z") }, { id: "four-years", createdAt: new Date("2022-01-01Z") });
    expect((await getPrivacyRetentionPreview({ db: s.db, now: NOW })).emailLogs.rows.map(row => row.id)).toEqual(["four-years"]);
    expect(addUtcYears(new Date("2024-02-29T12:00:00Z"), -1).toISOString()).toBe("2023-02-28T12:00:00.000Z");
  });

  it("separates undated, boundary, active, erased and blocked members from eligible profiles", async () => {
    const s = store();
    s.data.member.push(member("eligible"), member("undated", { leavingDate: null }), member("boundary", { leavingDate: new Date("2019-07-01Z") }), member("active", { active: true }), member("erased", { deletedAt: NOW }), member("family"));
    s.data.familyGroupMember.push({ id: "family-link", memberId: "family" });
    const preview = await getPrivacyRetentionPreview({ db: s.db, now: NOW });
    expect(preview.formerMembers.rows.map(row => row.id)).toEqual(["eligible"]);
    expect(preview.undatedMembers.rows).toEqual([{ id: "undated", date: null }]);
    expect(preview.blockedMembers.rows[0]).toMatchObject({ id: "family", reasons: ["active family group"] });
    s.settings.anonymiseMembersEnabled = true;
    expect(await runFormerMemberAnonymisationJob({ db: s.db, now: NOW })).toMatchObject({ anonymised: 1, blocked: 1 });
    expect(s.data.member.filter(row => row.deletedAt === NOW).map(row => row.id).sort()).toEqual(["eligible", "erased"]);
    expect(await runFormerMemberAnonymisationJob({ db: s.db, now: NOW })).toMatchObject({ anonymised: 0, blocked: 1 });
  });

  it("keeps completed paid booking identities and invoice references while erasing profile and guest details", async () => {
    const s = store();
    s.settings.anonymiseMembersEnabled = true;
    s.data.member.push(member("former"));
    const payment = { id: "payment", status: "SUCCEEDED", additionalAmountCents: 0, additionalPaymentStatus: null, recoveryOperations: [], manualRefundTasks: [], stripePaymentIntentId: "pi-kept", xeroInvoiceId: "invoice-kept" };
    s.data.booking.push({ id: "booking", memberId: "former", status: "COMPLETED", guests: [], payment });
    s.data.bookingGuest.push({ id: "guest", memberId: "former", firstName: "Former", lastName: "Person", dietaryRequirements: "Sensitive" });
    s.data.passwordResetToken.push({ id: "reset", memberId: "former" });
    expect((await getPrivacyRetentionPreview({ db: s.db, now: NOW })).formerMembers.count).toBe(1);
    expect(await runFormerMemberAnonymisationJob({ db: s.db, now: NOW })).toMatchObject({ anonymised: 1 });
    expect(s.data.member[0]).toMatchObject({ id: "former", xeroContactId: "contact-former", firstName: "Deleted", canLogin: false, dietaryRequirements: null });
    expect(s.data.booking[0]).toMatchObject({ id: "booking", memberId: "former", payment });
    expect(s.data.bookingGuest[0]).toMatchObject({ id: "guest", memberId: "former", firstName: "Deleted", dietaryRequirements: null });
    expect(s.data.passwordResetToken).toEqual([]);
    expect(createAuditLog).toHaveBeenCalledTimes(1);
  });

  it("records the second factor's clear under the named job, in the anonymising transaction (INV-PRIV-020)", async () => {
    const s = store();
    s.settings.anonymiseMembersEnabled = true;
    s.data.member.push(member("enrolled", { twoFactorEnabled: true, twoFactorMethod: "TOTP", totpSecret: "ciphertext" }));
    s.data.twoFactorRecoveryCode.push({ id: "code", memberId: "enrolled" });
    expect(await runFormerMemberAnonymisationJob({ db: s.db, now: NOW })).toMatchObject({ anonymised: 1 });
    expect(s.data.member[0]).toMatchObject({ twoFactorEnabled: false, twoFactorMethod: null, totpSecret: null });
    expect(s.data.twoFactorRecoveryCode).toEqual([]);
    const actions = vi.mocked(createAuditLog).mock.calls.map(([event]) => event.action);
    expect(actions).toEqual(["security.two_factor.cleared", "privacy.retention.member_anonymised"]);
    const [clear, client] = vi.mocked(createAuditLog).mock.calls[0]!;
    expect(client).toBe(s.db);
    expect(clear).toMatchObject({
      memberId: null, actorMemberId: null, subjectMemberId: "enrolled",
      metadata: { actorKind: "system", systemActor: "former-member-anonymisation", method: "TOTP", authenticatorApp: true },
    });
    expect(JSON.stringify(clear)).not.toContain("ciphertext");
  });

  it("blocks open money and open booking obligations", async () => {
    const s = store();
    s.settings.anonymiseMembersEnabled = true;
    s.data.member.push(member("credit"), member("booking"));
    vi.mocked(getMemberCreditBalance).mockImplementation(async id => id === "credit" ? 100 : 0);
    s.data.booking.push({ id: "open", memberId: "booking", guests: [], status: "CONFIRMED", payment: null });
    const preview = await getPrivacyRetentionPreview({ db: s.db, now: NOW });
    expect(preview.formerMembers.count).toBe(0);
    expect(preview.blockedMembers.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "credit", reasons: ["open money"] }),
      expect.objectContaining({ id: "booking", reasons: ["open booking or booking money"] }),
    ]));
    expect(await runFormerMemberAnonymisationJob({ db: s.db, now: NOW })).toMatchObject({ anonymised: 0, blocked: 2 });
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  it("allows ended bumped stays but still blocks their pending money", async () => {
    const s = store();
    s.settings.anonymiseMembersEnabled = true;
    s.data.member.push(member("bumped-settled"), member("bumped-pending"));
    s.data.booking.push(
      { id: "settled", memberId: "bumped-settled", guests: [], status: "BUMPED", payment: null },
      { id: "pending", memberId: "bumped-pending", guests: [], status: "BUMPED", payment: { status: "PENDING", recoveryOperations: [], manualRefundTasks: [] } },
    );
    const preview = await getPrivacyRetentionPreview({ db: s.db, now: NOW });
    expect(preview.formerMembers.rows.map(row => row.id)).toEqual(["bumped-settled"]);
    expect(preview.blockedMembers.rows.map(row => row.id)).toEqual(["bumped-pending"]);
    expect(await runFormerMemberAnonymisationJob({ db: s.db, now: NOW })).toMatchObject({ anonymised: 1, blocked: 1 });
  });

  it("clears the inherited mailbox choice and flag before reconciling descendants", async () => {
    const s = store();
    s.settings.anonymiseMembersEnabled = true;
    s.data.member.push(member("departing"), member("child", {
      active: true, inheritEmailFromId: "departing", inheritEmailChoiceId: "departing", inheritParentEmail: true,
    }));
    expect(await runFormerMemberAnonymisationJob({ db: s.db, now: NOW })).toMatchObject({ anonymised: 1 });
    expect(s.data.member[1]).toMatchObject({ inheritEmailFromId: null, inheritEmailChoiceId: null, inheritParentEmail: false });
    expect(reconcileEmailInheritanceForMemberChange).toHaveBeenCalledWith(s.db, ["departing"], { trigger: "lifecycle-eligibility-change" });
  });

  it("rechecks a changed application status inside the delete predicate", async () => {
    const s = store();
    s.settings.pruneLogsAndApplicationsEnabled = true;
    s.data.memberApplication.push({ id: "reviewed-again", status: "REJECTED", reviewedAt: new Date("2020-01-01Z") });
    s.hooks.beforeApplicationDelete = () => { s.data.memberApplication[0].status = "APPROVED"; };
    expect(await runPersonalDataPruneJob({ db: s.db, now: NOW })).toMatchObject({ deletedApplications: 0 });
    expect(s.data.memberApplication[0].status).toBe("APPROVED");
  });

  it.each([null, "FAILED"])("blocks a completed stay with an unpaid addition (%s)", async (additionalPaymentStatus) => {
    const s = store();
    s.settings.anonymiseMembersEnabled = true;
    s.data.member.push(member("still-owes"));
    s.data.booking.push({
      id: "completed", memberId: "still-owes", guests: [], status: "COMPLETED",
      payment: { status: "SUCCEEDED", additionalAmountCents: 1000, additionalPaymentStatus, recoveryOperations: [], manualRefundTasks: [] },
    });
    const preview = await getPrivacyRetentionPreview({ db: s.db, now: NOW });
    expect(preview.formerMembers.count).toBe(0);
    expect(preview.blockedMembers.rows).toEqual([
      { id: "still-owes", date: BEFORE, reasons: ["open booking or booking money"] },
    ]);
    expect(await runFormerMemberAnonymisationJob({ db: s.db, now: NOW })).toMatchObject({ anonymised: 0, blocked: 1 });
    expect(s.data.member[0].deletedAt).toBeNull();
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  it("a lost anonymisation claim runs no token, photo or audit side effects", async () => {
    const s = store();
    s.settings.anonymiseMembersEnabled = true;
    s.data.member.push(member("rejoined"));
    s.data.passwordResetToken.push({ id: "keep-token", memberId: "rejoined" });
    s.hooks.beforeMemberUpdate = () => { s.data.member[0].active = true; };
    expect(await runFormerMemberAnonymisationJob({ db: s.db, now: NOW })).toMatchObject({ anonymised: 0, blocked: 1 });
    expect(s.data.passwordResetToken).toHaveLength(1);
    expect(deleteOwnedMemberPhotoBlobs).not.toHaveBeenCalled();
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  it("a held lease skips work; a crashed worker's expired lease can be reclaimed", async () => {
    const s = store();
    s.settings.pruneLogsAndApplicationsEnabled = true;
    s.settings.pruneStartedAt = NOW;
    expect(await runPersonalDataPruneJob({ db: s.db, now: NOW })).toMatchObject({ skipped: "busy" });
    expect(s.db.$transaction).not.toHaveBeenCalled();
    s.settings.pruneStartedAt = new Date(NOW.getTime() - 3_600_001);
    expect(await runPersonalDataPruneJob({ db: s.db, now: NOW })).not.toHaveProperty("skipped");
    expect(s.settings.pruneStartedAt).toBeNull();
  });

  it("a support-only preview never reads applications or member records", async () => {
    const s = store();
    const preview = await getPrivacyRetentionPreview({ db: s.db, now: NOW, includeMembers: false });
    expect(preview.rejectedApplications).toEqual({ count: 0, rows: [] });
    expect(preview.formerMembers).toEqual({ count: 0, rows: [] });
    expect(s.db.memberApplication.findMany).not.toHaveBeenCalled();
    expect(s.db.memberApplication.count).not.toHaveBeenCalled();
    expect(s.db.member.findMany).not.toHaveBeenCalled();
  });
});
