/**
 * Client-only wire contract for #2576's officer hosting-coverage override.
 *
 * Keep this module free of Prisma, Node crypto and server-only imports. The server
 * owns the digest; browser surfaces only validate and return the opaque versioned
 * correlator with the exact rejected mutation.
 */

export interface HostingCoverageStrandedBooking {
  bookingId: string;
  reference: string;
  lodgeName: string;
  nights: string[];
}

export interface HostingCoverageOverridePromptData {
  message: string;
  strandedStateKey: string;
  strandedBookings: HostingCoverageStrandedBooking[];
}

/**
 * The wire format of EVERY hosting-coverage state key, in one place (#3232,
 * `INV-SSOT-001`).
 *
 * It used to be the literal `v1:` written out at six sites — two minters
 * (`strandedCoverageStateKey`, `linkedMoveStateKey`), two request schemas and two
 * browser readers. The code already anticipated the drift that arrangement
 * invites: the prefix exists so that a future change to what a key must cover
 * FAILS CLOSED rather than colliding with an old value, and with six copies a
 * bump to `v2` in the minters alone would leave the readers silently discarding
 * every offer the server made — a member clicking a button that can never work.
 * One version, one pattern, one mint, so the bump is one edit.
 *
 * Kept in this browser-safe module because the format is wire contract shared by
 * both sides, and because this module is already where the two surfaces share
 * `hostingCoverageMutationSignature` rather than growing a second copy of it.
 */
export const HOSTING_COVERAGE_STATE_KEY_VERSION = "v1";

/** Matches a complete state key of the current version, and nothing else. */
export const HOSTING_COVERAGE_STATE_KEY_PATTERN = new RegExp(
  `^${HOSTING_COVERAGE_STATE_KEY_VERSION}:[0-9a-f]{64}$`,
);

/** Mint the wire value from a sha-256 digest. The one place the prefix is written. */
export function hostingCoverageStateKeyOf(digest: string): string {
  return `${HOSTING_COVERAGE_STATE_KEY_VERSION}:${digest}`;
}

const LODGE_NIGHT_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Fail closed unless the complete typed 409 body is present. */
export function readHostingCoverageOverridePrompt(
  value: unknown,
): HostingCoverageOverridePromptData | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.code !== "SAME_OWNER_COVERAGE_OVERRIDE_REQUIRED" ||
    record.requiresOverrideReason !== true ||
    typeof record.error !== "string" ||
    record.error.trim().length === 0 ||
    typeof record.strandedStateKey !== "string" ||
    !HOSTING_COVERAGE_STATE_KEY_PATTERN.test(record.strandedStateKey) ||
    !Array.isArray(record.strandedBookings) ||
    record.strandedBookings.length === 0
  ) {
    return null;
  }

  const strandedBookings: HostingCoverageStrandedBooking[] = [];
  for (const value of record.strandedBookings) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (
      typeof row.bookingId !== "string" ||
      row.bookingId.length === 0 ||
      typeof row.reference !== "string" ||
      row.reference.trim().length === 0 ||
      typeof row.lodgeName !== "string" ||
      row.lodgeName.trim().length === 0 ||
      !Array.isArray(row.nights) ||
      row.nights.length === 0 ||
      !row.nights.every(
        (night) => typeof night === "string" && LODGE_NIGHT_PATTERN.test(night),
      )
    ) {
      return null;
    }
    strandedBookings.push({
      bookingId: row.bookingId,
      reference: row.reference,
      lodgeName: row.lodgeName,
      nights: row.nights as string[],
    });
  }

  return {
    message: record.error,
    strandedStateKey: record.strandedStateKey,
    strandedBookings,
  };
}

/**
 * Stable browser-side identity for the exact mutation that received the prompt.
 * This is not authority or a security token; it only retires a prompt as soon as
 * any proposal field or notification choice changes.
 */
export function hostingCoverageMutationSignature(value: unknown): string {
  function canonical(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .filter(([, nested]) => nested !== undefined)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, nested]) => [key, canonical(nested)]),
      );
    }
    return input;
  }
  return JSON.stringify(canonical(value));
}
