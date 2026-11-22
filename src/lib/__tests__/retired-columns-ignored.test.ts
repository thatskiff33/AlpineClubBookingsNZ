// #5396: two retired columns are `@ignore`d one release before they are dropped.
//
//   - ClubModuleSettings.multiLodge (ADR-005; drop tracked downstream as
//     hoppers99/AlpineClubBookingsNZ#139)
//   - NotificationPreference.bookingWaitlist (never offered, never read)
//
// Why `@ignore` and not only "nothing names the field": Prisma sends every
// column with a static `@default` in an INSERT's column list, even for a call
// that sets no value and narrows itself with `select` (the #2520 row of
// docs/BLUE_GREEN_MIGRATION_SAFETY.tsv). So while the field is in the client,
// every create or upsert of the model names the column, and a DROP would break
// the draining colour's writes. `@ignore` removes the field from the generated
// client, which keeps it out of every INSERT, SELECT and RETURNING.
//
// These tests pin the contract migration's precondition against the generated
// client, not the source. DELETE THIS FILE in the release that drops the two
// columns: once the fields are gone from schema.prisma there is nothing to pin.
import fs from "node:fs";
import path from "node:path";

import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

const SCHEMA_PATH = path.join(process.cwd(), "prisma", "schema.prisma");

const RETIRED = [
  {
    model: "ClubModuleSettings",
    field: "multiLodge",
    scalars: Object.keys(Prisma.ClubModuleSettingsScalarFieldEnum),
    // A live column on the same model, so a wrong or empty enum cannot pass.
    control: "kiosk",
  },
  {
    model: "NotificationPreference",
    field: "bookingWaitlist",
    scalars: Object.keys(Prisma.NotificationPreferenceScalarFieldEnum),
    control: "bookingReminder",
  },
] as const;

/** The body of `model <name> { ... }` in the schema text. */
function modelBody(schema: string, name: string): string {
  const start = schema.search(new RegExp(`^model\\s+${name}\\s*\\{`, "m"));
  expect(start, `model ${name} not found in prisma/schema.prisma`).toBeGreaterThan(-1);
  const end = schema.indexOf("\n}", start);
  return schema.slice(start, end);
}

describe("retired columns stay out of the generated client until they are dropped (#5396)", () => {
  const schema = fs.readFileSync(SCHEMA_PATH, "utf8");

  for (const { model, field, scalars, control } of RETIRED) {
    it(`the generated client has no ${model}.${field}`, () => {
      expect(scalars).toContain(control);
      expect(
        scalars,
        `${model}.${field} must stay \`@ignore\`d until its contract DROP. Without it the ` +
          "client sends the column's static @default in every INSERT, and the DROP stops " +
          "being old-code compatible.",
      ).not.toContain(field);
    });

    it(`the schema still declares ${model}.${field}, @ignore'd, while the column exists`, () => {
      // Deleting the field without the DROP migration would fail the drift gate;
      // this says why the line is still there.
      const line = modelBody(schema, model)
        .split("\n")
        .find((candidate) => new RegExp(`^\\s*${field}\\s`).test(candidate));
      expect(line, `${model}.${field} is missing from prisma/schema.prisma`).toBeDefined();
      expect(line).toMatch(/@ignore\b/);
    });
  }
});
