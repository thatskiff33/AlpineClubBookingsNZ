import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { computeAgeTier } from "@/lib/age-tier";

const profileSchema = z.object({
  firstName: z.string().min(1, "First name is required").max(100),
  lastName: z.string().min(1, "Last name is required").max(100),
  phone: z.string().max(20).optional().nullable(),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format")
    .optional()
    .nullable()
    .or(z.literal("")),
});

export async function PUT(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
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

  const { firstName, lastName, phone, dateOfBirth } = parsed.data;

  const updateData: {
    firstName: string;
    lastName: string;
    phone?: string | null;
    dateOfBirth?: Date | null;
    ageTier?: "ADULT" | "YOUTH" | "CHILD";
  } = {
    firstName: firstName.trim(),
    lastName: lastName.trim(),
    phone: phone?.trim() || null,
  };

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
    updateData.ageTier = computeAgeTier(dob);
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
        phone: true,
        dateOfBirth: true,
        ageTier: true,
      },
    });

    return NextResponse.json(updated);
  } catch {
    return NextResponse.json(
      { error: "Failed to update profile" },
      { status: 500 }
    );
  }
}
