/**
 * THE CONSERVATION CAPS A REFUND IS REFUSED ON (#4516, Ledger M4c; design section 4), as the codes every problem
 * names: C1 (a source line), C3 (a refund family, against its root's face) and C4 (a family's capture). A leaf, so
 * the plan builder, the state rules (`application-state.ts`) and the store import one spelling without a cycle
 * (the state rules already import the plan builder), and a refusal is classified by its code, never by a pattern over its text. C2 is a collection's cap,
 * never a refund's.
 */
export const MEMBER_MONEY_CAP_PROBLEMS = { C1: "C1_source_cap", C3: "C3_refund_family_cap", C4: "C4_capture_cap" } as const;
export type MemberMoneyCapProblem = (typeof MEMBER_MONEY_CAP_PROBLEMS)[keyof typeof MEMBER_MONEY_CAP_PROBLEMS];

/** A problem as the store and the plan write it: the cap's code, then what broke it. */
export function capProblem(code: MemberMoneyCapProblem, identity: string): string {
  return `${code}: ${identity}`;
}

/** Whether a problem names one of the refund caps: its code alone, or its code then what broke it. */
export function isMemberMoneyCapProblem(problem: string): boolean {
  return Object.values(MEMBER_MONEY_CAP_PROBLEMS).some((code) => problem === code || problem.startsWith(`${code}: `));
}
