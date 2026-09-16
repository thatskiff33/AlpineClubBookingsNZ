BEGIN;

-- #3366 (stage 1 of programme #2912, child of MAD epic #2725): give a school a
-- record of its own, linked from its bookings. EXPAND ONLY, AND DELIBERATELY
-- INERT.
--
-- Everything here is additive: two new enum types, two new tables, and one
-- NULLABLE column on each of "Booking" and "BookingRequest". Nothing is
-- dropped, nothing is made NOT NULL, no stored value is rewritten, and no
-- existing column changes its meaning. "Booking"."memberId" stays NOT NULL and
-- keeps pointing at the same row it points at today; making it optional is
-- stage 4 (#3369) and is a windowed migration of its own.
--
-- OLD-CODE COMPATIBLE against the PRE-EPIC release, which is the client the
-- draining colour runs (docs/BLUE_GREEN_MIGRATION_POLICY.md -> "An epic's
-- migrations arrive together"). Prisma names its columns explicitly, so the old
-- client never selects "organisationId" and never sees the new tables; its
-- INSERTs omit the column, which a nullable column with no default accepts.
-- Rehearsed rather than asserted with `npm run db:rehearse-epic`.
--
-- NO CONTRACT HALF IS PAIRED WITH THIS EXPAND: "Role"."SCHOOL" and
-- "AccessRole"."ORG" keep every value and every writer they have today. Inside
-- one deploy nothing has drained, so a contract release can only come after the
-- epic merges.

CREATE TYPE "OrganisationKind" AS ENUM ('SCHOOL');

CREATE TYPE "OrganisationContactRole" AS ENUM ('TEACHER', 'CONTACT');

-- The school itself: a durable identity the club can hold across years, across
-- bookings and across a change of teacher, with its OWN Xero customer link so a
-- person's personal contact is never renamed or reused as the school.
CREATE TABLE "Organisation" (
    "id" TEXT NOT NULL,
    "kind" "OrganisationKind" NOT NULL DEFAULT 'SCHOOL',
    "name" VARCHAR(200) NOT NULL,
    "xeroContactId" TEXT,
    "email" VARCHAR(200),
    "phone" VARCHAR(30),
    "notes" VARCHAR(2000),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organisation_pkey" PRIMARY KEY ("id")
);

-- The people who speak for an organisation. The person stays a plain "Member";
-- this row carries the relationship, which is why "Member"."role" is not
-- overloaded as organisation identity.
CREATE TABLE "OrganisationContact" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "role" "OrganisationContactRole" NOT NULL DEFAULT 'CONTACT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganisationContact_pkey" PRIMARY KEY ("id")
);

-- One provider contact can never be claimed by two organisations, exactly as
-- "Member"."xeroContactId" is unique.
CREATE UNIQUE INDEX "Organisation_xeroContactId_key" ON "Organisation"("xeroContactId");

CREATE INDEX "Organisation_kind_name_idx" ON "Organisation"("kind", "name");

CREATE INDEX "Organisation_archivedAt_idx" ON "Organisation"("archivedAt");

CREATE INDEX "OrganisationContact_memberId_idx" ON "OrganisationContact"("memberId");

CREATE INDEX "OrganisationContact_organisationId_role_idx" ON "OrganisationContact"("organisationId", "role");

-- One association row per (organisation, person): the capacity lives in "role",
-- so "is this person attached to that school" has exactly one answer.
CREATE UNIQUE INDEX "OrganisationContact_organisationId_memberId_key" ON "OrganisationContact"("organisationId", "memberId");

-- The optional links. Nullable is what keeps the draining colour working.
ALTER TABLE "Booking" ADD COLUMN     "organisationId" TEXT;

ALTER TABLE "BookingRequest" ADD COLUMN     "organisationId" TEXT;

CREATE INDEX "Booking_organisationId_idx" ON "Booking"("organisationId");

CREATE INDEX "BookingRequest_organisationId_idx" ON "BookingRequest"("organisationId");

-- RESTRICT, not SET NULL: from stage 4 this column is the booking's OWNER, and
-- silently nulling an owner is the one failure a deletion must not cause. It
-- matches "Booking"."otherLodgeId" and "BookingRequest"."otherLodgeId", which
-- are RESTRICT for the same reason.
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BookingRequest" ADD CONSTRAINT "BookingRequest_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CASCADE on both sides of the association: the row carries no history of its
-- own, so when either end goes the association is simply no longer true.
ALTER TABLE "OrganisationContact" ADD CONSTRAINT "OrganisationContact_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OrganisationContact" ADD CONSTRAINT "OrganisationContact_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
