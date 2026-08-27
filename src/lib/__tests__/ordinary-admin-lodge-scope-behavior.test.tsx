// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest"
import { useEffect, type ReactElement } from "react"
import { act, cleanup, render, screen } from "@/lib/__tests__/support/club-time-render"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AdminPermissionMatrix } from "@/lib/admin-permissions"

type LodgeOptionState = {
  lodges: ReadonlyArray<{ id: string; name: string }>
  loading: boolean
  failed: boolean
  forbidden: boolean
  reload: () => void
}

const LODGES = [
  { id: "lodge-1", name: "Lodge One" },
  { id: "lodge-2", name: "Lodge Two" },
]

let lodgeOptions: LodgeOptionState

vi.mock("@/components/lodge-select", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/lodge-select")>()
  return {
    ...actual,
    initialLodgeIdFromLocation: () => "lodge-2",
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

// The contract under test is whether the page exposes its action surface at
// all. A small form double makes that boundary observable without re-testing
// the hut-leader form's own date/member workflow here.
vi.mock("@/app/(admin)/admin/hut-leaders/_components/assignment-form", () => ({
  AssignmentForm: () => <button>Confirm assignment</button>,
}))

vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-admin-area-edit-access")>()),
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
  usePathname: () => "/admin/test",
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock("@/components/confirm-dialog", () => ({
  useConfirm: () => ({ confirm: vi.fn(async () => false), confirmDialog: null }),
}))

import SeasonsPage from "@/app/(admin)/admin/seasons/page"
import ChoresPage from "@/app/(admin)/admin/chores/page"
import LockersPage from "@/app/(admin)/admin/lockers/page"
import { HutFeesSection } from "@/app/(admin)/admin/fees/_components/hut-fees-section"
import RosterPage from "@/app/(admin)/admin/roster/page"
import HutLeadersPage from "@/app/(admin)/admin/hut-leaders/page"
import { RoomsBedsManager } from "@/components/admin/rooms-beds-manager"
import { LodgeCapacityCard } from "@/components/admin/lodge-capacity-card"
import AdminWorkPartiesPage from "@/app/(admin)/admin/work-parties/page"
import { PromoCodesPageClient } from "@/app/(admin)/admin/promo-codes/promo-codes-page-client"
import { ClubIdentityProvider } from "@/components/club-identity-provider"
import { clubIdentity } from "@/config/club-identity"

const PERMISSION_MATRIX: AdminPermissionMatrix = {
  overview: "view",
  bookings: "edit",
  membership: "edit",
  finance: "edit",
  lodge: "edit",
  content: "view",
  support: "view",
}

const EDITORS: Array<{
  name: string
  render: () => ReactElement
  action: RegExp
}> = [
  { name: "seasons", render: () => <SeasonsPage />, action: /^edit window$/i },
  { name: "chores", render: () => <ChoresPage />, action: /add chore|create chore|update chore/i },
  { name: "lockers", render: () => <LockersPage />, action: /^create locker$/i },
  { name: "hut fees", render: () => <HutFeesSection canEdit />, action: /add season|save season/i },
  { name: "roster", render: () => <RosterPage />, action: /generate roster|save roster|confirm roster/i },
  { name: "hut leaders", render: () => <HutLeadersPage />, action: /^confirm assignment$/i },
  {
    name: "rooms and beds",
    render: () => <RoomsBedsManager permissionMatrix={PERMISSION_MATRIX} />,
    action: /add room|bulk create|import rooms/i,
  },
  { name: "lodge capacity", render: () => <LodgeCapacityCard />, action: /^save$/i },
  { name: "work parties", render: () => <AdminWorkPartiesPage />, action: /^new event$/i },
  {
    name: "promo codes",
    render: () => <PromoCodesPageClient permissionMatrix={PERMISSION_MATRIX} />,
    action: /^add promo code$/i,
  },
]

const UNSETTLED_STATES = [
  {
    name: "delayed loading",
    state: { lodges: LODGES, loading: true, failed: false, forbidden: false },
  },
  {
    /*
      `lodges: []`, not `LODGES` (#2887 review). `useLodgeOptions` clears the
      list on any non-403 failure, so a fixture that keeps two lodges tests a
      state the hook never produces — and it hid real damage: with two lodges
      present the promo/work-party lodge-restriction control still renders, so
      the form looks healthy exactly where it is not.
    */
    name: "failed",
    state: { lodges: [], loading: false, failed: true, forbidden: false },
  },
  {
    /*
      LIVE behaviour, not a hypothetical. `GET /api/admin/lodges` requires
      `lodge:view`, and `ADMIN_MEMBERSHIP` and `FINANCE_ADMIN` hold no `lodge`
      entry, so a 403 here is their permanent answer and every editor below must
      stop cleanly rather than act on an empty list. Relaxing that route was
      attempted in this PR and reverted — the attempt was inert, since
      `requireAdmin()` re-infers `lodge:view` from the request path — and the
      real fix is tracked as #2925.

      `lodges: []` because that is what the hook produces on a 403
      (`lodge-select.tsx`), and asserting it with two lodges present would hide
      the promo/work-party restriction control still rendering.
    */
    name: "forbidden",
    state: { lodges: [], loading: false, failed: false, forbidden: true },
  },
  {
    name: "successful empty",
    state: { lodges: [], loading: false, failed: false, forbidden: false },
  },
] as const

describe("ordinary admin editors fail closed until lodge scope settles (#2701, #2887)", () => {
  beforeEach(() => {
    lodgeOptions = {
      lodges: LODGES,
      loading: true,
      failed: false,
      forbidden: false,
      reload: vi.fn(),
    }
    vi.stubGlobal("fetch", vi.fn(() => {
      throw new Error("An unsettled lodge scope attempted a downstream request")
    }))
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  const cases = EDITORS.flatMap((editor) =>
    UNSETTLED_STATES.map((scope) => ({
      editorName: editor.name,
      stateName: scope.name,
      render: editor.render,
      action: editor.action,
      state: scope.state,
    })),
  )

  it.each(cases)("$editorName sends no downstream GET and exposes no action while scope is $stateName", async ({ render: renderEditor, action, state }) => {
    lodgeOptions = { ...state, reload: vi.fn() }
    render(
      <ClubIdentityProvider value={clubIdentity}>
        {renderEditor()}
      </ClubIdentityProvider>,
    )

    await act(async () => {})

    expect(fetch).not.toHaveBeenCalled()
    expect(screen.queryByRole("button", { name: action })).not.toBeInTheDocument()
  })

  it.each(EDITORS)(
    "$name explains a 403 as a role fact, with no retry that could only 403 again",
    async ({ render: renderEditor }) => {
      /*
        `forbidden` is LIVE behaviour for `ADMIN_MEMBERSHIP` and `FINANCE_ADMIN`
        (see the state above), so the operator-facing copy is pinned rather than
        left to the gate. The cases above prove these editors stop; this proves
        they say WHY, and say it honestly:

          - an info explanation naming the role, not an error;
          - and NO "Try again", because the retry would 403 forever. `failed`
            gets one and `forbidden` must not — collapsing the two states is the
            defect this distinction exists to prevent.
      */
      lodgeOptions = {
        lodges: [],
        loading: false,
        failed: false,
        forbidden: true,
        reload: vi.fn(),
      }
      render(
        <ClubIdentityProvider value={clubIdentity}>
          {renderEditor()}
        </ClubIdentityProvider>,
      )
      await act(async () => {})

      expect(
        screen.getByText(/your role cannot choose a lodge/i),
      ).toBeInTheDocument()
      expect(
        screen.queryByRole("button", { name: /^try again$/i }),
      ).not.toBeInTheDocument()
    },
  )

  it.each(EDITORS)("$name exposes its real action after a concrete lodge settles", async ({ render: renderEditor, action }) => {
    lodgeOptions = {
      lodges: LODGES,
      loading: false,
      failed: false,
      forbidden: false,
      reload: vi.fn(),
    }
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const json = async () => {
        if (url.includes("/api/admin/seasons")) {
          return [{
            id: "season-1",
            name: "Winter",
            type: "WINTER",
            startDate: "2026-08-01",
            endDate: "2026-09-01",
            active: true,
            flatWholeLodgeNightCents: null,
            membershipTypeRates: [],
          }]
        }
        if (url.includes("/api/admin/chores")) return []
        if (url.includes("/api/admin/lockers")) return { lockers: [], members: [] }
        if (url.includes("/api/admin/roster/")) {
          return { date: "2026-08-01", assignments: [], availableGuests: [], status: "DRAFT" }
        }
        if (url.includes("/api/admin/roster/status")) return { statuses: [] }
        if (url.includes("/api/admin/hut-leaders")) return { assignments: [], members: [] }
        if (url.includes("/api/admin/bed-allocation/rooms")) {
          return {
            rooms: [],
            capacity: {
              capacity: 30,
              source: "capacity_override",
              bedAllocationEnabled: true,
              activeBedCount: 0,
              fallbackCapacity: 30,
            },
            canImportFromConfig: false,
            configBeds: [],
          }
        }
        if (url.includes("/api/admin/work-parties")) return { events: [] }
        if (url.includes("/api/admin/promo-codes")) return []
        if (url.includes("/api/admin/membership-types")) return { membershipTypes: [] }
        if (url.includes("/api/admin/age-tier-settings")) return { settings: [] }
        return {
          assignments: [],
          unassignedDates: [],
          nights: [],
          members: [],
          capacity: 30,
          hutLeaderLookaheadDays: 14,
          schoolGroupSoftCap: 12,
          clubConfigCapacity: 30,
        }
      }
      return { ok: true, status: 200, json } as Response
    }))

    render(
      <ClubIdentityProvider value={clubIdentity}>
        {renderEditor()}
      </ClubIdentityProvider>,
    )

    expect(await screen.findByRole("button", { name: action })).toBeInTheDocument()
  })
})
