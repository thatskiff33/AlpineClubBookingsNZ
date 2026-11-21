// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render"

/*
  The "Tax categories" card (#5209): income is read-only and points at the GST
  card, each other category is mapped through a staged, dirty-gated edit whose
  picker offers only what the writer accepts, and a finance viewer who is not a
  Full Admin sees it all read-only. The route's own test proves the server
  refuses the write regardless; this proves what the screen offers.
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
    <select aria-label="Xero tax rate" value={value} onChange={(event) => onValueChange?.(event.target.value)}>
      <option value="">Choose</option>
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectItem: ({ value, children }: { value: string; children?: React.ReactNode }) => <option value={value}>{children}</option>,
}))

import { TaxCategoryMappingCard } from "../tax-category-mapping-card"
import { ADMIN_VIEW_ONLY_SECTION_HEADING } from "@/components/admin/view-only-action"

const rate = (taxType: string, name: string, rateBasisPoints: number, expenses = false) => ({
  taxType,
  name,
  rateBasisPoints,
  active: true,
  revenue: true,
  expenses,
})
const category = (key: string, label: string, overrides: Record<string, unknown> = {}) => ({
  key,
  label,
  description: `${label} lines`,
  noSenderYet: null,
  source: "mapping",
  taxType: null,
  otherOrganisation: false,
  problem: null,
  ...overrides,
})
const STATE = {
  connected: true,
  registeredNowOrLater: true,
  registeredToday: true,
  categories: [
    category("SALES_TAX_ON_INCOME", "Sales tax on income", { source: "tax-treatment", taxType: "OUTPUT2" }),
    category("SALES_TAX_ON_EXPENSES", "Sales tax on expenses", { noSenderYet: "No document the app sends uses this category yet." }),
    category("EXEMPT", "Exempt", { taxType: "EXEMPTOUTPUT" }),
    category("ZERO_RATED", "Zero rated", { otherOrganisation: true }),
  ],
  rates: [
    rate("OUTPUT2", "15% GST on Income", 1500),
    rate("INPUT2", "15% GST on Expenses", 1500, true),
    rate("EXEMPTOUTPUT", "Exempt Income", 0),
    rate("NONE", "No GST", 0),
  ],
}

const fetchMock = vi.fn()

function signInAs(accessRoles: string[]) {
  session.value = { status: "authenticated", data: { user: { id: "member-1", accessRoles, canLogin: true } } }
}

function writeCalls(method: string) {
  return fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === method)
}

const options = () => Array.from((screen.getByLabelText("Xero tax rate") as HTMLSelectElement).options).map((o) => o.value).filter(Boolean)

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ state: STATE }) }))
  vi.stubGlobal("fetch", fetchMock)
  signInAs(["ADMIN"])
})

describe("a Full Admin", () => {
  it("sees income read-only with a link to the GST card, and no banner", async () => {
    render(<TaxCategoryMappingCard />)
    const income = await screen.findByTestId("tax-category-SALES_TAX_ON_INCOME")
    expect(income).toHaveTextContent(/In use today: Xero code OUTPUT2/)
    expect(screen.getByRole("link", { name: /GST \/ tax treatment card/ })).toHaveAttribute("href", expect.stringMatching(/#club-tax-treatment$/))
    expect(screen.queryByRole("button", { name: /Map Sales tax on income/ })).not.toBeInTheDocument()
    expect(screen.getByTestId("admin-view-only-banner")).toBeEmptyDOMElement()
  })

  it("says which categories have no sender yet, and flags one mapped in another organisation", async () => {
    render(<TaxCategoryMappingCard />)
    expect(await screen.findByTestId("tax-category-SALES_TAX_ON_EXPENSES")).toHaveTextContent(/No document the app sends/)
    expect(screen.getByTestId("tax-category-ZERO_RATED")).toHaveTextContent(/different Xero organisation/)
  })

  it("offers each picker only the rates its category accepts", async () => {
    render(<TaxCategoryMappingCard />)
    fireEvent.click(await screen.findByRole("button", { name: "Map Exempt" }))
    expect(options()).toEqual(["EXEMPTOUTPUT", "NONE"])
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    fireEvent.click(screen.getByRole("button", { name: "Map Sales tax on expenses" }))
    expect(options()).toEqual(["INPUT2"])
  })

  it("cannot save the saved code (the dirty gate), and sends a changed one", async () => {
    render(<TaxCategoryMappingCard />)
    fireEvent.click(await screen.findByRole("button", { name: "Map Exempt" }))
    expect(screen.getByRole("button", { name: "Save Exempt" })).toBeDisabled()
    fireEvent.change(screen.getByLabelText("Xero tax rate"), { target: { value: "NONE" } })
    fireEvent.click(screen.getByRole("button", { name: "Save Exempt" }))
    await waitFor(() => expect(writeCalls("PUT")).toHaveLength(1))
    expect(JSON.parse(writeCalls("PUT")[0][1].body as string)).toEqual({ category: "EXEMPT", taxType: "NONE" })
  })

  it("tells an unregistered club no category needs mapping", async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ state: { ...STATE, registeredNowOrLater: false, registeredToday: false } }),
    }))
    render(<TaxCategoryMappingCard />)
    expect(await screen.findByText(/no\s+category needs mapping/)).toBeInTheDocument()
    expect(screen.getByTestId("tax-category-SALES_TAX_ON_INCOME")).toHaveTextContent(/Not GST-registered today/)
  })
})

describe("a finance viewer who is not a Full Admin", () => {
  beforeEach(() => signInAs(["FINANCE_USER"]))

  it("sees the mappings and is told once, in the banner, that changing them needs Full Admin", async () => {
    render(<TaxCategoryMappingCard />)
    expect(await screen.findByTestId("tax-category-EXEMPT")).toHaveTextContent(/Mapped to EXEMPTOUTPUT — Exempt Income/)
    const banner = screen.getByTestId("admin-view-only-banner")
    expect(banner).toHaveTextContent(ADMIN_VIEW_ONLY_SECTION_HEADING)
    expect(banner).toHaveTextContent(/needs Full\s+Admin/)
  })

  it("is offered no enabled way to change them", async () => {
    render(<TaxCategoryMappingCard />)
    const map = await screen.findByRole("button", { name: "Map Exempt" })
    expect(map).toBeDisabled()
    expect(screen.getByRole("button", { name: "Clear Exempt" })).toBeDisabled()
    fireEvent.click(map)
    expect(screen.queryByRole("button", { name: "Save Exempt" })).not.toBeInTheDocument()
    expect(writeCalls("PUT")).toHaveLength(0)
  })

  it("keeps the banner mounted from first paint", () => {
    fetchMock.mockImplementation(() => new Promise(() => {}))
    render(<TaxCategoryMappingCard />)
    expect(screen.getByText(/Loading the tax categories/)).toBeInTheDocument()
    expect(screen.getByTestId("admin-view-only-banner")).toBeInTheDocument()
  })
})
