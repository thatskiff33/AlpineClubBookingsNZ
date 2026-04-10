import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { computeAgeTier, getSeasonStartDate } from "@/lib/age-tier";
import { getSeasonYear } from "@/lib/utils";
import { isXeroConnected, updateXeroContact } from "@/lib/xero";
import logger from "@/lib/logger";
import { requireActiveSessionUser } from "@/lib/session-guards";

const maxStr = (len: number) => z.string().max(len).optional().nullable();

const profileSchema = z.object({
  firstName: z.string().min(1, "First name is required").max(100).transform((s) => s.replace(/[\r\n]/g, " ").trim()),
  lastName: z.string().min(1, "Last name is required").max(100).transform((s) => s.replace(/[\r\n]/g, " ").trim()),
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
});

const PHONE_FIELDS = ["phoneCountryCode", "phoneAreaCode", "phoneNumber"] as const;
const STREET_FIELDS = ["streetAddressLine1", "streetAddressLine2", "streetCity", "streetRegion", "streetPostalCode", "streetCountry"] as const;
const POSTAL_FIELDS = ["postalAddressLine1", "postalAddressLine2", "postalCity", "postalRegion", "postalPostalCode", "postalCountry"] as const;

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

  // Date of birth
  const { dateOfBirth } = data;
  if (dateOfBirth && dateOfBirth !== "") {
    const dob = new Date(dateOfBirth);
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

  try {
    const updated = await prisma.member.update({
      where: { id: session.user.id },
      data: updateData,
      select: {
        id: true,
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
      },
    });

    // Sync to Xero if connected and member has a linked contact
    if (updated.xeroContactId) {
      try {
        if (await isXeroConnected()) {
          await updateXeroContact(updated.xeroContactId, {
            firstName: updated.firstName,
            lastName: updated.lastName,
            email: updated.email,
            phoneCountryCode: updated.phoneCountryCode,
            phoneAreaCode: updated.phoneAreaCode,
            phoneNumber: updated.phoneNumber,
            streetAddressLine1: updated.streetAddressLine1,
            streetAddressLine2: updated.streetAddressLine2,
            streetCity: updated.streetCity,
            streetRegion: updated.streetRegion,
            streetPostalCode: updated.streetPostalCode,
            streetCountry: updated.streetCountry,
            postalAddressLine1: updated.postalAddressLine1,
            postalAddressLine2: updated.postalAddressLine2,
            postalCity: updated.postalCity,
            postalRegion: updated.postalRegion,
            postalPostalCode: updated.postalPostalCode,
            postalCountry: updated.postalCountry,
          });
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
