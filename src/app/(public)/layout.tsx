import { auth } from "@/lib/auth";
import { Inter, League_Spartan } from "next/font/google";
import { WebsiteHeader } from "@/components/website-header";
import { WebsiteFooter } from "@/components/website-footer";

const websiteBodyFont = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-website-body",
});

const websiteHeadingFont = League_Spartan({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-website-heading",
});

export default async function PublicLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();

  return (
    <div
      className={`${websiteBodyFont.variable} ${websiteHeadingFont.variable} website-theme min-h-screen flex flex-col bg-background text-foreground`}
    >
      <WebsiteHeader isAuthenticated={!!session?.user} />
      <main className="flex-1 flex items-center justify-center p-4">
        {children}
      </main>
      <WebsiteFooter />
    </div>
  );
}
