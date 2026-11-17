// Which of an application's two nominator slots is which, and the fields each
// slot reads and writes. Moved out of `nomination.ts` unchanged (#4926, the hard
// ceiling on a file's length): every helper is a pure function of the slot and
// the application row it is given, so nothing here reads or writes the database.
import type { MemberApplication } from "@prisma/client";

export type NominatorSlot = "nominator1" | "nominator2";

export function getNominatorSlot(
  application: Pick<MemberApplication, "nominator1Id" | "nominator2Id">,
  nominatorMemberId: string
): NominatorSlot | null {
  if (application.nominator1Id === nominatorMemberId) {
    return "nominator1";
  }

  if (application.nominator2Id === nominatorMemberId) {
    return "nominator2";
  }

  return null;
}

export function isSlotConfirmed(
  application: Pick<MemberApplication, "nominator1ConfirmedAt" | "nominator2ConfirmedAt">,
  slot: NominatorSlot
) {
  return slot === "nominator1"
    ? Boolean(application.nominator1ConfirmedAt)
    : Boolean(application.nominator2ConfirmedAt);
}

export function getSlotMemberId(
  application: Pick<MemberApplication, "nominator1Id" | "nominator2Id">,
  slot: NominatorSlot
) {
  return slot === "nominator1"
    ? application.nominator1Id
    : application.nominator2Id;
}

export function getOtherSlotMemberId(
  application: Pick<MemberApplication, "nominator1Id" | "nominator2Id">,
  slot: NominatorSlot
) {
  return slot === "nominator1"
    ? application.nominator2Id
    : application.nominator1Id;
}

export function getSlotEmailField(slot: NominatorSlot) {
  return slot === "nominator1" ? "nominator1Email" : "nominator2Email";
}

export function getSlotIdField(slot: NominatorSlot) {
  return slot === "nominator1" ? "nominator1Id" : "nominator2Id";
}

export function getSlotConfirmedAtField(slot: NominatorSlot) {
  return slot === "nominator1"
    ? "nominator1ConfirmedAt"
    : "nominator2ConfirmedAt";
}
