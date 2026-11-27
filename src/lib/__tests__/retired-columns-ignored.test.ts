// #5396: retired columns stay `@ignore`d until their contract DROP, because
// only that keeps them out of every INSERT the draining colour sends
// (INV-OPS-005). The client-shape case is the drop's precondition, asserted
// against the generated client rather than the source.
//
//   - ClubModuleSettings.multiLodge (ADR-005; drop tracked downstream as
//     hoppers99/AlpineClubBookingsNZ#139)
//   - NotificationPreference.bookingWaitlist (never offered, never read)
//   - BookingRequestSettings.assignSchoolTeachersAsHutLeaders (retired by #3819
//     in favour of the per-lodge school hut-leader kinds)
//   - ServerNzSettings.otherLodgesOwnedNames (unread since triyder/AlpineClubBookingsNZ#69, central server
//     API 2.5; unwritten since #5407)
//
// Remove each entry in the release that drops its column, and the file with
// the last: once a field is gone from schema.prisma there is nothing to pin.
import fs from "node:fs";
import path from "node:path";

import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

const SCHEMA_PATH = path.join(process.cwd(), "prisma", "schema.prisma");

const RETIRED = [
  // `control` is a live column on the same model, so a wrong or empty enum
  // cannot pass vacuously.
  { model: "ClubModuleSettings", field: "multiLodge", control: "kiosk" },
  { model: "NotificationPreference", field: "bookingWaitlist", control: "bookingReminder" },
  {
    model: "BookingRequestSettings",
    field: "assignSchoolTeachersAsHutLeaders",
    control: "quoteResponseTtlDays",
  },
  { model: "ServerNzSettings", field: "otherLodgesOwnedNames", control: "otherLodgesOwnedNamesAt" },
] as const;

/**
 * The generated client's scalar fields for `model`, read when the test runs so
 * a renamed or removed model fails with this file's message, not at import.
 */
function scalarFields(model: string): string[] {
  const enumValue = (Prisma as unknown as Record<string, unknown>)[`${model}ScalarFieldEnum`];
  expect(
    enumValue,
    `Prisma.${model}ScalarFieldEnum is missing: was ${model} renamed or removed? Update this file.`,
  ).toBeTypeOf("object");
  return Object.keys(enumValue as Record<string, string>);
}

/** The body of `model <name> { ... }` in the schema text. */
function modelBody(schema: string, name: string): string {
  const start = schema.search(new RegExp(`^model\\s+${name}\\s*\\{`, "m"));
  expect(start, `model ${name} not found in prisma/schema.prisma`).toBeGreaterThan(-1);
  const end = schema.indexOf("\n}", start);
  return schema.slice(start, end);
}

describe("retired columns stay out of the generated client until they are dropped (#5396)", () => {
  const schema = fs.readFileSync(SCHEMA_PATH, "utf8");

  for (const { model, field, control } of RETIRED) {
    it(`the generated client has no ${model}.${field}`, () => {
      const scalars = scalarFields(model);
      expect(scalars).toContain(control);
      expect(
        scalars,
        `${model}.${field} must stay \`@ignore\`d until its contract DROP (INV-OPS-005).`,
      ).not.toContain(field);
    });

    it(`the schema still declares ${model}.${field}, @ignore'd, while the column exists`, () => {
      // Deleting the field without the DROP migration would fail the drift gate;
      // this says why the line is still there. Only the attribute counts: a
      // trailing `// ... @ignore ...` comment is not one.
      const line = modelBody(schema, model)
        .split("\n")
        .find((candidate) => new RegExp(`^\\s*${field}\\s`).test(candidate));
      expect(line, `${model}.${field} is missing from prisma/schema.prisma`).toBeDefined();
      const attributes = (line ?? "").split("//")[0];
      expect(attributes).toMatch(/@ignore\b/);
    });
  }
});
