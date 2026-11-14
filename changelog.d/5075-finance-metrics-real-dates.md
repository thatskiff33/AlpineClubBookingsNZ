- **The finance booking metrics API now refuses a cutoff or as-of date that does not exist, such as `2026-02-30`, instead of failing with an error (#5075).**
  A `realizedCutoff` or `forwardAsOf` of a day that is not on the calendar used to pass the request check and then fail with a `500`. It is now refused with a `400` that names the field.

  The four window dates (`realizedFrom`, `realizedTo`, `forwardFrom` and `forwardTo`) were already refused with a `400` for a day that does not exist, but with a less specific message. They now give the same message as the other two, naming the field. Valid requests behave as before.
