import type { Metadata } from "next";
import { redirect } from "next/navigation";

// The page only redirects, so this title shows for no longer than the redirect
// takes. It is set so the old address never falls back to the club's default
// tab title (#5217).
export const metadata: Metadata = {
  title: "Register",
};

export default function RegisterPage() {
  redirect("/join/apply");
}
