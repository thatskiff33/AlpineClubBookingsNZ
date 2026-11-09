/**
 * The resolve dialog's text. A credit note's adds the owner's rule (#4250,
 * 21 Oct 2026): a voided card refund note is raised again overnight, even one
 * resolved here, so a replacement made by hand as well would duplicate it.
 * Its own module so both resolve dialogs (#4421) read it without a cycle.
 */
export function resolveDialogDescription(entityType: string): string {
  const base = "How was this resolved in Xero? This drops it off the active failure list."
  return entityType === "CREDIT_NOTE"
    ? `${base} If you later void a card refund's credit note in Xero, don't make a replacement by hand: the app raises a fresh one overnight.`
    : base
}
