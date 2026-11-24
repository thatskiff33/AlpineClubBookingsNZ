/**
 * Route-level checks of the invalid-JSON answer (#5407). A route reads its body
 * through the shared readers in `src/lib/api-json.ts`; these helpers assert
 * that a body which is present but not valid JSON gets the shared default 400,
 * byte for byte, without restating its text here.
 */
import { expect } from "vitest";
import { invalidJsonBodyResponse } from "@/lib/api-json";

/** A request body that is present but is not valid JSON. */
export const MALFORMED_JSON_BODY = "{not json";

/** The route answered with the shared default invalid-JSON 400, exactly. */
export async function expectDefaultInvalidJsonAnswer(
  response: Response,
): Promise<void> {
  expect(response.status).toBe(400);
  expect(await response.text()).toBe(await invalidJsonBodyResponse().text());
}
