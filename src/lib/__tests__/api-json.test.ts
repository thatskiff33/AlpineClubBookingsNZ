import { describe, expect, it } from "vitest";
import {
  invalidJsonBodyResponse,
  parseJsonRequestBody,
  parseOptionalJsonRequestBody,
} from "@/lib/api-json";

function post(body: string) {
  return new Request("http://localhost/api/example", { method: "POST", body });
}

const DEFAULT_INVALID_JSON_BYTES = JSON.stringify({
  error: "Invalid JSON",
  details: { body: ["Request body must be valid JSON"] },
});

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
    it.each([
      "Invalid JSON",
      "Invalid JSON payload",
      "Invalid JSON.",
      "That post could not be read.",
    ] as const)(
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

    it("never copies extra properties of an options object into the body", async () => {
      // Held in a variable so TypeScript does not reject the extra fields.
      const held = {
        error: "Invalid JSON payload" as const,
        details: { body: ["x"] },
        extra: 1,
      };
      const result = await parseJsonRequestBody(post("{not json"), held);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        await expect(result.response.text()).resolves.toBe(
          JSON.stringify({ error: "Invalid JSON payload" }),
        );
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

describe("optional JSON body (#5407)", () => {
  it("treats a request with no body as no body", async () => {
    const result = await parseOptionalJsonRequestBody(
      new Request("http://localhost/api/example", { method: "POST" }),
    );
    expect(result).toEqual({ ok: true, body: undefined });
  });

  it.each(["", " ", "\n", " \r\n\t "])(
    "treats the body %j as no body",
    async (raw) => {
      const result = await parseOptionalJsonRequestBody(post(raw));
      expect(result).toEqual({ ok: true, body: undefined });
    },
  );

  // JSON's own whitespace only: a no-break space, a line separator or any
  // other Unicode space is a body that was sent, and it is not JSON.
  it.each([" ", "   ", " ", "　"])(
    "answers the body %j with the invalid-JSON 400, not as no body",
    async (raw) => {
      const result = await parseOptionalJsonRequestBody(post(raw), { whenAbsent: {} });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        await expect(result.response.text()).resolves.toBe(DEFAULT_INVALID_JSON_BYTES);
      }
    },
  );

  // UTF-8 decoding drops a leading byte-order mark before the reader sees the
  // text, as it does for request.json().
  it("treats a body of only a byte-order mark as no body, and reads JSON after one", async () => {
    expect(await parseOptionalJsonRequestBody(post("﻿"), { whenAbsent: {} })).toEqual({
      ok: true,
      body: {},
    });
    expect(await parseOptionalJsonRequestBody(post('﻿{"a":1}'))).toEqual({
      ok: true,
      body: { a: 1 },
    });
  });

  describe("only an absent body gets the route's default", () => {
    it("returns whenAbsent for an empty or whitespace-only body", async () => {
      for (const raw of ["", " \r\n\t"]) {
        expect(await parseOptionalJsonRequestBody(post(raw), { whenAbsent: { x: 1 } })).toEqual({
          ok: true,
          body: { x: 1 },
        });
      }
    });

    it("returns a JSON null as null, never as the default", async () => {
      expect(await parseOptionalJsonRequestBody(post("null"), { whenAbsent: {} })).toEqual({
        ok: true,
        body: null,
      });
    });

    it.each(["null", "[]", "[{}]", '"text"', "0", "true"])(
      "with objectOnly, refuses the non-object body %j with a 400",
      async (raw) => {
        const result = await parseOptionalJsonRequestBody(post(raw), {
          whenAbsent: {},
          objectOnly: true,
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.response.status).toBe(400);
          await expect(result.response.json()).resolves.toEqual({
            error: "Invalid request body",
            details: { body: ["Request body must be a JSON object"] },
          });
        }
      },
    );

    it("with objectOnly, still returns an object body and the default for an absent one", async () => {
      const options = { whenAbsent: { d: true }, objectOnly: true };
      expect(await parseOptionalJsonRequestBody(post('{"a":1}'), options)).toEqual({
        ok: true,
        body: { a: 1 },
      });
      expect(await parseOptionalJsonRequestBody(post(""), options)).toEqual({
        ok: true,
        body: { d: true },
      });
    });

    it("keeps a route's own invalid-JSON wording beside the other options", async () => {
      const result = await parseOptionalJsonRequestBody(post("{not json"), {
        error: "Invalid JSON",
        whenAbsent: {},
        objectOnly: true,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        await expect(result.response.text()).resolves.toBe(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
  });

  it("treats an empty body sent with a JSON content type as no body", async () => {
    const result = await parseOptionalJsonRequestBody(
      new Request("http://localhost/api/example", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "",
      }),
    );
    expect(result).toEqual({ ok: true, body: undefined });
  });

  it.each(["{not json", "{", "undefined", "'a'", "{}x"])(
    "answers the body %j with the default invalid-JSON 400, byte for byte",
    async (raw) => {
      const result = await parseOptionalJsonRequestBody(post(raw));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(400);
        await expect(result.response.text()).resolves.toBe(
          DEFAULT_INVALID_JSON_BYTES,
        );
      }
    },
  );

  it("returns every valid JSON value as sent, null and falsy values included", async () => {
    for (const raw of ['{"a":1}', "[1,2]", '"text"', '""', "null", "0", "false", ' {"a":1} ']) {
      const result = await parseOptionalJsonRequestBody(post(raw));
      expect(result).toEqual({ ok: true, body: JSON.parse(raw) });
    }
  });

  it("answers a malformed body with a route's own wording when it passes one", async () => {
    const result = await parseOptionalJsonRequestBody(post("{not json"), {
      error: "Invalid JSON",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      await expect(result.response.text()).resolves.toBe(
        JSON.stringify({ error: "Invalid JSON" }),
      );
    }
  });

  it("answers exactly as the required reader does for the same malformed body", async () => {
    const optional = await parseOptionalJsonRequestBody(post("{not json"));
    const required = await parseJsonRequestBody(post("{not json"));

    expect(optional.ok).toBe(false);
    expect(required.ok).toBe(false);
    if (!optional.ok && !required.ok) {
      expect(optional.response.status).toBe(required.response.status);
      expect(await optional.response.text()).toBe(await required.response.text());
      expect(optional.response.headers.get("content-type")).toBe(
        required.response.headers.get("content-type"),
      );
    }
  });
});
