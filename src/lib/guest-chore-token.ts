import crypto from "crypto";
import { prisma } from "./prisma";

const TOKEN_EXPIRY_HOURS = 48;

/**
 * Generate a secure, URL-safe token for guest chore access.
 */
export function generateChoreToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Create a GuestChoreToken for a booking guest on a specific date.
 * Returns the token string for embedding in emails.
 */
export async function createGuestChoreToken(
  bookingGuestId: string,
  date: Date
): Promise<string> {
  const token = generateChoreToken();
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + TOKEN_EXPIRY_HOURS);

  await prisma.guestChoreToken.create({
    data: {
      token,
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
    where: { token },
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
    (a) => a.date.toISOString().split("T")[0] === record.date.toISOString().split("T")[0]
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
