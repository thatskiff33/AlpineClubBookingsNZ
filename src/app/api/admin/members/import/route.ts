import { NextRequest, NextResponse } from "next/server";
import type { AgeTier } from "@prisma/client";
import { z } from "zod";
import { hash } from "bcryptjs";
import { randomBytes } from "crypto";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { computeAgeTier, getSeasonStartDate } from "@/lib/age-tier";
import { getSeasonYear } from "@/lib/utils";
import { sendMemberSetupInviteEmail } from "@/lib/email";
import { applyRateLimit } from "@/lib/rate-limit";
import { createAuditLog } from "@/lib/audit";
import logger from "@/lib/logger";
import { isPrismaUniqueConstraintError } from "@/lib/prisma-errors";
import { issueActionToken } from "@/lib/action-tokens";
import { getMemberSetupInviteExpiryDate } from "@/lib/member-setup-invite";
import { parseDateOnly } from "@/lib/date-only";
import {
  DEFAULT_MEMBER_IMPORT_DATE_FORMAT,
  deriveMemberImportNameFields,
  MEMBER_IMPORT_DATE_FIELD_KEYS,
  MEMBER_IMPORT_DATE_FORMAT_VALUES,
  MEMBER_IMPORT_FIELD_DEFINITIONS,
  normalizeMemberImportDateValue,
  type MemberImportDateFieldKey,
  type MemberImportDateFormatMapping,
} from "@/lib/member-csv-import";

const nullableImportString = (max: number) => z.string().max(max).optional().nullable();
const dateFormatSchema = z.enum(MEMBER_IMPORT_DATE_FORMAT_VALUES);

const importRowSchema = z.object({
  fullName: nullableImportString(200),
  firstName: nullableImportString(100),
  lastName: nullableImportString(100),
  email: z.string().email("Invalid email address"),
  phone: z.string().max(20).optional().nullable(), // Legacy: single phone string (will be put in phoneNumber)
  phoneCountryCode: z.string().max(5).optional().nullable(),
  phoneAreaCode: z.string().max(5).optional().nullable(),
  phoneNumber: z.string().max(15).optional().nullable(),
  dateOfBirth: z.string().max(32).optional().nullable(),
  joinedDate: z.string().max(32).optional().nullable(),
  role: z.enum(["MEMBER", "ADMIN"]).optional().default("MEMBER"),
  sourceLineNumber: z.number().int().positive().optional(),
  sourceColumnLabels: z.record(z.string(), z.string().max(128)).optional(),
}).superRefine((row, ctx) => {
  const names = deriveMemberImportNameFields(row);
  if (!names.firstName) {
    ctx.addIssue({ code: "custom", path: ["firstName"], message: "First name is required" });
  }
  if (!names.lastName) {
    ctx.addIssue({ code: "custom", path: ["lastName"], message: "Last name is required" });
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
  rows: z.array(importRowSchema).min(1, "At least one row is required").max(500, "Maximum 500 rows per import"),
  dateFormats: z
    .object({
      dateOfBirth: dateFormatSchema.optional(),
      joinedDate: dateFormatSchema.optional(),
    })
    .optional(),
  sendInvites: z.boolean().default(false),
  autoLinkXero: z.boolean().default(false),
});

type ImportRow = z.infer<typeof importRowSchema>;

function getImportFieldLabel(fieldKey: MemberImportDateFieldKey) {
  return (
    MEMBER_IMPORT_FIELD_DEFINITIONS.find((definition) => definition.key === fieldKey)?.label ??
    fieldKey
  );
}

function getImportRowNumber(row: ImportRow, rowIndex: number) {
  return row.sourceLineNumber ?? rowIndex + 1;
}

function getImportColumnContext(row: ImportRow, fieldKey: MemberImportDateFieldKey) {
  const label = row.sourceColumnLabels?.[fieldKey];
  return label ? ` (column ${label})` : "";
}

function normalizeImportDateField(
  row: ImportRow,
  fieldKey: MemberImportDateFieldKey,
  dateFormats: MemberImportDateFormatMapping
) {
  const rawValue = row[fieldKey]?.trim();
  if (!rawValue) {
    return { date: null, error: null };
  }

  const normalized = normalizeMemberImportDateValue(rawValue, dateFormats[fieldKey]);
  if (!normalized.ok) {
    return {
      date: null,
      error: `${getImportFieldLabel(fieldKey)}${getImportColumnContext(row, fieldKey)} ${normalized.error}`,
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
  const rateLimitResponse = applyRateLimit(
    { id: "member-import", limit: 5, windowSeconds: 60 * 60 },
    req
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
      { status: 422 }
    );
  }

  const { rows, sendInvites } = parsed.data;
  const dateFormats: MemberImportDateFormatMapping = {
    dateOfBirth: parsed.data.dateFormats?.dateOfBirth ?? DEFAULT_MEMBER_IMPORT_DATE_FORMAT,
    joinedDate: parsed.data.dateFormats?.joinedDate ?? DEFAULT_MEMBER_IMPORT_DATE_FORMAT,
  };
  const results = {
    created: 0,
    skipped: 0,
    skippedRows: [] as Array<{ row: number; email: string; reason: string }>,
    errors: [] as Array<{ row: number; errors: string[] }>,
    total: rows.length,
  };

  // Check for duplicate emails within the file
  const emailsInFile = new Map<string, number>();
  const duplicateRowIndexes = new Set<number>();
  for (let i = 0; i < rows.length; i++) {
    const email = rows[i].email.toLowerCase().trim();
    if (emailsInFile.has(email)) {
      const firstRowIndex = emailsInFile.get(email)!;
      duplicateRowIndexes.add(i);
      results.errors.push({
        row: getImportRowNumber(rows[i], i),
        errors: [`Duplicate email in file (same as row ${getImportRowNumber(rows[firstRowIndex], firstRowIndex)})`],
      });
    } else {
      emailsInFile.set(email, i);
    }
  }

  // Check for existing emails in DB (primary accounts only)
  const allEmails = [...new Set(rows.map((r) => r.email.toLowerCase().trim()))];
  const existingMembers = await prisma.member.findMany({
    where: { email: { in: allEmails }, canLogin: true },
    select: { email: true },
  });
  const existingEmailSet = new Set(
    existingMembers.map((m) => m.email.toLowerCase().trim())
  );

  // Pre-validate all rows before committing (all-or-nothing)
  interface ValidatedRow {
    rowNum: number;
    email: string;
    firstName: string;
    lastName: string;
    phoneCountryCode: string | null;
    phoneAreaCode: string | null;
    phoneNumber: string | null;
    dateOfBirth: Date | null;
    joinedDate: Date | null;
    ageTier: AgeTier;
    role: "MEMBER" | "ADMIN";
  }
  const validatedRows: ValidatedRow[] = [];

  for (let i = 0; i < rows.length; i++) {
    const rowNum = getImportRowNumber(rows[i], i);

    // Skip rows that already had duplicate-in-file errors
    if (duplicateRowIndexes.has(i)) continue;

    const row = rows[i];
    const email = row.email.toLowerCase().trim();
    const names = deriveMemberImportNameFields(row);

    // Skip if already exists in DB
    if (existingEmailSet.has(email)) {
      results.skipped++;
      results.skippedRows.push({
        row: rowNum,
        email,
        reason: "Login email already exists",
      });
      continue;
    }

    // Determine age tier
    let ageTier: AgeTier = "ADULT";
    const dateErrors: string[] = [];
    const parsedDates = Object.fromEntries(
      MEMBER_IMPORT_DATE_FIELD_KEYS.map((fieldKey) => [
        fieldKey,
        normalizeImportDateField(row, fieldKey, dateFormats),
      ])
    ) as Record<MemberImportDateFieldKey, { date: Date | null; error: string | null }>;

    for (const fieldKey of MEMBER_IMPORT_DATE_FIELD_KEYS) {
      const error = parsedDates[fieldKey].error;
      if (error) {
        dateErrors.push(error);
      }
    }

    if (dateErrors.length > 0) {
      results.errors.push({ row: rowNum, errors: dateErrors });
      continue;
    }

    const dateOfBirth = parsedDates.dateOfBirth.date;
    const joinedDate = parsedDates.joinedDate.date;

    if (dateOfBirth) {
      ageTier = (await computeAgeTier(dateOfBirth, getSeasonStartDate(getSeasonYear()))) as AgeTier;
    }

    validatedRows.push({
      rowNum,
      email,
      firstName: names.firstName,
      lastName: names.lastName,
      phoneCountryCode: row.phoneCountryCode?.trim() || null,
      phoneAreaCode: row.phoneAreaCode?.trim() || null,
      phoneNumber: row.phoneNumber?.trim() || row.phone?.trim() || null,
      dateOfBirth,
      joinedDate,
      ageTier,
      role: (row.role || "MEMBER") as "MEMBER" | "ADMIN",
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
    }))
  );

  // All-or-nothing: create all members in a transaction
  try {
    const createdMembers = await prisma.$transaction(
      async (tx) => {
        const created: Array<{ id: string; email: string; firstName: string; lastName: string }> = [];
        for (const row of membersToCreate) {
          const member = await tx.member.create({
            data: {
              email: row.email,
              firstName: row.firstName,
              lastName: row.lastName,
              phoneCountryCode: row.phoneCountryCode,
              phoneAreaCode: row.phoneAreaCode,
              phoneNumber: row.phoneNumber,
              dateOfBirth: row.dateOfBirth,
              joinedDate: row.joinedDate,
              role: row.role,
              ageTier: row.ageTier,
              active: true,
              canLogin: true,
              emailVerified: true, // Admin-imported members don't need email verification
              passwordHash: row.passwordHash,
            },
            select: { id: true, email: true, firstName: true, lastName: true },
          });
          created.push(member);
        }
        return created;
      },
      { timeout: 30000 }
    );

    results.created = createdMembers.length;

    // Audit log and invite emails (outside transaction)
    for (const member of createdMembers) {
      await createAuditLog({
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
        },
      });

      if (sendInvites) {
        try {
          const { token, tokenHash } = issueActionToken();
          const expiresAt = getMemberSetupInviteExpiryDate();
          await prisma.passwordResetToken.create({
            data: { tokenHash, memberId: member.id, expiresAt },
          });
          await sendMemberSetupInviteEmail(
            member.email,
            member.firstName,
            token
          );
        } catch (emailErr) {
          logger.error({ err: emailErr, memberId: member.id }, "Failed to send import invite email");
        }
      }
    }
  } catch (err) {
    if (isPrismaUniqueConstraintError(err)) {
      return NextResponse.json(
        {
          error: "Import failed because one or more login emails already exist. No members were created.",
        },
        { status: 409 }
      );
    }

    logger.error({ err }, "Failed to import members (transaction rolled back)");
    return NextResponse.json(
      { error: "Import failed — no members were created. Please try again." },
      { status: 500 }
    );
  }

  return NextResponse.json(results, { status: 200 });
}
