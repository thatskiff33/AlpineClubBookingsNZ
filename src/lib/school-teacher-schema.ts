/**
 * One stored-teacher shape for the strict school acting path and tolerant admin
 * queue read. A malformed teacher row must never look valid in one of them and
 * disappear in the other (#3485, INV-SSOT-001).
 */
import { z } from "zod";

import { nameField } from "@/lib/zod-helpers";

export const schoolTeacherSchema = z.object({
  firstName: nameField(),
  lastName: nameField(),
  // PIN email goes here when present; otherwise it falls back to the school
  // contact email at approval time.
  email: z.string().email().max(200).optional().nullable(),
});

export const storedSchoolTeacherListSchema = z.array(schoolTeacherSchema);
