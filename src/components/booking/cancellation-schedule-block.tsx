/** Closes every member-facing schedule, here and in the booking page's help widget. */
export const CANCELLATION_EXACT_AMOUNT_NOTE =
  "The exact amount for your booking is shown when you start a cancellation.";

const CANCELLATION_SCHEDULE_FALLBACK =
  "Cancellation terms depend on the club's policy; ask the club before booking if unsure.";

/**
 * The member-facing "Cancellation and refunds" block (#4946): the club's
 * current cancellation schedule, shown where a member commits money (the
 * booking wizard's review step) and beside the Cancel action of a paid booking.
 *
 * `rows` are the descriptions `describeCancellationSchedule` built on the
 * server, so the tier wording has one source. The `lead` line is the caller's,
 * because only the caller knows whether anything has been paid yet: the PR #1389
 * owner rule says tier percentages must never read as a refund of money not yet
 * received. With no rows a neutral fallback line shows instead, and booking is
 * never blocked by it. "No rows" covers both a schedule that could not be
 * loaded (null) and a lodge with no cancellation tiers configured ([]); the
 * fallback copy is true for either. The booking page renders this block only
 * for a non-empty schedule, because its Cancel flow shows the exact figure.
 *
 * The schedule is read live at cancel time rather than locked at booking, which
 * is why the copy says "current".
 */
export function CancellationScheduleBlock({
  rows,
  lead,
}: {
  rows: readonly string[] | null;
  lead: string;
}) {
  return (
    <section
      aria-labelledby="cancellation-schedule-heading"
      data-testid="cancellation-schedule"
      className="space-y-2 rounded-md border p-4 text-sm"
    >
      <h2 id="cancellation-schedule-heading" className="text-base font-medium">
        Cancellation and refunds
      </h2>
      {rows && rows.length > 0 ? (
        <>
          <p>{lead}</p>
          <ul className="list-disc space-y-1 pl-5">
            {rows.map((row) => (
              <li key={row}>{row}</li>
            ))}
          </ul>
          <p className="text-muted-foreground">{CANCELLATION_EXACT_AMOUNT_NOTE}</p>
        </>
      ) : (
        <p className="text-muted-foreground">{CANCELLATION_SCHEDULE_FALLBACK}</p>
      )}
    </section>
  );
}
