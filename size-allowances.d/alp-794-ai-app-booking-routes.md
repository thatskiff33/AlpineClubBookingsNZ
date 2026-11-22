# Size allowances for ALP-794 (AI app booking actions)

Each route below gains the lines that let an AI app connection call it safely:
officer reach decided on `memberOnlySessionUser`, the answer sent through
`connectionJson` with its allow-list shape, and a comment naming the action.
Those checks belong beside the branch they guard; moving them out would put a
route's authority decision in a different file from the route. Every file was
already over its limit, and splitting it is a refactor of its own. The action
catalogue itself was split instead (`src/lib/mcp/catalogue-bookings.ts`),
and `modify-quote/route.ts`, past its hard ceiling, absorbed its lines.

file: src/app/api/bookings/[id]/arrival-time/route.ts
lines: 374
reason: both writers decide on the member-only user and answer a connection
  with the arrival-time shape.

file: src/app/api/bookings/[id]/change-requests/route.ts
lines: 560
reason: the read and the create decide on the member-only user, refuse a
  connection the officer-only fields, and answer with their shapes.

file: src/app/api/bookings/[id]/refund-request/route.ts
lines: 323
reason: the read and the create decide on the member-only user, take their
  schema from refund-appeal-request.ts, and answer with their shapes.

file: src/app/api/bookings/[id]/waitlist-confirm/route.ts
lines: 606
reason: the accept decides on the member-only user and answers a connection
  with the accepted-offer shape.

function: src/app/api/bookings/quote/route.ts#POST
lines: 397
reason: the member-only authority for the on-behalf check, one more line
  than the role it replaces.

function: src/app/api/promo-codes/validate/route.ts#POST
lines: 384
reason: the member-only authority for the on-behalf and officer checks and
  the connection answer.
