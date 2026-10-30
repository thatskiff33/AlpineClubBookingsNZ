/** Keep the departure already recorded for an inactive member's current absence. */
export function leavingDateForDeactivation(
  member: { active: boolean; leavingDate?: Date | null },
  departureDay: Date,
): Date {
  return !member.active && member.leavingDate
    ? member.leavingDate
    : departureDay;
}
