// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render"

/*
  The "GST / tax treatment" card (#4632): the staged edit with its dirty gate
  and confirmation tick, and the view-only contract for a finance viewer who is
  not a Full Admin. The route's own test proves the server refuses the write
  regardless; this proves what the screen offers.
*/

const session = vi.hoisted(() => ({
  value: {
    status: "authenticated" as "authenticated" | "loading",
    data: null as null | { user: { id: string; accessRoles: string[]; canLogin: boolean } },
  },
}))
vi.mock("next-auth/react", () => ({ useSession: () => session.value }))

// Render the design-system Select as a native <select> so its options are reachable from the test.
vi.mock("@/components/ui/select", () => ({
  Select: ({ value, onValueChange, children }: { value?: string; onValueChange?: (value: string) => void; children?: React.ReactNode }) => (
    <select aria-label="Xero tax code" value={value} onChange={(event) => onValueChange?.(event.target.value)}>
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectItem: ({ value, children }: { value: string; children?: React.ReactNode }) => <option value={value}>{children}</option>,
}))

import { ClubTaxCard } from "../club-tax-card"
import { ADMIN_VIEW_ONLY_SECTION_HEADING } from "@/components/admin/view-only-action"

const STATE = {
  periods: [
    { gstRegistered: true, taxRateBasisPoints: 1500, xeroTaxType: "OUTPUT2", effectiveFrom: "2010-10-01", status: "current" },
  ],
  earliestChangeDate: "2026-07-02",
  xeroRevenueRates: [
    { taxType: "OUTPUT2", name: "15% GST on Income", rateBasisPoints: 1500, active: true, revenue: true },
    { taxType: "TAX009", name: "17% GST on Income", rateBasisPoints: 1700, active: true, revenue: true },
  ],
}

const fetchMock = vi.fn()

function signInAs(accessRoles: string[]) {
  session.value = { status: "authenticated", data: { user: { id: "member-1", accessRoles, canLogin: true } } }
}

function writeCalls(method: string) {
  return fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === method)
}

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => ({ state: STATE, keepingOldTreatment: url.includes("?from=") ? 3 : null }),
  }))
  vi.stubGlobal("fetch", fetchMock)
  signInAs(["ADMIN"])
})

const save = () => screen.getByRole("button", { name: "Save tax change" })

async function openEditor() {
  render(<ClubTaxCard />)
  fireEvent.click(await screen.findByRole("button", { name: "Schedule a change" }))
}

describe("a Full Admin", () => {
  it("sees the schedule and no banner", async () => {
    render(<ClubTaxCard />)
    expect(await screen.findByTestId("club-tax-period-current")).toHaveTextContent(/In force from 2010-10-01.*15%.*OUTPUT2/)
    expect(screen.getByTestId("admin-view-only-banner")).toBeEmptyDOMElement()
  })

  it("cannot save an untouched form (the dirty gate), even with the tick", async () => {
    await openEditor()
    fireEvent.click(screen.getByLabelText(/I understand/))
    expect(save()).toBeDisabled()
    expect(screen.getByText(/already the club.s treatment on that date/)).toBeInTheDocument()
  })

  it("needs the confirmation tick before a real change can be saved", async () => {
    await openEditor()
    fireEvent.click(screen.getByLabelText("The club is GST-registered"))
    expect(save()).toBeDisabled()
    fireEvent.click(screen.getByLabelText(/I understand/))
    expect(save()).toBeEnabled()
  })

  it("shows how many bookings keep the old treatment, and sends a confirmed unregistered change", async () => {
    await openEditor()
    expect(await screen.findByTestId("club-tax-keeping-count")).toHaveTextContent(/3 bookings already made/)
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/club-tax?from=2026-07-02")
    fireEvent.click(screen.getByLabelText("The club is GST-registered"))
    fireEvent.click(screen.getByLabelText(/I understand/))
    fireEvent.click(save())
    await waitFor(() => expect(writeCalls("PUT")).toHaveLength(1))
    expect(JSON.parse(writeCalls("PUT")[0][1].body as string)).toEqual({
      gstRegistered: false,
      taxRateBasisPoints: 0,
      xeroTaxType: null,
      effectiveFrom: "2026-07-02",
      confirmed: true,
    })
  })

  it("offers only Xero codes at the chosen rate", async () => {
    await openEditor()
    fireEvent.change(screen.getByLabelText(/GST rate/), { target: { value: "1700" } })
    const codes = Array.from((screen.getByLabelText("Xero tax code") as HTMLSelectElement).options).map((o) => o.value)
    expect(codes).toEqual(["TAX009"])
    expect(save()).toBeDisabled()
  })

  it("offers Cancel on a scheduled period only", async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        state: {
          ...STATE,
          periods: [
            ...STATE.periods,
            { gstRegistered: false, taxRateBasisPoints: 0, xeroTaxType: null, effectiveFrom: "2026-08-01", status: "scheduled" },
          ],
        },
      }),
    }))
    render(<ClubTaxCard />)
    await screen.findByTestId("club-tax-period-scheduled")
    expect(screen.getAllByRole("button", { name: "Cancel this change" })).toHaveLength(1)
  })
})

describe("a finance viewer who is not a Full Admin", () => {
  beforeEach(() => signInAs(["FINANCE_USER"]))

  it("sees the schedule and is told once, in the banner, that changing it needs Full Admin", async () => {
    render(<ClubTaxCard />)
    await screen.findByTestId("club-tax-period-current")
    const banner = screen.getByTestId("admin-view-only-banner")
    expect(banner).toHaveTextContent(ADMIN_VIEW_ONLY_SECTION_HEADING)
    expect(banner).toHaveTextContent(/needs\s+Full Admin/)
    expect(screen.getAllByTestId("admin-view-only-banner")).toHaveLength(1)
  })

  it("is offered no enabled way to change it", async () => {
    render(<ClubTaxCard />)
    const change = await screen.findByRole("button", { name: "Schedule a change" })
    expect(change).toBeDisabled()
    fireEvent.click(change)
    expect(screen.queryByRole("button", { name: "Save tax change" })).not.toBeInTheDocument()
    expect(writeCalls("PUT")).toHaveLength(0)
  })

  it("keeps the banner mounted from first paint", () => {
    fetchMock.mockImplementation(() => new Promise(() => {}))
    render(<ClubTaxCard />)
    expect(screen.getByText(/Loading the club.s tax treatment/)).toBeInTheDocument()
    expect(screen.getByTestId("admin-view-only-banner")).toBeInTheDocument()
  })
})
