import { describe, expect, it } from "vitest";
import { readAdminQueryErrorMessage } from "@/lib/admin-query-error";
import {
  AMOUNT_FILTER_GRAMMAR_MESSAGE,
  AMOUNT_FILTER_RANGE_MESSAGE,
  adminPaymentsQuerySchema,
} from "@/lib/admin-payments-service";

/**
 * #2685 review — the payments screen swallowed its own 400.
 *
 * `fetchData` was `if (res.ok) { … }` with no `else`, so a refused filter left
 * the PREVIOUS query's rows on screen underneath the new filter chip, and the
 * reason existed only in a network panel. This is the half of the fix that can
 * be tested away from the page: given the body the route actually sends, the
 * screen gets a sentence worth rendering.
 *
 * The corpus below is built from the real schema rather than from a hand-written
 * imitation of it, so a message that changes shape fails here.
 */
const FALLBACK = "fallback sentence";

function refusalBody(query: Record<string, string>) {
  const parsed = adminPaymentsQuerySchema.safeParse(query);
  if (parsed.success) throw new Error("expected the schema to refuse this query");
  return { error: "Invalid query parameters", details: parsed.error.flatten() };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}

describe("readAdminQueryErrorMessage", () => {
  it("quotes the field message the payments route actually sends", async () => {
    // A leading zero: admitted by the old looser regex, refused by the parser,
    // and reported as "outside the supported range" — which was not what was
    // wrong with it. The grammar now refuses it and says why (owner decision
    // 14 Aug 2026: leading zeros STAY rejected, the message becomes honest).
    const message = await readAdminQueryErrorMessage(
      jsonResponse(refusalBody({ amountExact: "007.50" })),
      FALLBACK,
    );

    expect(message).toBe(AMOUNT_FILTER_GRAMMAR_MESSAGE);
    expect(message).not.toContain("outside the supported range");
  });

  it("quotes a cross-field refusal too", async () => {
    const message = await readAdminQueryErrorMessage(
      jsonResponse(refusalBody({ amountMin: "75", amountMax: "50" })),
      FALLBACK,
    );

    expect(message).toBe(
      "Amount max must be greater than or equal to amount min",
    );
  });

  it("still explains a well-formed amount that is simply too large", async () => {
    const message = await readAdminQueryErrorMessage(
      jsonResponse(refusalBody({ amountExact: "99999999999.99" })),
      FALLBACK,
    );

    expect(message).toBe(AMOUNT_FILTER_RANGE_MESSAGE);
    // And the two refusals are genuinely different sentences — the whole point
    // of the fix is that a leading zero stopped being reported as a range
    // problem (#2685 review).
    expect(AMOUNT_FILTER_RANGE_MESSAGE).not.toBe(AMOUNT_FILTER_GRAMMAR_MESSAGE);
  });

  // #4467 (review F4): this reader is now `readValidationDetails`, the one
  // reader of a refusal's `details`. Same answer for the full flatten() and
  // formErrors-only shapes as the hand-rolled reader it replaced; the member
  // routes' bare fieldErrors shape is now read too, rather than falling back.
  it.each([
    [
      "the full flatten() shape: the first field message wins",
      { details: { formErrors: ["Form-level"], fieldErrors: { a: ["  ", "First"], b: ["Second"] } } },
      "First",
    ],
    ["a formErrors-only shape", { details: { formErrors: ["  ", "Only form-level"] } }, "Only form-level"],
    ["a full shape with empty fieldErrors", { details: { formErrors: ["Form-level"], fieldErrors: {} } }, "Form-level"],
    ["the bare fieldErrors shape", { details: { amountMin: ["Too small"] } }, "Too small"],
    ["details that are not zod's", { details: { code: 7 } }, FALLBACK],
    ["a list of refused rows", { details: ["Row 2 refused"] }, FALLBACK],
  ])("reads %s through the shared reader", async (_label, body, expected) => {
    await expect(
      readAdminQueryErrorMessage(
        new Response(JSON.stringify(body), { status: 400 }),
        FALLBACK,
      ),
    ).resolves.toBe(expected);
  });

  it.each([
    ["a body that is not JSON", new Response("<html>500</html>", { status: 500 })],
    ["a body with no details", new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 })],
    ["details that are the wrong shape", new Response(JSON.stringify({ details: { fieldErrors: { a: "not an array" } } }), { status: 400 })],
    ["blank messages only", new Response(JSON.stringify({ details: { fieldErrors: { a: ["   "] }, formErrors: [] } }), { status: 400 })],
  ])("falls back rather than showing nothing for %s", async (_label, res) => {
    await expect(readAdminQueryErrorMessage(res, FALLBACK)).resolves.toBe(
      FALLBACK,
    );
  });
});
