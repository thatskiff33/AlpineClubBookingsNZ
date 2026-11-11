// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MemberFamilyTreeCard } from "../member-family-tree-card";
import type { MemberFamilyTree, FamilyTreeNode } from "@/lib/member-family-tree";

function node(overrides: Partial<FamilyTreeNode> & { id: string }): FamilyTreeNode {
  return {
    name: overrides.id,
    ageTier: "ADULT",
    active: true,
    canLogin: true,
    archived: false,
    cancelled: false,
    isRoot: false,
    generation: 0,
    relationship: {
      label: "Parent",
      derived: false,
      qualifier: null,
      description: `${overrides.id} relationship sentence.`,
    },
    linkToDisplayParent: null,
    email: `${overrides.id}@example.org`,
    emailRecipientCount: 0,
    notificationEmail: null,
    secondParentInline: null,
    partner: null,
    attachedPartner: null,
    familyGroups: [],
    children: [],
    ...overrides,
  };
}

function mockTreeFetch(tree: MemberFamilyTree | null, ok = true) {
  const fetchMock = vi.fn(async () => ({
    ok,
    json: async () => tree,
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MemberFamilyTreeCard", () => {
  it("renders the tree as nested lists with sr-only relationship sentences", async () => {
    const tree: MemberFamilyTree = {
      root: { id: "me", name: "Tom Whitcombe" },
      roots: [
        node({
          id: "sarah",
          name: "Sarah Whitcombe",
          generation: -1,
          relationship: {
            label: "Parent",
            derived: false,
            qualifier: null,
            description: "Sarah Whitcombe is Tom Whitcombe's recorded parent.",
          },
          emailRecipientCount: 2,
          children: [
            node({
              id: "me",
              name: "Tom Whitcombe",
              isRoot: true,
              linkToDisplayParent: "PRIMARY",
              relationship: {
                label: "This member",
                derived: false,
                qualifier: null,
                description: "Tom Whitcombe — the member you are viewing.",
              },
              notificationEmail: {
                sourceId: "sarah",
                sourceName: "Sarah Whitcombe",
                sourceRelationship: null,
                beyondDirectParent: false,
                inTree: true,
              },
              partner: { id: "kate", name: "Kate Rangi", attachedHere: true },
              attachedPartner: node({
                id: "kate",
                name: "Kate Rangi",
                relationship: {
                  label: "Partner",
                  derived: false,
                  qualifier: null,
                  description: "Kate Rangi is Tom Whitcombe's confirmed partner.",
                },
                familyGroups: [{ id: "g2", name: "Rangi whānau", billing: false }],
              }),
              children: [
                node({
                  id: "ella",
                  name: "Ella Whitcombe-Rangi",
                  generation: 1,
                  ageTier: "YOUTH",
                  canLogin: false,
                  linkToDisplayParent: "PRIMARY",
                  relationship: {
                    label: "Dependant",
                    derived: false,
                    qualifier: null,
                    description:
                      "Ella Whitcombe-Rangi is a recorded dependant of Tom Whitcombe.",
                  },
                  secondParentInline: { id: "kate", name: "Kate Rangi" },
                  notificationEmail: {
                    sourceId: "sarah",
                    sourceName: "Sarah Whitcombe",
                    sourceRelationship: "grandparent",
                    beyondDirectParent: true,
                    inTree: true,
                  },
                  familyGroups: [
                    { id: "g1", name: "Whitcombe family", billing: true },
                  ],
                }),
              ],
            }),
          ],
        }),
        node({
          id: "ruth",
          name: "Ruth Whitcombe",
          relationship: {
            label: "Sibling",
            derived: true,
            qualifier: null,
            description:
              "Ruth Whitcombe is Tom Whitcombe's sibling — worked out from the recorded parent links, not stored.",
          },
        }),
      ],
      memberCount: 5,
      generationSpan: 3,
      truncated: false,
      truncatedReason: null,
      hasDerivedRelationships: true,
    };
    mockTreeFetch(tree);

    render(
      <MemberFamilyTreeCard memberId="me" currentMemberPath="/admin/members/me" />,
    );

    await waitFor(() =>
      expect(screen.getByText("Sarah Whitcombe")).toBeInTheDocument(),
    );

    // sr-only relationship sentences are present for ordinary and attached nodes.
    expect(
      screen.getByText("Tom Whitcombe — the member you are viewing."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Kate Rangi is Tom Whitcombe's confirmed partner."),
    ).toBeInTheDocument();

    // Derived relationships are labelled and badged.
    expect(screen.getByText("Sibling")).toBeInTheDocument();
    expect(screen.getByText("Derived")).toBeInTheDocument();

    // Inherited club email names the person and the relationship.
    expect(
      screen.getByText(/Club email goes to Sarah Whitcombe · grandparent/),
    ).toBeInTheDocument();
    // ...but not when the source is the direct parent (badge suppressed).
    expect(
      screen.queryAllByText(/Club email goes to Sarah Whitcombe$/),
    ).toHaveLength(0);

    // Detail lines: second parent inline, recipient count, billing family chip.
    expect(screen.getByText(/Second parent: Kate Rangi/)).toBeInTheDocument();
    expect(
      screen.getByText(/Club email for 2 members in this tree/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Whitcombe family · billing family/),
    ).toBeInTheDocument();

    // Members link to their admin pages.
    const link = screen.getByRole("link", { name: "Ella Whitcombe-Rangi" });
    expect(link).toHaveAttribute(
      "href",
      expect.stringContaining("/admin/members/ella"),
    );

    // Plain nested lists: the dependant's list sits inside the parent's item.
    const ella = screen.getByText("Ella Whitcombe-Rangi").closest("li");
    const sarah = screen.getByText("Sarah Whitcombe").closest("li");
    expect(sarah).not.toBeNull();
    expect(ella).not.toBeNull();
    expect(sarah).toContainElement(ella);

    // Read-only: the card offers no buttons at all.
    expect(screen.queryAllByRole("button")).toHaveLength(0);

    // Indentation makes a deep family wider than a phone, and the card sits
    // inside overflow-hidden ancestors — so the list scrolls in its own
    // focusable, NAMED region rather than being clipped unreachably.
    const scroller = screen.getByRole("region", { name: "Family tree Read-only" });
    expect(scroller).toHaveAttribute("tabindex", "0");
    expect(scroller.className).toContain("overflow-x-auto");
    expect(scroller).toContainElement(screen.getByText("Sarah Whitcombe"));
  });

  it("discloses an incomplete parent record beside a half-sibling label", async () => {
    const tree: MemberFamilyTree = {
      root: { id: "me", name: "Tom Whitcombe" },
      roots: [
        node({
          id: "ruth",
          name: "Ruth Ngata",
          relationship: {
            label: "Half-sibling",
            derived: true,
            qualifier: "one parent not recorded for Ruth Ngata",
            description:
              "Ruth Ngata is Tom Whitcombe's half-sibling — worked out from the recorded parent links, not stored. Shares parent Sarah Whitcombe. One parent not recorded for Ruth Ngata.",
          },
          children: [node({ id: "me", name: "Tom Whitcombe", isRoot: true })],
        }),
      ],
      memberCount: 2,
      generationSpan: 1,
      truncated: false,
      truncatedReason: null,
      hasDerivedRelationships: true,
    };
    mockTreeFetch(tree);

    render(
      <MemberFamilyTreeCard memberId="me" currentMemberPath="/admin/members/me" />,
    );
    await waitFor(() =>
      expect(screen.getByText("Ruth Ngata")).toBeInTheDocument(),
    );

    // Visible, not sr-only: "Half-sibling" is socially loaded and the reason
    // has to reach the person reading the screen.
    expect(
      screen.getByText(
        /Half-sibling · one parent not recorded for Ruth Ngata/,
      ),
    ).toBeVisible();
  });

  it("never names an email-inheritance source from outside the tree", async () => {
    const tree: MemberFamilyTree = {
      root: { id: "kid", name: "Ella Rangi" },
      roots: [
        node({
          id: "kid",
          name: "Ella Rangi",
          isRoot: true,
          notificationEmail: {
            sourceId: null,
            sourceName: null,
            sourceRelationship: null,
            beyondDirectParent: true,
            inTree: false,
          },
        }),
      ],
      memberCount: 2,
      generationSpan: 1,
      truncated: false,
      truncatedReason: null,
      hasDerivedRelationships: false,
    };
    mockTreeFetch(tree);

    render(
      <MemberFamilyTreeCard memberId="kid" currentMemberPath="/admin/members/kid" />,
    );
    await waitFor(() =>
      expect(
        screen.getByText("Club email goes to a member outside this family tree"),
      ).toBeInTheDocument(),
    );
    // Nobody is named, and nothing links out to them.
    expect(screen.queryByText(/Club email goes to [A-Z]/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("link")).toHaveLength(1); // the member's own name
  });

  it.each([
    ["generations" as const, /more than three generations above or below/],
    ["size" as const, /this family is larger than the tree can show/],
    ["both" as const, /outside the generation limit or beyond the size/],
  ])(
    "words the truncation notice for a %s cap rather than always blaming generations",
    async (truncatedReason, expected) => {
      const tree: MemberFamilyTree = {
        root: { id: "me", name: "Me" },
        roots: [
          node({
            id: "me",
            name: "Me",
            isRoot: true,
            children: [node({ id: "kid", name: "Kid" })],
          }),
        ],
        memberCount: 150,
        generationSpan: 4,
        truncated: true,
        truncatedReason,
        hasDerivedRelationships: false,
      };
      mockTreeFetch(tree);

      render(
        <MemberFamilyTreeCard memberId="me" currentMemberPath="/admin/members/me" />,
      );
      await waitFor(() => expect(screen.getByText("Kid")).toBeInTheDocument());
      expect(screen.getByText(expected)).toBeInTheDocument();
    },
  );

  it("suppresses archived members' contact details and shows the archived badge", async () => {
    const tree: MemberFamilyTree = {
      root: { id: "me", name: "Me" },
      roots: [
        node({
          id: "gran",
          name: "Gran Archived",
          archived: true,
          cancelled: true,
          email: null,
          relationship: {
            label: "Grandparent",
            derived: true,
            qualifier: null,
            description:
              "Gran Archived is Me's grandparent — worked out from the recorded parent links, not stored. Archived member — contact details hidden.",
          },
          children: [node({ id: "me", name: "Me", isRoot: true })],
        }),
      ],
      memberCount: 2,
      generationSpan: 2,
      truncated: false,
      truncatedReason: null,
      hasDerivedRelationships: true,
    };
    mockTreeFetch(tree);

    render(
      <MemberFamilyTreeCard memberId="me" currentMemberPath="/admin/members/me" />,
    );
    await waitFor(() =>
      expect(screen.getByText("Gran Archived")).toBeInTheDocument(),
    );

    expect(screen.getByText("Archived")).toBeInTheDocument();
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
    expect(
      screen.getByText(/Contact details hidden while archived/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/gran@/)).not.toBeInTheDocument();
  });

  it("shows the empty state for a member with no links", async () => {
    const tree: MemberFamilyTree = {
      root: { id: "solo", name: "Solo" },
      roots: [node({ id: "solo", name: "Solo", isRoot: true })],
      memberCount: 1,
      generationSpan: 1,
      truncated: false,
      truncatedReason: null,
      hasDerivedRelationships: false,
    };
    mockTreeFetch(tree);

    render(
      <MemberFamilyTreeCard
        memberId="solo"
        currentMemberPath="/admin/members/solo"
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByText(/No family links yet\. Add a parent in Parent Links/),
      ).toBeInTheDocument(),
    );
  });

  it("shows an error message when the fetch fails", async () => {
    mockTreeFetch(null, false);
    render(
      <MemberFamilyTreeCard memberId="me" currentMemberPath="/admin/members/me" />,
    );
    await waitFor(() =>
      expect(
        screen.getByText("Failed to load the family tree"),
      ).toBeInTheDocument(),
    );
  });
});
