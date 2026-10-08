- **Stripe setup's Webhook step can now be verified on a live-only club.** It
  used to tick only from a Stripe *test-mode* event. Stripe's dashboard no longer
  sends those to a live endpoint, so the step stayed amber ("Skipped for now")
  even while live webhooks were arriving and passing their signature check. Any
  signature-verified event, live or test, now verifies it. The hint now
  describes Stripe's current flow: in Workbench → Webhooks (Developers →
  Webhooks), select the endpoint and a recent delivery and click **Resend** —
  or, if it has none yet, make a payment (a test payment in test mode) — then
  click **Re-check verification**. Changing the signing secret still clears the tick until an
  event verified under the new secret arrives.
