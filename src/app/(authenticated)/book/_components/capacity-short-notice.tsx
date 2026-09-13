"use client";

/**
 * "These dates will not fit your party" — the one panel, drawn at both steps
 * that say it (#2930).
 *
 * The guests step and the review step were each about to grow their own copy of
 * the same warning block: same tokens, same `role="status"`, same full-night
 * list, same reassurance that nothing is charged. Two copies of a privacy-shaped
 * sentence is exactly the arrangement that lets one of them drift into naming a
 * reason (`INV-SSOT-001`), and this is the sentence that must never do that.
 *
 * IT CANNOT NAME A REASON, by construction rather than by care. Everything it
 * renders comes from `/api/availability/check`, which pins a whole-lodge-held
 * night to a full lodge at zero available beds and projects no hold flag
 * (`INV-CAP-021`, `INV-CAP-038`, ADR-001 decision 6). There is no input here
 * that distinguishes a lodge full of bookings from a lodge held for one group,
 * so both produce the same words.
 *
 * `role="status"` because the panel appears and updates as guests are added: a
 * member who cannot see it would otherwise meet the shortfall only at submit.
 */
export function CapacityShortNotice({
  headline,
  message,
  shortNights,
  children,
}: {
  /** The bold opening clause, which differs by step. */
  headline: string;
  /** The shared sentence from `formatCapacityShortMessage`. */
  message: string;
  /** Every night the party will not fit on, as `yyyy-MM-dd` (`INV-DATE-014`). */
  shortNights: string[];
  /** The step's own closing reassurance. */
  children: React.ReactNode;
}) {
  return (
    <div
      className="rounded-md border border-warning/20 bg-warning-muted p-4 text-sm text-warning"
      role="status"
    >
      <p>
        <strong>{headline}</strong> {message}
      </p>
      {shortNights.length > 1 ? (
        <p className="mt-2">Full nights: {shortNights.join(", ")}.</p>
      ) : null}
      <p className="mt-2">{children}</p>
    </div>
  );
}
