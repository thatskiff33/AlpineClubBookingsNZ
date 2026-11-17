// The partner-share sweep's guest name, moved verbatim from
// `bed-allocation-lifecycle.ts` to keep that file under its size ceiling (#5145).

export function sweepGuestName(guest: { firstName: string; lastName: string }): string {
  return `${guest.firstName} ${guest.lastName}`.trim();
}
