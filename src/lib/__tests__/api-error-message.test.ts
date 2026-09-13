import { describe, expect, it } from "vitest";
import {
  MODULE_DISABLED_ERROR_CODE,
  apiErrorCodeFromBody,
  apiErrorMessageFromBody,
  apiErrorMessageFromResponse,
  readApiErrorBody,
} from "@/lib/api-error-message";

const FALLBACK = "Failed to save";

describe("apiErrorMessageFromResponse", () => {
  it("uses the server's own curated sentence", async () => {
    const message = await apiErrorMessageFromResponse(
      Response.json({ error: "Lodge not found or not active" }, { status: 400 }),
      FALLBACK,
    );
    expect(message).toBe("Lodge not found or not active");
  });

  it("reads only `error`, never the rest of the body", async () => {
    const message = await apiErrorMessageFromResponse(
      Response.json(
        {
          error: "Invalid input",
          details: { fieldErrors: { lodgeId: ["Required"] } },
          meta: { constraint: "BedAllocationSettings_pkey" },
        },
        { status: 400 },
      ),
      FALLBACK,
    );
    expect(message).toBe("Invalid input");
  });

  it.each([
    ["a non-JSON body", new Response("<html>502 Bad Gateway</html>", { status: 502 })],
    ["an empty body", new Response(null, { status: 500 })],
    ["a JSON array", Response.json(["nope"], { status: 500 })],
    ["a JSON string", Response.json("nope", { status: 500 })],
    ["a body with no error field", Response.json({ ok: false }, { status: 500 })],
    ["a non-string error", Response.json({ error: { code: 7 } }, { status: 500 })],
    ["a blank error", Response.json({ error: "   " }, { status: 500 })],
  ])("falls back for %s", async (_case, response) => {
    expect(await apiErrorMessageFromResponse(response, FALLBACK)).toBe(FALLBACK);
  });

  it("trims the sentence it returns", async () => {
    expect(
      await apiErrorMessageFromResponse(
        Response.json({ error: "  Not found  " }, { status: 404 }),
        FALLBACK,
      ),
    ).toBe("Not found");
  });
});

describe("apiErrorMessageFromBody", () => {
  it("applies the same rule one step later, for a caller that already parsed", () => {
    expect(
      apiErrorMessageFromBody({ error: "Lodge not found or not active" }, FALLBACK),
    ).toBe("Lodge not found or not active");
    expect(apiErrorMessageFromBody({ error: "" }, FALLBACK)).toBe(FALLBACK);
    expect(apiErrorMessageFromBody(null, FALLBACK)).toBe(FALLBACK);
    expect(apiErrorMessageFromBody(["nope"], FALLBACK)).toBe(FALLBACK);
  });
});

describe("apiErrorCodeFromBody", () => {
  /**
   * #2931 — the reason the code exists rather than a status test. A module-gated
   * route answers 404 for the module being off AND for an anonymous caller
   * (`moduleGatedNotFoundResponse` in `src/lib/session-guards.ts`), so only the
   * body can tell a screen which refusal it is holding.
   */
  it("names a module refusal", () => {
    expect(
      apiErrorCodeFromBody({ error: "Not found", code: MODULE_DISABLED_ERROR_CODE }),
    ).toBe("MODULE_DISABLED");
  });

  it.each([
    ["the anonymous caller's bare 404 body", { error: "Not found" }],
    ["an empty code", { error: "Not found", code: "" }],
    ["a non-string code", { error: "Not found", code: 404 }],
    ["a non-object body", "MODULE_DISABLED"],
    ["an array body", ["MODULE_DISABLED"]],
    ["no body at all", null],
  ])("reports no code for %s", (_case, body) => {
    expect(apiErrorCodeFromBody(body)).toBeNull();
  });
});

describe("readApiErrorBody", () => {
  it("hands the same parsed body to both readers, from one read", async () => {
    const body = await readApiErrorBody(
      Response.json(
        { error: "Not found", code: MODULE_DISABLED_ERROR_CODE },
        { status: 404 },
      ),
    );
    expect(apiErrorCodeFromBody(body)).toBe(MODULE_DISABLED_ERROR_CODE);
    expect(apiErrorMessageFromBody(body, FALLBACK)).toBe("Not found");
  });

  it("is null rather than a throw when the body is not JSON", async () => {
    expect(
      await readApiErrorBody(new Response("<html>502</html>", { status: 502 })),
    ).toBeNull();
  });
});
