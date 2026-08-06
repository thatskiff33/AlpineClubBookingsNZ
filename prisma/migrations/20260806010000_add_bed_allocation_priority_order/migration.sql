-- Per-lodge ordered soft preferences for bed allocation (#2593).
--
-- Additive EXPAND only. The constant database default gives old-colour INSERTs
-- the same canonical order used by the new application while the column is
-- absent from every old-colour SELECT/UPDATE. Existing rows receive the same
-- value without an application backfill. See the blue/green ledger entry.
ALTER TABLE "BedAllocationSettings"
ADD COLUMN "allocationPriorityOrder" TEXT[] NOT NULL
DEFAULT ARRAY[
  'BOOKING_COHESION',
  'STAY_CONTINUITY',
  'REQUESTED_ROOM',
  'FAMILY_COHESION'
]::TEXT[];
