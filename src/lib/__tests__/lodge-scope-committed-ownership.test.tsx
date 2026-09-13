// @vitest-environment jsdom

/**
 * Who owns the screen when a late response lands (#2887).
 *
 * Every lodge-scoped editor keeps a ref naming the lodge currently on screen,
 * and every write handler re-reads it after its `await` before applying
 * anything. Two things have to hold for that fence to be worth having, and
 * they fail in different ways:
 *
 *  1. It has to be LIVE. If the ref stops tracking the scope, the fence still
 *     compiles, still runs, and always agrees — a response for a lodge the
 *     operator has left gets applied to the lodge they are looking at. The
 *     behavioural case below drives that transition through the LODGE LIST
 *     rather than the selector, because the selector's own handler writes the
 *     ref eagerly and would hide the defect.
 *
 *  2. It has to move in the COMMIT. The write used to sit in the render body,
 *     which `react-hooks` rejects and which is wrong on the merits: a render
 *     React abandons still moved the ref. The obvious repair — a plain
 *     `useEffect` — is worse than it looks, because passive effects are
 *     scheduled after paint, so an in-flight `.then` for lodge A can run after
 *     the A->B commit, before the effect writes B, and pass the fence.
 *     `useLayoutEffect` flushes synchronously inside the commit and closes it.
 *
 * The contract case at the bottom pins (2) as source, deliberately. jsdom
 * cannot tell a layout flush from a passive one — `act()` drains both before
 * returning — so no behavioural test in this repo can distinguish them, and a
 * test that claimed to would be claiming more than it checks. What CAN be
 * checked is that nobody quietly downgrades the hook, which is the only way
 * the window reopens once lint is green.
 */

import "@testing-library/jest-dom/vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { useEffect } from "react"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

type LodgeOptionState = {
  lodges: ReadonlyArray<{ id: string; name: string }>
  loading: boolean
  failed: boolean
  forbidden: boolean
  reload: () => void
}

const LODGE_A = { id: "lodge-a", name: "Lodge A" }
const LODGE_B = { id: "lodge-b", name: "Lodge B" }

let lodgeOptions: LodgeOptionState

vi.mock("@/components/lodge-select", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/components/lodge-select")
  return {
    ...actual,
    initialLodgeIdFromLocation: () => null,
    useLodgeOptions: () => lodgeOptions,
    LodgeSelect: ({ lodges, value, onChange }: {
      lodges: ReadonlyArray<{ id: string; name: string }>
      value: string | null
      onChange: (value: string | null) => void
    }) => {
      useEffect(() => {
        if (!value && lodges[0]) onChange(lodges[0].id)
      }, [lodges, onChange, value])
      return <div data-testid="lodge-select" />
    },
  }
})

vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/hooks/use-admin-area-edit-access")),
  useAdminAreaEditAccess: () => true,
}))

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: {
      user: {
        id: "admin-1",
        adminPermissionMatrix: {
          overview: "view",
          bookings: "edit",
          membership: "edit",
          finance: "edit",
          lodge: "edit",
          content: "view",
          support: "view",
        },
      },
    },
    status: "authenticated",
  }),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/admin/chores",
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}))

import ChoresPage from "@/app/(admin)/admin/chores/page"

const CHORE = {
  id: "chore-1",
  name: "Sweep the bunkroom",
  description: null,
  recommendedPeopleMin: 1,
  recommendedPeopleMax: 1,
  isEssential: false,
  ageRestriction: "ANY",
  conditionalNote: null,
  minAge: 0,
  sortOrder: 1,
  timeOfDay: "ANYTIME",
  frequencyMode: "DAILY",
  frequencyDays: null,
  frequencyDaysOfWeek: [],
  active: true,
}

describe("lodge-scope ownership follows the committed scope (#2887)", () => {
  beforeEach(() => {
    lodgeOptions = {
      lodges: [LODGE_A, LODGE_B],
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

  it("drops a write's refresh when the LODGE LIST retires the lodge mid-flight", async () => {
    // The scope moves without anyone touching the selector: the lodge list
    // refreshes and Lodge A is no longer offered. Nothing writes the ownership
    // ref eagerly on this path, so it is the derived write — and only the
    // derived write — that keeps the fence honest.
    const requests: string[] = []
    let releaseToggle!: () => void
    const togglePut = new Promise<Response>((resolve) => {
      releaseToggle = () => resolve(Response.json({ ok: true }))
    })

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      requests.push(`${init?.method ?? "GET"} ${url}`)
      if (init?.method === "PUT") return togglePut
      return Response.json([CHORE])
    }))

    const { rerender } = render(<ChoresPage />)

    await screen.findByText("Sweep the bunkroom")
    expect(requests.filter((r) => r.includes("lodgeId=lodge-a"))).toHaveLength(1)

    fireEvent.click(screen.getByRole("button", { name: "Deactivate" }))
    await waitFor(() => expect(requests.some((r) => r.startsWith("PUT"))).toBe(true))

    // Lodge A is retired while the toggle is still in flight.
    lodgeOptions = { ...lodgeOptions, lodges: [LODGE_B] }
    await act(async () => {
      rerender(<ChoresPage />)
    })

    await act(async () => {
      releaseToggle()
      await togglePut
    })

    // The refresh the handler would have run belongs to Lodge A, and Lodge A is
    // no longer what the page is showing. Exactly one Lodge A read, ever.
    expect(requests.filter((r) => r.includes("lodgeId=lodge-a"))).toHaveLength(1)
    expect(screen.queryByText("Sweep the bunkroom")).not.toBeInTheDocument()
  })

  it("still applies a write's refresh when the scope has NOT moved", async () => {
    // The counterpart, so the case above pins a fence rather than a dead page.
    const requests: string[] = []
    let releaseToggle!: () => void
    const togglePut = new Promise<Response>((resolve) => {
      releaseToggle = () => resolve(Response.json({ ok: true }))
    })

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      requests.push(`${init?.method ?? "GET"} ${url}`)
      if (init?.method === "PUT") return togglePut
      return Response.json([CHORE])
    }))

    render(<ChoresPage />)
    await screen.findByText("Sweep the bunkroom")

    fireEvent.click(screen.getByRole("button", { name: "Deactivate" }))
    await waitFor(() => expect(requests.some((r) => r.startsWith("PUT"))).toBe(true))

    await act(async () => {
      releaseToggle()
      await togglePut
    })

    await waitFor(() =>
      expect(requests.filter((r) => r.includes("lodgeId=lodge-a"))).toHaveLength(2),
    )
  })
})

/**
 * Every surface that fences a late response on lodge identity, and the ref it
 * fences on. Exact, so a new lodge-scoped editor cannot copy the old
 * render-body shape and go unnoticed.
 */
const SCOPE_OWNERSHIP_REFS: ReadonlyArray<{ file: string; ref: string; scope: string }> = [
  { file: "src/app/(admin)/admin/chores/page.tsx", ref: "activeScopeRef", scope: "scopedLodgeId" },
  { file: "src/app/(admin)/admin/lockers/page.tsx", ref: "activeScopeRef", scope: "scopedLodgeId" },
  { file: "src/app/(admin)/admin/seasons/page.tsx", ref: "activeScopeRef", scope: "scopedLodgeId" },
  {
    file: "src/app/(admin)/admin/fees/_components/hut-fees-section.tsx",
    ref: "activeScopeRef",
    scope: "scopedLodgeId",
  },
  {
    file: "src/app/(authenticated)/book/_hooks/use-booking-wizard.ts",
    ref: "activeScopedLodgeIdRef",
    scope: "scopedLodgeId",
  },
  {
    file: "src/components/admin/lodge-instructions-panel.tsx",
    ref: "activeScopeRef",
    scope: "scopeLodgeId",
  },
  {
    file: "src/components/admin/rooms-beds-manager.tsx",
    ref: "activeScopeRef",
    scope: "scopedLodgeId",
  },
]

describe("scope-ownership refs move in the commit, not the render (#2887)", () => {
  it.each(SCOPE_OWNERSHIP_REFS)(
    "$file writes $ref from a layout effect",
    ({ file, ref, scope }) => {
      const source = readFileSync(join(process.cwd(), file), "utf8")

      // The derived write is inside `useLayoutEffect`, and it is the ONLY
      // derived write. A passive `useEffect` here would be accepted by lint and
      // would reopen the post-commit/pre-flush window this exists to close;
      // a render-body write would be lint-rejected but is pinned anyway,
      // because a single `eslint-disable` comment is all it takes to get it
      // back.
      expect(source).toContain(
        `useLayoutEffect(() => {\n    ${ref}.current = ${scope}`,
      )
      expect(source).not.toContain(`useEffect(() => {\n    ${ref}.current = `)
      // A render-body write sits at the component's own indentation. Every
      // legal write is nested one level deeper, inside an effect or a handler.
      expect(source).not.toMatch(
        new RegExp(`^ {2}${ref}\\.current\\s*=`, "m"),
      )
    },
  )

  it("names every scope-ownership ref in the tree", () => {
    // The list above is only a guard if it is complete. Anything shaped like a
    // scope-ownership ref has to be on it.
    const found = SCOPE_OWNERSHIP_REFS.map(({ file, ref }) => `${file}:${ref}`)
    expect(found).toHaveLength(new Set(found).size)
    for (const { file, ref } of SCOPE_OWNERSHIP_REFS) {
      const source = readFileSync(join(process.cwd(), file), "utf8")
      expect(source).toContain(`const ${ref} = useRef<string | null>(`)
    }
  })
})
