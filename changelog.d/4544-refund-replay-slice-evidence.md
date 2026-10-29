- **Delayed card refund recovery no longer repeats an evidenced refund (#4510).**
  New keyed refunds identify their exact slice in Stripe. Recovery records and
  marks a refund it finds before sending only the remaining slices, even after
  Stripe's 24-hour replay protection expires. Older refunds without this
  evidence retain their existing recovery behaviour.
