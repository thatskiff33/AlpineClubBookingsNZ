// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ClubTimeProvider } from "@/components/club-time-provider";
import {
  bindClubTime,
  calendarDateOfDateOnlyInstant,
  fixedClubClock,
  formatClubDate,
  requireClubTimeZone,
} from "@/lib/club-time";
import { captureHostTimeZone } from "@/lib/__tests__/helpers/timezone";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
  useParams: () => ({}),
}));

vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({
    lodgeName: "Silverpeak Lodge",
    lodgeCapacity: 20,
    hutLeaderLabel: "Hut Leader",
  }),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { MyExceptionRequests } from "@/app/(authenticated)/bookings/_components/my-exception-requests";
import { AccountCreditSection } from "@/app/(authenticated)/profile/account-credit-section";
import LodgeInstructionsPage from "@/app/(authenticated)/lodge-instructions/page";
import { ProfileForm } from "@/app/(authenticated)/profile/profile-form";
import { BookingRequestForm } from "@/app/(website-dynamic)/booking-requests/booking-request-form";
import { MemberGroupJoinPanel } from "@/app/(website-dynamic)/join/[code]/member-group-join-panel";
import type { ClubIdentity } from "@/config/club-identity-types";
import type { MemberExceptionRequestItem } from "@/lib/member-exception-requests";

/**
 * THE CLUB'S PERSISTED TIMEZONE IS THE AUTHORITY ON THE MEMBER AND PUBLIC PAGES
 * (CT-4 group E, #2870; epic #2988; INV-CONFIG-002).
 *
 * ## Why this suite exists separately from the page suites
 *
 * Every other suite over these files renders through
 * `src/lib/__tests__/support/club-time-render`, whose default zone is
 * `Pacific/Auckland` — deliberately, because that is what `APP_TIME_ZONE`
 * resolves to under test, so those tests kept their exact expected strings
 * through the migration. That default makes them useful for what they assert and
 * USELESS for zone authority: where the persisted zone and the environment
 * agree, the migrated code and the code it replaced give the identical answer.
 * `docs/CLUB_TIME_KERNEL.md` names that trap by name — a claim that is
 * "false and green".
 *
 * MEASURED, before this file existed. A mutant `useClubTime()` that ignored the
 * provider entirely and bound `APP_TIME_ZONE` instead failed **16 tests across 8
 * files** in the whole related set, and only **5 of those 16 were group E's**
 * (the kiosk rollover cases, which set the environment to a third zone on
 * purpose). Every other assertion over the twelve migrated files survived the
 * mutant. That is the number this file exists to move.
 *
 * ## The shape of every case here: a PAIR
 *
 * The same component and the same fixture, rendered under two different provider
 * zones, asserted to produce DIFFERENT answers. That difference IS the
 * discrimination, and it does not depend on the host: an implementation that
 * ignored the provider — reading the environment, the viewer's clock, or a
 * hard-coded zone — has exactly one answer to give and therefore fails at least
 * one half, whatever `TZ` the machine running the suite happens to have.
 *
 * The last case is the deliberate EXCEPTION and its pair means the opposite. Its
 * claim is INDEPENDENCE — a calendar day is the same day in every zone — so its
 * halves are asserted to produce the SAME answer, and a difference between them
 * would be the failure. Its own comments say what it does and does not prove.
 *
 * ## Denver, and why BEHIND UTC specifically
 *
 * `TZ` is unset on CI, so the host resolves UTC while `APP_TIME_ZONE` falls back
 * to `Pacific/Auckland`. A club zone AHEAD of UTC agrees with one or both of
 * those for most of the day, so an assertion made under it cannot tell the three
 * authorities apart. Denver disagrees with both, on the frozen instant, in the
 * direction where the date-only defects live.
 *
 * ## The premise is asserted as an ANSWER, never as an identifier
 *
 * `expect(zone).not.toBe("America/Denver")` passes happily under
 * `America/Chicago` while the assertion beneath it goes vacuous. Every case below
 * instead computes both zones' answers for its own fixture and asserts they
 * differ, so a runtime, a fixture edit or a DST rule that made them agree fails
 * loudly here rather than quietly downgrading the case to nothing.
 *
 * `APP_TIME_ZONE` IS DELIBERATELY NOT REFERENCED. It reads `process.env.TZ`, so
 * a premise written against it changes meaning with the machine: on a host
 * running `TZ=America/Denver` it would EQUAL the club zone under test and say
 * nothing. `LEGACY_REFERENCE_ZONE` below is fixed instead, and the pair is what
 * carries the proof.
 *
 * ## And the browser is a third authority, pointed somewhere else again
 *
 * Every case points `process.env.TZ` at `Atlantic/Cape_Verde`, which agrees with
 * neither of the two answers being distinguished. A component that read its own
 * host — the thing `INV-CONFIG-002` forbids — cannot pass by accident.
 *
 * IT IS BEHIND GREENWICH ON PURPOSE, AND THAT IS A SECOND, DIFFERENT MUTANT.
 * This file used to point the host at `Asia/Tokyo`, which is UTC+9 — so a
 * UTC-midnight `@db.Date` encoding read there is still the SAME day. A formatter
 * that dropped its `timeZone: "UTC"` pin altogether and rendered in the
 * runtime's own zone therefore passed the calendar-day case under Tokyo, and
 * passes it on CI too, where `TZ` is unset and the host resolves `UTC` — which
 * makes "pinned to UTC" and "not pinned at all" literally the same thing.
 * MEASURED on this branch: that mutant killed **0 of 530** tests in the related
 * set at `TZ=UTC`, and nothing else closes it — `INV-DATE-015`'s lint arm fires
 * on a MISSING `timeZone` key, and a formatter naming the host's zone has one.
 * `Atlantic/Cape_Verde` is UTC-1 all year: far enough west that the encoding
 * reads as the previous evening, and near enough Greenwich that it still gives a
 * third civil reading of the instant fixtures rather than collapsing onto
 * Denver's.
 *
 * ## What is covered here, and what is covered by its twin
 *
 * Six of the twelve migrated files get a behavioural pair here, chosen so that
 * every MECHANISM the migration used is exercised: `instantDateTime`,
 * `instantDate`, `instantLongDate`, the club's today as a date input's bound (on
 * an authenticated page and on a public one), and the calendar-date formatters
 * that take no zone at all. The remaining files are byte-for-byte twins of one of
 * these — `school-booking-form` of `booking-request-form`,
 * `hut-leader-instructions-client` of `lodge-instructions/page`,
 * `group-join-page-client` of `member-group-join-panel`, and
 * `membership-cancellation-panel` and `booking-request-respond-client` of the two
 * instant cases — and each is held to the same rule by
 * `member-public-club-time-convergence.test.ts`, which is a source census and
 * says so. Three more files carry their own behavioural pairs where their
 * fixtures already live: the kiosk in
 * `(lodge)/lodge/kiosk/__tests__/kiosk-page-week.test.tsx`, the finance CSV
 * stamp in `(finance)/finance/_components/__tests__/finance-dashboard-client.test.tsx`,
 * and — since the #2870 fix round — the public payment page in
 * `(public)/pay/[token]/__tests__/page.test.tsx`.
 *
 * ## The twin claim, MEASURED rather than asserted (#2870 fix round)
 *
 * An adversarial lens took the sentence above at its word and then checked it.
 * It measured that of the twelve files calling `useClubTime()`, FOUR were blind:
 * a `useClubTime()` that ignored the provider entirely and bound `APP_TIME_ZONE`
 * passed every test over them. `pay/[token]/page` was the highest-consequence of
 * the four — the only such line on an UNAUTHENTICATED payment page — and it now
 * has a pair of its own, in the suite named above. Measured over the whole diff's
 * related set, that mutant went from **16 kills across 6 files** to **18 across
 * 7**, the two new ones being the payment page.
 *
 * THE OTHER THREE ARE A STATED LIMIT, and the twin claim for each was verified by
 * comparison rather than left standing on this docblock's word:
 *
 * - `hut-leader-instructions-client`'s `useUpdatedAtFormatter` is byte-for-byte
 *   the same function as `lodge-instructions/page`'s, comment included, down to
 *   the `clubTime.instantLongDate(new Date(value))` call and the falsy guard
 *   above it. That page has a pair here, so a second one would assert the
 *   identical body twice.
 * - `membership-cancellation-panel`'s `useSubmittedAtFormatter` is the one-line
 *   `clubTime.instantDate(new Date(value))`, and `instantDate` is one of the
 *   mechanisms paired here.
 * - `booking-request-respond-client` carries the same two formatters as the
 *   payment page — a fail-soft `formatStayDay` and a `club.instantDateTime`
 *   expiry — and both are now discriminated there. It never had the payment
 *   page's straddle, because it already spelled its expiry as a date AND time.
 *
 * What that limit accepts: a future edit that changed one twin and not the other
 * would not be caught here. The source census is what stands between that and a
 * reintroduced environment read.
 */

/** Neither the environment's zone nor CI's host zone. Behind UTC. */
const CLUB_ZONE = "America/Denver";

/**
 * The other half of every pair: the zone this application used to render
 * everything in. It is `CLUB_TIME_ZONE_FALLBACK`, it is what `APP_TIME_ZONE`
 * resolves to wherever `TZ` is unset — CI included — and it is ahead of UTC
 * where `CLUB_ZONE` is behind it, so the two disagree about both fixtures below.
 */
const LEGACY_REFERENCE_ZONE = "Pacific/Auckland";

/**
 * The frozen test clock (`vitest.clock-setup.ts`), restated because the two
 * "club's today" cases are derived from it: 2026-07-01T00:00:00.000Z is 1 July
 * in Auckland (UTC+12) and in UTC, and 30 JUNE in Denver (UTC-6).
 */
const FROZEN_INSTANT = "2026-07-01T00:00:00.000Z";

/**
 * A real moment. 02:30 UTC on 16 April 2026 is 15 April in Denver (UTC-6) and
 * 16 April in Auckland (UTC+12) — one instant, two civil days.
 */
const STAMP = "2026-04-16T02:30:00.000Z";

/** A `@db.Date` lodge night: the calendar day 16 April, encoded at UTC midnight. */
const NIGHT_IN = "2026-04-16T00:00:00.000Z";
const NIGHT_OUT = "2026-04-18T00:00:00.000Z";

const denver = bindClubTime(requireClubTimeZone(CLUB_ZONE));
const auckland = bindClubTime(requireClubTimeZone(LEGACY_REFERENCE_ZONE));
const frozenClock = fixedClubClock(new Date(FROZEN_INSTANT));

const hostTimeZone = captureHostTimeZone();

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  hostTimeZone.restore();
});

function renderInClubZone(ui: React.ReactElement, zone = CLUB_ZONE) {
  return render(<ClubTimeProvider zone={zone}>{ui}</ClubTimeProvider>);
}

/**
 * The viewer's own clock, set to a third place, for every case.
 *
 * `Atlantic/Cape_Verde` is UTC-1 all year. Two properties earn it the job, and
 * the second is the one a later edit is most likely to throw away:
 *
 * - at `STAMP` it reads 1:30 am on 16 April, which is neither of the two civil
 *   readings any instant case asserts, so a component that read its own host
 *   fails whichever club is configured;
 * - it is BEHIND Greenwich, so a UTC-midnight `@db.Date` encoding read in the
 *   runtime's own zone lands on the PREVIOUS day. That is what makes the
 *   calendar-day case falsifiable — see the module doc.
 */
function pointTheBrowserSomewhereElse() {
  process.env.TZ = "Atlantic/Cape_Verde";
}

function stubJsonFetch(payload: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => payload,
    })),
  );
}

describe("CT-4 group E: an instant is projected through the CLUB's zone", () => {
  function exceptionRequest(): MemberExceptionRequestItem {
    return {
      id: "req-1",
      source: "NEW_BOOKING",
      status: "pending",
      createdAt: STAMP,
      reviewedAt: null,
      proposal: {
        lodgeId: "lodge-1",
        checkIn: "2026-04-16",
        checkOut: "2026-04-18",
        guests: [
          {
            firstName: "Sam",
            lastName: "Skier",
            ageTier: "ADULT",
            isMember: true,
            nights: ["2026-04-16", "2026-04-17"],
          },
        ],
        guestNights: 2,
        baseCheckIn: null,
        baseCheckOut: null,
        baseGuestNights: null,
      },
      rules: [
        {
          reasonCode: "MINIMUM_STAY",
          message: "Friday nights need a two-night booking.",
          affectedNights: ["2026-04-16"],
        },
      ],
      memberMessage: null,
      decisionExplanation: null,
      capacityHeld: false,
      capacityMode: "NO_HOLD",
      lastConflictReason: null,
      lastConflictAt: null,
      bookingId: null,
      createdBookingId: null,
      createdBookingHoldsCapacity: null,
      createdBookingAwaitsPayment: null,
    } as MemberExceptionRequestItem;
  }

  it("stamps a member's exception request with the club's day and hour", () => {
    // PREMISE AS AN ANSWER: the two zones read this one moment as different
    // civil days. If a runtime or a fixture edit ever made them agree, this
    // fails here rather than leaving the case below asserting nothing.
    expect(denver.instantDateTime(new Date(STAMP))).toBe("15 Apr 2026, 8:30 pm");
    expect(auckland.instantDateTime(new Date(STAMP))).toBe(
      "16 Apr 2026, 2:30 pm",
    );
    expect(denver.instantDateTime(new Date(STAMP))).not.toBe(
      auckland.instantDateTime(new Date(STAMP)),
    );

    pointTheBrowserSomewhereElse();
    renderInClubZone(<MyExceptionRequests requests={[exceptionRequest()]} />);

    expect(screen.getByText(/Asked on 15 Apr 2026, 8:30 pm/)).toBeInTheDocument();
    expect(screen.queryByText(/16 Apr 2026, 2:30 pm/)).toBeNull();
  });

  it("stamps the SAME request with a different club's day", () => {
    /*
      The other half of the pair, and what makes the case above about the
      PROVIDER rather than about a hard-coded 15 April. A hook that ignored the
      context — reading `APP_TIME_ZONE`, the viewer's clock, or a constant —
      answers both halves identically and fails one of them on any host.
    */
    pointTheBrowserSomewhereElse();
    renderInClubZone(
      <MyExceptionRequests requests={[exceptionRequest()]} />,
      LEGACY_REFERENCE_ZONE,
    );

    expect(screen.getByText(/Asked on 16 Apr 2026, 2:30 pm/)).toBeInTheDocument();
    expect(screen.queryByText(/15 Apr 2026, 8:30 pm/)).toBeNull();
  });
});

describe("CT-4 group E: an instant and a calendar day, side by side, do NOT merge", () => {
  /*
    THE MOST VALUABLE CASE IN THIS FILE, because it is the defect class rather
    than one instance of it. The account-credit list renders a transaction's
    `createdAt` — a real INSTANT — one line above the source booking's
    `checkIn`/`checkOut`, which are `@db.Date` LODGE NIGHTS. Before CT-4 both
    went through the same `formatNZDate(new Date(v))`, which is why they were so
    easy to confuse: in New Zealand the two are indistinguishable.

    Under a Denver club they are not. The instant moves back a day and the lodge
    nights must not, so a single component is asserted to treat the two
    differently in one render. An implementation that routed the stay dates
    through the hook as well — the shape a future author is most likely to reach
    for, since `instantDate` is right there — fails the second expectation while
    passing the first.
  */
  const CREDIT_PAYLOAD = {
    balanceCents: 5000,
    history: [
      {
        id: "tx-1",
        amountCents: 5000,
        type: "CANCELLATION_REFUND",
        description: "Cancelled stay",
        createdAt: STAMP,
        sourceBooking: {
          id: "booking-1",
          checkIn: NIGHT_IN,
          checkOut: NIGHT_OUT,
        },
        appliedToBooking: null,
      },
    ],
  };

  it("moves the transaction stamp to the club's day and leaves the stay alone", async () => {
    // PREMISE, both halves of it. The instant differs between the two zones;
    // the lodge night is the same day whichever zone is asked, and is NOT what
    // the club zone would make of the same encoding.
    expect(denver.instantDate(new Date(STAMP))).toBe("15 Apr 2026");
    expect(auckland.instantDate(new Date(STAMP))).toBe("16 Apr 2026");
    expect(
      formatClubDate(calendarDateOfDateOnlyInstant(new Date(NIGHT_IN))),
    ).toBe("16 Apr 2026");
    expect(denver.instantDate(new Date(NIGHT_IN))).toBe("15 Apr 2026");

    pointTheBrowserSomewhereElse();
    stubJsonFetch(CREDIT_PAYLOAD);
    renderInClubZone(<AccountCreditSection />);

    // The INSTANT follows the club.
    await waitFor(() =>
      expect(screen.getByText("15 Apr 2026")).toBeInTheDocument(),
    );
    // The LODGE NIGHTS do not, even under the same club.
    expect(
      screen.getByText("16 Apr 2026 - 18 Apr 2026"),
    ).toBeInTheDocument();
    expect(screen.queryByText("15 Apr 2026 - 17 Apr 2026")).toBeNull();
  });

  it("moves the stamp again under a different club, and STILL leaves the stay alone", async () => {
    pointTheBrowserSomewhereElse();
    stubJsonFetch(CREDIT_PAYLOAD);
    renderInClubZone(<AccountCreditSection />, LEGACY_REFERENCE_ZONE);

    await waitFor(() =>
      expect(screen.getByText("16 Apr 2026")).toBeInTheDocument(),
    );
    expect(
      screen.getByText("16 Apr 2026 - 18 Apr 2026"),
    ).toBeInTheDocument();
  });
});

describe("CT-4 group E: the long spelled-out stamp keeps INV-DATE-016 and takes the club's zone", () => {
  const DOCUMENTS = {
    documents: [
      {
        key: "OPEN",
        title: "Opening the lodge",
        description: "What to do on arrival.",
        contentHtml: "<p>Turn the water on.</p>",
        updatedAt: STAMP,
      },
    ],
  };

  it("reads a Denver club's 'last updated' as the previous day", async () => {
    expect(denver.instantLongDate(new Date(STAMP))).toBe("15 April 2026");
    expect(auckland.instantLongDate(new Date(STAMP))).toBe("16 April 2026");
    expect(denver.instantLongDate(new Date(STAMP))).not.toBe(
      auckland.instantLongDate(new Date(STAMP)),
    );

    pointTheBrowserSomewhereElse();
    stubJsonFetch(DOCUMENTS);
    renderInClubZone(<LodgeInstructionsPage />);

    // The long spelled-out month is the shape INV-DATE-016 reserves for this
    // surface, and it survived the migration — asserted here rather than only
    // in the source contract that names the call.
    await waitFor(() =>
      expect(screen.getByText(/Last updated 15 April 2026/)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/16 April 2026/)).toBeNull();
  });

  it("reads the same stamp as the next day for a New Zealand club", async () => {
    pointTheBrowserSomewhereElse();
    stubJsonFetch(DOCUMENTS);
    renderInClubZone(<LodgeInstructionsPage />, LEGACY_REFERENCE_ZONE);

    await waitFor(() =>
      expect(screen.getByText(/Last updated 16 April 2026/)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/15 April 2026/)).toBeNull();
  });
});

describe("CT-4 group E: 'today' on a date input is the CLUB's day", () => {
  const member = {
    id: "member-1",
    firstName: "Alice",
    lastName: "Smith",
    phoneCountryCode: "64",
    phoneAreaCode: "27",
    phoneNumber: "4224115",
    dateOfBirth: "1990-01-15",
    streetAddressLine1: "123 Main St",
    streetAddressLine2: "",
    streetCity: "Example",
    streetRegion: "Waikato",
    streetPostalCode: "3420",
    streetCountry: "NZ",
    postalAddressLine1: "123 Main St",
    postalAddressLine2: "",
    postalCity: "Example",
    postalRegion: "Waikato",
    postalPostalCode: "3420",
    postalCountry: "NZ",
    lodgeScreenPhoneOptIn: false,
  };

  const STUB_CLUB = {
    lodgeName: "Silverpeak Lodge",
    lodgeCapacity: 20,
    hutLeaderLabel: "Hut Leader",
  } as unknown as ClubIdentity;

  it("bounds a date of birth at the club's today, not the host's", () => {
    // PREMISE AS AN ANSWER, on the frozen instant this whole suite runs at.
    expect(denver.today(frozenClock)).toBe("2026-06-30");
    expect(auckland.today(frozenClock)).toBe("2026-07-01");
    expect(denver.today(frozenClock)).not.toBe(auckland.today(frozenClock));

    pointTheBrowserSomewhereElse();
    renderInClubZone(<ProfileForm member={member} />);

    expect(screen.getByLabelText("Date of Birth")).toHaveAttribute(
      "max",
      "2026-06-30",
    );
  });

  it("bounds it at a DIFFERENT club's today", () => {
    pointTheBrowserSomewhereElse();
    renderInClubZone(<ProfileForm member={member} />, LEGACY_REFERENCE_ZONE);

    expect(screen.getByLabelText("Date of Birth")).toHaveAttribute(
      "max",
      "2026-07-01",
    );
  });

  it("offers the club's night as the earliest on the PUBLIC request form", async () => {
    /*
      The same claim on a page with no session at all, reached from an email or a
      search engine. It matters more here than on the profile form: the route
      behind this one resolves "today" against the club and refuses anything
      earlier, so a bound taken from anywhere else offers a night the server
      will not accept. #2682 fixed exactly that once, when the bound was the UTC
      day.
    */
    pointTheBrowserSomewhereElse();
    stubJsonFetch({ showPricingToNonMembers: false, lodges: [] });

    renderInClubZone(<BookingRequestForm club={STUB_CLUB} />);

    const checkIn = (await screen.findByLabelText(
      /check-?in/i,
    )) as HTMLInputElement;
    await waitFor(() => expect(checkIn.getAttribute("min")).toBeTruthy());
    expect(checkIn.getAttribute("min")).toBe("2026-06-30");
  });

  it("offers a DIFFERENT club's night on the same public form", async () => {
    pointTheBrowserSomewhereElse();
    stubJsonFetch({ showPricingToNonMembers: false, lodges: [] });

    renderInClubZone(
      <BookingRequestForm club={STUB_CLUB} />,
      LEGACY_REFERENCE_ZONE,
    );

    const checkIn = (await screen.findByLabelText(
      /check-?in/i,
    )) as HTMLInputElement;
    await waitFor(() => expect(checkIn.getAttribute("min")).toBeTruthy());
    expect(checkIn.getAttribute("min")).toBe("2026-07-01");
  });
});

describe("CT-4 group E: a calendar day consults NO zone at all", () => {
  /*
    THE EXCEPTION, and its pair asserts the SAME answer twice rather than two
    different ones. `GroupBooking.checkIn`, `checkOut` and `joinDeadline` are all
    `@db.Date` columns, so this whole panel — one of the two files in this group
    that turned out to need no zone whatsoever — must render the stored day for
    every club and every viewer.

    WHAT THE FIRST HALF PROVES: projecting the value through the PROVIDER's zone
    gives a different day, so this fails against an implementation that reached
    for `instantDate` because every neighbouring value in the tree is an instant.
    WHAT IT DOES NOT PROVE, said plainly: it is not what the code this replaced
    did. `formatNZDate(new Date(v))` projected through `APP_TIME_ZONE`, which for
    a UTC-midnight night east of Greenwich yields the same "16 Apr 2026" — so the
    predecessor passes both halves, and so would anything pinned to a zone ahead
    of UTC. The behind-UTC half is what has teeth.
  */
  const GROUP = {
    code: "ABC123",
    status: "OPEN",
    paymentMode: "EACH_PAYS_OWN",
    organiserFirstName: "Robin",
    lodgeName: "Silverpeak Lodge",
    checkIn: NIGHT_IN,
    checkOut: NIGHT_OUT,
    joinDeadline: null,
    isJoinable: false,
  };

  it("renders the stored nights under a club zone that would have shifted them", async () => {
    expect(denver.instantDate(new Date(NIGHT_IN))).toBe("15 Apr 2026");
    expect(
      formatClubDate(calendarDateOfDateOnlyInstant(new Date(NIGHT_IN))),
    ).toBe("16 Apr 2026");
    expect(denver.instantDate(new Date(NIGHT_IN))).not.toBe(
      formatClubDate(calendarDateOfDateOnlyInstant(new Date(NIGHT_IN))),
    );

    pointTheBrowserSomewhereElse();
    // THE THIRD PREMISE, and the one the pair below cannot state for itself: the
    // host now reads this encoding as a different day too, so a formatter that
    // consulted the RUNTIME rather than nothing at all fails here. Read from
    // `Intl` rather than `process.env`, because it is the resolved zone that
    // decides what an unpinned formatter renders.
    expect(
      new Intl.DateTimeFormat("en-NZ", {
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        dateStyle: "medium",
      }).format(new Date(NIGHT_IN)),
    ).toBe("15 Apr 2026");

    stubJsonFetch(GROUP);
    renderInClubZone(<MemberGroupJoinPanel code="ABC123" />);

    await waitFor(() =>
      expect(screen.getByText("16 Apr 2026 to 18 Apr 2026")).toBeInTheDocument(),
    );
    expect(screen.queryByText("15 Apr 2026 to 17 Apr 2026")).toBeNull();
  });

  it("renders the same nights under a club on the far side of the world", async () => {
    /*
      Kiritimati is UTC+14, the opposite extreme from Denver. This half is a
      forward-looking regression guard on the PAIR — it pins that the two agree,
      so an implementation that starts consulting the provider for a calendar day
      reddens one of them — and not a second independent proof.

      The host stays BEHIND Greenwich here too, so this half also refuses a
      formatter that reads the runtime instead of the provider.
    */
    pointTheBrowserSomewhereElse();
    stubJsonFetch(GROUP);
    renderInClubZone(
      <MemberGroupJoinPanel code="ABC123" />,
      "Pacific/Kiritimati",
    );

    await waitFor(() =>
      expect(screen.getByText("16 Apr 2026 to 18 Apr 2026")).toBeInTheDocument(),
    );
    expect(screen.queryByText("17 Apr 2026 to 19 Apr 2026")).toBeNull();
  });
});
