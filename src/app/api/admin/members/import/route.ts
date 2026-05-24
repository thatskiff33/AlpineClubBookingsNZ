import { NextRequest, NextResponse } from "next/server";
import type { AgeTier } from "@prisma/client";
import { z } from "zod";
import { hash } from "bcryptjs";
import { randomBytes } from "crypto";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { computeAgeTier, getSeasonStartDate } from "@/lib/age-tier";
import { getSeasonYear } from "@/lib/utils";
import { sendMemberSetupInviteEmail } from "@/lib/email";
import { applyRateLimit } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { isPrismaUniqueConstraintError } from "@/lib/prisma-errors";
import { issueActionToken } from "@/lib/action-tokens";
import { getMemberSetupInviteExpiryDate } from "@/lib/member-setup-invite";
import { nameField } from "@/lib/zod-helpers";

const importRowSchema = z.object({
  firstName: nameField({ required: "First name is required" }),
  lastName: nameField({ required: "Last name is required" }),
  email: z.string().email("Invalid email address"),
  phone: z.string().max(20).optional().nullable(), // Legacy: single phone string (will be put in phoneNumber)
  phoneCountryCode: z.string().max(5).optional().nullable(),
  phoneAreaCode: z.string().max(5).optional().nullable(),
  phoneNumber: z.string().max(15).optional().nullable(),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format (YYYY-MM-DD)")
    .optional()
    .nullable(),
  role: z.enum(["MEMBER", "ADMIN"]).optional().default("MEMBER"),
});

const importBodySchema = z.object({
  rows: z.array(importRowSchema).min(1, "At least one row is required").max(500, "Maximum 500 rows per import"),
  sendInvites: z.boolean().default(false),
  autoLinkXero: z.boolean().default(false),
});

/**
 * POST /api/admin/members/import
 * Bulk import members from CSV data.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

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
  const results = {
    created: 0,
    skipped: 0,
    errors: [] as Array<{ row: number; errors: string[] }>,
    total: rows.length,
  };

  // Check for duplicate emails within the file
  const emailsInFile = new Map<string, number>();
  for (let i = 0; i < rows.length; i++) {
    const email = rows[i].email.toLowerCase().trim();
    if (emailsInFile.has(email)) {
      results.errors.push({
        row: i + 1,
        errors: [`Duplicate email in file (same as row ${emailsInFile.get(email)! + 1})`],
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
  const existingEmailSet = new Set(existingMembers.map((m) => m.email));

  // Track which rows had file-duplicate errors
  const errorRowSet = new Set(results.errors.map((e) => e.row));

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
    ageTier: AgeTier;
    role: "MEMBER" | "ADMIN";
  }
  const validatedRows: ValidatedRow[] = [];

  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 1;

    // Skip rows that already had duplicate-in-file errors
    if (errorRowSet.has(rowNum)) continue;

    const row = rows[i];
    const email = row.email.toLowerCase().trim();

    // Skip if already exists in DB
    if (existingEmailSet.has(email)) {
      results.skipped++;
      continue;
    }

    // Determine age tier
    let ageTier: AgeTier = "ADULT";
    let dateOfBirth: Date | null = null;
    if (row.dateOfBirth) {
      dateOfBirth = new Date(row.dateOfBirth);
      if (isNaN(dateOfBirth.getTime())) {
        results.errors.push({ row: rowNum, errors: ["Invalid date of birth"] });
        continue;
      }
      ageTier = (await computeAgeTier(dateOfBirth, getSeasonStartDate(getSeasonYear()))) as AgeTier;
    }

    validatedRows.push({
      rowNum,
      email,
      firstName: row.firstName.trim(),
      lastName: row.lastName.trim(),
      phoneCountryCode: row.phoneCountryCode?.trim() || null,
      phoneAreaCode: row.phoneAreaCode?.trim() || null,
      phoneNumber: row.phoneNumber?.trim() || row.phone?.trim() || null,
      dateOfBirth,
      ageTier,
      role: (row.role || "MEMBER") as "MEMBER" | "ADMIN",
    });
  }

  // If there are validation errors, abort the entire import
  if (results.errors.length > 0) {
    return NextResponse.json(results, { status: 200 });
  }

  // All-or-nothing: create all members in a transaction
  try {
    const createdMembers = await prisma.$transaction(async (tx) => {
      const created: Array<{ id: string; email: string; firstName: string; lastName: string }> = [];
      for (const row of validatedRows) {
        const randomPassword = randomBytes(16).toString("hex");
        const passwordHash = await hash(randomPassword, 13);

        const member = await tx.member.create({
          data: {
            email: row.email,
            firstName: row.firstName,
            lastName: row.lastName,
            phoneCountryCode: row.phoneCountryCode,
            phoneAreaCode: row.phoneAreaCode,
            phoneNumber: row.phoneNumber,
            dateOfBirth: row.dateOfBirth,
            role: row.role,
            ageTier: row.ageTier,
            active: true,
            emailVerified: true, // Admin-imported members don't need email verification
            passwordHash,
          },
          select: { id: true, email: true, firstName: true, lastName: true },
        });
        created.push(member);
      }
      return created;
    });

    results.created = createdMembers.length;

    // Audit log and invite emails (outside transaction, fire-and-forget)
    for (const member of createdMembers) {
      logAudit({
        action: "member.imported",
        memberId: session.user.id,
        targetId: member.id,
        details: `Imported member: ${member.firstName} ${member.lastName} (${member.email})`,
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
