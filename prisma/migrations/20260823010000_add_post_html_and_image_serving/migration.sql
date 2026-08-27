-- Communication Portal federation (epic #2992): rich post bodies, and the
-- columns the image-serving route needs.
--
-- EXPAND PHASE. Every statement is additive: two nullable columns on
-- "ClubPost", and four columns on "ClubPostImage". Nothing is dropped,
-- renamed or retyped, and neither table is on the hot list.

-- AlterTable: the sanitised rich body the WYSIWYG composer writes.
-- Nullable, because "content" stays authoritative for every post written
-- before the editor existed and for anything whose HTML sanitised to nothing.
ALTER TABLE "ClubPost" ADD COLUMN "bodyHtml" VARCHAR(20000);

-- AlterTable: "ClubPostImage".
--
-- "publicId", "mimeType" and "sha256" are NOT NULL WITHOUT A DEFAULT, which
-- would abort on a table that had rows. This table provably has none: it was
-- created by 20260822010000 and no code path has ever inserted into it —
-- images were declared in that migration and never implemented, so there is
-- no writer in any released version to have filled it. A default would be
-- worse than the abort: it would let a row exist with a shared placeholder
-- publicId, and publicId is a capability — two rows sharing one would make
-- one member's image reachable from another's address.
--
-- Old code continues to work throughout the cutover because old code does not
-- touch this table at all.
ALTER TABLE "ClubPostImage" ADD COLUMN "publicId" VARCHAR(64) NOT NULL;
ALTER TABLE "ClubPostImage" ADD COLUMN "mimeType" VARCHAR(40) NOT NULL;
ALTER TABLE "ClubPostImage" ADD COLUMN "sha256" VARCHAR(64) NOT NULL;

-- Dimensions become optional: they are read opportunistically from the file,
-- and a format this deployment cannot measure must not block a member's post.
ALTER TABLE "ClubPostImage" ALTER COLUMN "width" DROP NOT NULL;
ALTER TABLE "ClubPostImage" ALTER COLUMN "height" DROP NOT NULL;

-- The serving route looks an image up by publicId alone, so this index is the
-- read path as well as the uniqueness guarantee.
CREATE UNIQUE INDEX "ClubPostImage_publicId_key" ON "ClubPostImage"("publicId");

-- An image is uploaded BEFORE the post that will carry it exists, so its post
-- link starts null and is claimed on submit. Widening a NOT NULL column to
-- nullable is `DROP NOT NULL` — a catalog metadata flip, no heap rewrite — and
-- it only ever widens what the column may hold, so no existing read breaks.
ALTER TABLE "ClubPostImage" ALTER COLUMN "postId" DROP NOT NULL;

-- Who uploaded it. Deliberately a bare column with NO foreign key, matching
-- "MediaImage"."uploadedByMemberId": it is an audit snapshot rather than a live
-- link, so a member merge leaves it pointing at the id that actually uploaded,
-- and it puts no validating constraint on the hot "Member" table.
ALTER TABLE "ClubPostImage" ADD COLUMN "uploadedByMemberId" TEXT;
