/**
 * Retention periods offered for the club message board (#2999).
 *
 * Deliberately its OWN module, with no imports at all. The admin section that
 * renders these is a client component, and the rest of `club-post-retention.ts`
 * imports `prisma` — so importing the list from there pulls the database client
 * into the browser bundle and the build fails resolving `dns`, `net` and `tls`.
 * A shared constant used by both sides has to live somewhere neither side has
 * to be careful about.
 */
export const RETENTION_CHOICES = [
  { days: 0, label: "Keep everything" },
  { days: 90, label: "3 months" },
  { days: 183, label: "6 months" },
  { days: 365, label: "1 year" },
  { days: 730, label: "2 years" },
] as const;
