// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@/lib/__tests__/support/club-time-render"
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

const options = {
  lodges: [
    { id: "lodge-a", name: "Lodge A" },
    { id: "lodge-b", name: "Lodge B" },
  ],
  loading: false,
  failed: false,
  forbidden: false,
  reload: vi.fn(),
}

vi.mock("@/components/lodge-select", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/components/lodge-select")),
  useLodgeOptions: () => options,
}))

import { useBookingWizard } from "@/app/(authenticated)/book/_hooks/use-booking-wizard"

function response(body: unknown = {}, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body } as Response
}

// What the policy check answers for one lodge and check-in: a schedule the
// test can tell apart from every other selection's.
function scheduleFor(url: URL): string[] {
  return [`${url.searchParams.get("lodgeId")} ${url.searchParams.get("checkIn")}: 100% refund`]
}

type PolicyAnswer = (url: URL) => Response | Promise<Response>

let policyAnswer: PolicyAnswer

describe("member booking wizard cancellation schedule (#4946)", () => {
  beforeEach(() => {
    policyAnswer = (url) => response({ valid: true, cancellationSchedule: scheduleFor(url) })
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "https://example.test")
      if (url.pathname === "/api/booking-policies/check") return policyAnswer(url)
      if (url.pathname === "/api/availability/check") return response({ nightDetails: [] })
      if (url.pathname === "/api/members/family") return response({ familyMembers: [] })
      if (url.pathname === "/api/payments/options") {
        return response({ methods: { stripe: { enabled: true, default: true } }, groupBookingsEnabled: false })
      }
      if (url.pathname === "/api/member/subscription-status") return response({ status: "PAID" })
      if (url.pathname === "/api/booking-messages") return response({ messages: {} })
      if (url.pathname === "/api/bookings/rooms") return response({ enabled: false, rooms: [] })
      return response()
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it("carries the policy check's schedule for the chosen lodge and check-in", async () => {
    const view = renderHook(() => useBookingWizard())
    act(() => view.result.current.handleLodgeChange("lodge-b"))

    await act(async () => {
      await view.result.current.handleDateSelect("2026-08-10", "2026-08-12")
    })

    expect(view.result.current.step).toBe("guests")
    expect(view.result.current.cancellationSchedule).toEqual(["lodge-b 2026-08-10: 100% refund"])
  })

  it("never shows an older selection's schedule, even when its answer arrives last", async () => {
    let releaseFirst!: () => void
    let policyCalls = 0
    policyAnswer = (url) => {
      policyCalls += 1
      const body = { valid: true, cancellationSchedule: scheduleFor(url) }
      return policyCalls === 1
        ? new Promise<Response>((resolve) => {
            releaseFirst = () => resolve(response(body))
          })
        : response(body)
    }
    const view = renderHook(() => useBookingWizard())
    act(() => view.result.current.handleLodgeChange("lodge-a"))

    let first!: Promise<void>
    act(() => {
      first = view.result.current.handleDateSelect("2026-08-10", "2026-08-11")
    })
    await waitFor(() => expect(policyCalls).toBe(1))
    await act(async () => {
      await view.result.current.handleDateSelect("2026-08-20", "2026-08-22")
    })
    expect(view.result.current.cancellationSchedule).toEqual(["lodge-a 2026-08-20: 100% refund"])

    await act(async () => {
      releaseFirst()
      await first
    })
    expect(view.result.current.checkIn).toBe("2026-08-20")
    expect(view.result.current.cancellationSchedule).toEqual(["lodge-a 2026-08-20: 100% refund"])
  })

  it("drops the schedule the moment the dates or the lodge change", async () => {
    const view = renderHook(() => useBookingWizard())
    act(() => view.result.current.handleLodgeChange("lodge-a"))
    await act(async () => {
      await view.result.current.handleDateSelect("2026-08-10", "2026-08-11")
    })
    expect(view.result.current.cancellationSchedule).not.toBeNull()

    // A new date pick whose check has not answered yet shows nothing, not the
    // previous dates' rows.
    policyAnswer = () => new Promise<Response>(() => {})
    act(() => {
      void view.result.current.handleDateSelect("2026-09-01", "2026-09-03")
    })
    expect(view.result.current.cancellationSchedule).toBeNull()

    policyAnswer = (url) => response({ valid: true, cancellationSchedule: scheduleFor(url) })
    await act(async () => {
      await view.result.current.handleDateSelect("2026-08-10", "2026-08-11")
    })
    expect(view.result.current.cancellationSchedule).not.toBeNull()
    act(() => view.result.current.handleLodgeChange("lodge-b"))
    expect(view.result.current.cancellationSchedule).toBeNull()
  })

  it.each([
    ["the check fails", () => response({ error: "boom" }, false)],
    ["the schedule could not be read", () => response({ valid: true, cancellationSchedule: null })],
    ["the answer is malformed", () => response({ valid: true, cancellationSchedule: [1, 2] })],
  ])("has no schedule when %s, and still lets the member continue", async (_name, answer) => {
    policyAnswer = answer
    const view = renderHook(() => useBookingWizard())
    act(() => view.result.current.handleLodgeChange("lodge-a"))

    await act(async () => {
      await view.result.current.handleDateSelect("2026-08-10", "2026-08-11")
    })

    expect(view.result.current.step).toBe("guests")
    expect(view.result.current.cancellationSchedule).toBeNull()
  })
})
