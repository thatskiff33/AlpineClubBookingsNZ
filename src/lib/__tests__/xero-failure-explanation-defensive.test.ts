import { describe, expect, it, vi } from "vitest";

const redact = vi.hoisted(() => vi.fn((value: string) => value));
vi.mock("@/lib/redact-sensitive-json", () => ({ redactSensitiveText: redact }));

import { explainXeroFailure } from "@/lib/xero-failure-explanation";

describe("explainXeroFailure when something inside it throws (#4278)", () => {
  it("returns the generic explanation instead of breaking the admin page", () => {
    redact.mockImplementationOnce(() => {
      throw new Error("redaction blew up");
    });
    const result = explainXeroFailure({ code: "WEIRD", message: "something unrecognised", entityType: "PAYMENT" });
    expect(result.kind).toBe("UNKNOWN");
    expect(result.headline).toContain("payment");
    expect(result.technicalDetail).toBe("WEIRD: something unrecognised");
  });
});
