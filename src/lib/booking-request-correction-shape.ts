/**
 * WHAT A CORRECTION ARRIVES AS, AND THE ONE PLACE IT IS MADE COMPARABLE
 * (#2936, MAD epic #2725).
 *
 * The third module of the correction, beside `booking-request-corrections.ts`
 * (the one write) and `booking-request-correction-hold.ts` (the beds). It holds
 * the shape an officer's correction travels in and the four pure functions that
 * turn it into something the write can compare against what is stored.
 *
 * They are here rather than inline for one reason worth stating: **the
 * comparison decides consequences, not just an audit line.** Whether the guest
 * list changed is what decides whether the request's positional member links
 * are cleared, and whether anything but the catering preference changed is what
 * decides whether its beds are released. Two of those computed slightly
 * differently — one normalising a teacher's email, one not — would release beds
 * for an edit that changed nothing, or keep a member link pointing at a guest
 * who has moved. One home, one rule (`INV-SSOT`).
 *
 * Normalising here is also what makes a teacher typed into the officer's
 * correction screen stored byte-identically to one typed into the school's own
 * public form, so the two surfaces cannot disagree about whether a name
 * changed.
 */

import { SchoolCateringPreference } from "@prisma/client";

import type { BookingRequestGuest } from "@/lib/booking-request";
import type { CorrectionHoldOutcome } from "@/lib/booking-request-correction-hold";
import type {
  SchoolRecordAcknowledgement,
  SchoolRecordPreview,
} from "@/lib/school-organisation-preview";

/** The corrected teacher, in the shape the request stores. */
export type CorrectedTeacher = {
  firstName: string;
  lastName: string;
  email: string | null;
};

/** The school half of a correction. Required for a SCHOOL request, absent otherwise. */
export type SchoolCorrection = {
  schoolName: string;
  teachers: CorrectedTeacher[];
  childCounts: { INFANT?: number; CHILD?: number; YOUTH?: number };
  cateringPreference: SchoolCateringPreference;
  /** The officer's confirmation of which school record this name claims. */
  schoolRecord: SchoolRecordAcknowledgement;
};

export type BookingRequestCorrectionInput = {
  requestId: string;
  adminMemberId: string;
  ipAddress?: string;
  /**
   * The version the officer's screen was showing. A correction written over a
   * request something else has moved is refused, not merged.
   */
  expectedVersion: number;
  /** Why the officer is changing it. Officer-facing only; never emailed. */
  reason: string;
  checkIn: Date;
  checkOut: Date;
  contactFirstName: string;
  contactLastName: string;
  contactEmail: string;
  contactPhone: string | null;
  /** SCHOOL requests only. */
  school?: SchoolCorrection | null;
  /** GENERAL requests only: the corrected party, in full. */
  guests?: BookingRequestGuest[] | null;
};

export type BookingRequestCorrectionResult = {
  /** Field names the officer actually changed, for the panel and the audit row. */
  changedFields: string[];
  holdOutcome: CorrectionHoldOutcome;
  /** How many DRAFT/SENT quotes this correction retired. */
  supersededQuoteCount: number;
  /**
   * How many admin-made member links this correction cleared, because the party
   * it rewrote is what those links were keyed to. Non-zero means the officer
   * must re-link before quoting, and the panel says so.
   */
  clearedMemberLinkCount: number;
  /** The school record the corrected name claims. Null for a GENERAL request. */
  schoolRecord: SchoolRecordPreview | null;
  /**
   * Whether the lodge can take the corrected party on every corrected night,
   * measured AFTER the correction committed and the hold was released.
   *
   * Advisory by construction, and labelled so everywhere it is shown: a request
   * holds nothing, so this is what the officer would find if they held it now,
   * not a reservation. A correction is never refused for it — the requester
   * asked for these nights, and recording what they asked for is the officer's
   * job whether or not the lodge can take it.
   */
  availability: { available: boolean; fullNights: string[] };
};

export function cleanCorrectionLine(value: string | null | undefined): string {
  return (value ?? "").replace(/[\r\n]/g, " ").trim();
}

export function teacherListKey(teachers: CorrectedTeacher[]): string {
  return JSON.stringify(
    teachers.map((t) => [t.firstName, t.lastName, t.email ?? ""]),
  );
}

export function guestListKey(guests: { firstName: string; lastName: string; ageTier: string }[]): string {
  return JSON.stringify(guests.map((g) => [g.firstName, g.lastName, g.ageTier]));
}

/**
 * Normalise the teacher list the way the public form does, so a teacher typed
 * into the correction screen is stored byte-identically to one typed into the
 * school's own form. Blank rows drop out rather than becoming a guest called
 * nothing.
 */
export function normaliseCorrectedTeachers(teachers: CorrectedTeacher[]): CorrectedTeacher[] {
  return teachers
    .map((teacher) => ({
      firstName: cleanCorrectionLine(teacher.firstName),
      lastName: cleanCorrectionLine(teacher.lastName),
      email: cleanCorrectionLine(teacher.email)
        ? cleanCorrectionLine(teacher.email).toLowerCase()
        : null,
    }))
    .filter((teacher) => teacher.firstName && teacher.lastName);
}
