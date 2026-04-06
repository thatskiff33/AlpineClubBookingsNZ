import Image from "next/image";
import Link from "next/link";

export function WebsiteFooter() {
  return (
    <footer className="bg-slate-900 text-slate-300">
      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 gap-8 md:grid-cols-3">
          {/* Club info */}
          <div>
            <div className="mb-3">
              <Image
                src="/images/tac-logo.png"
                alt="Tokoroa Alpine Club"
                width={140}
                height={48}
                className="h-10 w-auto brightness-110"
              />
            </div>
            <p className="text-sm leading-relaxed">
              Established 1969. Encouraging tramping, mountaineering, climbing,
              skiing, and alpine activities in New Zealand.
            </p>
          </div>

          {/* Quick links */}
          <div>
            <h3 className="text-white font-semibold mb-3">Quick Links</h3>
            <ul className="space-y-2 text-sm">
              <li>
                <Link href="/about" className="hover:text-white transition-colors">
                  About the Club
                </Link>
              </li>
              <li>
                <Link href="/join" className="hover:text-white transition-colors">
                  Join the Club
                </Link>
              </li>
              <li>
                <Link href="/faq" className="hover:text-white transition-colors">
                  FAQ
                </Link>
              </li>
              <li>
                <Link href="/rules" className="hover:text-white transition-colors">
                  Club Rules
                </Link>
              </li>
              <li>
                <Link href="/contact" className="hover:text-white transition-colors">
                  Contact Us
                </Link>
              </li>
              <li>
                <Link href="/login" className="hover:text-white transition-colors">
                  Member Login
                </Link>
              </li>
            </ul>
          </div>

          {/* Affiliations */}
          <div>
            <h3 className="text-white font-semibold mb-3">Affiliations</h3>
            <ul className="space-y-2 text-sm">
              <li>
                <a
                  href="https://www.fmc.org.nz/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-white transition-colors"
                >
                  Federated Mountain Clubs (FMC)
                </a>
              </li>
              <li>
                <a
                  href="https://rmca.org.nz/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-white transition-colors"
                >
                  Ruapehu Mountain Clubs Association (RMCA)
                </a>
              </li>
              <li>
                <a
                  href="https://www.facebook.com/TokoroaAlpineClub/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-white transition-colors"
                >
                  Facebook
                </a>
              </li>
            </ul>
          </div>
        </div>

        <div className="mt-10 border-t border-slate-700 pt-6 text-center text-sm text-slate-400">
          <p>
            &copy; {new Date().getFullYear()} Tokoroa Alpine Club Incorporated. All
            rights reserved.
          </p>
          <p className="mt-2 space-x-4">
            <Link href="/privacy" className="hover:text-white transition-colors">
              Privacy Policy
            </Link>
            <span aria-hidden="true">&middot;</span>
            <Link href="/terms" className="hover:text-white transition-colors">
              Terms of Service
            </Link>
          </p>
        </div>
      </div>
    </footer>
  );
}
