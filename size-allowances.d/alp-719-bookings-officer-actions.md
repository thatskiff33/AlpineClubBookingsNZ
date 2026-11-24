# Size allowances for ALP-719 (Bookings & Beds AI app actions)

file: src/app/api/admin/booking-policies/minimum-stay/[id]/route.ts
lines: 290
reason: the route is now also a Bookings & Beds AI app action (ALP-719).
  It gains the imports of its shared schema and connection shape and answers
  through `connectionJson`, so a connection receives only the named fields
  (`INV-MCP-006`). The route was already at or over its limit; splitting it
  is a refactor of its own, not part of this change.

file: src/app/api/admin/bookings/[id]/capacity-hold/route.ts
lines: 369
reason: the route is now also a Bookings & Beds AI app action (ALP-719).
  It gains the imports of its shared schema and connection shape and answers
  through `connectionJson`, so a connection receives only the named fields
  (`INV-MCP-006`). The route was already at or over its limit; splitting it
  is a refactor of its own, not part of this change.

file: src/app/api/admin/bookings/[id]/exclusive-hold/route.ts
lines: 435
reason: the route is now also a Bookings & Beds AI app action (ALP-719).
  It gains the imports of its shared schema and connection shape and answers
  through `connectionJson`, so a connection receives only the named fields
  (`INV-MCP-006`). The route was already at or over its limit; splitting it
  is a refactor of its own, not part of this change.

file: src/app/api/admin/bookings/[id]/force-confirm/route.ts
lines: 381
reason: the route is now also a Bookings & Beds AI app action (ALP-719).
  It gains the imports of its shared schema and connection shape and answers
  through `connectionJson`, so a connection receives only the named fields
  (`INV-MCP-006`). The route was already at or over its limit; splitting it
  is a refactor of its own, not part of this change.

file: src/app/api/admin/bookings/[id]/return-to-waitlist/route.ts
lines: 414
reason: the route is now also a Bookings & Beds AI app action (ALP-719).
  It gains the imports of its shared schema and connection shape and answers
  through `connectionJson`, so a connection receives only the named fields
  (`INV-MCP-006`). The route was already at or over its limit; splitting it
  is a refactor of its own, not part of this change.

file: src/app/api/admin/bookings/search/route.ts
lines: 280
reason: the route is now also a Bookings & Beds AI app action (ALP-719).
  It gains the imports of its shared schema and connection shape and answers
  through `connectionJson`, so a connection receives only the named fields
  (`INV-MCP-006`). The route was already at or over its limit; splitting it
  is a refactor of its own, not part of this change.

file: src/app/api/admin/promo-codes/[id]/redemptions/route.ts
lines: 396
reason: the route is now also a Bookings & Beds AI app action (ALP-719).
  It gains the imports of its shared schema and connection shape and answers
  through `connectionJson`, so a connection receives only the named fields
  (`INV-MCP-006`). The route was already at or over its limit; splitting it
  is a refactor of its own, not part of this change.

function: src/app/api/admin/bookings/[id]/exclusive-hold/route.ts#POST
lines: 380
reason: the route is now also a Bookings & Beds AI app action (ALP-719).
  It gains the imports of its shared schema and connection shape and answers
  through `connectionJson`, so a connection receives only the named fields
  (`INV-MCP-006`). The handler was already at or over its limit; splitting it
  is a refactor of its own, not part of this change.

function: src/app/api/admin/bookings/[id]/force-confirm/route.ts#POST
lines: 333
reason: the route is now also a Bookings & Beds AI app action (ALP-719).
  It gains the imports of its shared schema and connection shape and answers
  through `connectionJson`, so a connection receives only the named fields
  (`INV-MCP-006`). The handler was already at or over its limit; splitting it
  is a refactor of its own, not part of this change.

function: src/app/api/admin/promo-codes/[id]/redemptions/route.ts#GET
lines: 346
reason: the route is now also a Bookings & Beds AI app action (ALP-719).
  It gains the imports of its shared schema and connection shape and answers
  through `connectionJson`, so a connection receives only the named fields
  (`INV-MCP-006`). The handler was already at or over its limit; splitting it
  is a refactor of its own, not part of this change.
