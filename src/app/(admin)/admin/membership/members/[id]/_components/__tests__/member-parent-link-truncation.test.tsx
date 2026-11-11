// @vitest-environment jsdom

/**
 * #2425 — "keep typing", but only when the picker really did run out of room.
 *
 * The parent search asks for eight rows. Since #2282 lifted the adults-only
 * filter, a shared surname can produce more than eight eligible people, and the
 * list simply STOPPED — no adult, no explanation, and no way for the admin to
 * know that typing one more letter was the answer. The owner's second decision
 * (1 Aug 2026) is a truncation hint in the #2308 member-guest finder's own
 * words.
 *
 * Three things are pinned here, and each is a separate way to get it wrong:
 *
 *  1. THE SENTENCE IS THE MEMBER-GUEST FINDER'S, character for character. The
 *     admin picker keeps its own copy of the string rather than importing the
 *     member-facing one (that sentence carries privacy rules this surface does
 *     not share), so the only thing stopping the two drifting is this test.
 *  2. IT APPEARS ONLY WHEN THE PAGE WAS CUT SHORT. A hint under a complete list
 *     is worse than none: it tells the admin to keep typing for somebody who is
 *     not there.
 *  3. THE FLAG COMES FROM THE SERVER'S OWN TOTAL. `total > rows shown` is
 *     computed in the hook against the RAW page, so selecting a candidate —
 *     which removes that row from the rendered list — cannot fake a truncation.
 *
 * Mutation probes (each re-run and confirmed to turn this file red): drop the
 * `resultsTruncated &&` guard so the hint always renders; make the hook compare
 * against the post-filter list; make the hook read `members.length` instead of
 * `total`; change either copy of the sentence.
 */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, renderHook, screen } from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { MemberParentLinkDialog } from "../member-parent-link-dialog";
import { useMemberParentLink } from "../../_hooks/use-member-parent-link";
import { MEMBER_SEARCH_TRUNCATED_HINT } from "@/lib/admin-member-detail-helpers";
import { MEMBER_GUEST_FIND_COPY } from "@/lib/member-guest-find";
import type { MemberDetail } from "../../_types";

const HINT = "Keep typing to narrow this down.";

function buildCandidate(index: number, ageTier = "CHILD") {
  return {
    id: `kingi-${index}`,
    firstName: `Kid${index}`,
    lastName: "Kingi",
    email: `kid${index}@kingi.example.org`,
    ageTier,
    active: true,
    canLogin: false,
    dateOfBirth: null,
    familyGroups: [],
  };
}

function buildMember(): MemberDetail {
  return {
    id: "member-1",
    firstName: "Tui",
    lastName: "Kingi",
    email: "tui@kingi.example.org",
    ageTier: "CHILD",
    role: "USER",
    accessRoles: ["USER"],
    active: true,
    archivedAt: null,
    canLogin: true,
    dependents: [],
    parentLinks: [],
    familyGroups: [],
    inheritEmailFromId: null,
    inheritEmailFrom: null,
  } as unknown as MemberDetail;
}

function dialogElement(overrides: Record<string, unknown> = {}) {
  return (
    <MemberParentLinkDialog
      open
      onOpenChange={vi.fn()}
      member={buildMember()}
      search="kingi"
      searching={false}
      searchResults={[1, 2, 3, 4, 5, 6, 7, 8].map((index) => buildCandidate(index)) as never}
      selected={null}
      notificationParentId=""
      disableLogin={false}
      familyGroupIds={[]}
      saving={false}
      error=""
      onChangeSearch={vi.fn()}
      onSelectCandidate={vi.fn()}
      onClearSelection={vi.fn()}
      onChangeNotificationParentId={vi.fn()}
      onChangeDisableLogin={vi.fn()}
      onToggleFamilyGroup={vi.fn()}
      onSubmit={vi.fn()}
      {...overrides}
    />
  );
}

function renderDialog(overrides: Record<string, unknown> = {}) {
  // The dialog resolves the notification mailbox over the network when a
  // candidate is selected; nothing here selects one, so an inert fetch is
  // enough.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ source: null }) })) as never,
  );
  return render(dialogElement(overrides));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("#2425 — the parent picker's truncation hint", () => {
  it("says exactly what the member-guest finder says", () => {
    expect(MEMBER_SEARCH_TRUNCATED_HINT).toBe(HINT);
    expect(MEMBER_GUEST_FIND_COPY.truncated).toBe(HINT);
    expect(MEMBER_SEARCH_TRUNCATED_HINT).toBe(MEMBER_GUEST_FIND_COPY.truncated);
  });

  it("shows the hint under a page that was cut short", () => {
    renderDialog({ resultsTruncated: true });
    // Two nodes carry the sentence since #2460 — the visible hint and the
    // polite live region that announces it. The visible one is the paragraph
    // that is not the region.
    const drawn = screen
      .getAllByText(HINT)
      .filter((node) => node !== screen.getByTestId("parent-link-truncation-status"));
    expect(drawn).toHaveLength(1);
    expect(drawn[0]!.tagName).toBe("P");
    expect(drawn[0]!.className).toContain("text-muted-foreground");
  });

  it("stays silent when the list holds everyone who matched", () => {
    renderDialog({ resultsTruncated: false });
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
  });

  it("stays silent when nobody matched at all", () => {
    // Defence in depth: the hint lives inside the results branch, so an empty
    // search can never reach it — but "keep typing" beneath "no eligible active
    // members found" would be actively misleading if it ever did.
    renderDialog({ searchResults: [], resultsTruncated: true });
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
    expect(
      screen.getByText("No eligible active members found."),
    ).toBeInTheDocument();
  });

  it("also says adults come first, so the order does not read as a bug", () => {
    renderDialog();
    // Both halves of the sentence: the ranking guarantees that MINORS come last
    // (an age-exempt member ranks with the adults, not among the children —
    // #2425 review), so the copy says that rather than only "adults first".
    expect(
      screen.getByText(
        /active member of any age; adults are listed ahead of any children or youth that match/i,
      ),
    ).toBeInTheDocument();
  });
});

describe("#2425 — where the truncated flag comes from", () => {
  async function runSearch(response: { members: unknown[]; total: number }) {
    vi.useFakeTimers();
    const requestedUrls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      requestedUrls.push(String(input));
      return { ok: true, json: async () => response };
    });
    vi.stubGlobal("fetch", fetchMock as never);

    const { result } = renderHook(() =>
      useMemberParentLink({
        member: buildMember(),
        fetchMember: vi.fn(),
        setLoading: vi.fn(),
        setRelationshipError: vi.fn(),
      }),
    );

    act(() => {
      result.current.openParentLinkDialog();
    });
    act(() => {
      result.current.setParentLinkSearch("kingi");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(requestedUrls).not.toHaveLength(0);
    // The picker's own call path, and the page size the whole issue is about.
    expect(requestedUrls[0]).toContain("parentLinkEligibleFor=member-1");
    expect(requestedUrls[0]).toContain("pageSize=8");
    return result;
  }

  it("is true when the server counted more than it returned", async () => {
    const result = await runSearch({
      members: [1, 2, 3, 4, 5, 6, 7, 8].map((index) => buildCandidate(index)),
      total: 11,
    });
    expect(result.current.parentLinkSearchResults).toHaveLength(8);
    expect(result.current.parentLinkResultsTruncated).toBe(true);
  });

  it("is false when the page holds the whole eligible set", async () => {
    const result = await runSearch({
      members: [1, 2, 3].map((index) => buildCandidate(index)),
      total: 3,
    });
    expect(result.current.parentLinkResultsTruncated).toBe(false);
  });

  it("is not faked by a selection that drops a row from the rendered list", async () => {
    // A selected candidate is filtered out of the rendered list. Compared
    // against THAT list, a complete page of eight would read as eight of nine
    // and the dialog would tell the admin to keep typing for nobody. Set
    // directly rather than through `selectLinkParent`, which also clears the
    // search — that would end the search entirely and prove nothing.
    const result = await runSearch({
      members: [1, 2, 3, 4, 5, 6, 7, 8].map((index) => buildCandidate(index)),
      total: 8,
    });
    act(() => {
      result.current.setSelectedLinkParent(buildCandidate(1) as never);
    });
    expect(result.current.parentLinkSearchResults).toHaveLength(7);
    expect(result.current.parentLinkResultsTruncated).toBe(false);
  });
});

/*
  #2460 — the truncation hint is ANNOUNCED, not only drawn.

  #2425 shipped this sentence as a bare paragraph under the list, copied
  character for character from the #2308 member-guest finder — which had the
  same defect. An admin using a screen reader typed, the list quietly stopped at
  eight, and nothing said so. Both surfaces are fixed together, because the
  shared copy's whole promise is "same words, same shape".

  The shape is the house live-region rule (`AGENTS.md`, `PolicyFeedback`,
  `DependentNotice`, and the #2244 export-truncation notice): the `role="status"`
  wrapper is mounted for the whole life of the open dialog and only its CONTENT
  is gated, because a polite region injected already-populated is silently
  dropped by some screen-reader/browser pairings. Both halves are pinned below —
  it must exist and be EMPTY with nothing to say, and be the SAME node once
  there is, which is what stops anyone moving the role onto the visible
  paragraph inside the results branch.

  Where it sits is pinned too. The wrapper is invisible, but a `space-y-*` stack
  in Tailwind v4 hangs its gap off `:not(:last-child)`, so an invisible LAST
  child still pushes the visible content above it around. It goes above the
  results, never below them.

  The region and the list are gated by ONE expression (`showingResultsList`), so
  the announcement can never be made about content that is not drawn; that
  property is pinned directly rather than left to the shape of the code.

  Mutation probes run against this block, each confirmed to turn it red: drop
  the `role="status"` attribute; move the wrapper inside the results branch of
  the ternary; move it below the ternary, where it can end up last; render the
  wrapper only when truncated; announce a different sentence from the drawn one;
  drop `resultsTruncated`, `searchResults.length` or `!selected` from the
  `showTruncationHint` gate; give the ternary its own copy of the conditions and
  raise its character floor to three.
*/
describe("#2460 — the parent picker announces the truncation hint", () => {
  function region() {
    return screen.getByTestId("parent-link-truncation-status");
  }

  it("registers the polite region before there is anything to announce", () => {
    // The state the dialog opens in: nothing typed, no results, nothing to say.
    renderDialog({ search: "", searchResults: [], resultsTruncated: false });
    expect(region()).toHaveAttribute("role", "status");
    expect(region()).toBeEmptyDOMElement();
  });

  it("keeps the region mounted and empty when the list holds everyone", () => {
    renderDialog({ resultsTruncated: false });
    expect(region()).toBeEmptyDOMElement();
  });

  it("announces the sentence, verbatim, when the page was cut short", () => {
    renderDialog({ resultsTruncated: true });
    // Verbatim, and identical to the sentence on screen: no count is added for
    // the screen reader, so the pinned copy stays one string.
    expect(region().textContent).toBe(MEMBER_SEARCH_TRUNCATED_HINT);
    expect(region().textContent).toBe(HINT);
  });

  it("says nothing when nobody matched at all", () => {
    renderDialog({ searchResults: [], resultsTruncated: true });
    expect(region()).toBeEmptyDOMElement();
  });

  it("says nothing once a parent is chosen, since the list is gone", () => {
    renderDialog({ selected: buildCandidate(1), resultsTruncated: true });
    expect(region()).toBeEmptyDOMElement();
  });

  it("swaps the content of the region that was already there, never mounts a new one", () => {
    const { rerender } = renderDialog({
      search: "k",
      searchResults: [],
      resultsTruncated: false,
    });
    const before = region();
    expect(before).toBeEmptyDOMElement();

    rerender(dialogElement({ resultsTruncated: true }));

    // Same DOM node, now populated. A fresh node here would mean the region was
    // injected already carrying the sentence, which is the case screen readers
    // drop.
    expect(region()).toBe(before);
    expect(region().textContent).toBe(HINT);
  });

  it("never sits last in the stack, so it cannot open a gap on screen", () => {
    // The region is invisible but it is still a child of a `space-y-4` stack,
    // and Tailwind v4 compiles that gap onto `:not(:last-child)` — the element
    // BEFORE each gap carries it. Put this region last and whatever used to be
    // last gains a 16px bottom margin it never had, so the dialog grows a dead
    // strip above its footer and reflows the instant a parent is picked
    // (#2460 review). Above the results it is always a middle child.
    renderDialog({ resultsTruncated: true });
    const stack = region().parentElement;
    expect(stack?.className).toContain("space-y-4");
    expect(stack?.lastElementChild).not.toBe(region());
  });

  it("stays out of the stack's last slot with no parent selected either", () => {
    // The `{selected && …}` block below the region renders nothing until a
    // parent is picked, which is every moment from opening the dialog until one
    // is — the state the gap would be visible in.
    renderDialog({ selected: null, search: "", searchResults: [] });
    expect(region().parentElement?.lastElementChild).not.toBe(region());
  });

  it("never speaks about a list that is not on screen", () => {
    // The announcement is assembled OUTSIDE the results branch, so "is there a
    // list?" and "is the region allowed to talk?" are two questions that could
    // come to disagree — announcing "Keep typing to narrow this down." over
    // content nobody can see (#2460 review). They are one expression in the
    // component (`showingResultsList`); this pins the property itself, so a
    // future change to what puts rows on screen — a three-character floor, say
    // — has to keep them together or turn this red.
    const cases: Record<string, unknown>[] = [
      { search: "", searchResults: [], resultsTruncated: true },
      { search: "k", resultsTruncated: true },
      // Exactly at the floor: the case a raised floor would break first.
      { search: "ki", resultsTruncated: true },
      { search: "  ", resultsTruncated: true },
      { search: "kingi", searchResults: [], resultsTruncated: true },
      { search: "kingi", resultsTruncated: true },
      { search: "kingi", resultsTruncated: false },
      { selected: buildCandidate(1), resultsTruncated: true },
    ];
    for (const props of cases) {
      cleanup();
      renderDialog(props);
      if (region().textContent === "") continue;
      // Something was said: the rows it is about must be on screen, and so must
      // the visible copy of the same sentence.
      const rows = screen.getAllByRole("button", { name: /Kingi/ });
      expect(rows.length).toBeGreaterThan(0);
      expect(
        screen.getAllByText(HINT).filter((node) => node !== region()),
      ).toHaveLength(1);
    }
  });

  it("keeps the announced copy and the drawn copy an entire list apart", () => {
    // Both nodes carry the sentence and neither is `aria-hidden`, which is a
    // deliberate call (#2460 review): the drawn hint is the copy anchored to
    // the place the list stops, and hiding on-screen text from assistive
    // technology to tidy a duplicate is the worse trade. What makes it benign
    // is the ORDER — region first, then every candidate row, then the visible
    // hint — so browse mode never reads the sentence twice in succession.
    renderDialog({ resultsTruncated: true });
    const drawn = screen.getAllByText(HINT).filter((node) => node !== region())[0]!;
    const rows = screen.getAllByRole("button", { name: /Kingi/ });
    const before = region().compareDocumentPosition(rows[0]!);
    const after = drawn.compareDocumentPosition(rows[rows.length - 1]!);
    expect(before & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(after & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });
});
