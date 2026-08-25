import { NextRequest, NextResponse } from "next/server";
import type { AgeTier, Gender, Title } from "@prisma/client";
import { z } from "zod";
import { hash } from "bcryptjs";
import { randomBytes } from "crypto";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { computeAgeTier, getSeasonStartDate } from "@/lib/age-tier";
import { clubTimeZone } from "@/lib/club-time/server";
import { clubSeasonYear } from "@/lib/financial-year";
import { sendMemberSetupInviteEmail } from "@/lib/email";
import { applyRateLimit } from "@/lib/rate-limit";
import { createAuditLog } from "@/lib/audit";
import logger from "@/lib/logger";
import {
  describeUniqueConstraintTarget,
  isPrismaUniqueConstraintError,
} from "@/lib/prisma-errors";
import { isLoginEmailUniqueConflict } from "@/lib/member-email";
import { issueActionToken } from "@/lib/action-tokens";
import { getMemberSetupInviteExpiryDate } from "@/lib/member-setup-invite";
import { ensureMemberAccessRolesFromCompatibilityFields } from "@/lib/member-access-role-writes";
import {
  DEFAULT_MEMBER_IMPORT_DATE_FORMAT,
  deriveMemberImportNameFields,
  MEMBER_IMPORT_ADDRESS_MAX_LENGTHS,
  MEMBER_IMPORT_COMMENTS_MAX_LENGTH,
  MEMBER_IMPORT_DATE_FIELD_KEYS,
  MEMBER_IMPORT_CANCELLED_DATE_FLAG_HINT,
  MEMBER_IMPORT_DATE_FORMAT_VALUES,
  MEMBER_IMPORT_FIELD_DEFINITIONS,
  MEMBER_IMPORT_OCCUPATION_MAX_LENGTH,
  isMemberImportCancelledDateInFuture,
  normalizeMemberImportDateValue,
  type MemberImportDateFieldKey,
  type MemberImportDateFormatMapping,
} from "@/lib/member-csv-import";
import { clubTime } from "@/lib/club-time/server";
import { formatDateOnly, parseDateOnly } from "@/lib/date-only";
import { loadMemberFieldsFlags } from "@/lib/member-fields-settings";
import {
  GENDER_OPTIONS,
  TITLE_OPTIONS,
  parseGenderValue,
  parseTitleValue,
} from "@/lib/member-enums";
import { MEMBER_IMPORT_ROLE_VALUES } from "@/lib/member-roles";
import { isFullAdmin } from "@/lib/access-roles";

const nullableImportString = (max: number) =>
  z.string().max(max).optional().nullable();
const dateFormatSchema = z.enum(MEMBER_IMPORT_DATE_FORMAT_VALUES);

const importRowSchema = z
  .object({
    fullName: nullableImportString(200),
    title: nullableImportString(40),
    firstName: nullableImportString(100),
    lastName: nullableImportString(100),
    gender: nullableImportString(40),
    occupation: nullableImportString(MEMBER_IMPORT_OCCUPATION_MAX_LENGTH),
    email: z.string().email("Invalid email address"),
    phone: z.string().max(20).optional().nullable(), // Legacy: single phone string (will be put in phoneNumber)
    phoneCountryCode: z.string().max(5).optional().nullable(),
    phoneAreaCode: z.string().max(5).optional().nullable(),
    phoneNumber: z.string().max(15).optional().nullable(),
    dateOfBirth: z.string().max(32).optional().nullable(),
    joinedDate: z.string().max(32).optional().nullable(),
    cancelledDate: z.string().max(32).optional().nullable(),
    streetAddressLine1: nullableImportString(
      MEMBER_IMPORT_ADDRESS_MAX_LENGTHS.streetAddressLine1,
    ),
    streetAddressLine2: nullableImportString(
      MEMBER_IMPORT_ADDRESS_MAX_LENGTHS.streetAddressLine2,
    ),
    streetCity: nullableImportString(
      MEMBER_IMPORT_ADDRESS_MAX_LENGTHS.streetCity,
    ),
    streetRegion: nullableImportString(
      MEMBER_IMPORT_ADDRESS_MAX_LENGTHS.streetRegion,
    ),
    streetCountry: nullableImportString(
      MEMBER_IMPORT_ADDRESS_MAX_LENGTHS.streetCountry,
    ),
    streetPostalCode: nullableImportString(
      MEMBER_IMPORT_ADDRESS_MAX_LENGTHS.streetPostalCode,
    ),
    lifeMemberDate: z.string().max(32).optional().nullable(),
    comments: nullableImportString(MEMBER_IMPORT_COMMENTS_MAX_LENGTH),
    role: z.enum(MEMBER_IMPORT_ROLE_VALUES).optional().default("USER"),
    sourceLineNumber: z.number().int().positive().optional(),
    sourceColumnLabels: z.record(z.string(), z.string().max(128)).optional(),
  })
  .superRefine((row, ctx) => {
    const names = deriveMemberImportNameFields(row);
    if (!names.firstName) {
      ctx.addIssue({
        code: "custom",
        path: ["firstName"],
        message: "First name is required",
      });
    }
    if (!names.lastName) {
      ctx.addIssue({
        code: "custom",
        path: ["lastName"],
        message: "Last name is required",
      });
    }
    if (names.firstName.length > 100) {
      ctx.addIssue({
        code: "custom",
        path: ["firstName"],
        message: "First name must be 100 characters or fewer",
      });
    }
    if (names.lastName.length > 100) {
      ctx.addIssue({
        code: "custom",
        path: ["lastName"],
        message: "Last name must be 100 characters or fewer",
      });
    }
  });

const importBodySchema = z.object({
  rows: z
    .array(importRowSchema)
    .min(1, "At least one row is required")
    .max(500, "Maximum 500 rows per import"),
  dateFormats: z
    .object({
      dateOfBirth: dateFormatSchema.optional(),
      joinedDate: dateFormatSchema.optional(),
      lifeMemberDate: dateFormatSchema.optional(),
      cancelledDate: dateFormatSchema.optional(),
    })
    .optional(),
  sendInvites: z.boolean().default(false),
  autoLinkXero: z.boolean().default(false),
});

type ImportRow = z.infer<typeof importRowSchema>;

type ImportIdentity = {
  email: string;
  firstName: string;
  lastName: string;
};

type ExistingImportMember = ImportIdentity & {
  dateOfBirth: Date | null;
  canLogin: boolean;
};

function getImportFieldLabel(fieldKey: MemberImportDateFieldKey) {
  return (
    MEMBER_IMPORT_FIELD_DEFINITIONS.find(
      (definition) => definition.key === fieldKey,
    )?.label ?? fieldKey
  );
}

function getImportRowNumber(row: ImportRow, rowIndex: number) {
  return row.sourceLineNumber ?? rowIndex + 1;
}

function getImportColumnContext(row: ImportRow, fieldKey: string) {
  const label = row.sourceColumnLabels?.[fieldKey];
  return label ? ` (column ${label})` : "";
}

function normalizeImportIdentityName(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function getImportIdentityKey(identity: ImportIdentity) {
  return [
    identity.email,
    normalizeImportIdentityName(identity.firstName),
    normalizeImportIdentityName(identity.lastName),
  ].join("\u0000");
}

function normalizeImportDateField(
  row: ImportRow,
  fieldKey: MemberImportDateFieldKey,
  dateFormats: MemberImportDateFormatMapping,
) {
  const rawValue = row[fieldKey]?.trim();
  if (!rawValue) {
    return { date: null, error: null };
  }

  const normalized = normalizeMemberImportDateValue(
    rawValue,
    dateFormats[fieldKey],
  );
  if (!normalized.ok) {
    const cancelledFlagHint =
      fieldKey === "cancelledDate"
        ? ` — ${MEMBER_IMPORT_CANCELLED_DATE_FLAG_HINT}`
        : "";
    return {
      date: null,
      error: `${getImportFieldLabel(fieldKey)}${getImportColumnContext(row, fieldKey)} ${normalized.error}${cancelledFlagHint}`,
    };
  }

  const date = parseDateOnly(normalized.value);
  if (Number.isNaN(date.getTime())) {
    return {
      date: null,
      error: `${getImportFieldLabel(fieldKey)}${getImportColumnContext(row, fieldKey)} is invalid`,
    };
  }

  return { date, error: null };
}

/**
 * POST /api/admin/members/import
 * Bulk import members from CSV data.
 */
export async function POST(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;
  // Rate limit: 5 imports per hour
  const rateLimitResponse = await applyRateLimit(
    { id: "member-import", limit: 5, windowSeconds: 60 * 60 },
    req,
  );
  if (rateLimitResponse) return rateLimitResponse;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = importBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 422 },
    );
  }

  const { rows, sendInvites } = parsed.data;

  // Full Admin gate (issue #1012): a CSV row with role=ADMIN mints a
  // login-capable Full Admin, so only a Full Admin may import such rows.
  if (
    rows.some((row) => row.role === "ADMIN") &&
    !isFullAdmin(session.user)
  ) {
    return NextResponse.json(
      { error: "Only a Full Admin can import members with the Admin role" },
      { status: 403 },
    );
  }

  // Optional-field visibility settings. When a field is switched off club-wide
  // we ignore any value present in the CSV rather than importing it.
  const [flags, club] = await Promise.all([loadMemberFieldsFlags(), clubTime()]);
  const dateFormats: MemberImportDateFormatMapping = {
    dateOfBirth:
      parsed.data.dateFormats?.dateOfBirth ?? DEFAULT_MEMBER_IMPORT_DATE_FORMAT,
    joinedDate:
      parsed.data.dateFormats?.joinedDate ?? DEFAULT_MEMBER_IMPORT_DATE_FORMAT,
    lifeMemberDate:
      parsed.data.dateFormats?.lifeMemberDate ??
      DEFAULT_MEMBER_IMPORT_DATE_FORMAT,
    cancelledDate:
      parsed.data.dateFormats?.cancelledDate ??
      DEFAULT_MEMBER_IMPORT_DATE_FORMAT,
  };
  const results = {
    created: 0,
    createdLoginEnabled: 0,
    createdNonLogin: 0,
    createdCancelled: 0,
    skipped: 0,
    skippedRows: [] as Array<{ row: number; email: string; reason: string }>,
    rowNotes: [] as Array<{ row: number; email: string; note: string }>,
    errors: [] as Array<{ row: number; errors: string[] }>,
    total: rows.length,
  };

  // Load existing members for duplicate identity checks and login ownership.
  const allEmails = [...new Set(rows.map((r) => r.email.toLowerCase().trim()))];
  const existingMembers = await prisma.member.findMany({
    where: { email: { in: allEmails } },
    select: {
      email: true,
      firstName: true,
      lastName: true,
      dateOfBirth: true,
      canLogin: true,
    },
  });
  const existingMembersByEmail = new Map<string, ExistingImportMember[]>();
  const loginEmailClaimed = new Set<string>();
  const existingIdentityKeys = new Set(
    existingMembers.map((member) => {
      const email = member.email.toLowerCase().trim();
      if (member.canLogin) {
        loginEmailClaimed.add(email);
      }
      const normalizedMember = {
        email,
        firstName: member.firstName,
        lastName: member.lastName,
        dateOfBirth: member.dateOfBirth,
        canLogin: member.canLogin,
      };
      existingMembersByEmail.set(email, [
        ...(existingMembersByEmail.get(email) ?? []),
        normalizedMember,
      ]);
      return getImportIdentityKey(normalizedMember);
    }),
  );
  const acceptedIdentityKeys = new Set<string>();
  // Tracks whether the *kept* (first accepted) row for an identity carried a
  // cancelled date, so a later duplicate that is skipped can tell the admin when
  // it would have imported a different lifecycle state (issue #1946 review).
  const acceptedCancelledStateByKey = new Map<string, boolean>();

  // A row "carries" a cancelled date when its Cancelled Date column is populated;
  // that alone decides the imported lifecycle (an unparseable value would have
  // already failed validation), so presence is the right signal for the skip
  // note even though the skip happens before dates are parsed.
  const rowCarriesCancelledDate = (row: ImportRow) =>
    Boolean(row.cancelledDate?.trim());

  // Pre-validate all rows before committing (all-or-nothing)
  interface ValidatedRow {
    rowNum: number;
    email: string;
    title: Title | null;
    firstName: string;
    lastName: string;
    gender: Gender | null;
    occupation: string | null;
    phoneCountryCode: string | null;
    phoneAreaCode: string | null;
    phoneNumber: string | null;
    dateOfBirth: Date | null;
    joinedDate: Date | null;
    cancelledAt: Date | null;
    streetAddressLine1: string | null;
    streetAddressLine2: string | null;
    streetCity: string | null;
    streetRegion: string | null;
    streetCountry: string | null;
    streetPostalCode: string | null;
    lifeMemberDate: Date | null;
    comments: string | null;
    ageTier: AgeTier;
    role: (typeof MEMBER_IMPORT_ROLE_VALUES)[number];
    canLogin: boolean;
    rowNote: string | null;
  }
  const validatedRows: ValidatedRow[] = [];
  // ONE read of the club's season for the whole import (#2870, correctness
  // review). It was derived inside the per-row loop below, and an import that
  // straddles club midnight on a season boundary would then classify its early
  // and late rows against different seasons — an age tier decides a price band.
  const clubCurrentSeasonStart = getSeasonStartDate(
    clubSeasonYear(await clubTimeZone()),
  );

  for (let i = 0; i < rows.length; i++) {
    const rowNum = getImportRowNumber(rows[i], i);

    const row = rows[i];
    const email = row.email.toLowerCase().trim();
    const names = deriveMemberImportNameFields(row);
    const identity = {
      email,
      firstName: names.firstName,
      lastName: names.lastName,
    };
    const identityKey = getImportIdentityKey(identity);

    if (existingIdentityKeys.has(identityKey)) {
      results.skipped++;
      results.skippedRows.push({
        row: rowNum,
        email,
        reason: "Matching member already exists for this email and name",
      });
      continue;
    }

    if (acceptedIdentityKeys.has(identityKey)) {
      results.skipped++;
      const keptCancelled =
        acceptedCancelledStateByKey.get(identityKey) ?? false;
      const skippedCancelled = rowCarriesCancelledDate(row);
      // A silent first-wins skip hides a lifecycle mismatch: e.g. an active row
      // is kept and a later cancelled duplicate is dropped, or vice versa. Call
      // it out so the admin knows the dropped row's cancelled state was not
      // applied. Still a skip, never an error (the import stays all-or-nothing).
      const lifecycleNote =
        keptCancelled !== skippedCancelled
          ? `; the kept row is ${keptCancelled ? "cancelled" : "active"} but this skipped row is ${skippedCancelled ? "cancelled" : "active"}, so its cancelled state was not applied`
          : "";
      results.skippedRows.push({
        row: rowNum,
        email,
        reason: `Duplicate member identity already appears earlier in this import${lifecycleNote}`,
      });
      continue;
    }

    // Determine age tier
    let ageTier: AgeTier = "ADULT";
    const rowErrors: string[] = [];
    const parsedDates = Object.fromEntries(
      MEMBER_IMPORT_DATE_FIELD_KEYS.map((fieldKey) => [
        fieldKey,
        normalizeImportDateField(row, fieldKey, dateFormats),
      ]),
    ) as Record<
      MemberImportDateFieldKey,
      { date: Date | null; error: string | null }
    >;

    for (const fieldKey of MEMBER_IMPORT_DATE_FIELD_KEYS) {
      const error = parsedDates[fieldKey].error;
      if (error) {
        rowErrors.push(error);
      }
    }

    // A membership cancellation is always dated to when it happens, so a future
    // cancelled date is never legitimate (mirrors the admin cancellation flow's
    // `cancelledAt = now`). Re-checked server-side in the club time zone.
    const cancelledDateForFutureCheck = parsedDates.cancelledDate.date;
    if (
      cancelledDateForFutureCheck &&
      isMemberImportCancelledDateInFuture(
        formatDateOnly(cancelledDateForFutureCheck),
        club.today(),
      )
    ) {
      rowErrors.push(
        `Cancelled Date${getImportColumnContext(row, "cancelledDate")} cannot be in the future`,
      );
    }

    // Title/Gender are only parsed and validated when the field is enabled
    // club-wide; when disabled any CSV value is ignored.
    let title: Title | null | undefined = null;
    if (flags.showTitle) {
      title = parseTitleValue(row.title);
      if (title === undefined) {
        rowErrors.push(
          `Title${getImportColumnContext(row, "title")} must be one of ${TITLE_OPTIONS.map((option) => option.label).join(", ")}`,
        );
      }
    }

    let gender: Gender | null | undefined = null;
    if (flags.showGender) {
      gender = parseGenderValue(row.gender);
      if (gender === undefined) {
        rowErrors.push(
          `Gender${getImportColumnContext(row, "gender")} must be one of ${GENDER_OPTIONS.map((option) => option.label).join(", ")}`,
        );
      }
    }

    if (rowErrors.length > 0) {
      results.errors.push({ row: rowNum, errors: rowErrors });
      continue;
    }

    const dateOfBirth = parsedDates.dateOfBirth.date;
    const joinedDate = parsedDates.joinedDate.date;
    const lifeMemberDate = parsedDates.lifeMemberDate.date;
    // A populated cancelled date imports the member in the cancelled end-state
    // (issue #1946): inactive and non-login, matching what the normal admin
    // cancellation flow produces (minus notifications / Xero — a freshly
    // imported member has no Xero contact to cancel and gets no invite email).
    const cancelledAt = parsedDates.cancelledDate.date;
    const isCancelled = cancelledAt !== null;

    if (dateOfBirth) {
      ageTier = (await computeAgeTier(dateOfBirth, clubCurrentSeasonStart)) as AgeTier;
    }

    // Occupation is adult-only and gated by the club-wide field setting.
    const occupation =
      flags.showOccupation && ageTier === "ADULT"
        ? row.occupation?.trim() || null
        : null;

    // A cancelled member can never log in, so it is forced non-login and — key
    // interaction — it does NOT claim the login email, leaving that email free
    // for an active member (existing or another row) to own the login.
    const canLogin = isCancelled ? false : !loginEmailClaimed.has(email);
    const rowNote = isCancelled
      ? "Imported as a cancelled member (inactive, Can't Login)"
      : canLogin
        ? null
        : existingMembersByEmail.get(email)?.some((member) => member.canLogin)
          ? "Imported as Can't Login because this email already has a login-enabled member"
          : "Imported as Can't Login because an earlier row in this import uses this email for login";

    acceptedIdentityKeys.add(identityKey);
    acceptedCancelledStateByKey.set(identityKey, isCancelled);
    if (canLogin) {
      loginEmailClaimed.add(email);
    }

    validatedRows.push({
      rowNum,
      email,
      title: title ?? null,
      firstName: names.firstName,
      lastName: names.lastName,
      gender: gender ?? null,
      occupation,
      phoneCountryCode: row.phoneCountryCode?.trim() || null,
      phoneAreaCode: row.phoneAreaCode?.trim() || null,
      phoneNumber: row.phoneNumber?.trim() || row.phone?.trim() || null,
      dateOfBirth,
      joinedDate,
      cancelledAt,
      streetAddressLine1: row.streetAddressLine1?.trim() || null,
      streetAddressLine2: row.streetAddressLine2?.trim() || null,
      streetCity: row.streetCity?.trim() || null,
      streetRegion: row.streetRegion?.trim() || null,
      streetCountry: row.streetCountry?.trim() || null,
      streetPostalCode: row.streetPostalCode?.trim() || null,
      lifeMemberDate,
      comments: row.comments?.trim() || null,
      ageTier,
      role: (row.role || "USER") as (typeof MEMBER_IMPORT_ROLE_VALUES)[number],
      canLogin,
      rowNote,
    });
  }

  // If there are validation errors, abort the entire import
  if (results.errors.length > 0) {
    return NextResponse.json(results, { status: 200 });
  }

  if (validatedRows.length === 0) {
    return NextResponse.json(results, { status: 200 });
  }

  // Pre-compute password hashes BEFORE opening the transaction. bcrypt at cost
  // 13 takes a few hundred ms each; hashing inside an interactive transaction
  // exceeded Prisma's default 5s timeout at ~10 rows and rolled back the whole
  // import (issue #768). The transaction below now only does fast inserts.
  const membersToCreate = await Promise.all(
    validatedRows.map(async (row) => ({
      ...row,
      passwordHash: await hash(randomBytes(16).toString("hex"), 13),
    })),
  );

  // All-or-nothing: create all members in a transaction
  try {
    const createdMembers = await prisma.$transaction(
      async (tx) => {
        const created: Array<{
          id: string;
          email: string;
          firstName: string;
          lastName: string;
          canLogin: boolean;
          cancelled: boolean;
          rowNum: number;
          rowNote: string | null;
        }> = [];
        for (const row of membersToCreate) {
          const member = await tx.member.create({
            data: {
              email: row.email,
              title: row.title,
              firstName: row.firstName,
              lastName: row.lastName,
              gender: row.gender,
              occupation: row.occupation,
              phoneCountryCode: row.phoneCountryCode,
              phoneAreaCode: row.phoneAreaCode,
              phoneNumber: row.phoneNumber,
              dateOfBirth: row.dateOfBirth,
              joinedDate: row.joinedDate,
              streetAddressLine1: row.streetAddressLine1,
              streetAddressLine2: row.streetAddressLine2,
              streetCity: row.streetCity,
              streetRegion: row.streetRegion,
              streetCountry: row.streetCountry,
              streetPostalCode: row.streetPostalCode,
              lifeMemberDate: row.lifeMemberDate,
              comments: row.comments,
              role: row.role,
              ageTier: row.ageTier,
              // A cancelled date imports the member in the cancelled end-state
              // (issue #1946). No cancellation request exists for a legacy
              // import, so cancelledViaRequestId stays null; cancelledReason has
              // no CSV column and stays null.
              active: row.cancelledAt ? false : true,
              cancelledAt: row.cancelledAt,
              canLogin: row.canLogin,
              emailVerified: true, // Admin-imported members don't need email verification
              passwordHash: row.passwordHash,
            },
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
              canLogin: true,
            },
          });
          created.push({
            ...member,
            canLogin: row.canLogin,
            cancelled: row.cancelledAt !== null,
            rowNum: row.rowNum,
            rowNote: row.rowNote,
          });
          await ensureMemberAccessRolesFromCompatibilityFields(tx, {
            memberId: member.id,
            role: row.role,
            canLogin: row.canLogin,
            assignedByMemberId: session.user.id,
          });

          await createAuditLog(
            {
              action: "member.imported",
              memberId: session.user.id,
              targetId: member.id,
              entityType: "Member",
              entityId: member.id,
              category: "admin",
              severity: "important",
              outcome: "success",
              summary: "Member imported",
              details: `Imported member: ${member.firstName} ${member.lastName} (${member.email})`,
              metadata: {
                memberId: member.id,
                email: member.email,
                sendInvites,
                canLogin: row.canLogin,
                cancelled: row.cancelledAt !== null,
                cancelledAt: row.cancelledAt
                  ? formatDateOnly(row.cancelledAt)
                  : null,
              },
            },
            tx,
          );
        }
        return created;
      },
      { timeout: 30000 },
    );

    results.created = createdMembers.length;
    results.createdLoginEnabled = createdMembers.filter(
      (member) => member.canLogin,
    ).length;
    results.createdNonLogin = createdMembers.length - results.createdLoginEnabled;
    results.createdCancelled = createdMembers.filter(
      (member) => member.cancelled,
    ).length;
    results.rowNotes = createdMembers.flatMap((member) =>
      member.rowNote
        ? [
            {
              row: member.rowNum,
              email: member.email,
              note: member.rowNote,
            },
          ]
        : [],
    );

    // Invite emails remain post-commit best-effort; import/audit durability is
    // handled inside the transaction above.
    for (const member of createdMembers) {
      if (sendInvites && member.canLogin) {
        try {
          const { token, tokenHash } = issueActionToken();
          const expiresAt = getMemberSetupInviteExpiryDate();
          await prisma.passwordResetToken.create({
            data: { tokenHash, memberId: member.id, expiresAt },
          });
          await sendMemberSetupInviteEmail(
            member.email,
            member.firstName,
            token,
          );
        } catch (emailErr) {
          logger.error(
            { err: emailErr, memberId: member.id },
            "Failed to send import invite email",
          );
        }
      }
    }
  } catch (err) {
    // Narrowed from "any P2002 here means a login email already exists"
    // (#2455, the same treatment #2412 gave the member create): the import
    // pre-checks the addresses before it writes, so this only has to catch the
    // race that pre-check cannot close — a concurrent write claiming an address
    // in between, which the partial unique index `Member_email_login_unique`
    // rejects. A collision the database names as some OTHER constraint is still
    // a 409, because something really is already taken, but it no longer sends
    // the admin off to hunt for a duplicate address in a CSV where every
    // address is fine.
    //
    // A P2002 that names nothing is read as the address clash only when this
    // import actually creates someone who can log in: the index is
    // `WHERE "canLogin" = true`, so a batch of non-login rows cannot have hit
    // it. Nothing else in the transaction can collide either — the access-role
    // rows are written with `skipDuplicates`, `AuditLog` carries no unique
    // constraint, and the create writes neither `googleSub` nor
    // `xeroContactId`. The constraint is logged beside the error because the
    // pino `err` serializer keeps only name/message/stack and drops `meta`.
    if (isPrismaUniqueConstraintError(err)) {
      if (
        isLoginEmailUniqueConflict(err, {
          canClaimLoginEmail: membersToCreate.some((row) => row.canLogin),
        })
      ) {
        return NextResponse.json(
          {
            error:
              "Import failed because one or more login emails already exist. No members were created.",
          },
          { status: 409 },
        );
      }

      logger.error(
        { err, constraint: describeUniqueConstraintTarget(err) },
        "Member import hit an unexpected unique constraint",
      );
      return NextResponse.json(
        {
          error:
            "Import failed because one of the imported details is already used by another record. No members were created.",
        },
        { status: 409 },
      );
    }

    logger.error({ err }, "Failed to import members (transaction rolled back)");
    return NextResponse.json(
      { error: "Import failed — no members were created. Please try again." },
      { status: 500 },
    );
  }

  return NextResponse.json(results, { status: 200 });
}
