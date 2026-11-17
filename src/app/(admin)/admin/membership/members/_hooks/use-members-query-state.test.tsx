// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { adminHref } from "@/lib/admin-hubs"
import { useMembersQueryState } from "./use-members-query-state"

const navigation = vi.hoisted(() => ({
  currentPathname: "/admin/members",
  currentSearch: "",
  replace: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: navigation.replace }),
  usePathname: () => navigation.currentPathname,
  useSearchParams: () => new URLSearchParams(navigation.currentSearch),
}))

function Harness() {
  const state = useMembersQueryState()
  return (
    <>
      <output data-testid="state">
        {JSON.stringify({
          search: state.search,
          page: state.page,
          sortBy: state.sortBy,
          sortDir: state.sortDir,
          filters: state.filters,
        })}
      </output>
      <button type="button" onClick={state.resetDataset}>Reset members</button>
    </>
  )
}

describe("useMembersQueryState Reset", () => {
  beforeEach(() => {
    navigation.replace.mockReset()
    navigation.currentPathname = adminHref("members")
    navigation.currentSearch = ""
  })

  it("resets search, filters, sort, and page while preserving unknown URL keys", async () => {
    navigation.currentSearch =
      "futureContext=keep&q=Aroha&role=ADMIN&contactability=unreachable&sortBy=email&sortDir=desc&page=3"

    render(<Harness />)
    fireEvent.click(screen.getByRole("button", { name: "Reset members" }))

    await waitFor(() => {
      const state = JSON.parse(screen.getByTestId("state").textContent ?? "{}")
      expect(state.search).toBe("")
      expect(state.page).toBe(1)
      expect(state.sortBy).toBe("name")
      expect(state.sortDir).toBe("asc")
      // Eleven since #2716 added `contactability` — the members-list filter the
      // stuck-states dashboard deep-links into. Counting rather than naming them
      // is deliberate: a filter added without a reset path is the bug this pins,
      // and a count catches one that a name list would be updated to excuse.
      expect(Object.values(state.filters)).toEqual(Array(11).fill(""))
    })

    await waitFor(() => {
      const path = navigation.replace.mock.calls.at(-1)?.[0] as string
      const url = new URL(path, "http://localhost")
      expect(url.searchParams.get("futureContext")).toBe("keep")
      for (const key of [
        "q",
        "role",
        "contactability",
        "sortBy",
        "sortDir",
        "page",
      ]) {
        expect(url.searchParams.has(key)).toBe(false)
      }
    })
  })
})

// A replace to the URL the page is already on is a soft navigation that drops
// the <title> until the server streams it back; the E2E axe audit caught the
// gap as document-title (#5155).
describe("useMembersQueryState URL sync on mount", () => {
  beforeEach(() => {
    navigation.replace.mockReset()
    navigation.currentPathname = adminHref("members")
    navigation.currentSearch = ""
  })

  it.each([
    ["no query", ""],
    ["a canonical filtered query", "q=Aroha&sortBy=email&sortDir=desc&role=ADMIN"],
  ])("does not navigate when the URL is already canonical (%s)", async (_label, search) => {
    navigation.currentSearch = search

    render(<Harness />)
    // Outlast the 300 ms search debounce, which re-runs the sync effect.
    await new Promise((resolve) => setTimeout(resolve, 400))

    expect(navigation.replace).not.toHaveBeenCalled()
  })

  it("rewrites a non-canonical URL to the canonical one", async () => {
    navigation.currentSearch = "role=ADMIN&q=Aroha&page=1&sortBy=name&futureContext=keep"

    render(<Harness />)

    await waitFor(() => expect(navigation.replace).toHaveBeenCalled())
    expect(navigation.replace).toHaveBeenLastCalledWith(
      `${adminHref("members")}?futureContext=keep&q=Aroha&role=ADMIN`,
      { scroll: false },
    )
  })

  it("navigates to the members URL from any other path", async () => {
    navigation.currentPathname = "/admin/some-other-path"

    render(<Harness />)

    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith(adminHref("members"), { scroll: false }),
    )
  })
})
