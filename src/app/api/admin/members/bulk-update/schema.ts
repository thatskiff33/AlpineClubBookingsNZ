// The request body of POST /api/admin/members/bulk-update. Moved out of
// `route.ts` unchanged (#4926, the hard ceiling on a file's length); the route
// parses with it before it does anything else.
import { z } from "zod";
import { ROLE_VALUES } from "@/lib/member-roles";

export const bulkUpdateSchema = z.object({
  ids: z.array(z.string()).min(1, "At least one member ID is required").max(100),
  action: z.enum(["deactivate", "reactivate", "set-role"]),
  role: z.enum(ROLE_VALUES).optional(),
  accessRoles: z.array(z.string().trim().min(1).max(120)).optional(),
}).refine(
  (data) =>
    data.action !== "set-role" ||
    data.role !== undefined ||
    data.accessRoles !== undefined,
  { message: "Role is required for set-role action", path: ["role"] }
);
