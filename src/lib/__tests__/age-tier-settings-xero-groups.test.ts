import { describe, expect, it } from "vitest";
import {
  applyPrimaryXeroContactGroupSelection,
  buildAvailableAcceptedXeroContactGroups,
} from "@/lib/age-tier-settings-xero-groups";

describe("age-tier settings Xero group helpers", () => {
  const settings = [
    {
      tier: "INFANT" as const,
      xeroContactGroupId: "group-infant",
      xeroContactGroupName: "Infant Members",
      xeroAcceptedContactGroups: [
        {
          groupId: "group-family",
          groupName: "Family Memberships",
        },
      ],
    },
    {
      tier: "CHILD" as const,
      xeroContactGroupId: "group-child",
      xeroContactGroupName: "Child Members",
      xeroAcceptedContactGroups: [
        {
          groupId: "group-life",
          groupName: "Life Members",
        },
        {
          groupId: "group-legacy",
          groupName: "Legacy Manual Group",
        },
      ],
    },
    {
      tier: "YOUTH" as const,
      xeroContactGroupId: "group-youth",
      xeroContactGroupName: "Youth Members",
      xeroAcceptedContactGroups: [],
    },
    {
      tier: "ADULT" as const,
      xeroContactGroupId: "group-adult",
      xeroContactGroupName: "Adult Members",
      xeroAcceptedContactGroups: [],
    },
  ];

  const xeroGroups = [
    {
      id: "group-infant",
      name: "Infant Members",
      contactCount: 12,
    },
    {
      id: "group-child",
      name: "Child Members",
      contactCount: 18,
    },
    {
      id: "group-youth",
      name: "Youth Members",
      contactCount: 14,
    },
    {
      id: "group-adult",
      name: "Adult Members",
      contactCount: 24,
    },
    {
      id: "group-family",
      name: "Family Memberships",
      contactCount: 7,
    },
    {
      id: "group-life",
      name: "Life Members",
      contactCount: 3,
    },
  ];

  it("excludes every primary age-tier group from additional accepted options", () => {
    expect(
      buildAvailableAcceptedXeroContactGroups(settings, "CHILD", xeroGroups)
    ).toEqual([
      {
        id: "group-family",
        name: "Family Memberships",
        contactCount: 7,
      },
      {
        id: "group-legacy",
        name: "Legacy Manual Group",
        contactCount: 0,
      },
      {
        id: "group-life",
        name: "Life Members",
        contactCount: 3,
      },
    ]);
  });

  it("removes a newly-selected primary group from accepted groups on every tier", () => {
    expect(
      applyPrimaryXeroContactGroupSelection(settings, "ADULT", {
        id: "group-life",
        name: "Life Members",
      })
    ).toEqual([
      settings[0],
      {
        ...settings[1],
        xeroAcceptedContactGroups: [
          {
            groupId: "group-legacy",
            groupName: "Legacy Manual Group",
          },
        ],
      },
      settings[2],
      {
        ...settings[3],
        xeroContactGroupId: "group-life",
        xeroContactGroupName: "Life Members",
      },
    ]);
  });

  it("clears accepted groups when a tier is unmapped from its primary group", () => {
    expect(
      applyPrimaryXeroContactGroupSelection(settings, "CHILD", null)
    ).toEqual([
      settings[0],
      {
        ...settings[1],
        xeroContactGroupId: null,
        xeroContactGroupName: null,
        xeroAcceptedContactGroups: [],
      },
      settings[2],
      settings[3],
    ]);
  });
});
