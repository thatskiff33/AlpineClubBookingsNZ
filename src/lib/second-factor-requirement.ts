/**
 * Whether the member may give up the factor that still satisfies an officer
 * second factor (#4617).
 *
 * The body allows the removal. #4618 replaces it; the only delete path calls
 * this when the removal would leave `satisfiesOfficerSecondFactor` false, and
 * a refusal leaves the row in place.
 */
export async function assertLastFactorRemovable(memberId: string): Promise<void> {
  void memberId;
}
