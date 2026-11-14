- **Load tests cover more of a busy booking day (#4940).** The disposable test
  stack can seed thousands of members and five years of seasons of booking
  history. New scenarios cover card payments with a local Stripe stub, booking
  changes and cancellations across lodges, admin reads, and cron work alongside
  members. A weekly advisory smoke run saves summaries without using live
  providers. The guide records the corrected historical results and states which
  journeys remain unmeasured; full 100-user runs still require the owner.
