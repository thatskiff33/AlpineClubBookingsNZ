- **The finance booking metrics API now refuses a date that does not exist, such as `2026-02-30`, with a `400`.**
  A non-existent `realizedCutoff` or `forwardAsOf` used to fail with a `500`; every date field now names the bad field in the response.
