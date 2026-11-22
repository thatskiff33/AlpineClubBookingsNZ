import { describe, expect, it } from "vitest";
import { invalidJsonBodyResponse, parseJsonRequestBody } from "@/lib/api-json";

function post(body: string) {
  return new Request("http://localhost/api/example", { method: "POST", body });
}

describe("API JSON parsing", () => {
  it("returns a controlled 400 response for malformed JSON", async () => {
    const result = await parseJsonRequestBody(post("{not json"));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      await expect(result.response.json()).resolves.toEqual({
        error: "Invalid JSON",
        details: { body: ["Request body must be valid JSON"] },
      });
    }
  });

  it("returns the parsed body when the JSON is valid, whatever its type", async () => {
    for (const raw of ['{"a":1}', "[1,2]", '"text"', "null", "0"]) {
      const result = await parseJsonRequestBody(post(raw));
      expect(result).toEqual({ ok: true, body: JSON.parse(raw) });
    }
  });

  it("treats an empty body as invalid JSON, as request.json() does", async () => {
    const result = await parseJsonRequestBody(post(""));
    expect(result.ok).toBe(false);
  });

  describe("caller-chosen error text", () => {
    it.each(["Invalid JSON", "Invalid JSON payload", "Invalid JSON.", "Invalid JSON content"])(
      "answers exactly { error: %j } with no details field",
      async (error) => {
        const result = await parseJsonRequestBody(post("{not json"), { error });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.response.status).toBe(400);
          // The bytes, not just the parsed shape: an inline copy returned this string.
          await expect(result.response.text()).resolves.toBe(
            JSON.stringify({ error }),
          );
        }
      },
    );

    it("includes details only when the caller supplies them", async () => {
      const result = await parseJsonRequestBody(post("{not json"), {
        error: "Invalid JSON",
        details: { body: ["Request body must be valid JSON"] },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        await expect(result.response.json()).resolves.toEqual({
          error: "Invalid JSON",
          details: { body: ["Request body must be valid JSON"] },
        });
      }
    });

    it("does not change the answer for a valid body", async () => {
      const result = await parseJsonRequestBody(post('{"a":1}'), {
        error: "Invalid JSON payload",
      });
      expect(result).toEqual({ ok: true, body: { a: 1 } });
    });

    it("gives the same bytes as an inline NextResponse.json 400", async () => {
      const inline = Response.json({ error: "Invalid JSON." }, { status: 400 });
      const shared = invalidJsonBodyResponse({ error: "Invalid JSON." });

      expect(shared.status).toBe(inline.status);
      expect(await shared.text()).toBe(await inline.text());
      expect(shared.headers.get("content-type")).toBe(
        inline.headers.get("content-type"),
      );
    });
  });
});
