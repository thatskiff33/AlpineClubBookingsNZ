// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest"
import { fireEvent, render, screen, within } from "@/lib/__tests__/support/club-time-render"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { adminHref } from "@/lib/admin-hubs"
import { CONTACT_GROUP_MISMATCH_LIMIT } from "@/lib/xero-contact-group-mismatch-summary"
import { HealthAndDiagnosticsPanels } from "../health-diagnostics-panel"
import { xeroSectionId, type ContactGroupMismatchResponse } from "../types"

// #5234: Stuck States counted one contact-group entry, the health tile said
// "1 · Review", and the panel it pointed at said "0 mismatches" and named
// nobody. An information-only entry (a member no grouping rule matches whose
// contact still sits in a managed group) stays counted, so the tile and the
// panel must both say it is one to review by hand, and the panel must name it.

const mocks = vi.hoisted(() => ({ fetchJson: vi.fn(), postJson: vi.fn() }))

vi.mock("../api", () => ({ fetchJson: mocks.fetchJson, postJson: mocks.postJson }))
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a>,
}))

const health = {
  unlinkedMembers: { count: 0, href: "/admin/members" },
  failedOperations: { count: 0, legacyCount: 0 },
  pendingOperations: { count: 0 },
  lastMembershipRefresh: { at: null, lastCronStatus: null },
  contactGroupMismatches: { count: 1, resyncCount: 0, reviewByHandCount: 1, cacheReady: true },
  contactLinkMismatches: { count: 0, cacheReady: true },
  creditNotesSpentOutsideApp: { count: 0 },
  apiBudget: { usagePercent: 0, totalCalls: 0, failedCalls: 0, status: "healthy" },
  missingInvoices: { count: 0 },
}

const groupMismatches: ContactGroupMismatchResponse = {
  mode: "MEMBERSHIP_TYPE_AND_AGE",
  cacheReady: true,
  lastRefreshedAt: "2026-06-30T00:00:00.000Z",
  activeRuleCount: 3,
  membersConsidered: 40,
  mismatchCount: 0,
  addCount: 0,
  removeCount: 0,
  estimatedXeroCalls: 0,
  skippedNoContact: [],
  mismatches: [],
  informationalCount: 1,
  informational: [
    {
      memberId: "member-org",
      memberName: "Ridge Outdoor Trust",
      memberEmail: "office@ridge.example",
      ageTier: "NOT_APPLICABLE",
      xeroContactId: "contact-org",
      unexpectedManagedGroupIds: ["group-adults"],
      unexpectedManagedGroups: [{ id: "group-adults", name: "Adult Members" }],
    },
  ],
}

function renderPanel(
  healthAnswer: unknown = health,
  groupAnswer: unknown = groupMismatches,
) {
  mocks.fetchJson.mockImplementation(async (url: string) =>
    url.startsWith("/api/admin/xero/contact-group-mismatches") ? groupAnswer : healthAnswer,
  )
  return render(
    <HealthAndDiagnosticsPanels
      connected
      shortCode={null}
      currentXeroPath="/admin/xero"
      healthOpen
      contactGroupMismatchesOpen
      contactLinkMismatchesOpen={false}
      onToggle={vi.fn()}
      onMessage={vi.fn()}
      onRefreshOperations={vi.fn()}
      refreshToken={0}
      scrollToSection={vi.fn()}
    />,
  )
}

describe("an information-only contact-group entry (#5234)", () => {
  beforeEach(() => vi.clearAllMocks())

  it("is counted on the health tile as one to review by hand", async () => {
    renderPanel()
    const card = (await screen.findByText("Group mismatches")).closest("div.rounded-xl") as HTMLElement
    expect(card).toHaveTextContent("1")
    expect(card).toHaveTextContent("1 to review by hand")
    expect(card).not.toHaveTextContent("to re-sync")
  })

  it("is named in the mismatch panel with its managed group and the fix, never reported as nothing to do", async () => {
    renderPanel()
    const section = await screen.findByText("Ridge Outdoor Trust").then(
      () => document.getElementById(xeroSectionId("contactGroupMismatches")) as HTMLElement,
    )
    const panel = within(section)

    expect(panel.getByText("1 to review by hand")).toBeInTheDocument()
    expect(panel.queryByText(/No linked members are currently mismatched/)).not.toBeInTheDocument()
    expect(panel.queryByText(/0 mismatches/)).not.toBeInTheDocument()

    // One named row for the one entry Stuck States and the tile count.
    expect(panel.getByRole("heading", { name: "To review by hand" })).toBeInTheDocument()
    expect(panel.queryByRole("heading", { name: "To re-sync" })).not.toBeInTheDocument()
    const member = panel.getByRole("link", { name: "Ridge Outdoor Trust" })
    expect(member.getAttribute("href")).toContain(adminHref("member-detail", { id: "member-org" }))
    expect(panel.getByText("In Adult Members")).toBeInTheDocument()
    expect(
      panel.getByText("Remove the contact from Adult Members in Xero, or add a grouping rule that covers this member."),
    ).toBeInTheDocument()
  })

  // Blue-green: a new bundle can meet a server from before #5234, which sends
  // no split counts and only group ids. The page must still render and count.
  it("still counts and names the entry when an older server answers", async () => {
    const olderHealth = { ...health, contactGroupMismatches: { count: 1, cacheReady: true } }
    const olderEntry: Record<string, unknown> = { ...groupMismatches.informational[0] }
    delete olderEntry.unexpectedManagedGroups
    const olderGroups = { ...groupMismatches, informational: [olderEntry] }
    renderPanel(olderHealth, olderGroups)

    const card = (await screen.findByText("Group mismatches")).closest("div.rounded-xl") as HTMLElement
    // Worded from the total alone: no split it cannot know.
    expect(card).toHaveTextContent("1 to review. Linked members")
    expect(card).not.toHaveTextContent("by hand")

    await screen.findByText("Ridge Outdoor Trust")
    const panel = within(document.getElementById(xeroSectionId("contactGroupMismatches")) as HTMLElement)
    expect(panel.getByText("In group-adults")).toBeInTheDocument()
    expect(
      panel.getByText("Remove the contact from group-adults in Xero, or add a grouping rule that covers this member."),
    ).toBeInTheDocument()
  })
})

// A Refresh re-syncs at most CONTACT_GROUP_MISMATCH_LIMIT flagged contacts.
// With 340 flagged it once read "Re-synced 200 of 200", telling the officer
// everything was done when 140 were never fetched.
describe("the contact-group Refresh line", () => {
  beforeEach(() => vi.clearAllMocks())

  async function refreshWith(resync: NonNullable<ContactGroupMismatchResponse["resync"]>) {
    mocks.postJson.mockResolvedValue({ ...groupMismatches, resync })
    renderPanel()
    await screen.findByText("Ridge Outdoor Trust")
    const panel = within(document.getElementById(xeroSectionId("contactGroupMismatches")) as HTMLElement)
    fireEvent.click(panel.getByRole("button", { name: "Refresh" }))
    return panel.findByText(/^Re-synced /)
  }

  it("counts out of the true total and names the full refresh when the limit left contacts out", async () => {
    const line = await refreshWith({
      requestedContacts: CONTACT_GROUP_MISMATCH_LIMIT,
      resyncedContacts: CONTACT_GROUP_MISMATCH_LIMIT,
      removedContacts: 0,
      flaggedContacts: 340,
      resyncedAt: "2026-07-01T00:00:00.000Z",
    })
    expect(line).toHaveTextContent(
      /^Re-synced 200 of 340 flagged contacts from Xero at .+\. The other 140 were not re-fetched; Refresh Xero Groups on the members list \(or Refresh from Xero on Xero member grouping\) re-reads every contact's groups\.$/
    )
  })

  it("is unchanged at or under the limit", async () => {
    const line = await refreshWith({
      requestedContacts: CONTACT_GROUP_MISMATCH_LIMIT,
      resyncedContacts: CONTACT_GROUP_MISMATCH_LIMIT,
      removedContacts: 0,
      flaggedContacts: CONTACT_GROUP_MISMATCH_LIMIT,
      resyncedAt: "2026-07-01T00:00:00.000Z",
    })
    expect(line).toHaveTextContent(/^Re-synced 200 of 200 flagged contacts from Xero at [^.]+\.$/)
    expect(line).not.toHaveTextContent("were not re-fetched")
  })

  // Blue-green: a server from before this fix sends no flaggedContacts.
  it("keeps the old line when an older server answers", async () => {
    const line = await refreshWith({
      requestedContacts: 3,
      resyncedContacts: 2,
      removedContacts: 1,
      resyncedAt: "2026-07-01T00:00:00.000Z",
    })
    expect(line).toHaveTextContent(
      /^Re-synced 2 of 3 flagged contacts from Xero at .+ \(1 no longer exist in Xero; their stale cache entries were removed\)\.$/,
    )
  })
})
