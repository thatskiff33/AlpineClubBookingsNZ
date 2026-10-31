# File-size allowance for #4470

file: src/app/api/admin/integrations/credentials/route.ts
lines: 338
reason: the Alpine Central Server key save now names the address its setup
  page showed. The route is where the request body is parsed and every
  credential kind is dispatched, so the one new field, its "this key only"
  check and the 409 mapping sit beside the allowlist and the other kinds'
  capture-time gates they belong with; the comparison itself lives in
  `setServerNzApiKey` under the connection fence. Splitting the route's
  dispatch for seventeen lines would move one provider's rule away from the
  allowlist that names it.
