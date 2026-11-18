// @vitest-environment jsdom

/**
 * A refused booking-desk price quote says why (ALP-649, #4976 follow-up).
 *
 * The quote parsed the reply as JSON before checking `ok`. Its catch already
 * showed the fixed "Failed to calculate price" for an HTML error page, so these
 * cases pin that behaviour now that the refusal is read through the shared
 * `apiRefusalFromResponse` rather than fix a visible fault: the route's own
 * sentence when it sent one, this screen's fallback otherwise, and the fallback
 * again when the request never arrives. The page mocks below are
 * the ones lodge-date-response-ownership.test.tsx uses.
 */

import "@testing-library/jest-dom/vitest"
import { useEffect } from "react"
import { cleanup, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render"
import { afterEach, describe, expect, it, vi } from "vitest"
import { itShowsEveryRefusal } from "@/lib/__tests__/support/failed-write-cases"

const LODGES = [
  { id: "lodge-a", name: "Lodge A" },
  { id: "lodge-b", name: "Lodge B" },
]

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/hooks/use-admin-area-edit-access")),
  useAdminAreaEditAccess: () => true,
  // /admin/book also reads lodge-area view access for its not-set-up link (#3407).
  useAdminAreaViewAccess: () => true,
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
    lodges: LODGES,
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
    return (
      <button type="button" onClick={() => onChange("lodge-b")}>
        Choose Lodge B
      </button>
    )
  },
}))

vi.mock("@/components/booking-calendar", () => ({
  BookingCalendar: ({
    lodgeId,
    onDateSelect,
  }: {
    lodgeId: string | null
    onDateSelect: (checkIn: string, checkOut: string) => Promise<void>
  }) => (
    <button
      type="button"
      onClick={() =>
        void onDateSelect(
          lodgeId === "lodge-b" ? "2026-08-12" : "2026-08-10",
          lodgeId === "lodge-b" ? "2026-08-14" : "2026-08-12",
        )
      }
    >
      Choose dates at {lodgeId ?? "unknown"}
    </button>
  ),
}))

vi.mock("@/components/guest-form", () => ({
  // `maxGuests` is nullable since #2930: null is "no ceiling", which is how an
  // unconfigured lodge's 0 beds stops reading as "you may add zero guests".
  GuestForm: ({ maxGuests, onGuestsChange }: {
    maxGuests: number | null
    onGuestsChange: (guests: Array<{ firstName: string; lastName: string; ageTier: string; isMember: boolean }>) => void
  }) => (
    <div data-testid="guest-form" data-max-guests={String(maxGuests)}>
      <button
        type="button"
        onClick={() => onGuestsChange([{ firstName: "Alex", lastName: "Guest", ageTier: "ADULT", isMember: true }])}
      >
        Add test guest
      </button>
    </div>
  ),
}))

vi.mock("@/components/promo-code-input", () => ({
  PromoCodeInput: () => null,
}))

import AdminBookPage from "@/app/(admin)/admin/booking-desk/book/page"

type Answer = () => Response | Promise<Response>

async function requestQuote(answer: Answer) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input)
      if (url === "/api/bookings/quote") return answer()
      if (url.includes("/api/availability/check")) {
        return Response.json({ minAvailable: 8, lodgeCapacity: 10,
          nightDetails: [{ occupiedBeds: 2, availableBeds: 8 }] })
      }
      if (url.includes("/api/admin/bookings/eligible-family")) return Response.json({ familyMembers: [] })
      if (url.includes("/api/payments/options")) {
        return Response.json({ methods: { internetBanking: { enabled: false } } })
      }
      return Response.json({})
    }),
  )
  render(<AdminBookPage />)
  fireEvent.click(screen.getByRole("button", { name: "Pick member" }))
  await waitFor(() => expect(screen.getByTestId("admin-book-lodge")).toHaveTextContent("Lodge A"))
  fireEvent.click(screen.getByRole("button", { name: "Choose dates at lodge-a" }))
  expect(await screen.findByTestId("guest-form")).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "Add test guest" }))
  fireEvent.click(screen.getByRole("button", { name: "Continue" }))
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("Booking desk: a refused price quote says why", () => {
  itShowsEveryRefusal({ submit: requestQuote, fallback: "Failed to calculate price" })

  it("moves to the review step when the quote succeeds", async () => {
    await requestQuote(() => Response.json({ totalPriceCents: 1000, guests: [] }))
    expect(await screen.findByText("Booking Summary")).toBeInTheDocument()
  })
})
