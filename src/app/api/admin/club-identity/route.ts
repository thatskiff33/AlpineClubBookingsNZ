import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonRequestBody } from "@/lib/api-json";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import { primeClubIdentitySync } from "@/lib/club-identity-settings";
import { clubLegalNameSchema, clubPostalAddressSchema } from "@/lib/club-invoice-supplier-fields";
import { storedPostalAddress } from "@/lib/postal-address-lines";
import { isHttpUrl } from "@/lib/http-url";
import { prisma } from "@/lib/prisma";
import { invalidatePublicClubIdentity } from "@/lib/public-layout-cache";
import { requireAdmin } from "@/lib/session-guards";

// DB-first club identity admin API (E3 #1929; facebookUrl added C5 #1984).
// Cloned from the content-gated public-content-settings route: content:view to
// read, content:edit to write, audited, and it invalidates the tagged identity
// cache + primes the sync accessor on write. Every field is nullable — clearing
// one (empty string) restores the club.json / hard-default fallback for that
// field. facebookUrl additionally requires an http(s) URL shape when non-blank
// (the shared `isHttpUrl`, the same rule `publicUrl` is held to).
//
// #5066: legalName and postalAddress are the supplier the generated booking
// invoice prints (`getClubInvoiceSupplier`). Both are OPTIONAL in the body: a
// field left out is left as stored, so a Club identity page loaded before this
// release (blue/green overlap) still saves its four fields without clearing
// them. Sent blank, either clears to the fallback (club name; no address).
// The address is stored one trimmed line per line (`storedPostalAddress`).

const settingsSchema = z
  .object({
    name: z.string().trim().max(200).nullable(),
    shortName: z.string().trim().max(200).nullable(),
    hutLeaderLabel: z.string().trim().max(200).nullable(),
    facebookUrl: z
      .string()
      .trim()
      .max(500)
      // Blank clears (restores the fallback); a value must be a valid http(s) URL.
      .refine((v) => v === "" || isHttpUrl(v), {
        message: "facebookUrl must be a valid http(s) URL",
      })
      .nullable(),
    // One line, and the lengths config transfer also enforces (`club-invoice-supplier-fields.ts`).
    legalName: clubLegalNameSchema.nullable().optional(),
    postalAddress: clubPostalAddressSchema.nullable().optional(),
  })
  .strict();

type PersistedIdentity = {
  name: string | null;
  shortName: string | null;
  hutLeaderLabel: string | null;
  facebookUrl: string | null;
  legalName: string | null;
  postalAddress: string | null;
};

const defaults: PersistedIdentity = {
  name: null,
  shortName: null,
  hutLeaderLabel: null,
  facebookUrl: null,
  legalName: null,
  postalAddress: null,
};

const settingsSelect = {
  name: true,
  shortName: true,
  hutLeaderLabel: true,
  facebookUrl: true,
  legalName: true,
  postalAddress: true,
} as const;

function serialize(row: PersistedIdentity): PersistedIdentity {
  return {
    name: row.name,
    shortName: row.shortName,
    hutLeaderLabel: row.hutLeaderLabel,
    facebookUrl: row.facebookUrl,
    legalName: row.legalName,
    postalAddress: row.postalAddress,
  };
}

// Empty string clears the override (restores the fallback); a value is trimmed.
function emptyToNull(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "content", level: "view" },
  });
  if (!guard.ok) return guard.response;
  const settings = await prisma.clubIdentitySettings.findUnique({
    where: { id: "default" },
    select: settingsSelect,
  });
  return NextResponse.json({
    settings: settings ? serialize(settings) : defaults,
  });
}

export async function PUT(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "content", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const jsonBody = await parseJsonRequestBody(request, {
    error: "Invalid JSON",
  });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;
  const parsed = settingsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid settings" }, { status: 400 });
  }

  const data: Partial<PersistedIdentity> = {
    name: emptyToNull(parsed.data.name),
    shortName: emptyToNull(parsed.data.shortName),
    hutLeaderLabel: emptyToNull(parsed.data.hutLeaderLabel),
    facebookUrl: emptyToNull(parsed.data.facebookUrl),
    ...(parsed.data.legalName !== undefined ? { legalName: emptyToNull(parsed.data.legalName) } : {}),
    ...(parsed.data.postalAddress !== undefined ? { postalAddress: storedPostalAddress(parsed.data.postalAddress) } : {}),
  };

  const settings = await prisma.$transaction(async (tx) => {
    const before = await tx.clubIdentitySettings.findUnique({
      where: { id: "default" },
      select: settingsSelect,
    });
    const saved = await tx.clubIdentitySettings.upsert({
      where: { id: "default" },
      update: { ...data, updatedByMemberId: guard.session.user.id },
      create: { id: "default", ...data, updatedByMemberId: guard.session.user.id },
      select: settingsSelect,
    });
    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: "CLUB_IDENTITY_SETTINGS_UPDATED",
        actor: { memberId: guard.session.user.id },
        entity: { type: "ClubIdentitySettings", id: "default" },
        category: "admin",
        severity: "important",
        outcome: "success",
        summary: "Club identity settings updated",
        // The stored row, so a field the body left out still reads as kept.
        metadata: { before: before ? serialize(before) : defaults, after: serialize(saved) },
        request: getAuditRequestContext(request),
      }),
    );
    return saved;
  });

  revalidatePath("/", "layout");
  invalidatePublicClubIdentity();
  await primeClubIdentitySync();

  return NextResponse.json({ settings: serialize(settings) });
}
