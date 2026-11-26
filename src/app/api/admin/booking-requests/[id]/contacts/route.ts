import { exactContains } from "@/lib/prisma-exact-prefix";
import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { adminBookingRequestContactsQuerySchema } from "@/lib/admin-bookings-schemas/requests";
import { MAPPABLE_CONTACT_ROLES } from "@/lib/booking-request";
import {
  ADMIN_BOOKING_REQUEST_CONTACTS_CONNECTION_SHAPE,
  type AdminBookingRequestContactsAnswer,
} from "@/lib/connection-shapes/bookings-requests";
import { connectionJson } from "@/lib/mcp-connection-request";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

const RESULT_LIMIT = 8;

/**
 * GET /api/admin/booking-requests/[id]/contacts
 *
 * Search / suggest existing non-login Organisation/School contacts an admin can
 * MAP a public booking request onto at approval instead of creating a new one
 * (issue #1255). The scope is deliberately narrow — `canLogin: false` and role
 * in {NON_MEMBER, SCHOOL}, not archived — so a login-capable member can never be
 * surfaced (and the approval transaction re-checks the same guard). With no `q`
 * the endpoint returns likely matches for the request's own contact email / name
 * (a repeat email surfaces the existing contact); with `q` it free-text searches
 * the same scope. It never mutates anything and never forces a merge.
 *
 * Also the AI app action `list_booking_request_contacts` (ALP-719).
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const query = adminBookingRequestContactsQuerySchema.safeParse({
    q: req.nextUrl.searchParams.get("q") ?? undefined,
  });
  if (!query.success) {
    return NextResponse.json({ error: "Invalid query parameters" }, { status: 400 });
  }
  const request = await prisma.bookingRequest.findUnique({
    where: { id },
    select: {
      contactEmail: true,
      contactFirstName: true,
      contactLastName: true,
      schoolName: true,
    },
  });
  if (!request) {
    return NextResponse.json({ error: "Booking request not found" }, { status: 404 });
  }

  const q = (query.data.q ?? "").trim();

  // Base scope: only non-login organisation/booking contacts, never archived.
  const scope: Prisma.MemberWhereInput = {
    canLogin: false,
    role: { in: [...MAPPABLE_CONTACT_ROLES] },
    archivedAt: null,
    active: true,
  };

  let match: Prisma.MemberWhereInput;
  if (q.length >= 2) {
    match = {
      OR: [
        { email: exactContains(q, "insensitive") },
        { firstName: exactContains(q, "insensitive") },
        { lastName: exactContains(q, "insensitive") },
      ],
    };
  } else {
    // Suggestions: exact contact-email match first (the duplicate case the issue
    // targets), then name / school-name overlap.
    const nameNeedles = [
      request.contactFirstName,
      request.contactLastName,
      request.schoolName,
    ]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value && value.length >= 2));
    match = {
      OR: [
        { email: { equals: request.contactEmail, mode: "insensitive" } },
        ...nameNeedles.flatMap((needle) => [
          { firstName: exactContains(needle, "insensitive") },
          { lastName: exactContains(needle, "insensitive") },
        ]),
      ],
    };
  }

  const contacts = await prisma.member.findMany({
    where: { AND: [scope, match] },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      role: true,
      phoneNumber: true,
      _count: { select: { bookings: true } },
    },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    take: RESULT_LIMIT,
  });

  const answer: AdminBookingRequestContactsAnswer = {
    contacts: contacts.map((contact) => ({
      id: contact.id,
      firstName: contact.firstName,
      lastName: contact.lastName,
      email: contact.email,
      role: contact.role,
      phoneNumber: contact.phoneNumber,
      bookingCount: contact._count.bookings,
    })),
  };
  return connectionJson(req, answer, ADMIN_BOOKING_REQUEST_CONTACTS_CONNECTION_SHAPE);
}
