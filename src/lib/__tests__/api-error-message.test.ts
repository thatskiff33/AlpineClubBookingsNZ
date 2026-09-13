import { describe, expect, it } from "vitest";
import { responseErrorMessage } from "@/lib/api-error-message";

const FALLBACK = "Failed to save";

describe("responseErrorMessage", () => {
  it("uses the server's own curated sentence", async () => {
    const message = await responseErrorMessage(
      Response.json({ error: "Lodge not found or not active" }, { status: 400 }),
      FALLBACK,
    );
    expect(message).toBe("Lodge not found or not active");
  });

  it("reads only `error`, never the rest of the body", async () => {
    const message = await responseErrorMessage(
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
    ["a body with no error field", Response.json({ ok: false }, { status: 500 })],
    ["a non-string error", Response.json({ error: { code: 7 } }, { status: 500 })],
    ["a blank error", Response.json({ error: "   " }, { status: 500 })],
  ])("falls back for %s", async (_case, response) => {
    expect(await responseErrorMessage(response, FALLBACK)).toBe(FALLBACK);
  });

  it("trims the sentence it returns", async () => {
    expect(
      await responseErrorMessage(
        Response.json({ error: "  Not found  " }, { status: 404 }),
        FALLBACK,
      ),
    ).toBe("Not found");
  });
});
