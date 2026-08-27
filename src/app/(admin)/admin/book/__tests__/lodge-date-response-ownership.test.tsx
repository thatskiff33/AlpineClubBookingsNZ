// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest"
import { useEffect } from "react"
import { act, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const LODGES = [
  { id: "lodge-a", name: "Lodge A" },
  { id: "lodge-b", name: "Lodge B" },
]

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

vi.mock("@/hooks/use-admin-area-edit-access", () => ({
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
  GuestForm: ({ maxGuests, onGuestsChange }: {
    maxGuests: number
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

import AdminBookPage from "@/app/(admin)/admin/book/page"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function response(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response
}

async function openDates() {
  render(<AdminBookPage />)
  fireEvent.click(screen.getByRole("button", { name: "Pick member" }))
  await waitFor(() =>
    expect(screen.getByTestId("admin-book-lodge")).toHaveTextContent("Lodge A"),
  )
}

describe("admin booking date response ownership (#2701, #2887)", () => {
  let lodgeA = deferred<Response>()
  let lodgeB = deferred<Response>()
  let fetchMock = vi.fn()
  let lodgeASignal: AbortSignal | null = null

  beforeEach(() => {
    lodgeA = deferred<Response>()
    lodgeB = deferred<Response>()
    lodgeASignal = null
    fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        if (url.includes("/api/availability/check") && url.includes("lodgeId=lodge-a")) {
          lodgeASignal = init?.signal ?? null
          return lodgeA.promise
        }
        if (url.includes("/api/availability/check") && url.includes("lodgeId=lodge-b")) {
          return lodgeB.promise
        }
        if (url.includes("/api/admin/bookings/eligible-family")) {
          return response({ familyMembers: [] })
        }
        if (url.includes("/api/payments/options")) {
          return response({ methods: { internetBanking: { enabled: false } } })
        }
        return response({})
      },
    )
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it("does not advance Lodge B when only Lodge A dates were selected", async () => {
    await openDates()
    fireEvent.click(screen.getByRole("button", { name: "Choose dates at lodge-a" }))
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([input]) =>
        String(input).includes("lodgeId=lodge-a"),
      )).toBe(true),
    )

    fireEvent.click(screen.getByRole("button", { name: "Choose Lodge B" }))
    expect(screen.getByTestId("admin-book-lodge")).toHaveTextContent("Lodge B")
    expect(lodgeASignal?.aborted).toBe(true)

    await act(async () => {
      lodgeA.resolve(
        response({
          minAvailable: 1,
          nightDetails: [{ occupiedBeds: 20, availableBeds: 1 }],
        }),
      )
      await lodgeA.promise
    })

    expect(screen.queryByTestId("guest-form")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Choose dates at lodge-b" })).toBeInTheDocument()
  })

  it("keeps Lodge B dates and capacity when B finishes before late Lodge A", async () => {
    await openDates()
    fireEvent.click(screen.getByRole("button", { name: "Choose dates at lodge-a" }))
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([input]) =>
        String(input).includes("lodgeId=lodge-a"),
      )).toBe(true),
    )
    fireEvent.click(screen.getByRole("button", { name: "Choose Lodge B" }))
    expect(lodgeASignal?.aborted).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: "Choose dates at lodge-b" }))

    await act(async () => {
      lodgeB.resolve(
        response({
          minAvailable: 7,
          nightDetails: [{ occupiedBeds: 3, availableBeds: 7 }],
        }),
      )
      await lodgeB.promise
    })
    expect(await screen.findByTestId("guest-form")).toHaveAttribute(
      "data-max-guests",
      "10",
    )

    await act(async () => {
      lodgeA.resolve(
        response({
          minAvailable: 1,
          nightDetails: [{ occupiedBeds: 20, availableBeds: 1 }],
        }),
      )
      await lodgeA.promise
    })

    expect(screen.getByTestId("guest-form")).toHaveAttribute(
      "data-max-guests",
      "10",
    )
    expect(screen.getByText(/12 Aug 2026/)).toHaveTextContent("14 Aug 2026")
  })

  it("does not install a Lodge A quote after Back and a switch to Lodge B", async () => {
    const quoteA = deferred<Response>()
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes("/api/availability/check") && url.includes("lodgeId=lodge-a")) {
        return response({ minAvailable: 8, nightDetails: [{ occupiedBeds: 2, availableBeds: 8 }] })
      }
      if (url === "/api/bookings/quote") {
        expect(JSON.parse(String(init?.body))).toMatchObject({ lodgeId: "lodge-a" })
        return quoteA.promise
      }
      if (url.includes("/api/admin/bookings/eligible-family")) return response({ familyMembers: [] })
      if (url.includes("/api/payments/options")) return response({ methods: { internetBanking: { enabled: false } } })
      return response({})
    })

    await openDates()
    fireEvent.click(screen.getByRole("button", { name: "Choose dates at lodge-a" }))
    expect(await screen.findByTestId("guest-form")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Add test guest" }))
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/bookings/quote")).toBe(true))

    fireEvent.click(screen.getByRole("button", { name: "Back" }))
    fireEvent.click(screen.getByRole("button", { name: "Choose Lodge B" }))
    expect(screen.getByTestId("admin-book-lodge")).toHaveTextContent("Lodge B")

    await act(async () => {
      quoteA.resolve(response({ totalPriceCents: 1000, guests: [] }))
      await quoteA.promise
    })

    expect(screen.queryByText("Booking Summary")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Choose dates at lodge-b" })).toBeInTheDocument()
  })
})
