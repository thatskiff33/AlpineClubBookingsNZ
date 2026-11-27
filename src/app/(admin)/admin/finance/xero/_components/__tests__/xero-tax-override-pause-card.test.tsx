// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render"

/*
  The "GST overrides" card (#5208): the flagged invoices with the tax sent and
  the tax Xero holds on each line, the resume that needs a tick and a note, and
  the view-only contract for a finance viewer. The route's own test proves the
  server refuses regardless; this proves what the screen offers.
*/

const session = vi.hoisted(() => ({
  value: {
    status: "authenticated" as "authenticated" | "loading",
    data: null as null | { user: { id: string; accessRoles: string[]; canLogin: boolean } },
  },
}))
vi.mock("next-auth/react", () => ({ useSession: () => session.value }))

import { XeroTaxOverridePauseCard } from "../xero-tax-override-pause-card"
import { ADMIN_VIEW_ONLY_SECTION_HEADING } from "@/components/admin/view-only-action"

const PROBLEM = "Xero changed the GST on 1 invoice after the app sent it. Until someone in finance checks them and resumes, "
  + "new invoices go to Xero without the club's own GST figures and Xero works the GST out itself."
const FLAGGED = {
  invoices: [{ id: "m1", createdAt: "2026-07-01T00:00:00.000Z", bookingId: "booking-abcdef12", providerInvoiceId: "inv_1", invoiceNumber: "INV-0042",
    documentKind: "CREATE", lines: [{ index: 0, sentCents: 1044, xeroCents: 1043 }] }],
  problem: PROBLEM,
}

const fetchMock = vi.fn()
const signInAs = (accessRoles: string[]) => {
  session.value = { status: "authenticated", data: { user: { id: "member-1", accessRoles, canLogin: true } } }
}
const posts = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => ({
    ok: true,
    status: 200,
    json: async () => (init?.method === "POST" ? { cleared: 1, invoices: [], problem: null } : FLAGGED),
  }))
  vi.stubGlobal("fetch", fetchMock)
  signInAs(["ADMIN"])
})

describe("a finance editor", () => {
  it("sees each flagged line's GST, and resumes only after ticking and writing a note", async () => {
    render(<XeroTaxOverridePauseCard />)
    expect(await screen.findByRole("alert")).toHaveTextContent(PROBLEM)
    expect(screen.getByTestId("xero-tax-override-invoice")).toHaveTextContent("Invoice INV-0042")
    expect(screen.getByTestId("xero-tax-override-invoice")).toHaveTextContent(/the app sent \$10\.44 GST, Xero holds \$10\.43/)

    const resume = screen.getByRole("button", { name: "I've checked these, resume" })
    expect(resume).toBeDisabled()
    fireEvent.click(screen.getByRole("checkbox", { name: "I've checked these invoices in Xero" }))
    expect(resume).toBeDisabled()
    fireEvent.change(screen.getByLabelText("What you found"), { target: { value: "Xero rounded line 1 down" } })
    expect(resume).toBeEnabled()
    fireEvent.click(resume)

    await waitFor(() => expect(screen.getByTestId("xero-tax-overrides-on")).toBeInTheDocument())
    const [[url, init]] = posts()
    expect(url).toBe("/api/admin/xero/tax-override-pause/clear")
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ ids: ["m1"], note: "Xero rounded line 1 down", confirmed: true })
  })

  it("says the overrides are on when nothing is flagged", async () => {
    fetchMock.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ invoices: [], problem: null }) }))
    render(<XeroTaxOverridePauseCard />)
    expect(await screen.findByTestId("xero-tax-overrides-on")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "I've checked these, resume" })).not.toBeInTheDocument()
  })
})

describe("a finance viewer", () => {
  beforeEach(() => signInAs(["FINANCE_USER"]))

  it("sees the flagged invoices and the view-only banner, and cannot resume", async () => {
    render(<XeroTaxOverridePauseCard />)
    expect(await screen.findByRole("alert")).toHaveTextContent(PROBLEM)
    expect(screen.getByTestId("admin-view-only-banner")).toHaveTextContent(ADMIN_VIEW_ONLY_SECTION_HEADING)
    expect(screen.getByRole("button", { name: "I've checked these, resume" })).toBeDisabled()
    expect(screen.getByRole("checkbox", { name: "I've checked these invoices in Xero" })).toBeDisabled()
    expect(posts()).toEqual([])
  })
})
