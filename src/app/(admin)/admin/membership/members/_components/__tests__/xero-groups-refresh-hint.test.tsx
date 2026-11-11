// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { XeroGroupsRefreshHint } from "../xero-groups-refresh-hint"

afterEach(() => {
  cleanup()
})

describe("XeroGroupsRefreshHint", () => {
  it("shows the relative last-refreshed time with an explanatory info icon", () => {
    const twoDaysAgo = new Date(
      Date.now() - 2 * 24 * 60 * 60 * 1000
    ).toISOString()

    render(<XeroGroupsRefreshHint lastRefreshedAt={twoDaysAgo} />)

    expect(
      screen.getByText(/Groups last refreshed 2 days ago/)
    ).toBeInTheDocument()

    // Info icon carries the cache explanation as an accessible tooltip.
    const icon = screen.getByRole("img", { name: /cached snapshot/i })
    expect(icon).toHaveAttribute(
      "title",
      expect.stringContaining("Use Refresh Xero Groups to update it.")
    )

    // The removed persistent banner copy must not appear.
    expect(
      screen.queryByText(/Xero group filters are disabled/)
    ).not.toBeInTheDocument()
  })

  it("prompts to populate the cache when there is no last-refresh timestamp", () => {
    render(<XeroGroupsRefreshHint lastRefreshedAt={null} />)

    expect(
      screen.getByText(
        "No cached Xero groups yet — refresh to populate badges."
      )
    ).toBeInTheDocument()
    expect(screen.queryByText(/last refreshed/)).not.toBeInTheDocument()
  })

  it("renders the timestamp regardless of the live-lookup path (no banner)", () => {
    // The hint is flag-agnostic: with a truthful timestamp from either the
    // cached (flag-off) or live auto-load (flag-on) path it renders identically.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()

    render(<XeroGroupsRefreshHint lastRefreshedAt={oneHourAgo} />)

    expect(
      screen.getByText(/Groups last refreshed about 1 hour ago/)
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/Xero group filters are disabled/)
    ).not.toBeInTheDocument()
  })
})
