/**
 * Every email date, on BOTH rendering paths, by KIND (#3113, epic #2988).
 *
 * ## The branch, and why one suite has to cover both paths at once
 *
 * An email in this product is rendered two ways. Normally the shipped HTML body
 * renders it. But when an operator has saved a **body override** for that
 * template, `prepareEmailMessage` throws the built-in HTML away and rebuilds the
 * whole message from the sender's `templateData` map
 * (`email-message-renderer.ts`). Editing template wording is documented as
 * routine operator work, and the shipped default bodies already name these very
 * tokens — so both paths are live, and the member reads whichever one their club
 * happens to have.
 *
 * `payment-link-expiry-email-override-zone.test.ts` (#3105) closed this for the
 * two payment-link `expiresAt` sites. This suite is the generalisation, and it
 * covers the part that turned out to be the harder half: the two paths were not
 * "one correct, one wrong". They were wrong in DIFFERENT DIRECTIONS, because
 * they disagreed about what kind of thing a date is.
 *
 * ## The two kinds, which need opposite fixes
 *
 * - A **stored calendar day** — a lodge night, a hut-leader assignment's start,
 *   a capacity-warning day — is a `@db.Date` column. It round-trips as a `Date`
 *   pinned to exactly UTC midnight and encodes a DAY, not a moment. It has no
 *   zone, so rendering it must consult none (`INV-DATE-019`, `INV-DATE-026`).
 * - A **real instant** — a payment deadline, a hold expiry, a recorded-at stamp
 *   — is a moment, and becomes a civil date only by projecting it into the
 *   club's persisted zone (`INV-CONFIG-002`).
 *
 * Before this change the override path put ALL of them through the environment's
 * zone and the default body put ALL of them through the club's persisted zone.
 * So for calendar days both were projections of an encoding, and each was right
 * only when its own zone happened to sit east of Greenwich.
 *
 * ## Why the suite pins TWO persisted zones against ONE container zone
 *
 * This is the part a single configuration cannot do, and it is why the earlier
 * shape of this test would have passed while half the defect survived.
 *
 * The container is pinned BEHIND Greenwich (`APP_TIME_ZONE` = `America/Denver`,
 * set before the graph is imported). That is what makes the retired
 * environment-zone reading of a stored day a DIFFERENT DAY, so a revert on the
 * `templateData` side is visible at all. On this repository's own machine
 * `APP_TIME_ZONE` is `Pacific/Auckland`, and Auckland's projection of a
 * UTC-midnight day is that same day — so a suite that left the container alone
 * would have watched the old code produce the right answer by coincidence and
 * called it a pass.
 *
 * Then the club's PERSISTED zone is varied, and the two configurations do
 * genuinely different jobs — measured, not assumed:
 *
 * - `WEST` (`Pacific/Honolulu`) is the **discriminating** one. Both wrong
 *   authorities — the container's zone and the persisted zone — read a stored
 *   night as the previous day, so it kills a revert on EITHER path. Measured:
 *   with only this configuration kept, a reverted `templateData` site and a
 *   reverted default-HTML-body site are both killed.
 * - `EAST` (`Pacific/Auckland`) is the **current-adopter regression** case, and
 *   it is deliberately NOT the discriminating one. Here the persisted projection
 *   of a stored night agrees with the stored night, because New Zealand is east
 *   of Greenwich — which is exactly the situation of every deployment today. Its
 *   job is to prove this change is output-neutral for them rather than to catch
 *   a revert. Measured: with only this configuration kept, a reverted
 *   default-HTML-body site SURVIVES.
 *
 * That asymmetry is stated plainly because the obvious-sounding version — "each
 * configuration catches one path" — is false, and a suite whose comment
 * overstates its own reach is how a coverage gap gets left behind a green run.
 *
 * In both, the correct answer is the same stored day, and both paths must give
 * it. A premise failure here is a FAILURE and never a skip (owner decision,
 * #2870).
 *
 * ## The oracles are independent, on purpose
 *
 * The stored-day expectation is a hand-written `Intl` formatter pinned to `UTC`,
 * not a call to the kernel helper the implementation uses — otherwise the
 * assertion would be the implementation restated and could not fail. The
 * projected expectations (what each wrong path WOULD have said) are the same
 * hand-written shape pointed at a real zone.
 *
 * The instant expectation does use `bindClubTime(zone)`, because there the claim
 * under test is WHICH ZONE, not the character shape — the same choice #3105 made
 * for the same reason.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Type-only, so it emits nothing and cannot warm the module registry
// ahead of the container-zone re-import below.
import type { EmailTemplateData } from "@/lib/email-message-renderer";

/**
 * The container's zone, chosen BEHIND Greenwich so the retired environment-zone
 * reading of a stored calendar day lands on a different day.
 *
 * `APP_TIME_ZONE` is `process.env.TZ || NEXT_PUBLIC_TZ || "Pacific/Auckland"`
 * and is read ONCE at module load, so this must be set before the graph is
 * imported and the modules must be re-imported after it. `TZ` is deleted rather
 * than set: it would also move the HOST's own clock, and the point here is to
 * move the application's configured zone while leaving the host wherever the
 * runner put it.
 */
const CONTAINER_ZONE = "America/Denver";
process.env.NEXT_PUBLIC_TZ = CONTAINER_ZONE;
delete process.env.TZ;

const mocks = vi.hoisted(() => ({
  clubTimeSettingsFindUnique: vi.fn(),
  emailTemplateOverrideFindUnique: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    clubTimeSettings: { findUnique: mocks.clubTimeSettingsFindUnique },
    emailTemplateOverride: {
      findUnique: mocks.emailTemplateOverrideFindUnique,
    },
  },
}));

const SETTINGS = {
  clubName: "Test Club",
  bookingsName: "Test Club Bookings",
  lodgeName: "Test Lodge",
  emailFromName: "Test Club",
  supportEmail: "support@example.test",
  contactEmail: "contact@example.test",
  publicUrl: "https://bookings.example.test",
  lodgeTravelNote: "",
  doorCode: null,
};

vi.mock("@/lib/email-message-settings", () => ({
  EMAIL_DEFAULT_FROM_NAME: "Test Club",
  EMAIL_DEFAULT_LODGE_NAME: "Test Lodge",
  applyEmailMessageSettingsToHtml: (html: string) => html,
  applyEmailMessageSettingsToSubject: (subject: string) => subject,
  buildEmailTemplateGlobalData: (settings: Record<string, string>) => ({
    CLUB_NAME: settings.clubName,
    CLUB_BOOKINGS_NAME: settings.bookingsName,
    CLUB_LODGE_NAME: settings.lodgeName,
    CLUB_EMAIL_FROM_NAME: settings.emailFromName,
    SUPPORT_EMAIL: settings.supportEmail,
    CONTACT_EMAIL: settings.contactEmail,
    BASE_URL: settings.publicUrl,
    CLUB_LODGE_TRAVEL_NOTE: settings.lodgeTravelNote,
  }),
  formatEmailFromAddressWithSettings: () => "Club <club@example.test>",
  loadEmailMessageSettings: async () => SETTINGS,
  loadEmailMessageSettingsForLodge: async () => SETTINGS,
}));

vi.mock("@/lib/email-theme", () => ({
  emailPalette: () => ({
    gold: "#e7b83f",
    charcoal: "#374151",
    deep: "#1f2937",
    mist: "#e5e7eb",
    snow: "#ffffff",
    ridge: "#6b7280",
  }),
  // The #2900 render gate. Both the sender and the override re-render await it.
  ensureEmailPaletteReady: async () => ({ source: "club-theme" as const }),
  renderEmailHtml: async <T,>(build: () => T) => build(),
}));

// The sender's OUTPUT is the subject, so the transport is captured rather than
// executed. `prepareEmailMessage` below is the real one.
vi.mock("@/lib/email/core", () => ({
  sendEmail: mocks.sendEmail,
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// The graph, re-imported so `APP_TIME_ZONE` reads the container zone above
// ---------------------------------------------------------------------------

vi.resetModules();

const { APP_TIME_ZONE } = await import("@/config/operational");
const { bindClubTime, requireClubTimeZone } = await import("@/lib/club-time");
const { EMAIL_AUDIT_DEFAULTS } = await import(
  "@/lib/email-message-audit-defaults"
);
const { prepareEmailMessage } = await import("@/lib/email-message-renderer");
const { __resetEmailClubTimeZoneForTests, primeEmailClubTimeZone } =
  await import("@/lib/email-templates-club-time");
const { sendBookingRequestApprovedEmail, sendSplitGuestPaymentLinkEmail } =
  await import("@/lib/email/booking-requests");
const { sendAdditionalPaymentReminderEmail, sendSetupIntentFailedEmail } =
  await import("@/lib/email/booking");
const { sendHutLeaderAssignmentEmail } = await import("@/lib/email/chores");
const { sendWaitlistOfferEmail } = await import("@/lib/email/waitlist");


// ---------------------------------------------------------------------------
// Fixtures and the independent oracles
// ---------------------------------------------------------------------------

/**
 * Two stored lodge nights and one real instant.
 *
 * The nights are exact UTC midnight because that is what a `@db.Date` column
 * round-trips as; anything else is a real timestamp and the calendar-day
 * formatter refuses it outright.
 *
 * The instant is at 23:30 UTC deliberately: it is the same DAY as the stored
 * night for the container's zone and the NEXT day for an eastern club, so the
 * instant assertions can tell a persisted-zone projection from an
 * environment-zone one rather than agreeing by accident.
 */
const CHECK_IN_ISO = "2026-08-01T00:00:00.000Z";
const CHECK_OUT_ISO = "2026-08-03T00:00:00.000Z";
const INSTANT_ISO = "2026-08-01T23:30:00.000Z";
const CHECK_IN = new Date(CHECK_IN_ISO);
const CHECK_OUT = new Date(CHECK_OUT_ISO);
const INSTANT = new Date(INSTANT_ISO);

/**
 * The house medium date shape, written out by hand rather than imported.
 *
 * This is the whole reason the day assertions can fail: pointed at `UTC` it is
 * an independent oracle for "the stored day, unprojected", and pointed at a real
 * zone it reproduces exactly what the path that consulted that zone would have
 * said. `club-time/__tests__/house-shapes.test.ts` is what keeps this shape and
 * the kernel's honest about each other.
 */
const houseDay = (zone: string) =>
  new Intl.DateTimeFormat("en-NZ", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: zone,
  });

/**
 * Every occurrence of the house medium day shape — "1 Aug 2026" — in a document.
 *
 * This is the alphabet the agreement assertion compares in. It deliberately
 * matches the SHAPE rather than any particular value, so it finds the dates a
 * regression renders as well as the ones it should have. `describesTheHouseShape`
 * below refuses to let it drift away from what the formatters actually emit,
 * because a pattern that matches nothing would make that comparison `[]` versus
 * `[]` — vacuously green, which is the exact failure this suite was masking.
 */
const DAY_SHAPE = /[0-9]{1,2} [A-Z][a-z]{2} [0-9]{4}/g;

const storedDay = (iso: string) => houseDay("UTC").format(new Date(iso));
const projectedDay = (iso: string, zone: string) =>
  houseDay(zone).format(new Date(iso));

/** What the club's persisted zone makes of a real instant. */
const clubInstant = (iso: string, zone: string) =>
  bindClubTime(requireClubTimeZone(zone)).instantDateTime(new Date(iso));

// ---------------------------------------------------------------------------
// The two persisted-zone configurations
// ---------------------------------------------------------------------------

/**
 * `WEST` is the discriminating configuration; `EAST` is the current-adopter
 * regression case. See "Why the suite pins TWO persisted zones" in the header
 * for the measurements behind that split.
 */
const CONFIGURATIONS = [
  {
    label:
      "club EAST of Greenwich (persisted Pacific/Auckland, container America/Denver)",
    zone: "Pacific/Auckland",
    /** What this configuration is here to do. */
    role: "every deployment today: proves the stored night is unchanged when the persisted projection would have agreed anyway",
  },
  {
    label:
      "club WEST of Greenwich (persisted Pacific/Honolulu, container America/Denver)",
    zone: "Pacific/Honolulu",
    role: "the discriminating case: both wrong authorities read a stored night as the previous day, so a revert on either path dies here",
  },
] as const;

// ---------------------------------------------------------------------------
// The senders under test
// ---------------------------------------------------------------------------

type Sender = {
  templateName: string;
  label: string;
  send: () => Promise<unknown>;
  /** `templateData` keys holding a STORED CALENDAR DAY, and the value stored. */
  days: Array<{ key: string; iso: string }>;
  /** `templateData` keys holding a REAL INSTANT projected into club time. */
  instants: Array<{ key: string; iso: string }>;
  /**
   * `templateData` keys holding a real instant rendered as a BARE DAY — the
   * third class, which the issue's own split missed. The club's zone IS the
   * right authority here, because this really is a projection.
   */
  instantDays: Array<{ key: string; iso: string }>;
};

const SENDERS: readonly Sender[] = [
  {
    templateName: "booking-request-approved",
    label: "the approval email carrying the /pay link",
    send: () =>
      sendBookingRequestApprovedEmail({
        bookingContext: "none",
        email: "tara@example.test",
        firstName: "Tara",
        token: "pay-token",
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        guestCount: 2,
        priceCents: 12_000,
        bookingReference: "bk_1",
        expiresAt: INSTANT,
      }),
    days: [
      { key: "checkIn", iso: CHECK_IN_ISO },
      { key: "checkOut", iso: CHECK_OUT_ISO },
    ],
    instants: [{ key: "expiresAt", iso: INSTANT_ISO }],
    instantDays: [],
  },
  {
    templateName: "split-guest-payment-link",
    label: "the split-guest pay-link email",
    send: () =>
      sendSplitGuestPaymentLinkEmail({
        bookingContext: "none",
        email: "tara@example.test",
        firstName: "Tara",
        token: "pay-token",
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        guestCount: 2,
        priceCents: 12_000,
        bookingReference: "bk_1",
        expiresAt: INSTANT,
      }),
    days: [
      { key: "checkIn", iso: CHECK_IN_ISO },
      { key: "checkOut", iso: CHECK_OUT_ISO },
    ],
    instants: [{ key: "expiresAt", iso: INSTANT_ISO }],
    instantDays: [],
  },
  {
    templateName: "hut-leader-assignment",
    label: "the hut-leader assignment, whose dates are a roster RANGE",
    send: () =>
      sendHutLeaderAssignmentEmail({
        email: "tara@example.test",
        firstName: "Tara",
        startDate: CHECK_IN,
        endDate: CHECK_OUT,
        pin: "1234",
        assignmentId: "asg_1",
      }),
    days: [
      { key: "startDate", iso: CHECK_IN_ISO },
      { key: "endDate", iso: CHECK_OUT_ISO },
    ],
    instants: [],
    instantDays: [],
  },
  {
    templateName: "additional-payment-reminder",
    label:
      "the outstanding-payment chase, which mixes stored nights with an instant rendered as a bare day",
    send: () =>
      sendAdditionalPaymentReminderEmail({
        bookingId: "bk_1",
        recipientMemberId: "mem_1",
        email: "tara@example.test",
        firstName: "Tara",
        additionalAmountCents: 4_500,
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        requestedOn: INSTANT,
      }),
    days: [
      { key: "checkIn", iso: CHECK_IN_ISO },
      { key: "checkOut", iso: CHECK_OUT_ISO },
    ],
    instants: [],
    instantDays: [{ key: "requestedOn", iso: INSTANT_ISO }],
  },
  {
    templateName: "setup-intent-failed",
    label: "the card-setup failure, whose only dates are the stay",
    send: () =>
      sendSetupIntentFailedEmail({
        bookingId: "bk_1",
        recipientMemberId: "mem_1",
        email: "tara@example.test",
        firstName: "Tara",
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
      }),
    days: [
      { key: "checkIn", iso: CHECK_IN_ISO },
      { key: "checkOut", iso: CHECK_OUT_ISO },
    ],
    instants: [],
    instantDays: [],
  },
  {
    templateName: "waitlist-offer",
    label: "the waitlist offer, whose sender takes positional arguments",
    send: () =>
      sendWaitlistOfferEmail(
        { bookingId: "bk_1", recipientMemberId: "mem_1" },
        "tara@example.test",
        "Tara",
        CHECK_IN,
        CHECK_OUT,
        2,
        INSTANT,
        "bk_1",
        12_000,
      ),
    days: [
      { key: "checkIn", iso: CHECK_IN_ISO },
      { key: "checkOut", iso: CHECK_OUT_ISO },
    ],
    instants: [{ key: "expiresAt", iso: INSTANT_ISO }],
    instantDays: [],
  },
];

/** The shipped default body, saved verbatim as a club's override. */
function shippedDefaultBodyAsOverride(templateName: string) {
  const shipped = (
    EMAIL_AUDIT_DEFAULTS as Record<string, { defaultBody: string }>
  )[templateName];
  expect(
    shipped?.defaultBody,
    `No shipped default body for "${templateName}" — this suite reads the real one so it cannot drift from what clubs actually edit.`,
  ).toBeTruthy();
  return {
    templateName,
    subject: null,
    bodyText: shipped.defaultBody,
    updatedAt: new Date("2026-07-15T00:00:00.000Z"),
    updatedByMemberId: "admin_1",
  };
}

/**
 * Drive the real sender, then push its real `templateData` through the real
 * renderer — the two steps a delivered override email actually takes, with only
 * the transport left out. `override: false` renders the shipped HTML body
 * instead, which is the other path this suite compares against.
 */
async function render(sender: Sender, { override }: { override: boolean }) {
  mocks.sendEmail.mockClear();
  mocks.emailTemplateOverrideFindUnique.mockResolvedValue(
    override ? shippedDefaultBodyAsOverride(sender.templateName) : null,
  );
  await sender.send();
  expect(
    mocks.sendEmail,
    `${sender.label} did not reach sendEmail, so there is no templateData to render.`,
  ).toHaveBeenCalledTimes(1);
  const sent = mocks.sendEmail.mock.calls[0][0] as {
    templateName: string;
    subject: string;
    html: string;
    templateData: EmailTemplateData;
  };
  expect(sent.templateName).toBe(sender.templateName);
  const prepared = await prepareEmailMessage({
    templateName: sent.templateName,
    subject: sent.subject,
    html: sent.html,
    templateData: sent.templateData,
  });
  expect(
    prepared.bodyOverrideApplied,
    override
      ? `The override did not apply for ${sender.templateName}, so this case is not exercising the branch it exists for.`
      : `An override applied for ${sender.templateName} when none was saved.`,
  ).toBe(override);
  return { prepared, templateData: sent.templateData };
}

// ---------------------------------------------------------------------------

describe("email dates render by kind, on both rendering paths", () => {
  it("has the premise it needs: the container's zone is behind Greenwich and is NOT the club's", () => {
    // Without this the suite silently stops discriminating. `APP_TIME_ZONE`
    // defaults to Pacific/Auckland on this repository's own machine, and
    // Auckland's projection of a UTC-midnight day IS that day — so the retired
    // code would produce the right answer and every case below would pass while
    // measuring nothing.
    expect(
      APP_TIME_ZONE,
      "NEXT_PUBLIC_TZ was set before the graph was imported, so APP_TIME_ZONE should be the container zone. If a TZ in the environment is winning, this is an environment problem and not the behaviour under test.",
    ).toBe(CONTAINER_ZONE);

    // The container really does read a stored night as the previous day, which
    // is what makes a templateData revert visible.
    expect(projectedDay(CHECK_IN_ISO, CONTAINER_ZONE)).not.toBe(
      storedDay(CHECK_IN_ISO),
    );
    // And one configuration's persisted zone does too, which is what makes a
    // default-body revert visible.
    expect(projectedDay(CHECK_IN_ISO, "Pacific/Honolulu")).not.toBe(
      storedDay(CHECK_IN_ISO),
    );
    // While the other's does not — that asymmetry is the point of having two.
    expect(projectedDay(CHECK_IN_ISO, "Pacific/Auckland")).toBe(
      storedDay(CHECK_IN_ISO),
    );
  });

  it("has the other premise it needs: DAY_SHAPE really matches what the formatters emit", () => {
    // The agreement assertion compares the multisets of DAY_SHAPE matches in
    // two documents. A pattern that matched nothing would compare `[]` with
    // `[]` and pass while measuring nothing, so pin the pattern against the
    // oracles themselves rather than against a hand-written literal — every
    // day-valued string this suite can expect has to be findable by it.
    for (const value of [
      storedDay(CHECK_IN_ISO),
      storedDay(CHECK_OUT_ISO),
      projectedDay(CHECK_IN_ISO, "Pacific/Honolulu"),
      projectedDay(INSTANT_ISO, "Pacific/Auckland"),
    ]) {
      expect(
        value.match(DAY_SHAPE),
        `DAY_SHAPE no longer matches "${value}", so the agreement comparison it drives would be vacuous. The house medium date shape has moved — update the pattern.`,
      ).toEqual([value]);
    }
    // And it finds a day inside a rendered date-TIME too, which is the exact
    // overlap that made the old whole-document `toContain` maskable.
    expect(clubInstant(INSTANT_ISO, "Pacific/Honolulu").match(DAY_SHAPE)).toEqual(
      [projectedDay(INSTANT_ISO, "Pacific/Honolulu")],
    );
  });

  for (const configuration of CONFIGURATIONS) {
    describe(configuration.label, () => {
      beforeEach(() => {
        vi.clearAllMocks();
        __resetEmailClubTimeZoneForTests();
        mocks.clubTimeSettingsFindUnique.mockResolvedValue({
          timeZone: configuration.zone,
        });
        mocks.emailTemplateOverrideFindUnique.mockResolvedValue(null);
        vi.stubEnv("NEXTAUTH_URL", "https://bookings.example.test");
      });

      for (const sender of SENDERS) {
        describe(sender.label, () => {
          it("puts the STORED day in templateData, projected through no zone", async () => {
            await primeEmailClubTimeZone();
            const { templateData } = await render(sender, { override: true });

            for (const day of sender.days) {
              const expected = storedDay(day.iso);
              expect(
                templateData[day.key],
                `${sender.templateName}.${day.key} is a @db.Date lodge night, so it must render as the day it stores.`,
              ).toBe(expected);
              // The two wrong answers, named explicitly so a regression says
              // which authority it fell back to.
              const environmentSays = projectedDay(day.iso, CONTAINER_ZONE);
              if (environmentSays !== expected)
                expect(templateData[day.key]).not.toBe(environmentSays);
              const persistedSays = projectedDay(day.iso, configuration.zone);
              if (persistedSays !== expected)
                expect(templateData[day.key]).not.toBe(persistedSays);
            }
          });

          it("puts the CLUB's reading of a real instant in templateData", async () => {
            await primeEmailClubTimeZone();
            const { templateData } = await render(sender, { override: true });

            for (const instant of sender.instants) {
              const expected = clubInstant(instant.iso, configuration.zone);
              expect(
                templateData[instant.key],
                `${sender.templateName}.${instant.key} is a real instant, so it must read in the club's persisted zone.`,
              ).toBe(expected);
              const environmentSays = clubInstant(instant.iso, CONTAINER_ZONE);
              if (environmentSays !== expected)
                expect(templateData[instant.key]).not.toBe(environmentSays);
            }
            for (const instantDay of sender.instantDays) {
              const expected = projectedDay(instantDay.iso, configuration.zone);
              expect(
                templateData[instantDay.key],
                `${sender.templateName}.${instantDay.key} is a real instant rendered as a bare day, so the club's zone IS the authority — it is a projection, unlike a stored night.`,
              ).toBe(expected);
              const environmentSays = projectedDay(
                instantDay.iso,
                CONTAINER_ZONE,
              );
              if (environmentSays !== expected)
                expect(templateData[instantDay.key]).not.toBe(environmentSays);
            }
          });

          it("says the same thing with a saved override as without one", async () => {
            await primeEmailClubTimeZone();
            const { prepared: overridden } = await render(sender, {
              override: true,
            });
            const { prepared: shipped } = await render(sender, {
              override: false,
            });

            // THE AGREEMENT, which is the assertion that matters: the defect
            // class is divergence, and two assertions each pinning one path can
            // both pass while the pair disagrees. What each configuration is
            // for is recorded on its `role` above.
            //
            // ## Why the per-token `toContain`s below are NOT the agreement
            //
            // `toContain` searches the WHOLE document, so one token's output can
            // satisfy the assertion made on another token's behalf. Measured on
            // this suite: with the persisted zone `Pacific/Honolulu`, the instant
            // `2026-08-01T23:30Z` renders "1 Aug 2026, 1:30 pm", which contains
            // "1 Aug 2026" — the very string the stored night 2026-08-01 must
            // produce. So reverting a Check-in row to the pre-change
            // `emailClubDate` left all 49 cases green at four of the six senders
            // (only `hut-leader-assignment` and `setup-intent-failed`, which
            // carry no instant, actually died). That Check-in row was a merge
            // conflict site with #3105, so this is the resolution slip that
            // happens, and a Honolulu club's members would have read
            // "Check-in: 31 Jul" from the shipped body with the suite green.
            //
            // ## The oracle that is not maskable
            //
            // Compare the MULTISET of day-shaped strings the two documents
            // render. A revert on one path changes that document's dates and not
            // the other's, so the multisets differ and it dies wherever it is —
            // no per-sender knowledge, no extracted window sized by a magic
            // number, and no reliance on the fixtures failing to collide.
            //
            // Duplicates are kept deliberately (`.sort()`, not a Set): under
            // Honolulu the correct render really is
            // ["1 Aug 2026", "1 Aug 2026", "3 Aug 2026"] — the stored night and
            // the instant's date part genuinely coincide — and collapsing that
            // to a Set would throw away exactly the count that a revert changes.
            //
            // Note what this does and does not prove on its own. It proves the
            // two paths AGREE; it does not prove they are both right, since a
            // revert applied to both would agree too. That half is proved by the
            // `templateData` cases above, which pin the override path's values
            // absolutely with `toBe`, plus the not-vacuous case below, which
            // proves the override body really names every token. Right override
            // path + paths agree ⇒ right shipped path.
            const dayShapedStrings = (html: string) =>
              (html.match(DAY_SHAPE) ?? []).sort();
            // Anti-vacuity: an empty match on BOTH sides would compare equal and
            // prove nothing, which is the shape of the bug being fixed here.
            // Every stored night and every instant-as-bare-day owes the document
            // one day-shaped string, so the count cannot legitimately fall below
            // that.
            expect(
              dayShapedStrings(shipped.html).length,
              `${sender.templateName}'s shipped body renders fewer day-shaped strings than it has day tokens, so the agreement comparison would be vacuous. Either the house date shape moved (fix DAY_SHAPE) or the body stopped rendering a date.`,
            ).toBeGreaterThanOrEqual(
              sender.days.length + sender.instantDays.length,
            );
            expect(
              dayShapedStrings(shipped.html),
              `${sender.templateName} renders different days with a saved body override than without one. The override path and the shipped body must name the same days — that disagreement is the whole of #3113.`,
            ).toEqual(dayShapedStrings(overridden.html));

            for (const day of sender.days) {
              const expected = storedDay(day.iso);
              expect(shipped.html).toContain(expected);
              expect(overridden.html).toContain(expected);
            }
            for (const instant of sender.instants) {
              const expected = clubInstant(instant.iso, configuration.zone);
              expect(shipped.html).toContain(expected);
              expect(overridden.html).toContain(expected);
            }
            for (const instantDay of sender.instantDays) {
              const expected = projectedDay(instantDay.iso, configuration.zone);
              expect(shipped.html).toContain(expected);
              expect(overridden.html).toContain(expected);
            }
          });

          it("still carries the tokens the override renders, so the cases above are not vacuous", () => {
            const shipped = (
              EMAIL_AUDIT_DEFAULTS as Record<string, { defaultBody: string }>
            )[sender.templateName];
            for (const { key } of [
              ...sender.days,
              ...sender.instants,
              ...sender.instantDays,
            ]) {
              expect(
                shipped.defaultBody,
                `The shipped body for ${sender.templateName} no longer names {{${key}}}, so the override cases above assert nothing about a date nobody is shown.`,
              ).toContain(`{{${key}}}`);
            }
          });
        });
      }
    });
  }
});
