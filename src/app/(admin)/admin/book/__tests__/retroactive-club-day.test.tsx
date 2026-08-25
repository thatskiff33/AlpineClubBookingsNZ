// @vitest-environment jsdom

/**
 * WHOSE "today" decides that an admin-entered stay is RETROACTIVE (CT-4, #2870).
 *
 * ## Why this screen and not a prettier one
 *
 * `admin/book/page.tsx` compares the chosen check-in against `clubTime.today()`
 * and, when it is in the past, takes a different path: the guest cap relaxes,
 * "Save as Draft" is refused, and the POST carries `allowPastDates: true` so the
 * server applies the retroactive pricing rules. So the club's calendar day here
 * is not a label — it decides money and capacity — and before this test the only
 * coverage of it rendered under `CLUB_TIME_TEST_ZONE`, which is deliberately
 * equal to `APP_TIME_ZONE`. Under that zone the migrated code and the browser's
 * `new Date()` it replaced give the identical answer, so every assertion on this
 * page passed whether or not the club's persisted zone was consulted.
 *
 * ## What makes this one discriminating
 *
 * The frozen clock sits at 2026-07-01T00:00:00Z. A club six hours behind UTC is
 * still on 30 June; one twelve or fourteen hours ahead has reached 1 July. So a
 * stay whose first night is 30 June is TODAY for the first club and YESTERDAY
 * for the second — and the two clubs must therefore disagree about whether the
 * retroactive path engages at all. The zone is chosen rather than written down,
 * because a contributor running with `TZ=America/Denver` would otherwise make
 * the "divergent" literal the environment's own zone.
 */

import "@testing-library/jest-dom/vitest"
import { useEffect, type ReactNode } from "react"
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@/lib/__tests__/support/club-time-render"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { APP_TIME_ZONE } from "@/config/operational"
import { ClubTimeProvider } from "@/components/club-time-provider"
import { chooseDivergentClubZone } from "@/lib/__tests__/helpers/club-time-zone"

/** The stay's first night — 30 June, the day the two zones disagree about. */
const CHECK_IN = "2026-06-30"
const CHECK_OUT = "2026-07-02"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

// PARTIAL mock: only the hook is faked. `ADMIN_VIEW_ONLY_ACTION_REASON` lives
// in the same module and `ViewOnlyActionButton` defaults a prop from it, so a
// wholesale replacement makes the review step throw at render — the widened
// module graph problem `test:related` exists to catch.
vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-admin-area-edit-access")>()),
  useAdminAreaEditAccess: () => true,
}))

vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ lodgeCapacity: 30 }),
}))

vi.mock("@/components/admin/member-picker", () => ({
  MemberPicker: ({
    selected,
    onSelect,
  }: {
    selected?: { firstName: string } | null
    onSelect: (member: {
      id: string
      firstName: string
      lastName: string
      email: string
      ageTier: string
    }) => void
  }) =>
    selected ? (
      <div>Booking for {selected.firstName}</div>
    ) : (
      <button
        onClick={() =>
          onSelect({
            id: "member-1",
            firstName: "Alex",
            lastName: "Member",
            email: "alex@example.test",
            ageTier: "ADULT",
          })
        }
      >
        Pick member
      </button>
    ),
}))

vi.mock("@/components/admin/non-member-contact-form", () => ({
  NonMemberContactForm: () => null,
}))

vi.mock("@/components/lodge-select", () => ({
  useLodgeOptions: () => ({
    lodges: [{ id: "lodge-a", name: "Lodge A" }],
    loading: false,
    failed: false,
    forbidden: false,
    reload: vi.fn(),
  }),
  LodgeSelect: ({
    value,
    onChange,
  }: {
    value: string | null
    onChange: (lodgeId: string | null) => void
  }) => {
    useEffect(() => {
      if (value === null) onChange("lodge-a")
    }, [onChange, value])
    return null
  },
}))

vi.mock("@/components/booking-calendar", () => ({
  BookingCalendar: ({
    onDateSelect,
  }: {
    onDateSelect: (checkIn: string, checkOut: string) => Promise<void>
  }) => (
    <button type="button" onClick={() => void onDateSelect(CHECK_IN, CHECK_OUT)}>
      Choose the 30 June stay
    </button>
  ),
}))

vi.mock("@/components/guest-form", () => ({
  GuestForm: ({
    onGuestsChange,
  }: {
    onGuestsChange: (
      guests: Array<{
        firstName: string
        lastName: string
        ageTier: string
        isMember: boolean
      }>,
    ) => void
  }) => (
    <button
      type="button"
      onClick={() =>
        onGuestsChange([
          { firstName: "Alex", lastName: "Guest", ageTier: "ADULT", isMember: true },
        ])
      }
    >
      Add test guest
    </button>
  ),
}))

vi.mock("@/components/promo-code-input", () => ({
  PromoCodeInput: () => null,
}))

import AdminBookPage from "@/app/(admin)/admin/book/page"

function response(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response
}

/**
 * An INDEPENDENT oracle for "what calendar day is it in this zone", not
 * `clubToday`: reading the answer back through the kernel under test would let
 * one defect satisfy both sides of the comparison. `en-CA` numeric is
 * `yyyy-MM-dd`, the shape the page compares.
 */
const todayIn = (zone: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date())

describe("admin book: the club's day decides what is retroactive (CT-4, #2870)", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        const url = String(input)
        if (url.includes("/api/availability/check")) {
          return response({
            minAvailable: 20,
            nightDetails: [{ occupiedBeds: 10, availableBeds: 20 }],
          })
        }
        if (url.includes("/api/admin/bookings/eligible-family")) {
          return response({ familyMembers: [] })
        }
        if (url.includes("/api/payments/options")) {
          return response({ methods: { internetBanking: { enabled: false } } })
        }
        if (url.includes("/api/bookings/quote")) {
          return response({
            guests: [{ ageTier: "ADULT", isMember: true, nights: 2, priceCents: 6000 }],
            totalPriceCents: 6000,
            availableCreditCents: 0,
          })
        }
        return response({})
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it("treats the 30 June stay as retroactive only when the PERSISTED club zone says 30 June is past", async () => {
    const chosen = chooseDivergentClubZone({
      subject: "the club's today at the frozen instant",
      answerKey: "today",
      cases: [
        // −6 at this date: still 30 June, so the stay starts TODAY and the
        // retroactive path must NOT engage.
        { zone: "America/Denver", today: "2026-06-30", retroactive: false },
        // +14, no DST: already 1 July, so 30 June is yesterday and it MUST.
        { zone: "Pacific/Kiritimati", today: "2026-07-01", retroactive: true },
      ],
      answerFor: todayIn,
      // NOT `["UTC"]` — a "today" assertion has very few calendar days to play
      // with, and adding UTC as a rival can leave a correct tree with no
      // candidate at all. See the chooser's note.
    })
    // The two zones must genuinely disagree about this stay, or the assertion
    // below would hold for either answer. Hand-derived, not recomputed.
    const environmentRetroactive = CHECK_IN < todayIn(APP_TIME_ZONE)
    expect(chosen.retroactive).not.toBe(environmentRetroactive)
    expect(chosen.retroactive).toBe(CHECK_IN < chosen.today)

    render(<AdminBookPage />, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <ClubTimeProvider zone={chosen.zone}>{children}</ClubTimeProvider>
      ),
    })

    fireEvent.click(screen.getByRole("button", { name: "Pick member" }))
    await waitFor(() =>
      expect(screen.getByTestId("admin-book-lodge")).toHaveTextContent("Lodge A"),
    )

    // Tick "Record a past stay" FIRST: `isRetroactive` needs the flag as well as
    // a past check-in, so without it the page could not report either answer.
    fireEvent.click(screen.getByRole("checkbox", { name: /Record a past stay/ }))
    fireEvent.click(screen.getByRole("button", { name: "Choose the 30 June stay" }))

    fireEvent.click(await screen.findByRole("button", { name: "Add test guest" }))
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))

    // The review step's retroactive banner is the page's own statement of which
    // path it took, and the draft button's refusal is the consequence.
    const draftButton = await screen.findByRole("button", { name: /Save as Draft/i })
    const banner = screen.queryByText(/Recording a past stay/)

    if (chosen.retroactive) {
      expect(banner).not.toBeNull()
      expect(draftButton).toBeDisabled()
    } else {
      expect(banner).toBeNull()
      expect(draftButton).not.toBeDisabled()
    }
  })
})
