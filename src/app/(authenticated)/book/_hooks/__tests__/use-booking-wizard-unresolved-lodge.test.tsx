// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest"
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { id: "member-1", role: "MEMBER", accessRoles: [] } } }),
}))
vi.mock("@/lib/access-roles", () => ({
  hasAdminAccess: () => false,
  hasAccessRole: () => true,
}))
vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ lodgeCapacity: 20 }),
}))
vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn() } }))

const reload = vi.fn()
let options = {
  lodges: [] as Array<{ id: string; name: string }>,
  loading: false,
  failed: true,
  forbidden: false,
  reload,
}

vi.mock("@/components/lodge-select", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/components/lodge-select")),
  useLodgeOptions: () => options,
  LodgeSelect: () => <div data-testid="member-lodge-select" />,
}))
vi.mock("@/components/booking-calendar", () => ({
  BookingCalendar: ({ lodgeId }: { lodgeId: string }) => (
    <div data-testid="booking-calendar">{lodgeId}</div>
  ),
}))

import { DatesStep } from "@/app/(authenticated)/book/_components/dates-step"
import { useBookingWizard } from "@/app/(authenticated)/book/_hooks/use-booking-wizard"

function response(body: unknown = {}) {
  return { ok: true, status: 200, json: async () => body } as Response
}

const LODGE_DEPENDENT = [
  "/api/bookings/rooms",
  "/api/availability/check",
  "/api/booking-policies/check",
  "/api/bookings/quote",
  "/api/bookings/exception-requests",
]

describe("member booking wizard unresolved lodge scope (#2701, #2887)", () => {
  beforeEach(() => {
    reload.mockClear()
    options = {
      lodges: [],
      loading: false,
      failed: true,
      forbidden: false,
      reload,
    }
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("/api/members/family")) return response({ familyMembers: [] })
      if (url.includes("/api/payments/options")) {
        return response({ methods: { stripe: { enabled: true, default: true } }, groupBookingsEnabled: false })
      }
      if (url.includes("/api/member/subscription-status")) return response({ status: "PAID" })
      if (url.includes("/api/booking-messages")) return response({ messages: {} })
      return response()
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it.each([
    ["loading", { loading: true, failed: false, forbidden: false }],
    ["failure", { loading: false, failed: true, forbidden: false }],
    ["403", { loading: false, failed: false, forbidden: true }],
    ["successful empty", { loading: false, failed: false, forbidden: false }],
  ] as const)("performs no lodge-dependent read or write while the list is %s", async (_name, state) => {
    options = { ...options, ...state, lodges: [] }
    const { result } = renderHook(() => useBookingWizard())

    await act(async () => {
      await result.current.handleDateSelect("2026-08-10", "2026-08-11")
      await result.current.handleGuestsDone()
      await result.current.handleSubmit()
      await result.current.handleSaveAsDraft()
      await result.current.handleJoinWaitlist()
      await result.current.submitExceptionRequest({ memberMessage: "Please review", supersedeRequestId: null }).catch(() => {})
    })

    const calls = vi.mocked(fetch).mock.calls.map(([input]) => String(input))
    expect(calls.filter((url) => LODGE_DEPENDENT.some((path) => url.includes(path)))).toEqual([])
    expect(calls.filter((url) => url.endsWith("/api/bookings"))).toEqual([])
  })

  it("retry returns to Dates, reloads the options, and a recovered lodge mounts the calendar", async () => {
    const { result } = renderHook(() => useBookingWizard())
    act(() => result.current.retryLodgeOptions())
    expect(result.current.step).toBe("dates")
    expect(result.current.lodgeId).toBeNull()
    expect(reload).toHaveBeenCalledTimes(1)

    const retry = vi.fn()
    const view = render(
      <DatesStep
        subscriptionUnpaid={false}
        handleDateSelect={vi.fn()}
        checkIn={null}
        checkOut={null}
        lodges={[]}
        lodgeId={null}
        lodgesLoading={false}
        lodgeScope={{ kind: "failed" }}
        retryLodgeOptions={retry}
        handleLodgeChange={vi.fn()}
        selectedLodge={null}
      />,
    )
    expect(screen.queryByTestId("booking-calendar")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(retry).toHaveBeenCalledTimes(1)

    view.rerender(
      <DatesStep
        subscriptionUnpaid={false}
        handleDateSelect={vi.fn()}
        checkIn={null}
        checkOut={null}
        lodges={[{ id: "lodge-a", name: "Lodge A" }]}
        lodgeId="lodge-a"
        lodgesLoading={false}
        lodgeScope={{ kind: "lodge", lodgeId: "lodge-a", lodgeName: "Lodge A" }}
        retryLodgeOptions={retry}
        handleLodgeChange={vi.fn()}
        selectedLodge={{ id: "lodge-a", name: "Lodge A" }}
      />,
    )
    expect(await screen.findByTestId("member-lodge-select")).toBeInTheDocument()
    expect(screen.getByTestId("booking-calendar")).toHaveTextContent("lodge-a")
  })

  it("stops the date pipeline when the lodge list fails during availability", async () => {
    options = {
      lodges: [{ id: "lodge-a", name: "Lodge A" }],
      loading: false,
      failed: false,
      forbidden: false,
      reload,
    }
    let releaseAvailability!: () => void
    const availability = new Promise<Response>((resolve) => {
      releaseAvailability = () => resolve(response({ minAvailable: 20, nightDetails: [] }))
    })
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("/api/availability/check")) return availability
      if (url.includes("/api/members/family")) return response({ familyMembers: [] })
      if (url.includes("/api/payments/options")) {
        return response({ methods: { stripe: { enabled: true, default: true } }, groupBookingsEnabled: false })
      }
      if (url.includes("/api/member/subscription-status")) return response({ status: "PAID" })
      if (url.includes("/api/booking-messages")) return response({ messages: {} })
      if (url.includes("/api/bookings/rooms")) return response({ enabled: false, rooms: [] })
      return response()
    })
    vi.stubGlobal("fetch", fetchMock)

    const view = renderHook(() => useBookingWizard())
    act(() => view.result.current.handleLodgeChange("lodge-a"))
    let pending!: Promise<void>
    act(() => {
      pending = view.result.current.handleDateSelect("2026-08-10", "2026-08-11")
    })
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) =>
      String(input).includes("/api/availability/check"),
    )).toBe(true))

    options = { ...options, failed: true, lodges: [] }
    view.rerender()
    await act(async () => {
      releaseAvailability()
      await pending
    })

    expect(fetchMock.mock.calls.some(([input]) =>
      String(input).includes("/api/booking-policies/check"),
    )).toBe(false)
    expect(view.result.current.step).toBe("dates")
    expect(view.result.current.lodgeUnresolved).toBe(true)
  })

  it("lets Lodge B remain selected when a late Lodge A availability response arrives", async () => {
    options = {
      lodges: [
        { id: "lodge-a", name: "Lodge A" },
        { id: "lodge-b", name: "Lodge B" },
      ],
      loading: false,
      failed: false,
      forbidden: false,
      reload,
    }
    let releaseAvailability!: () => void
    const availability = new Promise<Response>((resolve) => {
      releaseAvailability = () => resolve(response({ minAvailable: 20, nightDetails: [] }))
    })
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("/api/availability/check")) return availability
      if (url.includes("/api/members/family")) return response({ familyMembers: [] })
      if (url.includes("/api/payments/options")) {
        return response({ methods: { stripe: { enabled: true, default: true } }, groupBookingsEnabled: false })
      }
      if (url.includes("/api/member/subscription-status")) return response({ status: "PAID" })
      if (url.includes("/api/booking-messages")) return response({ messages: {} })
      if (url.includes("/api/bookings/rooms")) return response({ enabled: false, rooms: [] })
      return response()
    })
    vi.stubGlobal("fetch", fetchMock)

    const view = renderHook(() => useBookingWizard())
    act(() => view.result.current.handleLodgeChange("lodge-a"))
    let pending!: Promise<void>
    act(() => {
      pending = view.result.current.handleDateSelect("2026-08-10", "2026-08-11")
    })
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) =>
      String(input).includes("/api/availability/check"),
    )).toBe(true))

    act(() => view.result.current.handleLodgeChange("lodge-b"))
    await act(async () => {
      releaseAvailability()
      await pending
    })

    expect(view.result.current.lodgeId).toBe("lodge-b")
    expect(view.result.current.lodgeUnresolved).toBe(false)
    expect(fetchMock.mock.calls.some(([input]) =>
      String(input).includes("/api/booking-policies/check"),
    )).toBe(false)
  })

  it("keeps the newer date range when two selections race at the same lodge", async () => {
    options = {
      lodges: [{ id: "lodge-a", name: "Lodge A" }],
      loading: false,
      failed: false,
      forbidden: false,
      reload,
    }
    let releaseFirst!: () => void
    const firstAvailability = new Promise<Response>((resolve) => {
      releaseFirst = () => resolve(response({ minAvailable: 1, nightDetails: [] }))
    })
    let availabilityCount = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("/api/availability/check")) {
        availabilityCount += 1
        return availabilityCount === 1
          ? firstAvailability
          : response({ minAvailable: 9, nightDetails: [] })
      }
      if (url.includes("/api/booking-policies/check")) return response({ valid: true })
      if (url.includes("/api/members/family")) return response({ familyMembers: [] })
      if (url.includes("/api/payments/options")) {
        return response({ methods: { stripe: { enabled: true, default: true } }, groupBookingsEnabled: false })
      }
      if (url.includes("/api/member/subscription-status")) return response({ status: "PAID" })
      if (url.includes("/api/booking-messages")) return response({ messages: {} })
      if (url.includes("/api/bookings/rooms")) return response({ enabled: false, rooms: [] })
      return response()
    })
    vi.stubGlobal("fetch", fetchMock)

    const view = renderHook(() => useBookingWizard())
    act(() => view.result.current.handleLodgeChange("lodge-a"))
    let first!: Promise<void>
    act(() => {
      first = view.result.current.handleDateSelect("2026-08-10", "2026-08-11")
    })
    await waitFor(() => expect(availabilityCount).toBe(1))

    await act(async () => {
      await view.result.current.handleDateSelect("2026-08-20", "2026-08-22")
    })
    expect(view.result.current.step).toBe("guests")
    expect(view.result.current.checkIn).toBe("2026-08-20")
    expect(view.result.current.checkOut).toBe("2026-08-22")

    await act(async () => {
      releaseFirst()
      await first
    })
    expect(view.result.current.step).toBe("guests")
    expect(view.result.current.checkIn).toBe("2026-08-20")
    expect(view.result.current.checkOut).toBe("2026-08-22")
  })
})
