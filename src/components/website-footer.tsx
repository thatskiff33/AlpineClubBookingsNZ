import Link from "next/link";
import { WebsiteLogo } from "@/components/website-logo";
import { CLUB_FACEBOOK_URL, CLUB_NAME, CLUB_PUBLIC_URL } from "@/config/club-identity";

export function WebsiteFooter({ logoDataUrl }: { logoDataUrl?: string | null }) {
  return (
    <footer className="border-t border-brand-gold/15 bg-brand-charcoal text-brand-snow/90">
      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 gap-8 md:grid-cols-3">
          {/* Club info */}
          <div>
            <div className="mb-3">
              <WebsiteLogo
                label={CLUB_NAME}
                logoDataUrl={logoDataUrl}
                className="max-h-10 max-w-40 brightness-110"
                textClassName="text-brand-snow"
              />
            </div>
            <p className="text-sm leading-relaxed">
              Established 1969. Encouraging tramping, mountaineering, climbing,
              skiing, and alpine activities in New Zealand.
            </p>
          </div>

          {/* Quick links */}
          <div>
            <h3 className="mb-3 font-heading text-lg font-semibold text-brand-snow">
              Quick Links
            </h3>
            <ul className="space-y-2 text-sm">
              <li>
                <Link href="/about" className="transition-colors hover:text-brand-gold">
                  About the Club
                </Link>
              </li>
              <li>
                <Link href="/join" className="transition-colors hover:text-brand-gold">
                  Join the Club
                </Link>
              </li>
              <li>
                <Link href="/faq" className="transition-colors hover:text-brand-gold">
                  FAQ
                </Link>
              </li>
              <li>
                <Link href="/rules" className="transition-colors hover:text-brand-gold">
                  Club Rules
                </Link>
              </li>
              <li>
                <Link href="/contact" className="transition-colors hover:text-brand-gold">
                  Contact Us
                </Link>
              </li>
              <li>
                <Link href="/login" className="transition-colors hover:text-brand-gold">
                  Member Login
                </Link>
              </li>
            </ul>
          </div>

          {/* Affiliations */}
          <div>
            <h3 className="mb-3 font-heading text-lg font-semibold text-brand-snow">
              Affiliations
            </h3>
            <ul className="space-y-2 text-sm">
              <li>
                <a
                  href="https://www.fmc.org.nz/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="transition-colors hover:text-brand-gold"
                >
                  Federated Mountain Clubs (FMC)
                </a>
              </li>
              <li>
                <a
                  href="https://rmca.org.nz/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="transition-colors hover:text-brand-gold"
                >
                  Ruapehu Mountain Clubs Association (RMCA)
                </a>
              </li>
              <li>
                <a
                  href={CLUB_FACEBOOK_URL ?? CLUB_PUBLIC_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="transition-colors hover:text-brand-gold"
                >
                  Facebook
                </a>
              </li>
            </ul>
          </div>
        </div>

        <div className="mt-10 border-t border-brand-ridge/30 pt-6 text-center text-sm text-brand-snow/85">
          <p>
            &copy; {new Date().getFullYear()} {CLUB_NAME} Incorporated. All
            rights reserved.
          </p>
          <p className="mt-2 space-x-4">
            <Link href="/privacy" className="transition-colors hover:text-brand-gold">
              Privacy Policy
            </Link>
            <span aria-hidden="true">&middot;</span>
            <Link href="/terms" className="transition-colors hover:text-brand-gold">
              Terms of Service
            </Link>
          </p>
        </div>
      </div>
    </footer>
  );
}
