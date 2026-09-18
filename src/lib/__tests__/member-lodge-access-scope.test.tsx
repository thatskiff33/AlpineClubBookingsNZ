// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

type LodgeOptions = {
  lodges: Array<{ id: string; name: string }>
  loading: boolean
  failed: boolean
  forbidden: boolean
  reload: () => void
}

let lodgeOptions: LodgeOptions

vi.mock("@/components/lodge-select", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/components/lodge-select")),
  useLodgeOptions: () => lodgeOptions,
}))

vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/hooks/use-admin-area-edit-access")),
  useAdminAreaEditAccess: () => true,
}))

import { MemberLodgeAccessCard } from "@/app/(admin)/admin/members/[id]/_components/member-lodge-access-card"

const LODGES = [
  { id: "lodge-a", name: "Lodge A" },
  { id: "lodge-b", name: "Lodge B" },
]

describe("MemberLodgeAccessCard settled lodge-list gate (#2701, #2887)", () => {
  beforeEach(() => {
    lodgeOptions = {
      lodges: LODGES,
      loading: true,
      failed: false,
      forbidden: false,
      reload: vi.fn(),
    }
    vi.stubGlobal("fetch", vi.fn(() => {
      throw new Error("unsettled lodge access attempted a downstream GET")
    }))
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it.each([
    ["loading", { lodges: LODGES, loading: true, failed: false, forbidden: false }],
    ["failure", { lodges: [], loading: false, failed: true, forbidden: false }],
    ["403", { lodges: [], loading: false, failed: false, forbidden: true }],
    ["successful empty", { lodges: [], loading: false, failed: false, forbidden: false }],
  ] as const)("sends no grant GET while the lodge list is %s", async (_name, state) => {
    lodgeOptions = { ...state, lodges: [...state.lodges], reload: vi.fn() }
    render(<MemberLodgeAccessCard memberId="member-1" />)
    await Promise.resolve()
    expect(fetch).not.toHaveBeenCalled()
    expect(screen.queryByRole("button", { name: "Save Lodge Access" })).not.toBeInTheDocument()
  })

  it("recovers from a failed list and then renders the populated grants", async () => {
    lodgeOptions = {
      lodges: [],
      loading: false,
      failed: true,
      forbidden: false,
      reload: vi.fn(),
    }
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        lodgeAccess: [
          { id: "grant-1", lodgeId: "lodge-a", kind: "BOOKING_RESTRICTION" },
          { id: "grant-2", lodgeId: "lodge-b", kind: "STAFF" },
        ],
      }),
    }))
    vi.stubGlobal("fetch", fetchMock)

    const view = render(<MemberLodgeAccessCard memberId="member-1" />)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByText("The lodge list could not be loaded")).toBeInTheDocument()

    lodgeOptions = {
      lodges: LODGES,
      loading: false,
      failed: false,
      forbidden: false,
      reload: vi.fn(),
    }
    view.rerender(<MemberLodgeAccessCard memberId="member-1" />)

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await waitFor(() => {
      expect(screen.getAllByLabelText("Lodge A")[0]).toBeChecked()
      expect(screen.getAllByLabelText("Lodge B")[1]).toBeChecked()
    })
    expect(screen.getByRole("button", { name: "Save Lodge Access" })).toBeInTheDocument()
  })
})
