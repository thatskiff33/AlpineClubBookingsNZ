import "server-only";

/**
 * #3413 write gate for anonymous school-adult capacity reservations.
 *
 * The migration is additive but old runtime colours cannot count its relation.
 * Both exact acknowledgements are therefore required at the point a write is
 * admitted. This deliberately does not reuse the migration override: a deploy
 * acknowledgement is not a durable permission to start accepting writes.
 */
export function isPendingSchoolAdultsWriteEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (
    env.PENDING_SCHOOL_ADULTS_ENABLED === "1" &&
    env.BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED === "1"
  );
}
