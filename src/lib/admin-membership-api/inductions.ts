/**
 * The induction routes' request schemas (`/api/admin/inductions/**`), shared
 * with the AI app actions that call them (ALP-720, `INV-SSOT`): the app is
 * described exactly the fields the route enforces.
 */
import { z } from "zod";

import {
  INDUCTION_KIND_LABELS,
  INDUCTION_STATUS_LABELS,
  type InductionKind,
  type InductionStatus,
} from "@/lib/induction-display";

const inductionKind = z.enum(Object.keys(INDUCTION_KIND_LABELS) as [InductionKind, ...InductionKind[]]);
const inductionStatus = z.enum(Object.keys(INDUCTION_STATUS_LABELS) as [InductionStatus, ...InductionStatus[]]);

/** The most inductions the register sends, newest first. */
export const INDUCTION_REGISTER_LIMIT = 500;

/** The most signers one induction may be assigned. */
export const MAX_ASSIGNED_INDUCTION_SIGNERS = 10;

const signerMemberIds = z.array(z.string().min(1)).max(MAX_ASSIGNED_INDUCTION_SIGNERS);

/** `GET /api/admin/inductions`: an empty filter is no filter. */
export const inductionListQuerySchema = z.object({
  status: z.union([inductionStatus, z.literal("")]).optional(),
  kind: z.union([inductionKind, z.literal("")]).optional(),
  search: z.string().trim().max(200).optional(),
});

/** `POST /api/admin/inductions`: `kind` defaults to a re-induction. */
export const createInductionSchema = z.object({
  memberId: z.string().min(1),
  kind: inductionKind.optional(),
  signerMemberIds: signerMemberIds.optional(),
});

/** `PATCH /api/admin/inductions/[id]` `OVERRIDE_COMPLETE`: completes it without the sign-offs. */
export const overrideCompleteInductionSchema = z.object({
  action: z.literal("OVERRIDE_COMPLETE"),
  comments: z.string().trim().max(2000).optional().nullable(),
});

/** `PATCH /api/admin/inductions/[id]` `VOID`. */
export const voidInductionSchema = z.object({
  action: z.literal("VOID"),
  reason: z.string().trim().min(3).max(2000),
});

/** `PATCH /api/admin/inductions/[id]` `REASSIGN_SIGNERS`: the list replaces the assigned signers. */
export const reassignInductionSignersSchema = z.object({
  action: z.literal("REASSIGN_SIGNERS"),
  signerMemberIds,
});

/** `PATCH /api/admin/inductions/[id]`. */
export const inductionPatchSchema = z.discriminatedUnion("action", [
  overrideCompleteInductionSchema,
  voidInductionSchema,
  reassignInductionSignersSchema,
]);
