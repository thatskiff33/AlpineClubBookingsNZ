// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { XeroStatusFeatures } from "@/hooks/use-xero-status"

const useXeroStatus = vi.fn()

vi.mock("@/hooks/use-xero-status", () => ({
  useXeroStatus: () => useXeroStatus(),
}))

import { useXeroContactGroups } from "../use-xero-contact-groups"

const REFRESHED_AT = "2026-07-05T09:30:00.000Z"

function mockStatus(
  connected: boolean,
  features: Partial<XeroStatusFeatures>
) {
  useXeroStatus.mockReturnValue({
    connected,
    features: {
      dailyMembershipRefresh: false,
      liveMemberGroupLookups: false,
      autoLoadContactGroups: false,
      ...features,
    },
  })
}

function mockContactGroupsFetch(payload: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => payload,
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

const hookOptions = {
  onError: vi.fn(),
  onSuccess: vi.fn(),
  refreshMembers: vi.fn().mockResolvedValue(undefined),
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

beforeEach(() => {
  Object.values(hookOptions).forEach((fn) => fn.mockClear?.())
})

describe("useXeroContactGroups lastRefreshedAt", () => {
  it("exposes the cached last-refresh timestamp when the live flag is OFF, without adopting the groups list", async () => {
    mockStatus(true, {
      liveMemberGroupLookups: false,
      autoLoadContactGroups: false,
    })
    mockContactGroupsFetch({
      groups: [{ id: "g1", name: "Adults", contactCount: 3 }],
      lastRefreshedAt: REFRESHED_AT,
    })

    const { result } = renderHook(() => useXeroContactGroups(hookOptions))

    await waitFor(() =>
      expect(result.current.lastRefreshedAt).toBe(REFRESHED_AT)
    )
    // Filter behavior unchanged: the groups list is not adopted when the
    // auto-load flags are off.
    expect(result.current.xeroContactGroupsList).toEqual([])
  })

  it("sets the timestamp from the fetched cache value and transitions to null for an empty cache", async () => {
    // Two queued responses: a populated cache, then an empty one. Asserting the
    // populated value first proves the read path actually sets state (the test
    // would stay stuck at the initial null if the code ignored the response),
    // and the second phase proves an empty cache maps to null rather than a
    // stale value.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ groups: [], lastRefreshedAt: REFRESHED_AT }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ groups: [], lastRefreshedAt: null }),
      })
    vi.stubGlobal("fetch", fetchMock)

    mockStatus(true, {
      autoLoadContactGroups: false,
      liveMemberGroupLookups: false,
    })
    const { result, rerender } = renderHook(() =>
      useXeroContactGroups(hookOptions)
    )

    await waitFor(() =>
      expect(result.current.lastRefreshedAt).toBe(REFRESHED_AT)
    )

    // Flip a mount-effect dependency to re-run the cache fetch with an empty
    // cache, and assert the timestamp transitions to null.
    mockStatus(true, {
      autoLoadContactGroups: true,
      liveMemberGroupLookups: false,
    })
    rerender()

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.lastRefreshedAt).toBeNull())
  })

  it("renders the same timestamp on the live auto-load path and adopts the groups list", async () => {
    mockStatus(true, {
      liveMemberGroupLookups: true,
      autoLoadContactGroups: true,
    })
    mockContactGroupsFetch({
      groups: [{ id: "g1", name: "Adults", contactCount: 3 }],
      lastRefreshedAt: REFRESHED_AT,
    })

    const { result } = renderHook(() => useXeroContactGroups(hookOptions))

    await waitFor(() =>
      expect(result.current.lastRefreshedAt).toBe(REFRESHED_AT)
    )
    expect(result.current.xeroContactGroupsList).toEqual([
      { id: "g1", name: "Adults", contactCount: 3 },
    ])
  })

  it("does not fetch or set a timestamp when Xero is not connected", async () => {
    mockStatus(false, {})
    const fetchMock = mockContactGroupsFetch({ lastRefreshedAt: REFRESHED_AT })

    const { result } = renderHook(() => useXeroContactGroups(hookOptions))

    await Promise.resolve()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.current.lastRefreshedAt).toBeNull()
  })
})
