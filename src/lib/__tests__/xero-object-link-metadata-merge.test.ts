import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { planXeroObjectLinkMetadataMerge } from "@/lib/xero-object-link-metadata-merge";
import { sanitizeForJson } from "@/lib/xero-sync";
import { applyLinkMetadataMerge, preFix4445MetadataMerge } from "./support/xero-link-metadata-merge-double";

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

  // The unit tests' one double of the statement (`support/xero-link-metadata-merge-double.ts`)
  // must mean what the pre-#4445 spread meant, or every mocked funnel test inherits the error.
  const STORED: unknown[] = [null, { kept: 1, nested: { x: 1 }, overridden: "old", status: "VOIDED" }, [1, 2], "legacy"];
  const INCOMING: unknown[] = [
    { overridden: "new", nested: { y: 2 }, added: null },
    { status: undefined, overridden: "new" },
    { password: "not-a-real-password", total: 50 },
    {},
    undefined,
    [3],
  ];
  it.each(STORED.flatMap((stored) => INCOMING.map((incoming) => [stored, incoming] as const)))(
    "the unit-test double over stored %j, incoming %j, matches the pre-#4445 spread",
    (stored, incoming) => {
      const merge = plan(incoming);
      const after = merge
        ? applyLinkMetadataMerge(stored, {
          removedKeys: merge.removedKeys,
          overlay: JSON.parse(JSON.stringify(merge.overlay)),
          replacement: JSON.parse(JSON.stringify(merge.replacement)),
          linkId: "link_1",
        })
        : stored;
      expect(after).toEqual(preFix4445MetadataMerge(stored, incoming, sanitizeForJson));
    },
  );
});
