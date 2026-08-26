import { prisma } from "./prisma";
import { hashActionToken, issueActionToken } from "./action-tokens";
import { formatDateOnly } from "@/lib/date-only";

const TOKEN_EXPIRY_HOURS = 48;

const MILLISECONDS_PER_HOUR = 3_600_000;

// test seam
/**
 * Generate a secure, URL-safe token for guest chore access.
 */
export function generateChoreToken(): string {
  return issueActionToken().token;
}

/**
 * Create a GuestChoreToken for a booking guest on a specific date.
 * Returns the token string for embedding in emails.
 */
export async function createGuestChoreToken(
  bookingGuestId: string,
  date: Date
): Promise<string> {
  const { token, tokenHash } = issueActionToken();
  // A token lifetime is a DURATION, so it is measured in milliseconds rather
  // than by adding to the host's clock face (INV-DATE-014, CT-6 #2991).
  // `setHours(getHours() + n)` added n WALL-CLOCK hours, which is n hours except
  // across a daylight-saving transition, where the token lived an hour longer or
  // shorter than the constant says.
  const expiresAt = new Date(
    Date.now() + TOKEN_EXPIRY_HOURS * MILLISECONDS_PER_HOUR
  );

  await prisma.guestChoreToken.create({
    data: {
      tokenHash,
      bookingGuestId,
      date,
      expiresAt,
    },
  });

  return token;
}

/**
 * Validate a guest chore token. Returns the token record with guest info
 * if valid and not expired, or null otherwise.
 */
export async function validateGuestChoreToken(token: string) {
  const record = await prisma.guestChoreToken.findUnique({
    where: { tokenHash: hashActionToken(token) },
    include: {
      bookingGuest: {
        include: {
          choreAssignments: {
            where: { status: { in: ["CONFIRMED", "COMPLETED"] } },
            include: { choreTemplate: true },
          },
        },
      },
    },
  });

  if (!record) return null;
  if (new Date() > record.expiresAt) return null;

  // Filter assignments to only those matching the token's date
  const dateAssignments = record.bookingGuest.choreAssignments.filter(
    (a) => formatDateOnly(a.date) === formatDateOnly(record.date)
  );

  return {
    id: record.id,
    date: record.date,
    expiresAt: record.expiresAt,
    guest: {
      id: record.bookingGuest.id,
      firstName: record.bookingGuest.firstName,
      lastName: record.bookingGuest.lastName,
    },
    assignments: dateAssignments.map((a) => ({
      id: a.id,
      choreTemplateName: a.choreTemplate.name,
      choreDescription: a.choreTemplate.description,
      choreTimeOfDay: a.choreTemplate.timeOfDay,
      choreSortOrder: a.choreTemplate.sortOrder,
      status: a.status,
      completedAt: a.completedAt?.toISOString() ?? null,
      completedVia: a.completedVia,
    })),
  };
}
