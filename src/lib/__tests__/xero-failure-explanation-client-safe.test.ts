import { describe, expect, it, vi } from "vitest";

// The explainer is imported by client components (the two Xero panels). A server
// -only module anywhere in its import graph fails the production build, not a unit
// test, so make the graph fail here: importing the database client, or a
// `server-only` module, throws.
vi.mock("@/lib/prisma", () => {
  throw new Error("xero-failure-explanation must not reach the database client");
});
vi.mock("server-only", () => {
  throw new Error("xero-failure-explanation must not import a server-only module");
});

describe("xero-failure-explanation is safe to bundle into a client component (#4278)", () => {
  it("imports without touching the database client or a server-only module", async () => {
    const mod = await import("@/lib/xero-failure-explanation");
    expect(mod.explainXeroFailure({ code: "500", message: "x" }).kind).toBe("XERO_DOWN");
  });
});
