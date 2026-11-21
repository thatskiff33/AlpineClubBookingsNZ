// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { expectRecoveryAlertToHoldFocus } from "@/lib/__tests__/helpers/focus"

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

import { MemberLodgeAccessCard } from "@/app/(admin)/admin/membership/members/[id]/_components/member-lodge-access-card"

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

/*
  #4975: a failed load of the member's grants is a passive box that moves
  nothing; a refused save is the admin's own action, so it takes focus, and takes
  it again when the same refusal repeats. A save that lands retires a stale load
  message rather than leaving it beside "Lodge access saved.".
*/
describe("MemberLodgeAccessCard action failures (#4975)", () => {
  const GRANTS_URL = "/api/admin/members/member-1/lodge-access"
  const answer = (status: number, body: unknown) =>
    ({ ok: status < 400, status, json: async () => body }) as Response

  beforeEach(() => {
    lodgeOptions = {
      lodges: LODGES,
      loading: false,
      failed: false,
      forbidden: false,
      reload: vi.fn(),
    }
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it("focuses a refused save, and focuses it again when it repeats", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === "PUT"
          ? answer(400, { error: "That grant was refused." })
          : answer(200, { lodgeAccess: [] }),
      ),
    )
    render(<MemberLodgeAccessCard memberId="member-1" />)
    // The alert mounts with the form, once the grants have loaded.
    await screen.findByRole("button", { name: "Save Lodge Access" })
    const alert = document.getElementById("member-lodge-access-save-error")

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const save = screen.getByRole("button", { name: "Save Lodge Access" })
      save.focus()
      fireEvent.click(save)
      await waitFor(() => expect(alert).toHaveTextContent("That grant was refused."))
      await expectRecoveryAlertToHoldFocus(alert)
    }
  })

  it("keeps a failed load passive, and retires it when a save lands", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === "PUT"
          ? answer(200, { lodgeAccess: [] })
          : answer(500, { error: "Grants unavailable." }),
      ),
    )
    render(<MemberLodgeAccessCard memberId="member-1" />)
    const loadMessage = await screen.findByText("Grants unavailable.")
    expect(document.getElementById("member-lodge-access-save-error")).toBeEmptyDOMElement()
    // The failed read moved no focus, and did not mark itself as the focus target.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(document.activeElement).toBe(document.body)
    expect(loadMessage.closest('[tabindex="-1"]')).toBeNull()

    fireEvent.click(await screen.findByRole("button", { name: "Save Lodge Access" }))

    await waitFor(() => expect(screen.getByText("Lodge access saved.")).toBeInTheDocument())
    expect(screen.queryByText("Grants unavailable.")).not.toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith(GRANTS_URL, expect.objectContaining({ method: "PUT" }))
  })
})
