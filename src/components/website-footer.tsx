import Link from "next/link";
import { Mountain } from "lucide-react";

export function WebsiteFooter() {
  return (
    <footer className="bg-slate-900 text-slate-300">
      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 gap-8 md:grid-cols-3">
          {/* Club info */}
          <div>
            <div className="flex items-center gap-2 text-white font-bold mb-3">
              <Mountain className="h-5 w-5 text-blue-400" />
              Tokoroa Alpine Club
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
          &copy; {new Date().getFullYear()} Tokoroa Alpine Club Incorporated. All
          rights reserved.
        </div>
      </div>
    </footer>
  );
}
