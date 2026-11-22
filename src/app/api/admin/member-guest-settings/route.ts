import { NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonRequestBody } from "@/lib/api-json";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  MEMBER_GUEST_PENDING_HOLD_EXPIRY_DAYS_MAX,
  MEMBER_GUEST_PENDING_HOLD_EXPIRY_DAYS_MIN,
} from "@/config/club-settings-defaults";
import { hasAdminAreaAccess } from "@/lib/admin-permissions";
import {
  MEMBER_GUEST_SETTINGS_ID,
  normalizeMemberGuestSettings,
} from "@/lib/member-guest-settings";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

// GET/PUT /api/admin/member-guest-settings — the club's member-guest policy
// ("+ Add Member Guest", epic #2305, MG2 #2307). Owner decision D-17 puts this
// route and the settings card it feeds in MG2, alongside the behaviour they
// control, so no admin can change a member-guest setting before the feature that
// reads it exists. MG1 (#2306) shipped the singleton, its defaults, and its
// config-transfer classification with deliberately no admin surface at all.
//
// Modelled on /api/admin/ai-assistant/settings (#2211, C3), which is the closest
// existing precedent: one LAZILY-created id="default" singleton, a `.strict()`
// zod body, a read-previous/upsert/audit interactive transaction, and a response
// carrying the values plus `updatedAt` / `updatedByMemberId`. The additions here
// are the view/manage capability signal and the bounds echo, both explained below.
//
// PERMISSION AREA: `bookings`, the same area as every other booking-policy
// settings route (booking-requests/settings, booking-policies/*, bed-allocation/
// settings). The path is registered on the `bookings` permissions prefix list in
// src/lib/admin-permissions.ts and pinned in the admin-route-area matrix, so it
// can never silently fall through to the `overview` catch-all.

/**
 * Inclusive bounds echoed to the card so the number input can render its own
 * min/max without a second copy of the two constants in client code. The card,
 * the config-transfer dry-run, and the validator below all read the same pair
 * from src/config/club-settings-defaults.ts.
 */
const BOUNDS = {
  pendingHoldExpiryDaysMin: MEMBER_GUEST_PENDING_HOLD_EXPIRY_DAYS_MIN,
  pendingHoldExpiryDaysMax: MEMBER_GUEST_PENDING_HOLD_EXPIRY_DAYS_MAX,
} as const;

/**
 * One plain-English sentence covers every way `pendingHoldExpiryDays` can be
 * wrong — a string, a fraction, null, 0, 61 — because from an admin's point of
 * view they are all the same mistake, and the field-level zod defaults ("Invalid
 * input", "Too small: expected number to be >=1") are not sentences an operator
 * should ever be shown.
 */
const PENDING_HOLD_EXPIRY_DAYS_MESSAGE =
  `Hold expiry must be a whole number of days between ` +
  `${MEMBER_GUEST_PENDING_HOLD_EXPIRY_DAYS_MIN} and ` +
  `${MEMBER_GUEST_PENDING_HOLD_EXPIRY_DAYS_MAX}.`;

function booleanField(name: string) {
  // Strict booleans: no "true"/1/"on" coercion. A card that posts a string has a
  // bug worth surfacing, and silently coercing it would let a typo turn a
  // privacy toggle on.
  return z.boolean({ error: `${name} must be true or false.` });
}

// All four fields are required, as on the precedent route: the card owns the
// whole form and posts it whole, so there is no partial-update shape to merge
// and no read-modify-write race to reason about. `.strict()` REJECTS unknown
// keys with a 400 rather than ignoring them, which is what stops a renamed or
// mistyped field from looking like a successful save.
const updateSchema = z
  .object({
    // D-3: ask-first is the shipped default; notify-only is an explicit opt-down
    // by the club's admin, never a value that arrives by accident.
    approvalRequired: booleanField("Approval required"),
    pendingHoldExpiryDays: z
      .number({ error: PENDING_HOLD_EXPIRY_DAYS_MESSAGE })
      .int(PENDING_HOLD_EXPIRY_DAYS_MESSAGE)
      .min(MEMBER_GUEST_PENDING_HOLD_EXPIRY_DAYS_MIN, PENDING_HOLD_EXPIRY_DAYS_MESSAGE)
      .max(MEMBER_GUEST_PENDING_HOLD_EXPIRY_DAYS_MAX, PENDING_HOLD_EXPIRY_DAYS_MESSAGE),
    // The two privacy toggles. Turning the first on makes the club's membership
    // name list browsable to anyone who can start a booking; the second decides
    // whether children appear in that list. Both ship OFF, and per owner
    // decision D-18 neither ever travels in a config bundle — an import must not
    // be able to widen a target club's member privacy. This route is therefore
    // the ONLY way either value can change, which is why the audit entry below
    // records both before and after.
    openMemberSearchEnabled: booleanField("Open member search"),
    openMemberSearchIncludesMinors: booleanField("Include minors in open member search"),
  })
  .strict();

/**
 * The capability signal the settings card renders its three states from.
 *
 * `"manage"` = bookings:edit, so the card shows a live Save button. `"view"` =
 * bookings:view only, so it renders read-only with no Save button — an admin is
 * never offered a control whose PUT is guaranteed to 403. `"none"` never appears
 * in a 200 body: the guard has already answered 401/403, and the card treats that
 * as the third state. It is named here so the card can type all three cases in
 * one discriminated union instead of inferring the third from a status code.
 *
 * A tri-state string rather than the `canEdit` boolean used by
 * /api/admin/fee-configuration, precisely because a boolean cannot distinguish
 * view-only from no-access and this card has to render both differently.
 *
 * Declared but NOT exported: no other route.ts in this app exports a type, and
 * the card that consumes this payload lands in a separate lane, so it declares
 * its own copy of the union rather than importing across the app/route boundary.
 */
type MemberGuestSettingsAdminAccess = "manage" | "view" | "none";

type MemberGuestSettingsAdminPayload = {
  settings: {
    approvalRequired: boolean;
    pendingHoldExpiryDays: number;
    openMemberSearchEnabled: boolean;
    openMemberSearchIncludesMinors: boolean;
  };
  /** ISO 8601, or null while the club has never saved the singleton. */
  updatedAt: string | null;
  updatedByMemberId: string | null;
  access: Exclude<MemberGuestSettingsAdminAccess, "none">;
  bounds: typeof BOUNDS;
};

function buildPayload(
  record: {
    approvalRequired: boolean;
    pendingHoldExpiryDays: number;
    openMemberSearchEnabled: boolean;
    openMemberSearchIncludesMinors: boolean;
    updatedAt: Date;
    updatedByMemberId: string | null;
  } | null,
  access: Exclude<MemberGuestSettingsAdminAccess, "none">,
): MemberGuestSettingsAdminPayload {
  return {
    settings: normalizeMemberGuestSettings(record),
    updatedAt: record?.updatedAt?.toISOString() ?? null,
    updatedByMemberId: record?.updatedByMemberId ?? null,
    access,
    bounds: BOUNDS,
  };
}

export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "view" },
  });
  if (!guard.ok) return guard.response;

  // The row is created lazily (MG1's loader returns schema defaults on a miss and
  // writes nothing), so a club that has never saved reads the defaults and STILL
  // has no row afterwards. A GET must never materialise one: the config-transfer
  // exporter and four setup-checklist signals key on singleton rows existing.
  const record = await prisma.memberGuestSettings.findUnique({
    where: { id: MEMBER_GUEST_SETTINGS_ID },
  });

  return NextResponse.json(
    buildPayload(
      record,
      hasAdminAreaAccess(guard.session.user, { area: "bookings", level: "edit" })
        ? "manage"
        : "view",
    ),
  );
}

export async function PUT(request: Request) {
  // bookings:EDIT — the write half of the split. A bookings:view admin is stopped
  // here with the guard's ordinary 403 and nothing is read or written, which is
  // what makes the GET's `access: "view"` an honest promise rather than a hint.
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const jsonBody = await parseJsonRequestBody(request, {
    error: "Invalid JSON",
  });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const data = { ...parsed.data, updatedByMemberId: session.user.id };

  // Read the previous values, upsert, and write the audit entry inside ONE
  // interactive transaction, exactly as the ai-assistant settings route does:
  // reading the old row outside the transaction would let two racing writers
  // both record the same stale "previous" values in their audit metadata.
  const record = await prisma.$transaction(async (tx) => {
    const existing = await tx.memberGuestSettings.findUnique({
      where: { id: MEMBER_GUEST_SETTINGS_ID },
    });
    // What the club was actually running on, not "null": a missing row means the
    // shared defaults were in force, so that is the honest "before" for a first
    // save. Normalising it also keeps the audit diff readable when a column is
    // added later.
    const previousSettings = normalizeMemberGuestSettings(existing);

    // Upsert, because of the lazy row: the first save has to create it. `create`
    // and `update` carry identical data, so it does not matter which branch runs.
    const updated = await tx.memberGuestSettings.upsert({
      where: { id: MEMBER_GUEST_SETTINGS_ID },
      create: { id: MEMBER_GUEST_SETTINGS_ID, ...data },
      update: data,
    });

    // Audited UNCONDITIONALLY, including a save that changes nothing. Two
    // reasons. First, re-affirming a privacy posture is itself an administrative
    // act worth a record — "who opened the member-guest card and pressed Save on
    // 3 August, and what were the open-search toggles at the time" is exactly the
    // question this trail has to answer, and a suppressed no-op cannot answer it.
    // Second, deciding "nothing changed" would mean trusting the pre-read, which
    // races another writer; the metadata already carries previous and new side by
    // side, so a no-op is plainly visible as one rather than being hidden.
    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: "MEMBER_GUEST_SETTINGS_UPDATED",
        actor: { memberId: session.user.id },
        entity: { type: "MemberGuestSettings", id: MEMBER_GUEST_SETTINGS_ID },
        category: "admin",
        // "important" rather than "routine": two of these four fields decide
        // whether the club's membership list — children included — becomes
        // browsable, which is the same weight as the nomination-gate settings.
        severity: "important",
        outcome: "success",
        summary: "Member-guest policy settings updated",
        metadata: {
          previousSettings,
          newSettings: parsed.data,
          // Spelled out so an auditor reading one entry can see a privacy widening
          // without diffing two nested objects by eye (D-18's whole concern).
          openMemberSearchWidened:
            (parsed.data.openMemberSearchEnabled &&
              !previousSettings.openMemberSearchEnabled) ||
            (parsed.data.openMemberSearchIncludesMinors &&
              !previousSettings.openMemberSearchIncludesMinors),
        },
        request: getAuditRequestContext(request),
      }),
    );

    return updated;
  });

  // Same shape as the GET so the card can parse one response type. `access` is
  // "manage" by construction: the guard above required bookings:edit.
  return NextResponse.json(buildPayload(record, "manage"));
}
