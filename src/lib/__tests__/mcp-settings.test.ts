/**
 * The club's AI-connection policy (ALP-653, `INV-MCP-002`, `INV-MCP-003`):
 * the defaults an unsaved club reads, who may hold a connection, how far a
 * connection may act, and what an officer's save is reduced to.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { mcpSettings: { findUnique } } }));

import { ADMIN_PERMISSION_AREAS } from "@/lib/admin-permissions";
import {
  DEFAULT_MCP_SETTINGS,
  effectiveMcpScope,
  loadMcpSettings,
  mayHoldMcpConnection,
  MCP_SETTINGS_ID,
  type McpSettingsValues,
} from "@/lib/mcp/settings";
import {
  MCP_ALLOWED_HOSTS_MAX,
  mcpSettingsUpdateSchema,
  normaliseMcpAllowedHosts,
} from "@/lib/mcp/settings-update";

beforeEach(() => {
  findUnique.mockResolvedValue(null);
});

/** Each field's `@default(...)` in `model McpSettings`, read from the schema. */
function schemaDefaults(): Record<string, string> {
  const schema = readFileSync(path.resolve(process.cwd(), "prisma/schema.prisma"), "utf8");
  const block = /^model McpSettings \{([\s\S]*?)^\}/m.exec(schema);
  if (!block) throw new Error("model McpSettings not found in prisma/schema.prisma");
  const defaults: Record<string, string> = {};
  for (const raw of block[1].split(/\r?\n/)) {
    const line = raw.trim();
    const match = /^(\w+)\s+\S+.*@default\(([^)]*)\)/.exec(line);
    if (match) defaults[match[1]] = match[2];
  }
  return defaults;
}

function parseDefault(token: string): unknown {
  if (token === "true" || token === "false") return token === "true";
  if (token.startsWith("[") || token.startsWith('"')) return JSON.parse(token);
  return token;
}

const member = { accessRoles: [], canLogin: true };
const fullAdmin = { accessRoles: ["ADMIN" as const], canLogin: true };
/** Anyone the admin area admits at all is an officer, however narrow their role. */
const narrowOfficer = {
  canLogin: true,
  adminPermissionMatrix: Object.fromEntries(
    ADMIN_PERMISSION_AREAS.map((area) => [area.key, area.key === "bookings" ? "view" : "none"]),
  ),
};

function settings(overrides: Partial<McpSettingsValues>): McpSettingsValues {
  return { ...DEFAULT_MCP_SETTINGS, ...overrides };
}

describe("the defaults an unsaved club reads", () => {
  it("match the column defaults of model McpSettings", () => {
    const defaults = schemaDefaults();
    for (const field of Object.keys(DEFAULT_MCP_SETTINGS) as (keyof McpSettingsValues)[]) {
      expect(defaults[field], `${field} has a column default`).toBeDefined();
      expect(DEFAULT_MCP_SETTINGS[field], field).toEqual(parseDefault(defaults[field]));
    }
    expect(defaults.id).toBe(`"${MCP_SETTINGS_ID}"`);
  });

  it("are what loadMcpSettings answers when no row was ever saved", async () => {
    await expect(loadMcpSettings()).resolves.toEqual(DEFAULT_MCP_SETTINGS);
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: MCP_SETTINGS_ID } }),
    );
  });

  it("are replaced by the saved row when there is one", async () => {
    const saved = {
      membersMayConnect: false,
      officersMayConnect: true,
      maxScope: "READ_WRITE",
      allowedRedirectHosts: ["example.org"],
    };
    findUnique.mockResolvedValue(saved);
    await expect(loadMcpSettings()).resolves.toEqual(saved);
  });
});

describe("mayHoldMcpConnection", () => {
  it("judges a member by the members' switch alone", () => {
    expect(mayHoldMcpConnection(settings({ membersMayConnect: true, officersMayConnect: false }), member)).toBe(true);
    expect(mayHoldMcpConnection(settings({ membersMayConnect: false, officersMayConnect: true }), member)).toBe(false);
  });

  it.each([
    ["a full administrator", fullAdmin],
    ["an officer with one area at view", narrowOfficer],
  ])("judges %s by the officers' switch alone", (_name, officer) => {
    // The members' switch never covers an officer: their app reaches other members.
    expect(mayHoldMcpConnection(settings({ membersMayConnect: true, officersMayConnect: false }), officer)).toBe(false);
    expect(mayHoldMcpConnection(settings({ membersMayConnect: false, officersMayConnect: true }), officer)).toBe(true);
  });

  it("refuses everyone with both switches off and admits everyone with both on", () => {
    const off = settings({ membersMayConnect: false, officersMayConnect: false });
    const on = settings({ membersMayConnect: true, officersMayConnect: true });
    for (const user of [member, fullAdmin, narrowOfficer]) {
      expect(mayHoldMcpConnection(off, user)).toBe(false);
      expect(mayHoldMcpConnection(on, user)).toBe(true);
    }
  });

  it("treats an officer whose login is switched off as holding no admin role", () => {
    const disabled = { ...fullAdmin, canLogin: false };
    expect(mayHoldMcpConnection(settings({ membersMayConnect: true, officersMayConnect: false }), disabled)).toBe(true);
  });
});

describe("effectiveMcpScope", () => {
  it.each([
    ["READ", "READ", "READ"],
    ["READ", "READ_WRITE", "READ"],
    ["READ_WRITE", "READ", "READ"],
    ["READ_WRITE", "READ_WRITE", "READ_WRITE"],
  ] as const)("a %s connection under a %s club limit acts as %s", (granted, max, expected) => {
    expect(effectiveMcpScope(granted, settings({ maxScope: max }))).toBe(expected);
  });
});

describe("normaliseMcpAllowedHosts", () => {
  it("skips blank lines, cuts pasted addresses to their host and keeps the officer's order", () => {
    expect(
      normaliseMcpAllowedHosts(["", "  ", "https://Claude.ai/", "chatgpt.com/path", " example.org "]),
    ).toEqual({ ok: true, hosts: ["claude.ai", "chatgpt.com", "example.org"] });
  });

  it("collapses entries that name the same host", () => {
    expect(
      normaliseMcpAllowedHosts(["claude.ai", "CLAUDE.AI", "https://claude.ai/callback", "claude.com"]),
    ).toEqual({ ok: true, hosts: ["claude.ai", "claude.com"] });
  });

  it("keeps a subdomain apart from its parent", () => {
    expect(normaliseMcpAllowedHosts(["claude.ai", "app.claude.ai"])).toEqual({
      ok: true,
      hosts: ["claude.ai", "app.claude.ai"],
    });
  });

  it.each(["not a host", "localhost", "claude", "https://", "exa_mple.com"])(
    "refuses the whole list over one entry it cannot read (%j), and names it",
    (bad) => {
      expect(normaliseMcpAllowedHosts(["claude.ai", bad, "chatgpt.com"])).toEqual({
        ok: false,
        invalid: bad,
      });
    },
  );

  it("accepts an empty list: only apps on the member's own computer remain", () => {
    expect(normaliseMcpAllowedHosts([])).toEqual({ ok: true, hosts: [] });
    expect(normaliseMcpAllowedHosts(["", ""])).toEqual({ ok: true, hosts: [] });
  });

  it("cuts a typed address at its first slash, however many slashes follow", () => {
    expect(normaliseMcpAllowedHosts(["chatgpt.com/a/b/c", "claude.ai////"])).toEqual({
      ok: true,
      hosts: ["chatgpt.com", "claude.ai"],
    });
  });

  it("refuses an entry holding a line break, as the pattern it replaced did", () => {
    for (const bad of ["claude.ai/x\ny", "claude.ai\n/x", "claude.ai/x\r", "claude.ai/x\u2028y"]) {
      expect(normaliseMcpAllowedHosts([`${bad}z`])).toEqual({ ok: false, invalid: `${bad}z` });
    }
  });

  it("answers a long run of slashes at once (no backtracking pattern on officer input)", () => {
    // The regular expression this replaced took time quadratic in the run's
    // length when a line break followed it (CodeQL js/polynomial-redos): on
    // this input it runs past the test timeout, which is how this test fails.
    const hostile = `${"/".repeat(200_000)}\n`;
    expect(normaliseMcpAllowedHosts([`claude.ai${hostile}x`])).toEqual({
      ok: false,
      invalid: `claude.ai${hostile}x`,
    });
  });
});

describe("mcpSettingsUpdateSchema", () => {
  const valid = {
    membersMayConnect: true,
    officersMayConnect: false,
    maxScope: "READ",
    allowedRedirectHosts: ["claude.ai"],
  };

  it("accepts the four settings", () => {
    expect(mcpSettingsUpdateSchema.safeParse(valid).success).toBe(true);
    expect(
      mcpSettingsUpdateSchema.safeParse({ ...valid, maxScope: "READ_WRITE" }).success,
    ).toBe(true);
  });

  it("refuses a key it does not know, so nothing else can ride along", () => {
    expect(
      mcpSettingsUpdateSchema.safeParse({ ...valid, updatedByMemberId: "someone-else" }).success,
    ).toBe(false);
  });

  it.each([
    ["a missing switch", { membersMayConnect: undefined }],
    ["a switch that is not a boolean", { officersMayConnect: "yes" }],
    ["a scope that does not exist", { maxScope: "ADMIN" }],
    ["hosts that are not a list", { allowedRedirectHosts: "claude.ai" }],
    ["an entry too long to be a host", { allowedRedirectHosts: ["a".repeat(301)] }],
  ])("refuses %s", (_name, change) => {
    expect(mcpSettingsUpdateSchema.safeParse({ ...valid, ...change }).success).toBe(false);
  });

  it(`takes at most ${MCP_ALLOWED_HOSTS_MAX} approved-app entries`, () => {
    const hosts = (count: number) => Array.from({ length: count }, (_, i) => `app${i}.example.org`);
    expect(
      mcpSettingsUpdateSchema.safeParse({ ...valid, allowedRedirectHosts: hosts(MCP_ALLOWED_HOSTS_MAX) })
        .success,
    ).toBe(true);
    expect(
      mcpSettingsUpdateSchema.safeParse({
        ...valid,
        allowedRedirectHosts: hosts(MCP_ALLOWED_HOSTS_MAX + 1),
      }).success,
    ).toBe(false);
  });
});
