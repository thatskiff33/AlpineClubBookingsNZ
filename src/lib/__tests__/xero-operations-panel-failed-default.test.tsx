// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render"
import { beforeEach, describe, expect, it, vi } from "vitest"

// #4220 (owner decision, 24 Oct 2026): choosing Status = Failed in the Xero
// operations panel also picks Failure = Active only, visibly, with an "N hidden,
// show them" line. The API default stays "all", so a link carrying only
// opStatus=FAILED keeps its literal meaning.

const mocks = vi.hoisted(() => ({
  fetchJson: vi.fn(),
  replace: vi.fn(),
  search: { current: "" },
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
  usePathname: () => "/admin/xero",
  useSearchParams: () => new URLSearchParams(mocks.search.current),
}))

vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/hooks/use-admin-area-edit-access")),
  useAdminAreaEditAccess: () => true,
}))

vi.mock("../../app/(admin)/admin/finance/xero/_components/api", () => ({
  fetchJson: mocks.fetchJson,
  postJson: vi.fn(),
}))

// The real Select is a Radix popover; a native <select> exercises the same
// onValueChange wiring in the panel without a pointer-event simulation.
vi.mock("../../app/(admin)/admin/finance/xero/_components/shared", async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import("../../app/(admin)/admin/finance/xero/_components/shared")
  return {
    ...actual,
    FilterSelect: ({
      label,
      value,
      values,
      labels,
      onValueChange,
    }: {
      label: string
      value: string
      values: string[]
      labels?: Record<string, string>
      onValueChange: (value: string) => void
    }) => (
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
      >
        {values.map((item) => (
          <option key={item} value={item}>
            {labels?.[item] ?? item}
          </option>
        ))}
      </select>
    ),
  }
})

import { OperationsPanel } from "@/app/(admin)/admin/finance/xero/_components/operations-panel"

function renderPanel() {
  return render(
    <OperationsPanel
      connected
      open
      onToggle={() => {}}
      onMessage={() => {}}
      onRefreshDiagnostics={() => {}}
      refreshToken={0}
    />,
  )
}

function lastRequest(): URLSearchParams {
  const calls = mocks.fetchJson.mock.calls
  const url = String(calls[calls.length - 1][0])
  return new URL(url, "http://localhost").searchParams
}

function select(label: string): HTMLSelectElement {
  return screen.getByLabelText(label) as HTMLSelectElement
}

describe("Xero operations panel: the Failed view means active failures", () => {
  beforeEach(() => {
    mocks.fetchJson.mockReset()
    mocks.replace.mockReset()
    mocks.search.current = ""
    mocks.fetchJson.mockResolvedValue({ data: [], total: 0, hiddenFailedCount: 0 })
  })

  it("picks Failure = Active only when Status = Failed is chosen, and puts it in the request and URL", async () => {
    renderPanel()
    await waitFor(() => expect(mocks.fetchJson).toHaveBeenCalled())
    expect(select("Failure").value).toBe("all")

    fireEvent.change(select("Status"), { target: { value: "FAILED" } })

    await waitFor(() => expect(select("Failure").value).toBe("ACTIVE"))
    await waitFor(() => {
      const request = lastRequest()
      expect(request.get("status")).toBe("FAILED")
      expect(request.get("failureState")).toBe("ACTIVE")
    })
    await waitFor(() => {
      const url = String(mocks.replace.mock.calls.at(-1)?.[0])
      expect(url).toContain("opStatus=FAILED")
      expect(url).toContain("opFailureState=ACTIVE")
    })
    expect(screen.getByRole("option", { name: "Active only" })).toBeDefined()
  })

  it("leaves a link that carries only opStatus=FAILED at its literal meaning", async () => {
    mocks.search.current = "section=operations&opStatus=FAILED"
    renderPanel()
    await waitFor(() => expect(mocks.fetchJson).toHaveBeenCalled())

    expect(select("Status").value).toBe("FAILED")
    expect(select("Failure").value).toBe("all")
    expect(lastRequest().get("failureState")).toBe("all")
  })

  it("does not overwrite a Failure choice the officer already made", async () => {
    renderPanel()
    await waitFor(() => expect(mocks.fetchJson).toHaveBeenCalled())
    fireEvent.change(select("Failure"), { target: { value: "REPAIRED" } })
    fireEvent.change(select("Status"), { target: { value: "FAILED" } })

    await waitFor(() => expect(select("Failure").value).toBe("REPAIRED"))
  })

  it("clears a Failure filter when another status is chosen", async () => {
    mocks.search.current = "section=operations&opFailureState=REPAIRED"
    renderPanel()
    await waitFor(() => expect(select("Failure").value).toBe("REPAIRED"))

    fireEvent.change(select("Status"), { target: { value: "PENDING" } })

    await waitFor(() => expect(select("Failure").value).toBe("all"))
  })

  it("drops the Active default again when Status moves off Failed", async () => {
    renderPanel()
    await waitFor(() => expect(mocks.fetchJson).toHaveBeenCalled())
    fireEvent.change(select("Status"), { target: { value: "FAILED" } })
    await waitFor(() => expect(select("Failure").value).toBe("ACTIVE"))

    fireEvent.change(select("Status"), { target: { value: "PENDING" } })

    await waitFor(() => expect(select("Failure").value).toBe("all"))
    await waitFor(() => expect(lastRequest().get("failureState")).toBe("all"))
  })

  it("says how many rows are hidden and brings them back with Show them", async () => {
    mocks.search.current = "section=operations&opStatus=FAILED&opFailureState=ACTIVE"
    mocks.fetchJson.mockResolvedValue({ data: [], total: 0, hiddenFailedCount: 11 })
    renderPanel()

    expect(await screen.findByText(/11 hidden/)).toBeDefined()
    expect(screen.getByText("No active failures.")).toBeDefined()

    fireEvent.click(screen.getByRole("button", { name: "Show them" }))

    await waitFor(() => expect(select("Failure").value).toBe("all"))
    await waitFor(() => expect(lastRequest().get("failureState")).toBe("all"))
    expect(lastRequest().get("status")).toBe("FAILED")
    // The button is gone, so the region says what changed and holds focus.
    const region = screen.getByText(/Showing all failures, including 11/).closest('[role="status"]')
    expect(region).not.toBeNull()
    expect(document.activeElement).toBe(region)
  })

  it("drops the revealed message when the dataset is reset", async () => {
    mocks.search.current = "section=operations&opStatus=FAILED&opFailureState=ACTIVE"
    mocks.fetchJson.mockResolvedValue({ data: [], total: 0, hiddenFailedCount: 4 })
    renderPanel()
    fireEvent.click(await screen.findByRole("button", { name: "Show them" }))
    await screen.findByText(/Showing all failures, including 4/)

    fireEvent.click(screen.getByRole("button", { name: "Reset" }))

    await waitFor(() => expect(screen.queryByText(/Showing all failures/)).toBeNull())
  })

  it("shows no hidden line while the Failure filter is not Active only", async () => {
    mocks.search.current = "section=operations&opStatus=FAILED&opFailureState=REPAIRED"
    mocks.fetchJson.mockResolvedValue({ data: [], total: 0, hiddenFailedCount: 3 })
    renderPanel()
    await waitFor(() => expect(mocks.fetchJson).toHaveBeenCalled())
    await waitFor(() => expect(select("Failure").value).toBe("REPAIRED"))
    expect(screen.queryByRole("button", { name: "Show them" })).toBeNull()
    expect(screen.queryByText(/hidden/)).toBeNull()
  })

  it("shows no hidden line when nothing is hidden or the filter is off", async () => {
    mocks.search.current = "section=operations&opStatus=FAILED&opFailureState=ACTIVE"
    mocks.fetchJson.mockResolvedValue({ data: [], total: 0, hiddenFailedCount: 0 })
    renderPanel()
    await waitFor(() => expect(mocks.fetchJson).toHaveBeenCalled())
    await screen.findByText("No active failures.")
    expect(screen.queryByRole("button", { name: "Show them" })).toBeNull()
  })
})
