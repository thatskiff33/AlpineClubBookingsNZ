import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

const updateSchema = z.object({
  bookingConfirmation: z.boolean().optional(),
  bookingReminder: z.boolean().optional(),
  bookingBumped: z.boolean().optional(),
  bookingCancelled: z.boolean().optional(),
  choreRoster: z.boolean().optional(),
  marketingEmails: z.boolean().optional(),
});

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Get or create default preferences
  let prefs = await prisma.notificationPreference.findUnique({
    where: { memberId: session.user.id },
  });

  if (!prefs) {
    prefs = await prisma.notificationPreference.create({
      data: { memberId: session.user.id },
    });
  }

  return NextResponse.json({
    bookingConfirmation: prefs.bookingConfirmation,
    bookingReminder: prefs.bookingReminder,
    bookingBumped: prefs.bookingBumped,
    bookingCancelled: prefs.bookingCancelled,
    choreRoster: prefs.choreRoster,
    marketingEmails: prefs.marketingEmails,
  });
}

export async function PUT(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const prefs = await prisma.notificationPreference.upsert({
    where: { memberId: session.user.id },
    create: {
      memberId: session.user.id,
      ...parsed.data,
    },
    update: parsed.data,
  });

  return NextResponse.json({
    bookingConfirmation: prefs.bookingConfirmation,
    bookingReminder: prefs.bookingReminder,
    bookingBumped: prefs.bookingBumped,
    bookingCancelled: prefs.bookingCancelled,
    choreRoster: prefs.choreRoster,
    marketingEmails: prefs.marketingEmails,
  });
}
