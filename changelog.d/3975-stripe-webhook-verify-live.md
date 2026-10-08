- **Stripe setup's Webhook step can now be verified on a live-only club.** It
  used to tick only from a Stripe *test-mode* event. Stripe's dashboard no longer
  sends those to a live endpoint, so the step stayed amber ("Skipped for now")
  even while live webhooks were arriving and passing their signature check. Any
  signature-verified event, live or test, now verifies it. The hint now
  describes Stripe's current flow: in Workbench, open the endpoint, select a
  recent delivery, click **Resend** (or, for a brand-new endpoint with no
  deliveries, wait for the next real payment), then click **Re-check
  verification**. Changing the signing secret still clears the tick until an
  event verified under the new secret arrives.
