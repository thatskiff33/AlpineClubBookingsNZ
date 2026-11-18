// @vitest-environment jsdom

/*
  #4975 (ALP-578): the booking desk's one error box is the result of an
  officer's own action: a quote, a draft or a create. Each refusal takes focus
  through the permanently mounted `FocusedActionError`, and takes it again when
  the same refusal repeats word for word. The Xero reconnect link a refused
  create can carry survives the move into the alert's `action` slot.

  The harness is the trimmed shape `dependant-identity-on-behalf.test.tsx` uses:
  the pickers, calendar and guest form are stubs, so the page's own handlers and
  alert are what run.
*/

import "@testing-library/jest-dom/vitest"
import { useEffect } from "react"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@/lib/__tests__/support/club-time-render"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { expectRecoveryAlertToHoldFocus } from "@/lib/__tests__/helpers/focus"

const MEMBER = {
  id: "member-1",
  firstName: "Alex",
  lastName: "Member",
  email: "alex@example.test",
  ageTier: "ADULT",
}

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

// A partial mock: `ViewOnlyActionButton` reads a constant from this module.
vi.mock(import("@/hooks/use-admin-area-edit-access"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAdminAreaEditAccess: () => true,
  useAdminAreaViewAccess: () => true,
}))

vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ lodgeCapacity: 30 }),
}))

vi.mock("@/components/admin/member-picker", () => ({
  MemberPicker: ({ onSelect }: { onSelect: (member: typeof MEMBER) => void }) => (
    <button onClick={() => onSelect(MEMBER)}>Pick member</button>
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
    return <div data-testid="lodge-select" />
  },
}))

vi.mock("@/components/booking-calendar", () => ({
  BookingCalendar: ({
    onDateSelect,
  }: {
    onDateSelect: (checkIn: string, checkOut: string) => Promise<void>
  }) => (
    <button type="button" onClick={() => void onDateSelect("2026-08-10", "2026-08-12")}>
      Choose dates
    </button>
  ),
}))

vi.mock("@/components/guest-form", () => ({
  GuestForm: ({
    onGuestsChange,
  }: {
    onGuestsChange: (guests: unknown[]) => void
  }) => (
    <button
      type="button"
      onClick={() =>
        onGuestsChange([
          { firstName: "Robin", lastName: "Visitor", ageTier: "ADULT", isMember: false },
        ])
      }
    >
      Add a visitor
    </button>
  ),
}))

vi.mock("@/components/promo-code-input", () => ({
  PromoCodeInput: () => null,
}))

import AdminBookPage from "@/app/(admin)/admin/booking-desk/book/page"

function response(body: unknown, init?: { ok?: boolean; status?: number }) {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
  } as Response
}

const QUOTE = {
  guests: [{ ageTier: "ADULT", isMember: false, nights: 2, priceCents: 0 }],
  totalPriceCents: 0,
  availableCreditCents: 0,
}

let quoteAnswer: Response
let createAnswer: Response

beforeEach(() => {
  quoteAnswer = response(QUOTE)
  createAnswer = response({ id: "booking-new" })
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input)
      if (url.includes("/api/admin/bookings/eligible-family")) {
        return response({ familyMembers: [], ownDependants: [] })
      }
      if (url.includes("/api/availability/check")) {
        return response({
          minAvailable: 20,
          lodgeCapacity: 30,
          nightDetails: [{ occupiedBeds: 10, availableBeds: 20 }],
        })
      }
      if (url.includes("/api/payments/options")) {
        return response({ methods: { internetBanking: { enabled: false } } })
      }
      if (url.includes("/api/bookings/quote")) return quoteAnswer
      if (url.includes("/api/bookings")) return createAnswer
      return response({})
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

/** Pick the member and dates, and add a guest; the party is ready to quote. */
async function reachGuestStep() {
  render(<AdminBookPage />)
  fireEvent.click(screen.getByRole("button", { name: "Pick member" }))
  fireEvent.click(await screen.findByRole("button", { name: "Choose dates" }))
  fireEvent.click(await screen.findByRole("button", { name: "Add a visitor" }))
}

/** Continue to the review step, whose quote the test has set to succeed. */
async function reachReviewStep() {
  await reachGuestStep()
  fireEvent.click(screen.getByRole("button", { name: "Continue" }))
  await screen.findByRole("button", { name: "Confirm Booking" })
}

const alertElement = () => document.getElementById("admin-book-action-error")

describe("booking desk action failures (#4975)", () => {
  it("focuses a refused price quote, and focuses it again when it repeats", async () => {
    quoteAnswer = response({ error: "Those dates are closed." }, { ok: false, status: 409 })
    await reachGuestStep()
    const alert = alertElement()

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const next = await screen.findByRole("button", { name: "Continue" })
      next.focus()
      fireEvent.click(next)
      await waitFor(() => expect(alert).toHaveTextContent("Those dates are closed."))
      await expectRecoveryAlertToHoldFocus(alert)
    }
  })

  it("focuses a refused draft, and focuses it again when it repeats", async () => {
    createAnswer = response({ error: "Draft refused." }, { ok: false, status: 409 })
    await reachReviewStep()
    const alert = alertElement()

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const draft = screen.getByRole("button", { name: "Save as Draft" })
      draft.focus()
      fireEvent.click(draft)
      await waitFor(() => expect(alert).toHaveTextContent("Draft refused."))
      await expectRecoveryAlertToHoldFocus(alert)
    }
  })

  it("focuses a refused create and keeps the Xero reconnect link", async () => {
    createAnswer = response(
      { error: "Xero needs to be reconnected.", reason: "reconnect_required" },
      { ok: false, status: 503 },
    )
    await reachReviewStep()
    fireEvent.click(screen.getByRole("button", { name: "Confirm Booking" }))
    fireEvent.click(await screen.findByRole("button", { name: "Create without emailing" }))
    const alert = alertElement()

    await waitFor(() => expect(alert).toHaveTextContent("Xero needs to be reconnected."))
    await expectRecoveryAlertToHoldFocus(alert)
    expect(alert).toContainElement(screen.getByRole("link", { name: "Go to Xero setup" }))
  })
})
