import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { computeAgeTier, getSeasonStartDate } from "@/lib/age-tier";
import { getSeasonYear } from "@/lib/utils";
import {
  isXeroConnected,
  syncManagedXeroContactGroupForMember,
  updateXeroContact,
} from "@/lib/xero";
import {
  buildXeroContactUpdatePayload,
  hasMemberXeroContactChanges,
} from "@/lib/xero-contact-sync";
import logger from "@/lib/logger";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { copyStreetAddressToPostal } from "@/lib/member-address";
import { parseDateOnly } from "@/lib/date-only";
import { evaluateSelfServiceProfilePayload } from "@/lib/member-profile-completeness";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import { nameField } from "@/lib/zod-helpers";

const maxStr = (len: number) => z.string().max(len).optional().nullable();

const profileSchema = z.object({
  firstName: nameField({ required: "First name is required" }),
  lastName: nameField({ required: "Last name is required" }),
  phoneCountryCode: z.string().max(5).optional().nullable(),
  phoneAreaCode: z.string().max(5).optional().nullable(),
  phoneNumber: z.string().max(15).optional().nullable(),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format")
    .optional()
    .nullable()
    .or(z.literal("")),
  // Physical address
  streetAddressLine1: maxStr(200),
  streetAddressLine2: maxStr(200),
  streetCity: maxStr(200),
  streetRegion: maxStr(200),
  streetPostalCode: maxStr(20),
  streetCountry: maxStr(100),
  // Postal address
  postalAddressLine1: maxStr(200),
  postalAddressLine2: maxStr(200),
  postalCity: maxStr(200),
  postalRegion: maxStr(200),
  postalPostalCode: maxStr(20),
  postalCountry: maxStr(100),
  postalSameAsPhysical: z.boolean().optional(),
});

const PHONE_FIELDS = ["phoneCountryCode", "phoneAreaCode", "phoneNumber"] as const;
const STREET_FIELDS = ["streetAddressLine1", "streetAddressLine2", "streetCity", "streetRegion", "streetPostalCode", "streetCountry"] as const;
const POSTAL_FIELDS = ["postalAddressLine1", "postalAddressLine2", "postalCity", "postalRegion", "postalPostalCode", "postalCountry"] as const;
const PROFILE_AUDIT_FIELDS = [
  "firstName",
  "lastName",
  ...PHONE_FIELDS,
  "dateOfBirth",
  "ageTier",
  ...STREET_FIELDS,
  ...POSTAL_FIELDS,
  "profileCompletedAt",
] as const;
const PROFILE_XERO_SYNC_SELECT = {
  id: true,
  canLogin: true,
  role: true,
  firstName: true,
  lastName: true,
  phoneCountryCode: true,
  phoneAreaCode: true,
  phoneNumber: true,
  dateOfBirth: true,
  ageTier: true,
  email: true,
  xeroContactId: true,
  streetAddressLine1: true,
  streetAddressLine2: true,
  streetCity: true,
  streetRegion: true,
  streetPostalCode: true,
  streetCountry: true,
  postalAddressLine1: true,
  postalAddressLine2: true,
  postalCity: true,
  postalRegion: true,
  postalPostalCode: true,
  postalCountry: true,
  profileCompletedAt: true,
} as const;

function normalizeAuditValue(value: unknown): unknown {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (value === undefined || value === "") {
    return null;
  }
  return value;
}

function getChangedFields(
  before: Record<string, unknown>,
  updateData: Record<string, unknown>,
  fields: readonly string[]
): string[] {
  return fields.filter((field) => {
    if (!Object.prototype.hasOwnProperty.call(updateData, field)) {
      return false;
    }
    return normalizeAuditValue(before[field]) !== normalizeAuditValue(updateData[field]);
  });
}

function hasAnyField(
  changedFields: readonly string[],
  fields: readonly string[]
): boolean {
  return fields.some((field) => changedFields.includes(field));
}

export async function PUT(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = profileSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const data = parsed.data;

  const updateData: Record<string, unknown> = {
    firstName: data.firstName.trim(),
    lastName: data.lastName.trim(),
  };

  // Phone fields
  for (const f of PHONE_FIELDS) {
    updateData[f] = data[f]?.trim() || null;
  }

  // Address fields
  for (const f of [...STREET_FIELDS, ...POSTAL_FIELDS]) {
    if (data[f] !== undefined) {
      updateData[f] = data[f]?.trim() || null;
    }
  }

  if (data.postalSameAsPhysical) {
    const postalAddress = copyStreetAddressToPostal({
      streetAddressLine1: data.streetAddressLine1,
      streetAddressLine2: data.streetAddressLine2,
      streetCity: data.streetCity,
      streetRegion: data.streetRegion,
      streetPostalCode: data.streetPostalCode,
      streetCountry: data.streetCountry,
    });

    for (const field of POSTAL_FIELDS) {
      updateData[field] = postalAddress[field]?.trim() || null;
    }
  }

  // Date of birth
  const { dateOfBirth } = data;
  if (dateOfBirth && dateOfBirth !== "") {
    const dob = parseDateOnly(dateOfBirth);
    if (isNaN(dob.getTime())) {
      return NextResponse.json(
        { error: "Invalid date of birth" },
        { status: 422 }
      );
    }
    if (dob > new Date()) {
      return NextResponse.json(
        { error: "Date of birth cannot be in the future" },
        { status: 422 }
      );
    }
    updateData.dateOfBirth = dob;
    updateData.ageTier = await computeAgeTier(dob, getSeasonStartDate(getSeasonYear()));
  } else if (dateOfBirth === "" || dateOfBirth === null) {
    updateData.dateOfBirth = null;
  }

  const existing = await prisma.member.findUnique({
    where: { id: session.user.id },
    select: PROFILE_XERO_SYNC_SELECT,
  });
  if (!existing) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  if (existing.canLogin && existing.role === "MEMBER") {
    const profileCompleteness = evaluateSelfServiceProfilePayload({
      firstName: updateData.firstName as string | null | undefined,
      lastName: updateData.lastName as string | null | undefined,
      phoneCountryCode: updateData.phoneCountryCode as string | null | undefined,
      phoneAreaCode: updateData.phoneAreaCode as string | null | undefined,
      phoneNumber: updateData.phoneNumber as string | null | undefined,
      dateOfBirth: updateData.dateOfBirth as Date | null | undefined,
      streetAddressLine1: updateData.streetAddressLine1 as string | null | undefined,
      streetAddressLine2: updateData.streetAddressLine2 as string | null | undefined,
      streetCity: updateData.streetCity as string | null | undefined,
      streetRegion: updateData.streetRegion as string | null | undefined,
      streetPostalCode: updateData.streetPostalCode as string | null | undefined,
      streetCountry: updateData.streetCountry as string | null | undefined,
      postalAddressLine1: updateData.postalAddressLine1 as string | null | undefined,
      postalAddressLine2: updateData.postalAddressLine2 as string | null | undefined,
      postalCity: updateData.postalCity as string | null | undefined,
      postalRegion: updateData.postalRegion as string | null | undefined,
      postalPostalCode: updateData.postalPostalCode as string | null | undefined,
      postalCountry: updateData.postalCountry as string | null | undefined,
      postalSameAsPhysical: data.postalSameAsPhysical,
    });

    if (!profileCompleteness.isProfileComplete) {
      return NextResponse.json(
        {
          error: "Profile is incomplete",
          missingFields: profileCompleteness.missingFields,
        },
        { status: 422 }
      );
    }

    if (!existing.profileCompletedAt) {
      updateData.profileCompletedAt = new Date();
    }
  }

  try {
    const changedFields = getChangedFields(
      existing as unknown as Record<string, unknown>,
      updateData,
      PROFILE_AUDIT_FIELDS
    );
    const [updated] = await prisma.$transaction([
      prisma.member.update({
        where: { id: session.user.id },
        data: updateData,
        select: PROFILE_XERO_SYNC_SELECT,
      }),
      prisma.auditLog.create(
        buildStructuredAuditLogCreateArgs({
          action: "member.profile.updated",
          actor: { memberId: session.user.id },
          subject: { memberId: session.user.id },
          entity: { type: "Member", id: session.user.id },
          category: "account",
          severity: "important",
          outcome: "success",
          summary: "Member profile updated",
          metadata: {
            changedFields,
            changedFieldCount: changedFields.length,
            fieldGroups: {
              name: hasAnyField(changedFields, ["firstName", "lastName"]),
              phone: hasAnyField(changedFields, PHONE_FIELDS),
              address: hasAnyField(changedFields, [
                ...STREET_FIELDS,
                ...POSTAL_FIELDS,
              ]),
              dateOfBirth: changedFields.includes("dateOfBirth"),
              ageTier: changedFields.includes("ageTier"),
              profileCompleted: changedFields.includes("profileCompletedAt"),
            },
            postalSameAsPhysical: data.postalSameAsPhysical === true,
          },
          request: getAuditRequestContext(req),
        })
      ),
    ]);

    const needsContactUpdate =
      updated.xeroContactId &&
      hasMemberXeroContactChanges(existing, updated);
    const needsContactGroupSync =
      updated.xeroContactId && existing.ageTier !== updated.ageTier;

    if (updated.xeroContactId && (needsContactUpdate || needsContactGroupSync)) {
      try {
        if (await isXeroConnected()) {
          if (needsContactUpdate) {
            await updateXeroContact(
              updated.xeroContactId,
              buildXeroContactUpdatePayload(updated),
              {
                localModel: "Member",
                localId: session.user.id,
                createdByMemberId: session.user.id,
              }
            );
          }

          if (needsContactGroupSync) {
            await syncManagedXeroContactGroupForMember(session.user.id, {
              createdByMemberId: session.user.id,
            });
          }
        }
      } catch (xeroErr) {
        logger.error({ err: xeroErr, memberId: session.user.id }, "Xero sync failed for profile update");
      }
    }

    return NextResponse.json(updated);
  } catch {
    return NextResponse.json(
      { error: "Failed to update profile" },
      { status: 500 }
    );
  }
}
