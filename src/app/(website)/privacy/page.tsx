import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "How the Tokoroa Alpine Club collects, uses, and protects your personal information under the New Zealand Privacy Act 2020.",
};

const LAST_UPDATED = "1 April 2026";
const EFFECTIVE_DATE = "1 April 2026";

export default function PrivacyPage() {
  return (
    <>
      <section className="bg-gradient-to-br from-brand-charcoal to-brand-deep py-16 text-brand-snow sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <span className="website-eyebrow mb-4">Policy</span>
          <h1 className="font-heading text-4xl font-bold tracking-tight sm:text-5xl">
            Privacy Policy
          </h1>
          <p className="mt-4 max-w-2xl text-lg text-brand-snow/80">
            How we collect, use, and protect your personal information.
          </p>
          <p className="mt-2 text-sm text-brand-snow/60">
            Effective {EFFECTIVE_DATE} &mdash; Last updated {LAST_UPDATED}
          </p>
        </div>
      </section>

      <section className="bg-brand-snow py-16 sm:py-20">
        <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
          <div className="website-legal-copy">

            <div>
              <h2>1. Who We Are</h2>
              <p>
                The Tokoroa Alpine Club Incorporated (&ldquo;we&rdquo;, &ldquo;us&rdquo;, &ldquo;our&rdquo;) is a not-for-profit
                incorporated society registered in New Zealand. We operate Waldvogel Lodge at Iwikau
                Village, Mt Ruapehu, and this booking and membership management system (&ldquo;the
                System&rdquo;).
              </p>
              <p className="mt-3">
                We are committed to protecting your personal information and complying with the{" "}
                <strong>New Zealand Privacy Act 2020</strong> and its 13 Information Privacy Principles
                (IPPs).
              </p>
            </div>

            <div>
              <h2>2. What Information We Collect</h2>
              <p>We collect the following categories of personal information:</p>
              <ul className="list-disc pl-6 mt-3 space-y-2">
                <li>
                  <strong>Identity and contact details:</strong> First and last name, email address,
                  phone number, date of birth.
                </li>
                <li>
                  <strong>Account credentials:</strong> Hashed password (we never store your password in
                  plain text).
                </li>
                <li>
                  <strong>Booking information:</strong> Dates of stay, guest names and age groups,
                  member/non-member status.
                </li>
                <li>
                  <strong>Payment information:</strong> Payment status, Stripe payment reference IDs.
                  We do <em>not</em> store full card numbers &mdash; payment card data is handled
                  directly by Stripe.
                </li>
                <li>
                  <strong>Membership information:</strong> Membership subscription status, season year,
                  Xero invoice references.
                </li>
                <li>
                  <strong>Chore roster data:</strong> Chore assignments linked to your lodge stays.
                </li>
                <li>
                  <strong>Communication records:</strong> Emails sent to you by the system (booking
                  confirmations, reminders, notifications).
                </li>
                <li>
                  <strong>System usage logs:</strong> IP addresses and request logs for security and
                  troubleshooting purposes.
                </li>
              </ul>
              <p className="mt-3">
                We collect only the information necessary for managing club membership and lodge
                bookings (IPP 1 &mdash; Purpose of collection).
              </p>
            </div>

            <div>
              <h2>3. How We Collect Information</h2>
              <p>We collect your information:</p>
              <ul className="list-disc pl-6 mt-3 space-y-2">
                <li>Directly from you when you register an account, make a booking, or contact us.</li>
                <li>
                  From Xero, our accounting platform, when we import membership and subscription
                  information.
                </li>
                <li>Automatically through the System when you log in and use the booking features.</li>
              </ul>
              <p className="mt-3">
                Where we collect information from you, we will tell you why we are collecting it at the
                point of collection (IPP 3 &mdash; Collection of information from subject).
              </p>
            </div>

            <div>
              <h2>4. How We Use Your Information</h2>
              <p>We use your personal information to:</p>
              <ul className="list-disc pl-6 mt-3 space-y-2">
                <li>Create and manage your member account.</li>
                <li>Process and manage lodge bookings.</li>
                <li>Process payments and issue refunds through Stripe.</li>
                <li>Manage membership subscriptions and invoicing through Xero.</li>
                <li>Send you booking confirmations, reminders, and other transactional emails.</li>
                <li>Assign chore roster duties during your lodge stays.</li>
                <li>Maintain financial and membership records as required by law.</li>
                <li>Ensure the security and integrity of the System.</li>
              </ul>
              <p className="mt-3">
                We will only use your information for the purposes for which it was collected, or for
                directly related purposes (IPP 10 &mdash; Limits on use of personal information).
              </p>
            </div>

            <div>
              <h2>5. Who We Share Your Information With</h2>
              <p>
                We share your personal information with the following third-party service providers
                where necessary to operate the System:
              </p>
              <ul className="list-disc pl-6 mt-3 space-y-2">
                <li>
                  <strong>Stripe Inc.</strong> &mdash; Payment processing. Stripe receives payment card
                  details and processes transactions on our behalf. Stripe is PCI-DSS compliant.
                  See{" "}
                  <a
                    href="https://stripe.com/en-nz/privacy"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="website-link"
                  >
                    Stripe&apos;s Privacy Policy
                  </a>
                  .
                </li>
                <li>
                  <strong>Xero Limited</strong> &mdash; Accounting and invoicing. Your name, email, and
                  membership subscription status are synchronised with Xero to manage invoices and verify
                  membership. Xero is headquartered in New Zealand.
                  See{" "}
                  <a
                    href="https://www.xero.com/nz/about/policies/privacy/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="website-link"
                  >
                    Xero&apos;s Privacy Policy
                  </a>
                  .
                </li>
                <li>
                  <strong>Amazon Web Services (AWS) &mdash; Simple Email Service (SES)</strong> &mdash;
                  Transactional email delivery. Your email address is used to send you booking
                  confirmations and notifications. AWS SES operates within AWS&apos;s secure infrastructure.
                  See{" "}
                  <a
                    href="https://aws.amazon.com/privacy/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="website-link"
                  >
                    AWS Privacy Notice
                  </a>
                  .
                </li>
                <li>
                  <strong>Amazon Web Services (AWS) &mdash; Lightsail and S3</strong> &mdash; Our
                  application and database are hosted on AWS Lightsail in the Asia Pacific (Sydney) region.
                  Automated database backups are stored in AWS S3. Your data remains within AWS
                  infrastructure.
                </li>
              </ul>
              <p className="mt-3">
                We do not sell, rent, or trade your personal information to any third party for
                marketing or other unrelated purposes (IPP 11 &mdash; Limits on disclosure of personal
                information).
              </p>
              <p className="mt-3">
                Where we disclose information to overseas recipients (Stripe, AWS), we take reasonable
                steps to ensure those recipients are required to protect the information consistently
                with the Privacy Act 2020 (IPP 12 &mdash; Disclosure of information outside New
                Zealand).
              </p>
            </div>

            <div>
              <h2>6. How We Store and Protect Your Information</h2>
              <ul className="list-disc pl-6 mt-3 space-y-2">
                <li>
                  Your data is stored in a PostgreSQL database hosted on AWS Lightsail in the
                  Asia Pacific (Sydney) region.
                </li>
                <li>Passwords are hashed using bcrypt before storage &mdash; we cannot see your password.</li>
                <li>
                  Sensitive tokens (such as Xero OAuth tokens) are encrypted using AES-256-GCM
                  before storage.
                </li>
                <li>
                  All communication between your browser and our servers uses HTTPS with automatic
                  TLS certificates.
                </li>
                <li>
                  Database backups are encrypted and stored in AWS S3 with restricted access.
                </li>
                <li>
                  We use security headers (Content Security Policy, HSTS, etc.) to protect
                  against common web attacks.
                </li>
              </ul>
              <p className="mt-3">
                We take reasonable steps to protect your personal information from unauthorised access,
                disclosure, or misuse (IPP 5 &mdash; Storage and security of personal information).
              </p>
            </div>

            <div>
              <h2>7. How Long We Keep Your Information</h2>
              <ul className="list-disc pl-6 mt-3 space-y-2">
                <li>
                  <strong>Active member accounts:</strong> Retained for as long as you remain a member
                  or have an active account.
                </li>
                <li>
                  <strong>Booking and payment records:</strong> Retained for 7 years as required by New
                  Zealand tax law (Income Tax Act 2007).
                </li>
                <li>
                  <strong>Email logs:</strong> Retained for 90 days for troubleshooting, then
                  automatically deleted.
                </li>
                <li>
                  <strong>System audit logs:</strong> Retained for 90 days, then automatically pruned.
                </li>
                <li>
                  <strong>Password reset and verification tokens:</strong> Automatically deleted after
                  use or expiry (1&ndash;24 hours).
                </li>
              </ul>
              <p className="mt-3">
                We do not keep personal information for longer than is necessary for the purpose for
                which it was collected (IPP 9 &mdash; Retention of personal information).
              </p>
            </div>

            <div>
              <h2>8. Your Rights</h2>
              <p>Under the Privacy Act 2020, you have the right to:</p>
              <ul className="list-disc pl-6 mt-3 space-y-2">
                <li>
                  <strong>Access your information (IPP 6):</strong> Request a copy of the personal
                  information we hold about you. You can download your data from your{" "}
                  <Link href="/profile" className="website-link">
                    Profile page
                  </Link>
                  .
                </li>
                <li>
                  <strong>Correct your information (IPP 7):</strong> Request that inaccurate information
                  be corrected. You can update your profile details directly, or contact us for
                  assistance.
                </li>
                <li>
                  <strong>Request deletion:</strong> Request deletion of your account and personal data
                  from your Profile page. Note that some financial records must be retained for legal
                  compliance.
                </li>
                <li>
                  <strong>Complain:</strong> If you believe we have breached the Privacy Act 2020, you
                  may complain to us first, or directly to the{" "}
                  <a
                    href="https://www.privacy.org.nz/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="website-link"
                  >
                    Office of the Privacy Commissioner
                  </a>
                  .
                </li>
              </ul>
            </div>

            <div>
              <h2>9. Cookies and Tracking</h2>
              <p>
                This System uses a single session cookie to keep you logged in. This cookie contains an
                encrypted session token and no personal information. We do not use advertising cookies,
                third-party tracking, or analytics cookies. The session cookie expires after 8 hours of
                inactivity or when you sign out.
              </p>
            </div>

            <div>
              <h2>10. Changes to This Policy</h2>
              <p>
                We may update this Privacy Policy from time to time. When we do, we will update the
                &ldquo;Last updated&rdquo; date at the top of this page. Continued use of the System
                after any changes constitutes acceptance of the updated policy.
              </p>
            </div>

            <div>
              <h2>11. Contact Our Privacy Officer</h2>
              <p>
                For any questions or concerns about this Privacy Policy, or to exercise your privacy
                rights, please contact our Privacy Officer:
              </p>
              <div className="website-legal-callout">
                <p className="font-semibold text-brand-charcoal">Privacy Officer</p>
                <p className="text-brand-deep">Tokoroa Alpine Club Incorporated</p>
                <p className="mt-2">
                  Please use our{" "}
                  <Link href="/contact?recipient=secretary" className="website-link">
                    contact form
                  </Link>
                  .
                </p>
              </div>
            </div>

          </div>
        </div>
      </section>
    </>
  );
}
