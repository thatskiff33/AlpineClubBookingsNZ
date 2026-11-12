/**
 * Real-PostgreSQL proof of the shared subject access builder (#4915,
 * `INV-PRIV-023`): the relation names and filters are Prisma's, not a mock's.
 *
 * Seeds a member with credits, a family group, an application, an email log
 * row and a stay as a guest on someone else's booking beside a co-guest, then
 * reads the file the member downloads and the files a Full Admin produces for a
 * dependant sharing a parent's address, a non-member guest and a non-member
 * booking requester. The co-guest's and the booker's own fields must never
 * appear in another subject's file.
 *
 * OFF unless `RUN_CONCURRENCY_RACE_TESTS=1`, and only against
 * `CONCURRENCY_RACE_DATABASE_URL` (loopback, port 55442+, the
 * `concurrency_race_1881` marker).
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";

vi.mock("server-only", () => ({}));

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const LABEL = "Subject access export (#4915)";

const P = "sar-4915";
const SUBJECT = `${P}-subject`;
const BOOKER = `${P}-booker`;
const DEPENDANT = `${P}-dependant`;
const OFFICER = `${P}-officer`;
const LODGE = `${P}-lodge`;
const BOOKING = `${P}-booking`;
const SUBJECT_GUEST = `${P}-guest-subject`;
const CO_GUEST = `${P}-guest-other`;
const FAMILY = `${P}-family`;
const SUBJECT_EMAIL = `${P}-subject@example.invalid`;
const BOOKER_EMAIL = `${P}-booker@example.invalid`;
const REQUESTER_EMAIL = `${P}-requester@example.invalid`;

/** Fields that belong to the co-guest or the booker, never to the subject. */
const CO_GUEST_NAME = "Coguestina";
const CO_GUEST_DIETARY = "Severe sesame allergy 4915";
const BOOKER_NAME = "Bookerton";
const BOOKER_DATE_OF_BIRTH = "1961-03-14";
const BOOKER_DIETARY = "Booker-only gluten note 4915";

let prisma: PrismaClient;
let builder: typeof import("@/lib/subject-access-export");
let dietary: typeof import("@/lib/member-dietary");

const night = (day: number) => new Date(Date.UTC(2026, 7, day));

async function teardown() {
  await prisma.auditLog.deleteMany({ where: { action: { startsWith: P } } });
  await prisma.memberInduction.deleteMany({ where: { memberId: { startsWith: P } } });
  await prisma.inductionChecklistTemplate.deleteMany({ where: { id: P } });
  await prisma.emailLog.deleteMany({ where: { to: { startsWith: P } } });
  await prisma.memberApplication.deleteMany({ where: { applicantEmail: { startsWith: P } } });
  await prisma.bookingRequest.deleteMany({ where: { contactEmail: { startsWith: P } } });
  await prisma.memberCredit.deleteMany({ where: { memberId: { startsWith: P } } });
  await prisma.familyGroupMember.deleteMany({ where: { familyGroupId: FAMILY } });
  await prisma.familyGroup.deleteMany({ where: { id: FAMILY } });
  await prisma.bookingGuest.deleteMany({ where: { bookingId: BOOKING } });
  await prisma.booking.deleteMany({ where: { id: BOOKING } });
  await prisma.choreTemplate.deleteMany({ where: { id: P } });
  await prisma.memberAccessRole.deleteMany({ where: { memberId: { startsWith: P } } });
  await prisma.member.deleteMany({ where: { id: { in: [DEPENDANT] } } });
  await prisma.member.deleteMany({ where: { id: { startsWith: P } } });
  await prisma.lodge.deleteMany({ where: { id: LODGE } });
}

(RUN ? describe : describe.skip)("subject access export — real PostgreSQL (#4915)", { timeout: 30_000 }, () => {
  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, LABEL);
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = await import("@/lib/prisma"));
    builder = await import("@/lib/subject-access-export");
    dietary = await import("@/lib/member-dietary");
    await teardown();

    await prisma.lodge.create({ data: { id: LODGE, name: "Subject Access Lodge", slug: P } });
    await prisma.member.createMany({
      data: ([
        { id: SUBJECT, email: SUBJECT_EMAIL, firstName: "Subjecta", lastName: "Own", canLogin: true,
          dietaryRequirements: "Subject's own vegetarian note" },
        { id: BOOKER, email: BOOKER_EMAIL, firstName: BOOKER_NAME, lastName: "Host", canLogin: true,
          dateOfBirth: new Date(`${BOOKER_DATE_OF_BIRTH}T00:00:00.000Z`), dietaryRequirements: BOOKER_DIETARY },
        { id: OFFICER, email: `${P}-officer@example.invalid`, firstName: "Privacy", lastName: "Officer",
          canLogin: true, active: true },
      ] as const).map((member) => ({ ...member, passwordHash: "not-a-real-password" })),
    });
    // A dependant with no login, sharing the booker's address.
    await prisma.member.create({
      data: { id: DEPENDANT, email: BOOKER_EMAIL, firstName: "Dependa", lastName: "Host", canLogin: false,
        parentMemberId: BOOKER, passwordHash: "not-a-real-password" },
    });
    await prisma.memberAccessRole.create({ data: { memberId: OFFICER, role: "ADMIN" } });

    await prisma.inductionChecklistTemplate.create({ data: { id: P, name: "Test induction", version: "1" } });
    const induction = await prisma.memberInduction.create({
      data: { memberId: BOOKER, templateId: P },
    });
    await prisma.memberInductionSignOff.createMany({ data: [
      { inductionId: induction.id, signerMemberId: SUBJECT, signerName: "Subjecta Own", signerRole: "HUT_LEADER", declarationAccepted: true },
      { inductionId: induction.id, signerMemberId: OFFICER, signerName: "Privacy Officer", signerRole: "ADMIN" },
    ] });
    await prisma.auditLog.createMany({ data: [
      { action: `${P}.own`, category: "privacy", memberId: OFFICER, subjectMemberId: SUBJECT, targetId: BOOKING,
        metadata: { memberFacingText: "Subject's own activity" } },
      { action: `${P}.other`, category: "privacy", memberId: SUBJECT, subjectMemberId: BOOKER,
        metadata: { memberFacingText: "Another subject's private message" } },
      { action: `${P}.internal`, category: "admin", memberId: SUBJECT, subjectMemberId: SUBJECT },
    ] });
    await prisma.memberInductionAssignedSigner.createMany({
      data: [{ inductionId: induction.id, memberId: SUBJECT }, { inductionId: induction.id, memberId: OFFICER }],
    });
    await prisma.memberCredit.createMany({
      data: [
        { memberId: SUBJECT, amountCents: 12000, type: "ADMIN_ADJUSTMENT", description: "Weather cancellation" },
        { memberId: SUBJECT, amountCents: -4500, type: "BOOKING_APPLIED", description: "Used on a booking" },
      ],
    });
    await prisma.familyGroup.create({ data: { id: FAMILY, name: "Own family" } });
    await prisma.familyGroupMember.createMany({
      data: [{ familyGroupId: FAMILY, memberId: SUBJECT }, { familyGroupId: FAMILY, memberId: BOOKER }],
    });
    await prisma.memberApplication.create({
      data: { applicantFirstName: "Subjecta", applicantLastName: "Own", applicantEmail: SUBJECT_EMAIL,
        nominator1Email: `${P}-n1@example.invalid`, nominator2Email: `${P}-n2@example.invalid` },
    });
    await prisma.emailLog.createMany({
      data: [
        { to: SUBJECT_EMAIL, subject: "Your booking", templateName: "booking-confirmed" },
        { to: BOOKER_EMAIL, subject: "Booker's private receipt", templateName: "payment-receipt" },
      ],
    });
    await prisma.bookingRequest.create({
      data: { type: "GENERAL", contactFirstName: "Reque", contactLastName: "Ster", contactEmail: REQUESTER_EMAIL,
        checkIn: night(10), checkOut: night(12), guests: [] },
    });

    // The booker's booking: the subject (a member) and a non-member co-guest.
    await prisma.booking.create({
      data: { id: BOOKING, memberId: BOOKER, lodgeId: LODGE, checkIn: night(1), checkOut: night(3),
        status: "CONFIRMED", totalPriceCents: 40000, finalPriceCents: 40000 },
    });
    await prisma.choreTemplate.create({ data: { id: P, name: "Guest duty", lodgeId: LODGE } });
    await prisma.bookingGuest.createMany({
      data: [
        { id: SUBJECT_GUEST, bookingId: BOOKING, memberId: SUBJECT, firstName: "Subjecta", lastName: "Own",
          ageTier: "ADULT", isMember: true, stayStart: night(1), stayEnd: night(3), priceCents: 20000 },
        { id: CO_GUEST, bookingId: BOOKING, firstName: CO_GUEST_NAME, lastName: "Other", ageTier: "ADULT",
          stayStart: night(1), stayEnd: night(3), priceCents: 20000, dietaryRequirements: CO_GUEST_DIETARY },
      ],
    });
    await prisma.choreAssignment.createMany({ data: [
      { choreTemplateId: P, bookingId: BOOKING, bookingGuestId: CO_GUEST, date: night(1) },
      { choreTemplateId: P, bookingId: BOOKING, bookingGuestId: SUBJECT_GUEST, date: night(2) },
    ] });
  });

  afterAll(async () => {
    if (prisma) await teardown();
  });

  async function ownFile() {
    const grant = dietary.grantSelfDataExportDietaryAccess({ user: { id: SUBJECT } } as never);
    const file = await builder.buildSubjectAccessExport({ memberId: SUBJECT }, grant);
    return { file: file!, text: JSON.stringify(file) };
  }

  async function officerFile(subject: { memberId: string } | { guestId: string } | { email: string }) {
    const grant = await dietary.grantOfficerSubjectAccessDietaryAccess(OFFICER, {
      memberId: "memberId" in subject ? subject.memberId : undefined,
      guestId: "guestId" in subject ? subject.guestId : undefined,
    });
    expect(grant).not.toBeNull();
    const file = await builder.buildSubjectAccessExport(subject, grant!);
    return { file: file!, text: JSON.stringify(file) };
  }

  it("carries the member's credits in labelled integer cents, family, application and email log", async () => {
    const { file } = await ownFile();
    expect(file.subjectKind).toBe("member");
    expect(file.amountUnit).toBe("integer cents");
    expect(typeof file.currency).toBe("string");
    expect(file.credits.map((credit) => credit.amountCents)).toEqual([12000, -4500]);
    expect(file.creditBalanceCents).toBe(7500);
    expect(file.familyGroups).toEqual([
      expect.objectContaining({ name: "Own family", members: expect.arrayContaining(["Subjecta Own"]) }),
    ]);
    expect(file.applications).toHaveLength(1);
    expect(file.emailKeyedRecords).toBe("included");
    expect(file.emailLog.map((row) => row.subject)).toEqual(["Your booking"]);
    expect(file.auditLogTotal).toBe(file.auditLog.length);
  });

  it("shows a stay as a guest as the subject's own row only: never the co-guest or the booker", async () => {
    const { file, text } = await ownFile();
    expect(file.guestAppearances).toEqual([
      expect.objectContaining({
        firstName: "Subjecta",
        priceCents: 20000,
        booking: { checkIn: "2026-08-01", checkOut: "2026-08-03", status: "CONFIRMED", lodge: "Subject Access Lodge" },
      }),
    ]);
    for (const other of [CO_GUEST_NAME, CO_GUEST_DIETARY, BOOKER_EMAIL, BOOKER_DATE_OF_BIRTH, BOOKER_DIETARY]) {
      expect(text).not.toContain(other);
    }
  });

  it("withholds address-filed records from a dependant who shares a parent's address", async () => {
    const { file, text } = await officerFile({ memberId: DEPENDANT });
    expect(file.subjectKind).toBe("member");
    expect(file.emailKeyedRecords).toMatch(/^withheld/);
    expect(file.emailLog).toEqual([]);
    expect(text).not.toContain("Booker's private receipt");
  });

  it("withholds address-filed records even from a login holder sharing an address", async () => {
    const { file } = await officerFile({ memberId: BOOKER });
    expect(file.emailKeyedRecords).toMatch(/^withheld/);
    expect(file.emailLog).toEqual([]);
  });

  it("includes only the subject's assigned induction signer rows", async () => {
    const { file } = await ownFile();
    expect(file.additionalRecords?.MemberInductionAssignedSigner).toEqual([
      { emailSentAt: null, createdAt: expect.any(Date) },
    ]);
  });

  it("includes the subject's sign-offs on other people's inductions", async () => {
    const { file } = await ownFile();
    expect(file.additionalRecords?.MemberInductionSignOff).toEqual([
      { signerName: "Subjecta Own", signerRole: "HUT_LEADER",
        signedAt: expect.any(Date), declarationAccepted: true },
    ]);
  });

  it("exports subject-visible activity without other subjects' messages or internal events", async () => {
    const { file, text } = await ownFile();
    expect(file.auditLog).toEqual([
      { action: `${P}.own`, details: "Subject's own activity", createdAt: expect.any(String) },
    ]);
    expect(file.auditLogTotal).toBe(1);
    expect(text).not.toContain("Another subject's private message");
  });

  it("produces a non-member guest's file from their exact guest row, with their own dietary note only", async () => {
    const { file, text } = await officerFile({ guestId: CO_GUEST });
    expect(file.subjectKind).toBe("non-member");
    expect(file.guestAppearances).toEqual([expect.objectContaining({ firstName: CO_GUEST_NAME })]);
    expect(file.guestDietaryRequirements).toBe(CO_GUEST_DIETARY);
    expect(file.choreAssignments).toEqual([expect.objectContaining({
      assignedTo: `${CO_GUEST_NAME} Other`, choreName: "Guest duty", date: "2026-08-01",
    })]);
    expect(text).not.toContain("Subjecta");
    expect(text).not.toContain(BOOKER_EMAIL);
  });

  it("produces a non-member booking requester's file by the address they gave", async () => {
    const { file } = await officerFile({ email: REQUESTER_EMAIL });
    expect(file.subjectKind).toBe("non-member");
    expect(file.bookingRequests).toEqual([expect.objectContaining({ contactEmail: REQUESTER_EMAIL })]);
    expect(file.guestAppearances).toEqual([]);
  });

  it("finds nothing for an address that holds no record", async () => {
    const grant = await dietary.grantOfficerSubjectAccessDietaryAccess(OFFICER, {});
    expect(await builder.buildSubjectAccessExport({ email: `${P}-nobody@example.invalid` }, grant!)).toBeNull();
  });
});
