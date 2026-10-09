import "server-only";
import { z } from "zod";
import {
  amenitiesInputSchema,
  otherLodgeDataShape,
  otherLodgeNameSchema,
  type OtherLodgeAmenity,
  type SerializedOtherLodgeData,
} from "@/lib/other-lodges";

/**
 * The Alpine Central Server's WIRE SHAPES, as `servernz-api.ts` validates them
 * (#49 review split). Declarative only: every schema here is what one of that
 * module's request functions parses a response with, and the long comments
 * are the contract each shape carries. Nothing here makes a request, reads a
 * setting or touches the version gate, which is why this module can sit
 * beside the client without a cycle.
 */

/**
 * A lodge entry pushed up to the server: every data column (dates as
 * `YYYY-MM-DD`) and the lodge's WHOLE amenity list, which replaces the server's
 * set for that lodge. The server's item schema is `.strict()`, so this must
 * carry exactly the keys it knows — `serializeOtherLodgeData` is the one list.
 * `distribute` and provenance are never sent by clients.
 */
export type OtherLodgeUploadItem = SerializedOtherLodgeData & {
  name: string;
  amenities: OtherLodgeAmenity[];
};

export const uploadResultSchema = z.object({
  created: z.number(),
  updated: z.number(),
  // Rows the server received but left unchanged (identical to what it stored).
  // Defaulted so an older server that omits the field still validates.
  unchanged: z.number().default(0),
  skipped: z.number(),
  results: z
    .array(
      z.object({
        name: z.string(),
        status: z.enum(["created", "updated", "unchanged", "skipped"]),
        reason: z.string().optional(),
      }),
    )
    .default([]),
});
export type OtherLodgesUploadResult = z.infer<typeof uploadResultSchema>;

/**
 * A lodge as the central server sends it, held to the SAME bounds the club's own
 * officer is held to in `PATCH /api/admin/other-lodges/[id]` — literally the same
 * `otherLodgeDataShape` (name 120, location 300, officer name 200, email 320,
 * phone 50, bed capacity, double and single beds and minutes' walk each
 * 0..100000, room type `ROOM` or `DORMITORY`, booking page URL 500 and
 * `http(s)` only, cancellation period 200, season starts a real `YYYY-MM-DD`
 * calendar date, at most 50 amenities of name 120 / description 1000 with names
 * unique ignoring case).
 *
 * Matching those bounds is the point. `getPublicOtherLodges()` serves `id + name`
 * on the UNAUTHENTICATED booking-request settings endpoint, which renders on the
 * public form — so without a cap the central server controls unbounded text on
 * every connected club's public page, while the local admin typing the same row
 * is validated. Trusting the remote MORE than the local admin is the inversion.
 * The site URL is rendered as a link in the admin panel, so a scheme other than
 * `http(s)` is refused here exactly as it is from the local admin.
 *
 * It also removes a partial-merge failure mode: the text columns are
 * VarChar-capped, so an over-long value would raise a 22001 mid-loop — after
 * earlier rows were written, with no transaction around the loop and before the
 * cursor advanced. A row that fails these bounds is dropped by `pullOtherLodges`
 * instead, which costs one row rather than the rest of the batch.
 *
 * Every data field is OPTIONAL on the wire: a server that does not send one
 * (an older release, a field added later) leaves the local value alone, and is
 * never read as "set it to null/false". Absent is not the same as `null`.
 *
 * Every text field also refuses U+0000 (the shared bounded-text rule), because
 * PostgreSQL rejects it on the write with 22021 — a throw that would land
 * mid-merge, leave the cursor unmoved and re-fail on the same row every pull.
 * Refused here it costs one row, counted in `dropped`, like every other bound.
 */
export const distributedLodgeSchema = z.object({
  id: z.string().max(64),
  name: otherLodgeNameSchema,
  ...otherLodgeDataShape,
  /** When present, the lodge's WHOLE amenity set; absent leaves ours alone. */
  amenities: amenitiesInputSchema.optional(),
  updatedAt: z.string().max(64),
});

/** Upper bound on one pull, so a hostile or broken server cannot stream forever. */
const MAX_LODGES_PER_PULL = 5_000;

// No exported alias for a single distributed lodge: nothing names one on its
// own, and callers reach them through `OtherLodgesPullResult["lodges"]`.
//
// Rows arrive as `unknown` and are validated one at a time by the pull, so ONE
// bad row costs that row rather than the whole batch. `cursor` is capped at 64
// to match `ServerNzSettings.otherLodgesCursor`'s VarChar(64): an over-long
// cursor would otherwise raise P2000 AFTER the rows were written and BEFORE the
// cursor advanced, so every subsequent run would re-fetch and re-fail,
// permanently.
//
// `ownLodgeNames` (#52) is the names of the lodges the AUTHENTICATED club owns,
// which the server sends on EVERY pull, incremental or not, because it is the
// club's whole current list rather than a delta. OPTIONAL: an older server does
// not send it, and absent must survive as `undefined` so the sync leaves the
// stored list alone rather than reading "not sent" as "owns nothing". It is
// taken as `unknown` here and validated on its own by the pull: a list that
// breaks its bounds (count, or a name over the lodge-name bound) must not fail
// the WHOLE pull — the lodges still merge and the cursor still advances — it is
// treated as not sent, and reported so the sync can say so.
export const pullEnvelopeSchema = z.object({
  lodges: z.array(z.unknown()).max(MAX_LODGES_PER_PULL),
  cursor: z.string().max(64).nullable(),
  count: z.number(),
  ownLodgeNames: z.unknown().optional(),
});

export interface OtherLodgesPullResult {
  lodges: z.infer<typeof distributedLodgeSchema>[];
  cursor: string | null;
  count: number;
  /** Rows the server sent that failed the bounds above and were discarded. */
  dropped: number;
  /**
   * The lodges the server says this club owns, or `undefined` when the server
   * did not send the list (an older release). Never defaulted to `[]`: absent
   * and "owns nothing" are different answers.
   */
  ownLodgeNames: string[] | undefined;
  /** True when the server sent an owned list that failed its bounds and was discarded. */
  ownLodgeNamesRefused: boolean;
}

/** The column's VarChar(16): the bound on any version string taken off the wire. */
export const MAX_SERVER_VERSION_CHARS = 16;

export const versionResultSchema = z.object({
  version: z.string().max(MAX_SERVER_VERSION_CHARS),
  match: z.boolean().nullable(),
});

/** One image to send with a shared post. */
export interface SharedPostImage {
  /** This club's own publicId, so the server can rewrite the body's URLs. */
  publicId: string;
  mimeType: string;
  bytes: Uint8Array;
}

export const sharedPostResultSchema = z.object({
  id: z.string().min(1),
  images: z.number().int().nonnegative().optional(),
  baseUrl: z.string().optional(),
});
export type SharedPostResult = z.infer<typeof sharedPostResultSchema>;

/**
 * One post as the central server serialises it. Note what is absent: no
 * author identifiers and no email — the server never sends another club's
 * member identity, only the display name.
 */
const syncPostSchema = z.object({
  id: z.string().min(1).max(64),
  club: z.object({
    id: z.string().min(1),
    name: z.string().min(1).max(200),
    code: z.string().min(1).max(40),
  }),
  authorName: z.string().min(1).max(200),
  content: z.string().max(4000),
  bodyHtml: z.string().max(20_000).nullable().optional(),
  images: z
    .array(
      z.object({
        url: z.string().min(1).max(2000),
        width: z.number().int().nullable().optional(),
        height: z.number().int().nullable().optional(),
      }),
    )
    .max(12)
    .default([]),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type SyncPost = z.infer<typeof syncPostSchema>;

const syncChangeSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("visible"), post: syncPostSchema }),
  z.object({
    state: z.literal("removed"),
    id: z.string().min(1).max(64),
    reason: z.enum(["hidden", "removed"]),
  }),
]);

export const syncEnvelopeSchema = z.object({
  changes: z.array(syncChangeSchema).max(200),
  cursor: z
    .object({ since: z.string().min(1), sinceId: z.string().min(1) })
    .nullable()
    .optional(),
  hasMore: z.boolean().default(false),
});
export type SyncEnvelope = z.infer<typeof syncEnvelopeSchema>;

export const pushTargetResultSchema = z.object({
  url: z.string(),
  secretVersion: z.number().int().positive(),
  secret: z.string().min(32),
});
export type PushTargetResult = z.infer<typeof pushTargetResultSchema>;
