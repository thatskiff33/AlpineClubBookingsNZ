/**
 * ALP-720 (`INV-MCP-006`): the committee, induction and induction checklist
 * actions an officer's AI app connection may run, each held to its contract
 * (`expectActionContract`): the connection gets exactly the action's
 * `returns` fields and the browser's answer is unchanged.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  prisma: {
    committeeRole: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    committeeAssignment: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    member: { findUnique: vi.fn(), findMany: vi.fn() },
    memberInduction: { findMany: vi.fn(), count: vi.fn() },
    memberInductionAssignedSigner: { updateMany: vi.fn() },
    inductionChecklistTemplate: { findMany: vi.fn(), findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  },
  induction: {
    createMemberInduction: vi.fn(),
    getInductionById: vi.fn(),
    overrideCompleteInduction: vi.fn(),
    reassignInductionSigners: vi.fn(),
    voidInduction: vi.fn(),
  },
  sendSignOffEmail: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock,
  requireActiveSessionUser: vi.fn(async () => null),
}));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/audit", () => ({
  buildStructuredAuditLogCreateArgs: vi.fn(() => ({ data: {} })),
  getAuditRequestContext: vi.fn(() => ({})),
  logAudit: vi.fn(),
}));
vi.mock("@/lib/committee-booking-officer-sync", () => ({ syncBookingOfficerForRole: vi.fn() }));
vi.mock("@/lib/induction", () => ({
  ...h.induction,
  InductionError: class InductionError extends Error {
    status = 400;
  },
}));
vi.mock("@/lib/email", () => ({ sendInductionSignOffRequestEmail: h.sendSignOffEmail }));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { GET as listRoles, POST as createRole } from "@/app/api/admin/committee/roles/route";
import { DELETE as deleteRole, PATCH as updateRole } from "@/app/api/admin/committee/roles/[id]/route";
import { GET as listAssignments, POST as assignRole } from "@/app/api/admin/committee/assignments/route";
import {
  DELETE as deactivateAssignment,
  PATCH as updateAssignment,
} from "@/app/api/admin/committee/assignments/[id]/route";
import { GET as listInductions, POST as createInduction } from "@/app/api/admin/inductions/route";
import { GET as getInduction, PATCH as patchInduction } from "@/app/api/admin/inductions/[id]/route";
import { GET as listTemplates } from "@/app/api/admin/induction-templates/route";
import { GET as getTemplate } from "@/app/api/admin/induction-templates/[id]/route";
import { expectActionContract, officerMemberSession } from "@/lib/__tests__/helpers/mcp-action-contract";
import { MCP_ACTIONS } from "@/lib/mcp/catalogue";

const at = new Date("2026-06-01T00:00:00.000Z");

/** A committee role as the routes select it. */
const roleRow = {
  id: "role-1",
  key: "treasurer",
  name: "Treasurer",
  description: "Keeps the books",
  contactEmail: "treasurer@club.example",
  isActive: true,
  sortOrder: 2,
  createdAt: at,
  updatedAt: at,
  _count: { assignments: 1 },
};

/** A committee assignment as the routes select it, with fields no action returns. */
const assignmentRow = {
  id: "assignment-1",
  memberId: "member-2",
  committeeRoleId: "role-1",
  blurb: "Ana keeps our accounts.",
  sortOrder: 0,
  published: true,
  showPhone: false,
  contactable: true,
  contactEmailMode: "ROLE",
  contactEmailOverride: "ana.custom@example.test",
  isActive: true,
  assignedByMemberId: "officer-1",
  createdAt: at,
  updatedAt: at,
  committeeRole: roleRow,
  member: {
    id: "member-2",
    firstName: "Ana",
    lastName: "Hale",
    email: "ana@example.test",
    phoneCountryCode: "+64",
    phoneAreaCode: "21",
    phoneNumber: "555 0101",
    role: "ADMIN",
    active: true,
  },
  assignedBy: { id: "officer-1", firstName: "Olive", lastName: "Reid", email: "olive@example.test" },
};

const person = (id: string, firstName: string, lastName: string) => ({ id, firstName, lastName });

const checklistSection = {
  id: "section-1",
  templateId: "template-1",
  title: "Fire safety",
  description: "Where the extinguishers are",
  priority: "EMERGENCY",
  sortOrder: 0,
  items: [
    {
      id: "item-1",
      sectionId: "section-1",
      label: "Shows the fire exits",
      competencyPrompt: "Walk the exits",
      notesPrompt: "Any concerns",
      isMandatory: true,
      requiresDemonstration: true,
      sortOrder: 0,
      legacySourceText: "old text",
    },
  ],
};

const templateRow = {
  id: "template-1",
  name: "New member induction",
  version: "2026.1",
  kind: "NEW_MEMBER",
  sourceLabel: "Club handbook",
  isActive: true,
  createdAt: at,
  updatedAt: at,
  sections: [checklistSection],
};

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue(officerMemberSession());
  h.prisma.$transaction.mockImplementation(async (run: (tx: typeof h.prisma) => unknown) => run(h.prisma));
});

describe("committee roles", () => {
  it("lists the roles with their assignment counts", async () => {
    h.prisma.committeeRole.findMany.mockResolvedValue([roleRow]);

    const { connection, browser } = await expectActionContract({ actionId: "list_committee_roles", handler: listRoles });

    expect(connection).toEqual({
      roles: [
        {
          id: "role-1",
          key: "treasurer",
          name: "Treasurer",
          description: "Keeps the books",
          contactEmail: "treasurer@club.example",
          isActive: true,
          sortOrder: 2,
          assignmentCount: 1,
        },
      ],
    });
    expect(browser).toMatchObject({ roles: [{ createdAt: at.toISOString() }] });
  });

  it("adds a role and answers with it", async () => {
    h.prisma.committeeRole.findUnique.mockResolvedValue(null);
    h.prisma.committeeRole.findFirst.mockResolvedValue({ sortOrder: 1 });
    h.prisma.committeeRole.create.mockResolvedValue(roleRow);

    const { connection } = await expectActionContract({
      actionId: "create_committee_role",
      handler: createRole,
      args: { name: "Treasurer", contactEmail: "treasurer@club.example" },
    });

    expect(connection).toMatchObject({ role: { id: "role-1", assignmentCount: 1 } });
    expect(h.prisma.committeeRole.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ key: "treasurer", sortOrder: 2, isActive: true }) }),
    );
  });

  it("archives a role", async () => {
    h.prisma.committeeRole.findUnique.mockResolvedValue(roleRow);
    h.prisma.committeeRole.update.mockResolvedValue({ ...roleRow, isActive: false });

    const { connection } = await expectActionContract({
      actionId: "update_committee_role",
      handler: updateRole,
      args: { id: "role-1", isActive: false },
    });

    expect(connection).toMatchObject({ role: { isActive: false } });
    expect(h.prisma.committeeRole.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "role-1" }, data: { isActive: false } }),
    );
  });

  it("deletes a role that never had an assignment", async () => {
    h.prisma.committeeRole.findUnique.mockResolvedValue({ ...roleRow, _count: { assignments: 0 } });

    const { connection } = await expectActionContract({
      actionId: "delete_committee_role",
      handler: deleteRole,
      args: { id: "role-1" },
    });

    expect(connection).toEqual({ ok: true });
    expect(h.prisma.committeeRole.delete).toHaveBeenCalledWith({ where: { id: "role-1" } });
  });
});

describe("committee assignments", () => {
  const expectedAssignment = {
    id: "assignment-1",
    memberId: "member-2",
    committeeRoleId: "role-1",
    blurb: "Ana keeps our accounts.",
    sortOrder: 0,
    published: true,
    showPhone: false,
    contactable: true,
    contactEmailMode: "ROLE",
    contactEmailOverride: "ana.custom@example.test",
    isActive: true,
    updatedAt: at.toISOString(),
    committeeRole: { id: "role-1", name: "Treasurer", isActive: true },
    member: {
      id: "member-2",
      firstName: "Ana",
      lastName: "Hale",
      email: "ana@example.test",
      phone: "+64 21 555 0101",
      active: true,
    },
    assignedBy: { id: "officer-1", displayName: "Olive Reid" },
  };

  it("lists holders without their access role, phone parts or the assigning officer's email", async () => {
    h.prisma.committeeAssignment.findMany.mockResolvedValue([assignmentRow]);

    const { connection, browser } = await expectActionContract({
      actionId: "list_committee_assignments",
      handler: listAssignments,
      args: { committeeRoleId: "role-1", includeInactive: "1" },
    });

    expect(connection).toEqual({ assignments: [expectedAssignment] });
    expect(browser).toMatchObject({ assignments: [{ member: { role: "ADMIN" } }] });
    expect(h.prisma.committeeAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { committeeRoleId: "role-1" } }),
    );
  });

  it("refuses a list filter the schema does not know", async () => {
    const response = await listAssignments(
      new Request("https://club.example.test/api/admin/committee/assignments?includeInactive=yes"),
    );
    expect(response.status).toBe(400);
  });

  it("gives a member a role with the defaults for what was left out", async () => {
    h.prisma.member.findUnique.mockResolvedValue({ id: "member-2", firstName: "Ana", lastName: "Hale", email: "ana@example.test" });
    h.prisma.committeeRole.findUnique.mockResolvedValue({ id: "role-1", name: "Treasurer", isActive: true });
    h.prisma.committeeAssignment.findUnique.mockResolvedValue(null);
    h.prisma.committeeAssignment.create.mockResolvedValue(assignmentRow);

    const { connection } = await expectActionContract({
      actionId: "assign_committee_role",
      handler: assignRole,
      args: { memberId: "member-2", committeeRoleId: "role-1" },
    });

    expect(connection).toEqual({ assignment: expectedAssignment });
    expect(h.prisma.committeeAssignment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ published: false, showPhone: false, contactEmailMode: "ROLE", isActive: true }),
      }),
    );
  });

  it("changes one field of an assignment and keeps the rest", async () => {
    h.prisma.committeeAssignment.findUnique.mockResolvedValue(assignmentRow);
    h.prisma.committeeAssignment.update.mockResolvedValue({ ...assignmentRow, showPhone: true });

    const { connection } = await expectActionContract({
      actionId: "update_committee_assignment",
      handler: updateAssignment,
      args: { id: "assignment-1", showPhone: true },
    });

    expect(connection).toMatchObject({ assignment: { showPhone: true } });
    expect(h.prisma.committeeAssignment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "assignment-1" },
        data: { assignedBy: { connect: { id: "officer-1" } }, showPhone: true },
      }),
    );
  });

  it("deactivates an assignment and takes it off the public page", async () => {
    h.prisma.committeeAssignment.findUnique.mockResolvedValue(assignmentRow);
    h.prisma.committeeAssignment.update.mockResolvedValue({ ...assignmentRow, isActive: false, published: false });

    const { connection } = await expectActionContract({
      actionId: "deactivate_committee_assignment",
      handler: deactivateAssignment,
      args: { id: "assignment-1" },
    });

    expect(connection).toMatchObject({ assignment: { isActive: false, published: false } });
    expect(h.prisma.committeeAssignment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isActive: false, published: false, showPhone: false, contactable: false }),
      }),
    );
  });
});

describe("inductions", () => {
  it("lists the register", async () => {
    h.prisma.memberInduction.findMany.mockResolvedValue([
      {
        id: "induction-1",
        memberId: "member-2",
        templateId: "template-1",
        kind: "NEW_MEMBER",
        status: "IN_PROGRESS",
        requiredSignOffs: 2,
        completedAt: at,
        completionSource: "SIGN_OFFS",
        finalComments: "internal",
        createdAt: at,
        member: { ...person("member-2", "Ana", "Hale"), email: "ana@example.test", ageTier: "ADULT" },
        _count: { signOffs: 1 },
        assignedSigners: [
          { memberId: "member-3", emailSentAt: at, member: { ...person("member-3", "Kai", "Ngata"), email: "kai@example.test" } },
        ],
      },
    ]);

    const { connection } = await expectActionContract({
      actionId: "list_inductions",
      handler: listInductions,
      args: { status: "IN_PROGRESS", search: "ana" },
    });

    expect(connection).toMatchObject({
      inductions: [{ id: "induction-1", signOffCount: 1, assignedSigners: [{ memberId: "member-3", email: "kai@example.test" }] }],
    });
    expect(h.prisma.memberInduction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: "IN_PROGRESS" }) }),
    );
  });

  it("shows one induction with its checklist and sign-offs", async () => {
    h.induction.getInductionById.mockResolvedValue({
      id: "induction-1",
      memberId: "member-2",
      templateId: "template-1",
      applicationId: "application-1",
      kind: "NEW_MEMBER",
      status: "IN_PROGRESS",
      requiredSignOffs: 2,
      inductionDate: at,
      completedAt: at,
      completionSource: "SIGN_OFFS",
      finalComments: "Well done",
      voidedReason: "n/a",
      createdByMemberId: "officer-1",
      createdAt: at,
      updatedAt: at,
      member: person("member-2", "Ana", "Hale"),
      template: templateRow,
      signOffs: [
        {
          id: "signoff-1",
          inductionId: "induction-1",
          signerMemberId: "member-3",
          signerName: "Kai Ngata",
          signerRole: "NOMINATOR",
          declarationAccepted: true,
          comments: "Ready",
          signedAt: at,
        },
      ],
      application: { nominator1Id: "member-3", nominator2Id: "member-4" },
      assignedSigners: [
        { id: "signer-1", inductionId: "induction-1", memberId: "member-3", emailSentAt: at, createdAt: at, member: person("member-3", "Kai", "Ngata") },
      ],
    });

    const { connection } = await expectActionContract({
      actionId: "get_admin_induction",
      handler: getInduction,
      args: { id: "induction-1" },
    });

    expect(connection).toMatchObject({
      induction: { id: "induction-1", template: { sections: [{ items: [{ label: "Shows the fire exits" }] }] } },
      declaration: expect.any(String),
    });
    expect(h.induction.getInductionById).toHaveBeenCalledWith("induction-1");
  });

  it("starts an induction and emails its assigned signers", async () => {
    h.prisma.member.findUnique.mockResolvedValue({ id: "member-2", firstName: "Ana", lastName: "Hale" });
    h.prisma.member.findMany.mockResolvedValue([{ ...person("member-3", "Kai", "Ngata"), email: "kai@example.test" }]);
    h.induction.createMemberInduction.mockResolvedValue({
      id: "induction-1",
      memberId: "member-2",
      templateId: "template-1",
      applicationId: null,
      kind: "RE_INDUCTION",
      status: "IN_PROGRESS",
      requiredSignOffs: 2,
      createdByMemberId: "officer-1",
      createdAt: at,
      updatedAt: at,
    });

    const { connection } = await expectActionContract({
      actionId: "create_induction",
      handler: createInduction,
      args: { memberId: "member-2", signerMemberIds: ["member-3"] },
    });

    expect(connection).toMatchObject({ induction: { id: "induction-1", kind: "RE_INDUCTION" } });
    expect(h.induction.createMemberInduction).toHaveBeenCalledWith({
      memberId: "member-2",
      kind: "RE_INDUCTION",
      createdByMemberId: "officer-1",
      signerMemberIds: ["member-3"],
    });
    expect(h.sendSignOffEmail).toHaveBeenCalledWith(expect.objectContaining({ email: "kai@example.test" }));
  });

  it("reassigns signers and voids through the route's own action switch", async () => {
    await expectActionContract({
      actionId: "reassign_induction_signers",
      handler: patchInduction,
      args: { id: "induction-1", signerMemberIds: ["member-4"] },
    });
    expect(h.induction.reassignInductionSigners).toHaveBeenCalledWith({
      inductionId: "induction-1",
      adminMemberId: "officer-1",
      signerMemberIds: ["member-4"],
    });

    const { connection } = await expectActionContract({
      actionId: "void_induction",
      handler: patchInduction,
      args: { id: "induction-1", reason: "Started by mistake" },
    });
    expect(connection).toEqual({ ok: true });
    expect(h.induction.voidInduction).toHaveBeenCalledWith({
      inductionId: "induction-1",
      adminMemberId: "officer-1",
      reason: "Started by mistake",
    });
    expect(h.induction.overrideCompleteInduction).not.toHaveBeenCalled();
  });

  it("never offers completing an induction without its sign-offs", () => {
    const pinned = MCP_ACTIONS.filter((action) => action.path === "/api/admin/inductions/[id]" && action.method === "PATCH");
    expect(pinned.map((action) => action.fixedBody?.action).sort()).toEqual(["REASSIGN_SIGNERS", "VOID"]);
  });
});

describe("induction checklists", () => {
  it("lists the templates", async () => {
    h.prisma.inductionChecklistTemplate.findMany.mockResolvedValue([
      { ...templateRow, _count: { inductions: 3, sections: 1 } },
    ]);

    const { connection } = await expectActionContract({ actionId: "list_induction_templates", handler: listTemplates });

    expect(connection).toMatchObject({ templates: [{ id: "template-1", sectionCount: 1, inductionCount: 3 }] });
  });

  it("shows one template's sections and items", async () => {
    h.prisma.inductionChecklistTemplate.findUnique.mockResolvedValue(templateRow);
    h.prisma.memberInduction.count.mockResolvedValue(3);

    const { connection } = await expectActionContract({
      actionId: "get_induction_template",
      handler: getTemplate,
      args: { id: "template-1" },
    });

    expect(connection).toMatchObject({ template: { sections: [{ title: "Fire safety" }] }, used: true });
  });
});
