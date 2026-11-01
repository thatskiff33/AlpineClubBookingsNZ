import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { planXeroObjectLinkMetadataMerge } from "@/lib/xero-object-link-metadata-merge";
import { sanitizeForJson } from "@/lib/xero-sync";

/**
 * #4445: what one merge lays over a stored link row. The statement that
 * applies it is pinned against the pre-#4445 spread on PostgreSQL in
 * `xero-object-link-metadata-merge.realdb.test.ts`.
 */
const plan = (incoming: unknown) => planXeroObjectLinkMetadataMerge(incoming, sanitizeForJson(incoming));

describe("planXeroObjectLinkMetadataMerge (#4445)", () => {
  it("lays the sanitised record over a stored object, an explicit null kept as a value", () => {
    expect(plan({ status: "VOIDED", total: null, nested: { y: 2 }, password: "not-a-real-password" })).toEqual({
      overlay: { status: "VOIDED", total: null, nested: { y: 2 }, password: "[REDACTED]" },
      removedKeys: [],
      replacement: { status: "VOIDED", total: null, nested: { y: 2 }, password: "[REDACTED]" },
    });
  });

  it("removes a key the record sends as undefined, as the spread then JSON serialisation did", () => {
    expect(plan({ status: undefined, total: 50 })).toEqual({ overlay: { total: 50 }, removedKeys: ["status"], replacement: { total: 50 } });
  });

  it("keeps a stored object under a write that is not a record, and replaces anything else", () => {
    expect(plan([3])).toEqual({ overlay: {}, removedKeys: [], replacement: [3] });
    expect(plan("text")).toEqual({ overlay: {}, removedKeys: [], replacement: "text" });
  });

  it("writes nothing for a write that names no metadata", () => {
    expect(plan(undefined)).toBeNull();
  });
});
