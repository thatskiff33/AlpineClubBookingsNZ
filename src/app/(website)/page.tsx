import type { Metadata } from "next";
import Link from "next/link";
import {
  Mountain,
  Users,
  Calendar,
  Snowflake,
  Sun,
  Camera,
  Footprints,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export const metadata: Metadata = {
  title: "Tokoroa Alpine Club — Mt Ruapehu Lodge",
  description:
    "Book a stay at the Tokoroa Alpine Club lodge on Mt Ruapehu, Whakapapa. 29 beds, year-round access, lowest fees on the mountain. Est. 1969.",
};

const highlights = [
  {
    icon: Mountain,
    title: "Mt Ruapehu Lodge",
    description:
      "29-bed lodge in the Whakapapa ski area, built and maintained by members since 1969.",
  },
  {
    icon: Users,
    title: "Family Friendly",
    description:
      "Family memberships available with concessions for children. All ages welcome at the lodge.",
  },
  {
    icon: Calendar,
    title: "Year-Round Access",
    description:
      "Open all year for skiing, snowboarding, tramping, photography, and alpine adventures.",
  },
  {
    icon: Snowflake,
    title: "Lowest Fees on the Mountain",
    description:
      "Among the most affordable lodge fees on Ruapehu. Member rates even lower.",
  },
];

const activities = [
  { icon: Snowflake, label: "Skiing & Snowboarding" },
  { icon: Footprints, label: "Tramping" },
  { icon: Mountain, label: "Mountaineering" },
  { icon: Camera, label: "Photography" },
  { icon: Sun, label: "Summer Adventures" },
  { icon: Users, label: "School Groups" },
];

export default function HomePage() {
  return (
    <>
      {/* Hero */}
      <section className="relative bg-gradient-to-br from-blue-900 via-slate-800 to-slate-900 text-white">
        <div className="mx-auto max-w-7xl px-4 py-24 sm:px-6 sm:py-32 lg:px-8 lg:py-40">
          <div className="max-w-2xl">
            <div className="flex items-center gap-3 mb-6">
              <Mountain className="h-10 w-10 text-blue-300" />
              <span className="text-blue-300 font-medium tracking-wide uppercase text-sm">
                Est. 1969
              </span>
            </div>
            <h1 className="text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl">
              Tokoroa Alpine Club
            </h1>
            <p className="mt-4 text-lg text-slate-300 sm:text-xl max-w-xl">
              Your home on Mt Ruapehu. A 29-bed lodge in the Whakapapa ski area,
              open year-round for members and guests.
            </p>
            <div className="mt-8 flex flex-wrap gap-4">
              <Button size="lg" asChild className="bg-blue-600 hover:bg-blue-700">
                <Link href="/login">Book a Stay</Link>
              </Button>
              <Button
                size="lg"
                variant="outline"
                asChild
                className="border-slate-400 text-white hover:bg-white/10"
              >
                <Link href="/join">Join the Club</Link>
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* Highlights */}
      <section className="bg-white py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold text-slate-900">
              Why Stay With Us
            </h2>
            <p className="mt-3 text-slate-600 max-w-2xl mx-auto">
              The Tokoroa Alpine Club has been welcoming members and guests to Mt
              Ruapehu since 1969.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {highlights.map((item) => (
              <Card key={item.title} className="border-slate-200">
                <CardContent className="pt-6">
                  <item.icon className="h-8 w-8 text-blue-600 mb-3" />
                  <h3 className="font-semibold text-slate-900 mb-2">
                    {item.title}
                  </h3>
                  <p className="text-sm text-slate-600">{item.description}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* Activities */}
      <section className="bg-slate-50 py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold text-slate-900">
              Something for Everyone
            </h2>
            <p className="mt-3 text-slate-600 max-w-2xl mx-auto">
              Whether you&apos;re hitting the slopes, exploring the trails, or just
              enjoying the mountain views.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            {activities.map((activity) => (
              <div
                key={activity.label}
                className="flex flex-col items-center gap-2 rounded-lg bg-white p-4 shadow-sm border border-slate-200"
              >
                <activity.icon className="h-6 w-6 text-blue-600" />
                <span className="text-sm font-medium text-slate-700 text-center">
                  {activity.label}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="bg-blue-900 text-white py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 text-center sm:px-6 lg:px-8">
          <h2 className="text-3xl font-bold">Ready to Visit?</h2>
          <p className="mt-3 text-blue-200 max-w-xl mx-auto">
            Book your stay at the lodge or become a member to enjoy the lowest
            rates on the mountain.
          </p>
          <div className="mt-8 flex flex-wrap gap-4 justify-center">
            <Button size="lg" asChild className="bg-white text-blue-900 hover:bg-blue-50">
              <Link href="/login">Book Now</Link>
            </Button>
            <Button
              size="lg"
              variant="outline"
              asChild
              className="border-blue-400 text-white hover:bg-white/10"
            >
              <Link href="/about">Learn More</Link>
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}
