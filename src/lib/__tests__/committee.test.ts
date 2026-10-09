import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) =>
      callback((await import("@/lib/prisma")).prisma)
    ),
    member: { count: vi.fn(), findUnique: vi.fn() },
    committeeRole: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    committeeAssignment: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    // Booking Officer → OtherLodge sync (runs inside the assignment routes'
    // transaction). Default to no lodges and no owned-lodge list (#52: the sync
    // reads the settings row first) so it is a harmless no-op here; the sync
    // itself is covered by committee-booking-officer-sync.test.ts.
    serverNzSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    lodge: { findMany: vi.fn().mockResolvedValue([]) },
    otherLodge: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
    },
    publicContentSettings: { findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
const mockRequireActiveSessionUser = vi.fn<(...args: unknown[]) => Promise<Response | null>>(async () => null);
vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock"))
    .evaluateRequireAdminMock,
  requireActiveSessionUser: (...args: Parameters<typeof mockRequireActiveSessionUser>) => mockRequireActiveSessionUser(...args),
}));
vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
  buildStructuredAuditLogCreateArgs: vi.fn((event) => ({ data: event })),
  getAuditRequestContext: vi.fn(() => ({
    id: null,
    ipAddress: "unknown",
    userAgent: null,
  })),
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: vi.fn().mockReturnValue(null),
  rateLimiters: { contact: { limit: 10, windowSeconds: 3600, prefix: "contact" } },
}));
vi.mock("@/lib/email-templates/escape", () => ({
  escapeHtml: vi.fn((s: string) => s),
}));

// The contact route resolves its default recipient DB-first from
// EmailMessageSetting.contactEmail (C6 #1985), no longer the static
// CLUB_CONTACT_EMAIL club-identity constant. A distinct sentinel proves the
// route uses the resolved (DB) value, not a config/bootstrap default.
const { DEFAULT_CONTACT_EMAIL } = vi.hoisted(() => ({
  DEFAULT_CONTACT_EMAIL: "committee-inbox@club.test",
}));
vi.mock("@/lib/email-message-settings", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadEmailMessageSettings: vi.fn(async () => ({
    contactEmail: DEFAULT_CONTACT_EMAIL,
  })),
}));

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { sendEmail } from "@/lib/email";
import logger from "@/lib/logger";
import { GET as listRoles, POST as createRole } from "@/app/api/admin/committee/roles/route";
import { PATCH as updateRole, DELETE as deleteRole } from "@/app/api/admin/committee/roles/[id]/route";
import { GET as listAssignments, POST as createAssignment } from "@/app/api/admin/committee/assignments/route";
import { PATCH as updateAssignment, DELETE as deleteAssignment } from "@/app/api/admin/committee/assignments/[id]/route";

const mockedAuth = vi.mocked(auth);

const adminSession = { user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } } as any;

const sampleRole = {
  id: "role1",
  key: "president",
  name: "President",
  description: "Chairs meetings.",
  contactEmail: "president@example.org",
  isActive: true,
  sortOrder: 0,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  _count: { assignments: 2 },
};

const sampleAssignment = {
  id: "assign1",
  memberId: "member1",
  committeeRoleId: "role1",
  blurb: "Current president.",
  sortOrder: 0,
  published: false,
  showPhone: false,
  contactable: false,
  isActive: true,
  assignedByMemberId: "admin1",
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  committeeRole: sampleRole,
  member: {
    id: "member1",
    firstName: "Alex",
    lastName: "Admin",
    email: "alex@example.org",
    phoneCountryCode: "64",
    phoneAreaCode: "21",
    phoneNumber: "123456",
    role: "ADMIN",
    active: true,
  },
  assignedBy: {
    id: "admin1",
    firstName: "Root",
    lastName: "Admin",
    email: "root@example.org",
  },
};

describe("Committee Master Role API", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const makeParams = (id: string) => Promise.resolve({ id });

  it("lists reusable committee roles for admins", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.committeeRole.findMany).mockResolvedValue([sampleRole] as any);

    const res = await listRoles();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.roles).toHaveLength(1);
    expect(body.roles[0]).toMatchObject({
      id: "role1",
      key: "president",
      name: "President",
      contactEmail: "president@example.org",
      assignmentCount: 2,
    });
  });

  it("creates a committee role with a unique key and audit record", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.committeeRole.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.committeeRole.findFirst).mockResolvedValue({ sortOrder: 4 } as any);
    vi.mocked(prisma.committeeRole.create).mockResolvedValue({
      ...sampleRole,
      id: "role2",
      key: "trip-leader",
      name: "Trip Leader",
      contactEmail: "trips@example.org",
      sortOrder: 5,
      _count: { assignments: 0 },
    } as any);

    const req = new NextRequest("http://localhost/api/admin/committee/roles", {
      method: "POST",
      body: JSON.stringify({
        name: "Trip Leader",
        description: "Trips",
        contactEmail: " Trips@Example.Org ",
      }),
    });

    const res = await createRole(req);
    expect(res.status).toBe(201);
    expect(prisma.committeeRole.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          key: "trip-leader",
          name: "Trip Leader",
          contactEmail: "trips@example.org",
          sortOrder: 5,
        }),
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledOnce();
  });

  it("archives committee roles instead of adding committee to Member.role", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.committeeRole.findUnique).mockResolvedValue(sampleRole as any);
    vi.mocked(prisma.committeeRole.update).mockResolvedValue({
      ...sampleRole,
      isActive: false,
    } as any);

    const req = new NextRequest("http://localhost/api/admin/committee/roles/role1", {
      method: "PATCH",
      body: JSON.stringify({ isActive: false }),
    });
    const res = await updateRole(req, { params: makeParams("role1") });

    expect(res.status).toBe(200);
    expect(prisma.committeeRole.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "role1" },
        data: expect.objectContaining({ isActive: false }),
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledOnce();
  });

  it("blocks deleting roles that have assignments", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.committeeRole.findUnique).mockResolvedValue(sampleRole as any);

    const req = new NextRequest("http://localhost/api/admin/committee/roles/role1", {
      method: "DELETE",
    });
    const res = await deleteRole(req, { params: makeParams("role1") });

    expect(res.status).toBe(409);
    expect(prisma.committeeRole.delete).not.toHaveBeenCalled();
  });
});

describe("Committee Assignment API", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const makeParams = (id: string) => Promise.resolve({ id });

  it("lists member-linked committee assignments without changing public committee source", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.committeeAssignment.findMany).mockResolvedValue([
      sampleAssignment,
    ] as any);

    const req = new NextRequest(
      "http://localhost/api/admin/committee/assignments?includeInactive=1",
    );
    const res = await listAssignments(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.assignments[0]).toMatchObject({
      id: "assign1",
      committeeRoleId: "role1",
      member: { displayName: "Alex Admin" },
      committeeRole: { name: "President" },
    });
  });

  it("creates initially hidden assignments and allows multiple members per role", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "member1",
      firstName: "Alex",
      lastName: "Admin",
      email: "alex@example.org",
    } as any);
    vi.mocked(prisma.committeeRole.findUnique).mockResolvedValue({
      id: "role1",
      name: "President",
      isActive: true,
    } as any);
    vi.mocked(prisma.committeeAssignment.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.committeeAssignment.create).mockResolvedValue(sampleAssignment as any);

    const req = new NextRequest("http://localhost/api/admin/committee/assignments", {
      method: "POST",
      body: JSON.stringify({
        memberId: "member1",
        committeeRoleId: "role1",
        blurb: "Current president.",
      }),
    });
    const res = await createAssignment(req);

    expect(res.status).toBe(201);
    expect(prisma.committeeAssignment.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          memberId_committeeRoleId: {
            memberId: "member1",
            committeeRoleId: "role1",
          },
        },
      }),
    );
    expect(prisma.committeeAssignment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          memberId: "member1",
          committeeRoleId: "role1",
          published: false,
          showPhone: false,
          contactable: false,
        }),
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledOnce();
  });

  it("updates an existing member-role assignment instead of duplicating it", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "member1",
      firstName: "Alex",
      lastName: "Admin",
      email: "alex@example.org",
    } as any);
    vi.mocked(prisma.committeeRole.findUnique).mockResolvedValue({
      id: "role1",
      name: "President",
      isActive: true,
    } as any);
    vi.mocked(prisma.committeeAssignment.findUnique).mockResolvedValue(
      sampleAssignment as any,
    );
    vi.mocked(prisma.committeeAssignment.update).mockResolvedValue({
      ...sampleAssignment,
      published: true,
    } as any);

    const req = new NextRequest("http://localhost/api/admin/committee/assignments", {
      method: "POST",
      body: JSON.stringify({
        memberId: "member1",
        committeeRoleId: "role1",
        published: true,
      }),
    });
    const res = await createAssignment(req);

    expect(res.status).toBe(201);
    expect(prisma.committeeAssignment.create).not.toHaveBeenCalled();
    expect(prisma.committeeAssignment.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "assign1" } }),
    );
  });

  it("deactivates assignments and clears public/contact flags", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.committeeAssignment.findUnique).mockResolvedValue({
      ...sampleAssignment,
      published: true,
      showPhone: true,
      contactable: true,
    } as any);
    vi.mocked(prisma.committeeAssignment.update).mockResolvedValue({
      ...sampleAssignment,
      published: false,
      showPhone: false,
      contactable: false,
      isActive: false,
    } as any);

    const req = new NextRequest(
      "http://localhost/api/admin/committee/assignments/assign1",
      { method: "DELETE" },
    );
    const res = await deleteAssignment(req, { params: makeParams("assign1") });

    expect(res.status).toBe(200);
    expect(prisma.committeeAssignment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "assign1" },
        data: expect.objectContaining({
          isActive: false,
          published: false,
          showPhone: false,
          contactable: false,
        }),
      }),
    );
  });

  it("updates assignment presentation controls", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.committeeAssignment.findUnique).mockResolvedValue(
      sampleAssignment as any,
    );
    vi.mocked(prisma.committeeAssignment.update).mockResolvedValue({
      ...sampleAssignment,
      published: true,
      showPhone: true,
      contactable: true,
    } as any);

    const req = new NextRequest(
      "http://localhost/api/admin/committee/assignments/assign1",
      {
        method: "PATCH",
        body: JSON.stringify({
          published: true,
          showPhone: true,
          contactable: true,
          sortOrder: 2,
        }),
      },
    );
    const res = await updateAssignment(req, { params: makeParams("assign1") });

    expect(res.status).toBe(200);
    expect(prisma.committeeAssignment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          published: true,
          showPhone: true,
          contactable: true,
          sortOrder: 2,
        }),
      }),
    );
  });
});

describe("Committee Assignment API - contact email mode", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const makeParams = (id: string) => Promise.resolve({ id });

  function mockMemberAndRole() {
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "member1",
      firstName: "Alex",
      lastName: "Admin",
      email: "alex@example.org",
    } as any);
    vi.mocked(prisma.committeeRole.findUnique).mockResolvedValue({
      id: "role1",
      name: "President",
      isActive: true,
    } as any);
    vi.mocked(prisma.committeeAssignment.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.committeeAssignment.create).mockResolvedValue(
      sampleAssignment as any,
    );
  }

  it("POST persists a CUSTOM contact email mode and normalized override", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    mockMemberAndRole();

    const req = new NextRequest("http://localhost/api/admin/committee/assignments", {
      method: "POST",
      body: JSON.stringify({
        memberId: "member1",
        committeeRoleId: "role1",
        contactable: true,
        contactEmailMode: "CUSTOM",
        contactEmailOverride: "Custom@Example.Org",
      }),
    });
    const res = await createAssignment(req);

    expect(res.status).toBe(201);
    expect(prisma.committeeAssignment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          contactEmailMode: "CUSTOM",
          contactEmailOverride: "custom@example.org",
        }),
      }),
    );
  });

  it("POST forces the override to null for non-CUSTOM modes", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    mockMemberAndRole();

    const req = new NextRequest("http://localhost/api/admin/committee/assignments", {
      method: "POST",
      body: JSON.stringify({
        memberId: "member1",
        committeeRoleId: "role1",
        contactable: true,
        contactEmailMode: "MEMBER",
        contactEmailOverride: "stale@example.org",
      }),
    });
    const res = await createAssignment(req);

    expect(res.status).toBe(201);
    expect(prisma.committeeAssignment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          contactEmailMode: "MEMBER",
          contactEmailOverride: null,
        }),
      }),
    );
  });

  it("POST defaults to ROLE mode when unspecified (back-compat)", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    mockMemberAndRole();

    const req = new NextRequest("http://localhost/api/admin/committee/assignments", {
      method: "POST",
      body: JSON.stringify({ memberId: "member1", committeeRoleId: "role1" }),
    });
    const res = await createAssignment(req);

    expect(res.status).toBe(201);
    expect(prisma.committeeAssignment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          contactEmailMode: "ROLE",
          contactEmailOverride: null,
        }),
      }),
    );
  });

  it("POST rejects an invalid custom committee email", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    mockMemberAndRole();

    const req = new NextRequest("http://localhost/api/admin/committee/assignments", {
      method: "POST",
      body: JSON.stringify({
        memberId: "member1",
        committeeRoleId: "role1",
        contactable: true,
        contactEmailMode: "CUSTOM",
        contactEmailOverride: "not-an-email",
      }),
    });
    const res = await createAssignment(req);

    expect(res.status).toBe(400);
    expect(prisma.committeeAssignment.create).not.toHaveBeenCalled();
  });

  it("POST rejects CUSTOM mode without an override", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    mockMemberAndRole();

    const req = new NextRequest("http://localhost/api/admin/committee/assignments", {
      method: "POST",
      body: JSON.stringify({
        memberId: "member1",
        committeeRoleId: "role1",
        contactable: true,
        contactEmailMode: "CUSTOM",
      }),
    });
    const res = await createAssignment(req);

    expect(res.status).toBe(400);
    expect(prisma.committeeAssignment.create).not.toHaveBeenCalled();
  });

  it("PATCH updates the contact email mode and normalized override", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.committeeAssignment.findUnique).mockResolvedValue({
      ...sampleAssignment,
      contactEmailMode: "ROLE",
      contactEmailOverride: null,
    } as any);
    vi.mocked(prisma.committeeAssignment.update).mockResolvedValue({
      ...sampleAssignment,
      contactEmailMode: "CUSTOM",
      contactEmailOverride: "custom@example.org",
    } as any);

    const req = new NextRequest(
      "http://localhost/api/admin/committee/assignments/assign1",
      {
        method: "PATCH",
        body: JSON.stringify({
          contactEmailMode: "CUSTOM",
          contactEmailOverride: "Custom@Example.Org",
        }),
      },
    );
    const res = await updateAssignment(req, { params: makeParams("assign1") });

    expect(res.status).toBe(200);
    expect(prisma.committeeAssignment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          contactEmailMode: "CUSTOM",
          contactEmailOverride: "custom@example.org",
        }),
      }),
    );
  });

  it("PATCH leaves an existing CUSTOM override untouched when only unrelated fields change", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.committeeAssignment.findUnique).mockResolvedValue({
      ...sampleAssignment,
      contactEmailMode: "CUSTOM",
      contactEmailOverride: "custom@example.org",
    } as any);
    vi.mocked(prisma.committeeAssignment.update).mockResolvedValue({
      ...sampleAssignment,
      published: true,
      contactEmailMode: "CUSTOM",
      contactEmailOverride: "custom@example.org",
    } as any);

    const req = new NextRequest(
      "http://localhost/api/admin/committee/assignments/assign1",
      {
        method: "PATCH",
        body: JSON.stringify({ published: true }),
      },
    );
    const res = await updateAssignment(req, { params: makeParams("assign1") });

    expect(res.status).toBe(200);
    const updateArgs = vi.mocked(prisma.committeeAssignment.update).mock
      .calls[0][0] as { data: Record<string, unknown> };
    expect(updateArgs.data.published).toBe(true);
    // The override column must not be touched (not nulled/wiped) by an
    // unrelated toggle while the assignment stays in CUSTOM mode.
    expect("contactEmailOverride" in updateArgs.data).toBe(false);
    expect("contactEmailMode" in updateArgs.data).toBe(false);
  });

  it("PATCH clears the override when moving away from CUSTOM", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.committeeAssignment.findUnique).mockResolvedValue({
      ...sampleAssignment,
      contactEmailMode: "CUSTOM",
      contactEmailOverride: "custom@example.org",
    } as any);
    vi.mocked(prisma.committeeAssignment.update).mockResolvedValue({
      ...sampleAssignment,
      contactEmailMode: "ROLE",
      contactEmailOverride: null,
    } as any);

    const req = new NextRequest(
      "http://localhost/api/admin/committee/assignments/assign1",
      {
        method: "PATCH",
        body: JSON.stringify({ contactEmailMode: "ROLE" }),
      },
    );
    const res = await updateAssignment(req, { params: makeParams("assign1") });

    expect(res.status).toBe(200);
    expect(prisma.committeeAssignment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          contactEmailMode: "ROLE",
          contactEmailOverride: null,
        }),
      }),
    );
  });

  it("PATCH rejects switching to CUSTOM without a resolvable override", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.committeeAssignment.findUnique).mockResolvedValue({
      ...sampleAssignment,
      contactEmailMode: "ROLE",
      contactEmailOverride: null,
    } as any);

    const req = new NextRequest(
      "http://localhost/api/admin/committee/assignments/assign1",
      {
        method: "PATCH",
        body: JSON.stringify({ contactEmailMode: "CUSTOM" }),
      },
    );
    const res = await updateAssignment(req, { params: makeParams("assign1") });

    expect(res.status).toBe(400);
    expect(prisma.committeeAssignment.update).not.toHaveBeenCalled();
  });

  it("PATCH rejects an invalid custom committee email", async () => {
    mockedAuth.mockResolvedValue(adminSession);

    const req = new NextRequest(
      "http://localhost/api/admin/committee/assignments/assign1",
      {
        method: "PATCH",
        body: JSON.stringify({ contactEmailOverride: "not-an-email" }),
      },
    );
    const res = await updateAssignment(req, { params: makeParams("assign1") });

    expect(res.status).toBe(400);
    expect(prisma.committeeAssignment.update).not.toHaveBeenCalled();
  });
});

describe("Contact API - committee contact email mode routing", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const contactReq = (recipient: string) =>
    new Request("http://localhost/api/contact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Test User",
        email: "test@example.com",
        message: "Hello",
        recipient,
      }),
    });

  it("ROLE mode routes to the role email", async () => {
    const { POST } = await import("@/app/api/contact/route");
    vi.mocked(prisma.committeeAssignment.findFirst).mockResolvedValue({
      contactEmailMode: "ROLE",
      contactEmailOverride: null,
      committeeRole: { name: "President", contactEmail: "role@example.org" },
      member: { email: "member@example.org" },
    } as any);

    const res = await POST(contactReq("assign1"));
    expect(res.status).toBe(200);
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "role@example.org" }),
    );
  });

  it("MEMBER mode routes to the member email", async () => {
    const { POST } = await import("@/app/api/contact/route");
    vi.mocked(prisma.committeeAssignment.findFirst).mockResolvedValue({
      contactEmailMode: "MEMBER",
      contactEmailOverride: null,
      committeeRole: { name: "President", contactEmail: "role@example.org" },
      member: { email: "member@example.org" },
    } as any);

    const res = await POST(contactReq("assign1"));
    expect(res.status).toBe(200);
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "member@example.org" }),
    );
  });

  it("CUSTOM mode routes to the override email", async () => {
    const { POST } = await import("@/app/api/contact/route");
    vi.mocked(prisma.committeeAssignment.findFirst).mockResolvedValue({
      contactEmailMode: "CUSTOM",
      contactEmailOverride: "custom@example.org",
      committeeRole: { name: "President", contactEmail: "role@example.org" },
      member: { email: "member@example.org" },
    } as any);

    const res = await POST(contactReq("assign1"));
    expect(res.status).toBe(200);
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "custom@example.org" }),
    );
  });

  it("CUSTOM with a blank override falls back to role then member and warns", async () => {
    const { POST } = await import("@/app/api/contact/route");
    vi.mocked(prisma.committeeAssignment.findFirst).mockResolvedValue({
      contactEmailMode: "CUSTOM",
      contactEmailOverride: null,
      committeeRole: { name: "President", contactEmail: "role@example.org" },
      member: { email: "member@example.org" },
    } as any);

    const res = await POST(contactReq("assign1"));
    expect(res.status).toBe(200);
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "role@example.org",
        logRecipient: "committee-contact:assign1",
      }),
    );
    expect(logger.warn).toHaveBeenCalled();
  });

  it("MEMBER mode with no member email falls back to the role email and warns", async () => {
    const { POST } = await import("@/app/api/contact/route");
    vi.mocked(prisma.committeeAssignment.findFirst).mockResolvedValue({
      contactEmailMode: "MEMBER",
      contactEmailOverride: null,
      committeeRole: { name: "President", contactEmail: "role@example.org" },
      member: { email: null },
    } as any);

    const res = await POST(contactReq("assign1"));
    expect(res.status).toBe(200);
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "role@example.org" }),
    );
    expect(logger.warn).toHaveBeenCalled();
  });

  it("MEMBER mode with no role or member email falls back to the CONTACT_EMAIL default and warns", async () => {
    const { POST } = await import("@/app/api/contact/route");
    vi.mocked(prisma.committeeAssignment.findFirst).mockResolvedValue({
      contactEmailMode: "MEMBER",
      contactEmailOverride: null,
      committeeRole: { name: "President", contactEmail: null },
      member: { email: null },
    } as any);

    const res = await POST(contactReq("assign1"));
    expect(res.status).toBe(200);
    const emailArgs = vi.mocked(sendEmail).mock.calls[0][0];
    // Never an empty `to`: routing lands on the DB-first club default recipient.
    expect(emailArgs.to).toBe(DEFAULT_CONTACT_EMAIL);
    expect(emailArgs.to).toBeTruthy();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("ignores a set CONTACT_EMAIL env var — the DB contactEmail is the sole source (#1986)", async () => {
    // C7 #1986 removed the process.env.CONTACT_EMAIL bootstrap override. Setting
    // it must have NO effect: the default recipient comes solely from the DB-first
    // EmailMessageSetting.contactEmail (mocked to DEFAULT_CONTACT_EMAIL).
    vi.stubEnv("CONTACT_EMAIL", "env-override@example.com");
    const { POST } = await import("@/app/api/contact/route");
    const req = new Request("http://localhost/api/contact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Test User",
        email: "test@example.com",
        message: "Hello",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const emailArgs = vi.mocked(sendEmail).mock.calls[0][0];
    expect(emailArgs.to).toBe(DEFAULT_CONTACT_EMAIL);
    expect(emailArgs.to).not.toBe("env-override@example.com");
    vi.unstubAllEnvs();
  });
});

describe("Committee Public API - GET /api/committee", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns only published assignment presentation fields without email", async () => {
    const { GET } = await import("@/app/api/committee/route");
    vi.mocked(prisma.committeeAssignment.findMany).mockResolvedValue([
      {
        ...sampleAssignment,
        id: "assign1",
        published: true,
        showPhone: false,
        contactable: false,
      },
      {
        ...sampleAssignment,
        id: "assign2",
        blurb: null,
        published: true,
        showPhone: true,
        contactable: true,
        committeeRole: {
          ...sampleRole,
          key: "secretary",
          name: "Secretary",
          description: "Keeps club records.",
        },
        member: {
          ...sampleAssignment.member,
          firstName: "Jamie",
          lastName: "Jones",
          email: "private-secretary@example.org",
          phoneCountryCode: "+64",
          phoneAreaCode: "27",
          phoneNumber: "555 0100",
        },
      },
    ] as any);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.members).toHaveLength(2);
    expect(JSON.stringify(body)).not.toContain("example.org");
    expect(body.members[0]).toMatchObject({
      id: "assign1",
      role: "President",
      roleKey: "president",
      name: "Alex Admin",
      phone: null,
      contactKey: null,
      description: "Current president.",
    });
    expect(body.members[1]).toMatchObject({
      id: "assign2",
      role: "Secretary",
      roleKey: "secretary",
      name: "Jamie Jones",
      phone: "+64 27 555 0100",
      contactKey: "assign2",
      description: "Keeps club records.",
    });

    expect(prisma.committeeAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          isActive: true,
          published: true,
          committeeRole: { isActive: true },
          member: { active: true },
        },
      })
    );
    // A pathological backstop (500) far above any real committee, so the roster
    // stays in lockstep with what /api/members/[id]/photo serves publicly while
    // still bounding an abusive unauthenticated query.
    const call = (prisma.committeeAssignment.findMany as unknown as {
      mock: { calls: Array<[{ take?: number }]> };
    }).mock.calls[0][0];
    expect(call.take).toBe(500);
  });

  it("emits committee photo metadata only when the club opts the roster in (MP5)", async () => {
    const { GET } = await import("@/app/api/committee/route");
    const withPhoto = [
      {
        ...sampleAssignment,
        id: "assignP",
        published: true,
        member: {
          ...sampleAssignment.member,
          id: "mem-photo",
          photoImageId: "img-1",
          photoUpdatedAt: new Date("2026-07-21T00:00:00.000Z"),
        },
      },
    ] as any;

    // Enabled (CIRCLE): photo metadata is present; display mode is returned.
    vi.mocked(prisma.committeeAssignment.findMany).mockResolvedValue(withPhoto);
    vi.mocked(prisma.publicContentSettings.findUnique).mockResolvedValue({
      committeePhotoDisplay: "CIRCLE",
    } as any);
    const on = await (await GET()).json();
    expect(on.photoDisplay).toBe("CIRCLE");
    expect(on.members[0].photo).toEqual({
      memberId: "mem-photo",
      version: "2026-07-21T00:00:00.000Z",
    });

    // Disabled (NONE / unset): no photo metadata is exposed at all.
    vi.mocked(prisma.publicContentSettings.findUnique).mockResolvedValue(null);
    const off = await (await GET()).json();
    expect(off.photoDisplay).toBe("NONE");
    expect(off.members[0].photo).toBeNull();
    expect(JSON.stringify(off)).not.toContain("mem-photo");
  });
});

describe("Contact API - recipient lookup from database", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("sends to the committee role email when recipient matches a published contactable assignment", async () => {
    const { POST } = await import("@/app/api/contact/route");
    vi.mocked(prisma.committeeAssignment.findFirst).mockResolvedValue({
      committeeRole: { name: "President", contactEmail: "president@example.org" },
      member: { email: "member@example.org" },
    } as any);

    const req = new Request("http://localhost/api/contact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Test User",
        email: "test@example.com",
        message: "Hello",
        recipient: "assign1",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    expect(prisma.committeeAssignment.findFirst).toHaveBeenCalledWith({
      where: {
        id: "assign1",
        isActive: true,
        published: true,
        contactable: true,
        committeeRole: { isActive: true },
        member: { active: true },
      },
      select: {
        contactEmailMode: true,
        contactEmailOverride: true,
        committeeRole: { select: { name: true, contactEmail: true } },
        member: { select: { email: true } },
      },
    });

    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "president@example.org",
        subject: "Website Contact (to President): Test User",
      })
    );
  });

  it("falls back to CONTACT_EMAIL when no contactable published assignment matches", async () => {
    const { POST } = await import("@/app/api/contact/route");
    vi.mocked(prisma.committeeAssignment.findFirst).mockResolvedValue(null);

    const req = new Request("http://localhost/api/contact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Test User",
        email: "test@example.com",
        message: "Hello",
        recipient: "unknown",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    expect(prisma.committeeAssignment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "unknown",
          published: true,
          contactable: true,
        }),
      })
    );
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: DEFAULT_CONTACT_EMAIL })
    );
  });

  it("falls back to the assigned member email when a contactable role has no alias email", async () => {
    const { POST } = await import("@/app/api/contact/route");
    vi.mocked(prisma.committeeAssignment.findFirst).mockResolvedValue({
      committeeRole: { name: "President", contactEmail: null },
      member: { email: "member@example.org" },
    } as any);

    const req = new Request("http://localhost/api/contact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Test User",
        email: "test@example.com",
        message: "Hello",
        recipient: "assign1",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "member@example.org",
        subject: "Website Contact (to President): Test User",
        logRecipient: "committee-contact:assign1",
      })
    );
  });

  it("falls back to CONTACT_EMAIL when a contactable assignment has no role or member email", async () => {
    const { POST } = await import("@/app/api/contact/route");
    vi.mocked(prisma.committeeAssignment.findFirst).mockResolvedValue({
      committeeRole: { name: "President", contactEmail: null },
      member: { email: null },
    } as any);

    const req = new Request("http://localhost/api/contact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Test User",
        email: "test@example.com",
        message: "Hello",
        recipient: "assign1",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: DEFAULT_CONTACT_EMAIL,
        subject: "Website Contact (to President): Test User",
      })
    );
  });

  it("sanitizes committee role labels before adding them to the email subject", async () => {
    const { POST } = await import("@/app/api/contact/route");
    vi.mocked(prisma.committeeAssignment.findFirst).mockResolvedValue({
      committeeRole: {
        name: "President\r\nBcc: attacker@example.org",
        contactEmail: "president@example.org",
      },
      member: { email: "member@example.org" },
    } as any);

    const req = new Request("http://localhost/api/contact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Test User",
        email: "test@example.com",
        message: "Hello",
        recipient: "assign1",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject:
          "Website Contact (to President Bcc: attacker@example.org): Test User",
      })
    );
  });

  it("sends to default email when no recipient specified", async () => {
    const { POST } = await import("@/app/api/contact/route");

    const req = new Request("http://localhost/api/contact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Test User",
        email: "test@example.com",
        message: "Hello",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    expect(prisma.committeeAssignment.findFirst).not.toHaveBeenCalled();

    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: DEFAULT_CONTACT_EMAIL })
    );
  });
});
