import { signOut, type SignOutParams } from "next-auth/react";
import { clearWizardWork } from "@/lib/booking-wizard-work";

export const MEMBER_SIGN_OUT_EVENT = "member-sign-out";

/**
 * The application's one client-side sign-out (#4950).
 *
 * Everything that signs a person out in the browser comes through here, so
 * whatever this tab is holding for them is forgotten at the same moment: today
 * that is the booking wizard's kept work (guest names, on a computer that may be
 * shared at a lodge or club room, `INV-PRIV`). `member-sign-out.test.ts` fails
 * any other file that imports `signOut` from `next-auth/react` directly.
 */
export async function signOutMember(
  options?: SignOutParams<boolean>,
): Promise<void> {
  window.dispatchEvent(new Event(MEMBER_SIGN_OUT_EVENT));
  clearWizardWork();
  // The overloads only differ in what they resolve with, which no caller reads.
  await signOut(options as SignOutParams<true>);
}
