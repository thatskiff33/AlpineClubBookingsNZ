import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hash } from "bcryptjs";
import { randomBytes } from "crypto";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { computeAgeTier } from "@/lib/age-tier";
import { sendPasswordResetEmail } from "@/lib/email";
import { applyRateLimit } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";

const importRowSchema = z.object({
  firstName: z.string().min(1, "First name is required").max(100),
  lastName: z.string().min(1, "Last name is required").max(100),
  email: z.string().email("Invalid email address"),
  phone: z.string().max(20).optional().nullable(),
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
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
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

  // Check for existing emails in DB
  const allEmails = [...new Set(rows.map((r) => r.email.toLowerCase().trim()))];
  const existingMembers = await prisma.member.findMany({
    where: { email: { in: allEmails } },
    select: { email: true },
  });
  const existingEmailSet = new Set(existingMembers.map((m) => m.email));

  // Track which rows had file-duplicate errors
  const errorRowSet = new Set(results.errors.map((e) => e.row));

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

    try {
      // Determine age tier
      let ageTier: "ADULT" | "YOUTH" | "CHILD" = "ADULT";
      let dateOfBirth: Date | null = null;
      if (row.dateOfBirth) {
        dateOfBirth = new Date(row.dateOfBirth);
        if (isNaN(dateOfBirth.getTime())) {
          results.errors.push({ row: rowNum, errors: ["Invalid date of birth"] });
          continue;
        }
        ageTier = computeAgeTier(dateOfBirth) as "ADULT" | "YOUTH" | "CHILD";
      }

      // Generate cryptographically random password
      const randomPassword = randomBytes(16).toString("hex");
      const passwordHash = await hash(randomPassword, 13);

      const member = await prisma.member.create({
        data: {
          email,
          firstName: row.firstName.trim(),
          lastName: row.lastName.trim(),
          phone: row.phone?.trim() || null,
          dateOfBirth,
          role: row.role || "MEMBER",
          ageTier,
          active: true,
          passwordHash,
        },
        select: { id: true, email: true, firstName: true, lastName: true },
      });

      // Add to existing set so subsequent rows cannot create duplicates
      existingEmailSet.add(email);

      // Audit log
      logAudit({
        action: "member.imported",
        memberId: session.user.id,
        targetId: member.id,
        details: `Imported member: ${member.firstName} ${member.lastName} (${member.email})`,
      });

      // Send invite email if requested
      if (sendInvites) {
        try {
          const token = randomBytes(32).toString("hex");
          const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
          await prisma.passwordResetToken.create({
            data: { token, memberId: member.id, expiresAt },
          });
          sendPasswordResetEmail(member.email, token).catch((err) => {
            logger.error({ err, memberId: member.id }, "Failed to send import invite email");
          });
        } catch (emailErr) {
          logger.error({ err: emailErr, memberId: member.id }, "Failed to create import invite token");
        }
      }

      results.created++;
    } catch (err) {
      logger.error({ err, row: rowNum }, "Failed to import member row");
      results.errors.push({ row: rowNum, errors: ["Failed to create member"] });
    }
  }

  return NextResponse.json(results, { status: 200 });
}