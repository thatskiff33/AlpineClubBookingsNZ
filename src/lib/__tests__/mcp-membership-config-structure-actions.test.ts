/**
 * ALP-720 (`INV-MCP-006`, #5305 comment 7111359405): the actions that shape
 * the club's membership structure (membership types, subscription
 * categories and induction checklist templates), each held to its contract
 * (`expectActionContract`): the connection gets exactly the action's
 * `returns` fields and the browser's answer is unchanged.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  prisma: {
    membershipType: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    membershipTypeAgeTier: { deleteMany: vi.fn(), createMany: vi.fn() },
    seasonalMembershipAssignment: { findMany: vi.fn(), updateMany: vi.fn() },
    subscriptionCategory: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    inductionChecklistTemplate: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    inductionChecklistSection: { deleteMany: vi.fn() },
    memberInduction: { count: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock,
  requireActiveSessionUser: vi.fn(async () => null),
}));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
  buildStructuredAuditLogCreateArgs: vi.fn(() => ({ data: {} })),
  getAuditRequestContext: vi.fn(() => ({})),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/club-time/server", () => ({ clubTimeZone: async () => "Pacific/Auckland" }));

import { POST as createType } from "@/app/api/admin/membership-types/route";
import { DELETE as deleteType, PATCH as updateType } from "@/app/api/admin/membership-types/[id]/route";
import { POST as mergeType } from "@/app/api/admin/membership-types/[id]/merge/route";
import { POST as reorderTypes } from "@/app/api/admin/membership-types/reorder/route";
import {
  GET as listCategories,
  POST as createCategory,
} from "@/app/api/admin/subscription-categories/route";
import {
  DELETE as deleteCategory,
  PATCH as updateCategory,
} from "@/app/api/admin/subscription-categories/[id]/route";
import { POST as createTemplate } from "@/app/api/admin/induction-templates/route";
import {
  DELETE as deleteTemplate,
  PATCH as activateTemplate,
  PUT as rewriteTemplate,
} from "@/app/api/admin/induction-templates/[id]/route";
import { expectActionContract, officerMemberSession } from "@/lib/__tests__/helpers/mcp-action-contract";

const at = new Date("2026-06-01T00:00:00.000Z");

/** A membership type row as the routes select it. */
function typeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "type-1",
    key: "SENIOR",
    name: "Senior",
    description: "Over 65",
    publicDescription: null,
    publiclyListed: true,
    isActive: true,
    isBuiltIn: false,
    bookingBehavior: "MEMBER_RATE",
    subscriptionBehavior: "REQUIRED",
    ageGroupsApply: true,
    sortOrder: 3,
    createdAt: at,
    updatedAt: at,
    allowedAgeTiers: [{ ageTier: "ADULT" }],
    _count: { assignments: 0, annualFees: 0 },
    ...overrides,
  };
}

const typeAnswer = {
  id: "type-1",
  key: "SENIOR",
  name: "Senior",
  description: "Over 65",
  publicDescription: null,
  publiclyListed: true,
  isActive: true,
  isBuiltIn: false,
  bookingBehavior: "MEMBER_RATE",
  subscriptionBehavior: "REQUIRED",
  ageGroupsApply: true,
  sortOrder: 3,
  assignmentCount: 0,
  allowedAgeTiers: ["ADULT"],
};

const categoryRow = {
  id: "cat-1",
  key: "FAMILY",
  name: "Family",
  description: null,
  isActive: true,
  isBuiltIn: false,
  sortOrder: 1,
  createdAt: at,
  updatedAt: at,
  _count: { assignments: 0, fees: 0 },
};

const templateRow = {
  id: "tpl-1",
  name: "New member induction",
  version: "2026",
  kind: "NEW_MEMBER",
  sourceLabel: null,
  isActive: false,
  legacySourceText: "never sent",
  sections: [
    {
      id: "sec-1",
      title: "Fire",
      description: null,
      priority: "EMERGENCY",
      sortOrder: 0,
      items: [
        {
          id: "item-1",
          label: "Find the extinguisher",
          competencyPrompt: null,
          notesPrompt: null,
          isMandatory: true,
          requiresDemonstration: false,
          sortOrder: 0,
          legacySourceText: null,
        },
      ],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue(officerMemberSession());
  h.prisma.$transaction.mockImplementation(async (run: unknown) =>
    typeof run === "function" ? run(h.prisma) : Promise.all(run as unknown[]),
  );
  h.prisma.membershipType.findFirst.mockResolvedValue(null);
  h.prisma.subscriptionCategory.findFirst.mockResolvedValue(null);
  h.prisma.memberInduction.count.mockResolvedValue(0);
});

describe("membership types", () => {
  it("create_membership_type creates a type and answers with its rules", async () => {
    h.prisma.membershipType.findUnique.mockResolvedValue(null);
    h.prisma.membershipType.create.mockResolvedValue(typeRow());
    h.prisma.membershipType.findUniqueOrThrow.mockResolvedValue(typeRow());
    const { connection } = await expectActionContract({
      actionId: "create_membership_type",
      handler: createType,
      args: { name: "Senior", bookingBehavior: "MEMBER_RATE", subscriptionBehavior: "REQUIRED", allowedAgeTiers: ["ADULT"] },
    });
    expect(connection).toEqual({ membershipType: typeAnswer });
  });

  it("update_membership_type changes only what it is sent", async () => {
    h.prisma.membershipType.findUnique.mockResolvedValue(typeRow());
    h.prisma.membershipType.update.mockResolvedValue(typeRow({ description: "65 and over" }));
    h.prisma.membershipType.findUniqueOrThrow.mockResolvedValue(typeRow({ description: "65 and over" }));
    const { connection } = await expectActionContract({
      actionId: "update_membership_type",
      handler: updateType,
      args: { id: "type-1", description: "65 and over" },
    });
    expect(connection).toEqual({ membershipType: { ...typeAnswer, description: "65 and over" } });
    expect(h.prisma.membershipType.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "type-1" }, data: { description: "65 and over" } }),
    );
  });

  it("delete_membership_type deletes an unused type", async () => {
    h.prisma.membershipType.findUnique.mockResolvedValue(typeRow());
    const { connection } = await expectActionContract({ actionId: "delete_membership_type", handler: deleteType, args: { id: "type-1" } });
    expect(connection).toEqual({ ok: true });
    expect(h.prisma.membershipType.delete).toHaveBeenCalledWith({ where: { id: "type-1" } });
  });

  it("merge_membership_type moves the members to the target and answers how many", async () => {
    h.prisma.membershipType.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      typeRow({ id: where.id }),
    );
    h.prisma.seasonalMembershipAssignment.findMany.mockResolvedValue([
      { id: "a-1", memberId: "member-2", seasonYear: 2026, member: { ageTier: "ADULT", role: "USER", accessRoles: [] } },
    ]);
    h.prisma.seasonalMembershipAssignment.updateMany.mockResolvedValue({ count: 1 });
    const { connection } = await expectActionContract({
      actionId: "merge_membership_type",
      handler: mergeType,
      args: { id: "type-1", targetId: "type-2" },
    });
    expect(connection).toEqual({ ok: true, reassignedCount: 1, sourceId: "type-1", targetId: "type-2" });
    expect(h.prisma.seasonalMembershipAssignment.updateMany).toHaveBeenCalledWith({
      where: { membershipTypeId: "type-1" },
      data: { membershipTypeId: "type-2" },
    });
  });

  it("reorder_membership_types answers with every type in its new order", async () => {
    h.prisma.membershipType.findMany.mockResolvedValue([typeRow()]);
    const { connection } = await expectActionContract({
      actionId: "reorder_membership_types",
      handler: reorderTypes,
      args: { orderedIds: ["type-1"] },
    });
    expect(connection).toEqual({ membershipTypes: [typeAnswer] });
    expect(h.prisma.membershipType.update).toHaveBeenCalledWith({ where: { id: "type-1" }, data: { sortOrder: 0 } });
  });
});

describe("subscription categories", () => {
  const categoryAnswer = {
    id: "cat-1",
    key: "FAMILY",
    name: "Family",
    description: null,
    isActive: true,
    isBuiltIn: false,
    sortOrder: 1,
    assignmentCount: 0,
    feeCount: 0,
  };

  it("list_subscription_categories sends each category with its counts", async () => {
    h.prisma.subscriptionCategory.findMany.mockResolvedValue([categoryRow]);
    const { connection } = await expectActionContract({ actionId: "list_subscription_categories", handler: listCategories, args: {} });
    expect(connection).toEqual({ subscriptionCategories: [categoryAnswer] });
  });

  it("create_subscription_category creates one", async () => {
    h.prisma.subscriptionCategory.findUnique.mockResolvedValue(null);
    h.prisma.subscriptionCategory.create.mockResolvedValue(categoryRow);
    const { connection } = await expectActionContract({
      actionId: "create_subscription_category",
      handler: createCategory,
      args: { name: "Family" },
    });
    expect(connection).toEqual({ subscriptionCategory: categoryAnswer });
  });

  it("update_subscription_category changes only what it is sent", async () => {
    h.prisma.subscriptionCategory.findUnique.mockResolvedValue(categoryRow);
    h.prisma.subscriptionCategory.update.mockResolvedValue({ ...categoryRow, sortOrder: 4 });
    const { connection } = await expectActionContract({
      actionId: "update_subscription_category",
      handler: updateCategory,
      args: { id: "cat-1", sortOrder: 4 },
    });
    expect(connection).toEqual({ subscriptionCategory: { ...categoryAnswer, sortOrder: 4 } });
  });

  it("delete_subscription_category deletes an unused one", async () => {
    h.prisma.subscriptionCategory.findUnique.mockResolvedValue(categoryRow);
    const { connection } = await expectActionContract({
      actionId: "delete_subscription_category",
      handler: deleteCategory,
      args: { id: "cat-1" },
    });
    expect(connection).toEqual({ ok: true });
    expect(h.prisma.subscriptionCategory.delete).toHaveBeenCalledWith({ where: { id: "cat-1" } });
  });
});

describe("induction checklist templates", () => {
  const templateAnswer = {
    id: "tpl-1",
    name: "New member induction",
    version: "2026",
    kind: "NEW_MEMBER",
    sourceLabel: null,
    isActive: false,
    sections: [
      {
        id: "sec-1",
        title: "Fire",
        description: null,
        priority: "EMERGENCY",
        sortOrder: 0,
        items: [
          {
            id: "item-1",
            label: "Find the extinguisher",
            competencyPrompt: null,
            notesPrompt: null,
            isMandatory: true,
            requiresDemonstration: false,
            sortOrder: 0,
          },
        ],
      },
    ],
  };

  it("create_induction_template creates an inactive template", async () => {
    h.prisma.inductionChecklistTemplate.create.mockResolvedValue(templateRow);
    const { connection } = await expectActionContract({
      actionId: "create_induction_template",
      handler: createTemplate,
      args: { name: "New member induction", version: "2026" },
    });
    expect(connection).toEqual({ template: templateAnswer });
    expect(h.prisma.inductionChecklistTemplate.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isActive: false, kind: "NEW_MEMBER" }) }),
    );
  });

  it("update_induction_template replaces the checklist of an unused template", async () => {
    h.prisma.inductionChecklistTemplate.findUnique.mockResolvedValue(templateRow);
    const { connection } = await expectActionContract({
      actionId: "update_induction_template",
      handler: rewriteTemplate,
      args: {
        id: "tpl-1",
        sections: [{ title: "Fire", priority: "EMERGENCY", items: [{ label: "Find the extinguisher", isMandatory: true }] }],
      },
    });
    expect(connection).toEqual({ template: templateAnswer });
    expect(h.prisma.inductionChecklistSection.deleteMany).toHaveBeenCalledWith({ where: { templateId: "tpl-1" } });
  });

  it("activate_induction_template makes it the one in use for its kind", async () => {
    h.prisma.inductionChecklistTemplate.findUnique.mockResolvedValue({ id: "tpl-1", kind: "NEW_MEMBER" });
    const { connection } = await expectActionContract({
      actionId: "activate_induction_template",
      handler: activateTemplate,
      args: { id: "tpl-1" },
    });
    expect(connection).toEqual({ ok: true });
    expect(h.prisma.inductionChecklistTemplate.updateMany).toHaveBeenCalledWith({
      where: { id: { not: "tpl-1" }, kind: "NEW_MEMBER" },
      data: { isActive: false },
    });
  });

  it("delete_induction_template deletes an inactive, unused template", async () => {
    h.prisma.inductionChecklistTemplate.findUnique.mockResolvedValue({ id: "tpl-1", isActive: false });
    const { connection } = await expectActionContract({
      actionId: "delete_induction_template",
      handler: deleteTemplate,
      args: { id: "tpl-1" },
    });
    expect(connection).toEqual({ ok: true });
    expect(h.prisma.inductionChecklistTemplate.delete).toHaveBeenCalledWith({ where: { id: "tpl-1" } });
  });
});
