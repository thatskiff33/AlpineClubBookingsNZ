-- #3416: a portable booking policy, defaulting OFF for existing installations.
--
-- Additive and old-code readable: the draining application neither selects nor
-- writes this column, while its existing singleton upsert omits it and receives
-- the database default. Existing rows also receive false without a data rewrite.
ALTER TABLE "BookingRequestSettings"
ADD COLUMN "assignSchoolTeachersAsHutLeaders" BOOLEAN NOT NULL DEFAULT false;
