# File-size allowances for #5037

file: src/lib/admin-bookings-service.ts
lines: 1645
reason: the derived-filter pre-filter (#4939) shares the service's private
  XERO_ACTIVITY_LOCAL_MODELS and status sets with the Xero activity lookup that
  feeds the derivation it narrows, and composes into the service's chunked
  derived scan. Moving it out would export those internals and split the
  superset rule from the lookup it must mirror.
