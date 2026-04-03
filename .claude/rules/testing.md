## Testing Rules (applies to **/*.test.*)

- Use Vitest for all tests
- Test business logic thoroughly: pricing engine, availability calculator, bumping algorithm, chore allocator
- Mock external services (Stripe, Xero, email) in tests - never call real APIs
- Every new lib/ function should have corresponding tests
- Test edge cases: overlapping bookings, capacity limits, season boundaries, promo code expiry
- Use factories/fixtures for test data, not inline object literals repeated everywhere
- Integration tests should use a test database, not mock Prisma
