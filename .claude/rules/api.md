## API Rules (applies to src/app/api/**)

- Validate all inputs with Zod schemas
- Return consistent error shape: { error: string, details?: any }
- Always check auth via auth() helper before processing
- Admin routes must verify role === ADMIN
- Stripe webhooks: always verify signature before processing
- Xero webhooks: verify intent-to-receive pattern
- Never trust client-side price calculations - always recalculate server-side
- Use advisory locks (pg_advisory_lock) for booking creation to prevent double-booking
- All API routes should handle errors gracefully and return appropriate HTTP status codes
