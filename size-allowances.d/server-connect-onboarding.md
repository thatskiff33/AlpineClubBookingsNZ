# File-size allowances for the server connection onboarding

file: src/app/api/admin/integrations/credentials/route.ts
lines: 331
reason: saving the Alpine Central Server key now registers this site's
  address and returns the outcome. The registration itself and its error
  handling live in `club-post-mirror.ts` (`registerAfterKeySave`); what stays
  here is the one call after the key's transaction commits and the field in
  the response, because this route is where the key save completes and where
  the page reads its answer. A second route would need a second request from
  the page and could run against a key it did not save.
