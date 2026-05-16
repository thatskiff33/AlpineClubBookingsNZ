import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import {
  Mountain,
  Users,
  Calendar,
  Snowflake,
  Sun,
  Camera,
  Footprints,
  Hammer,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CLUB_NAME } from "@/config/club-identity";
import { LODGE_CAPACITY } from "@/lib/lodge-capacity";

export const metadata: Metadata = {
  title: `${CLUB_NAME} — Mt Ruapehu Lodge`,
  description:
    `The ${CLUB_NAME} operates a ${LODGE_CAPACITY}-bed lodge on Mt Ruapehu, Whakapapa. A members' club est. 1969 — join us on the mountain.`,
};

const highlights = [
  {
    icon: Mountain,
    title: "Mt Ruapehu Lodge",
    description:
      `${LODGE_CAPACITY}-bed lodge in the Whakapapa ski area, built and maintained by members since 1969.`,
  },
  {
    icon: Users,
    title: "A Members' Club",
    description:
      "Run entirely by volunteers. Members look after each other and the lodge through working bees and shared responsibilities.",
  },
  {
    icon: Hammer,
    title: "Built by Members",
    description:
      "The lodge was built in a single weekend by members' voluntary labour. All maintenance continues on the same basis.",
  },
  {
    icon: Calendar,
    title: "Year-Round Access",
    description:
      "Open all year for skiing, snowboarding, tramping, photography, and alpine adventures.",
  },
];

const activities = [
  { icon: Snowflake, label: "Skiing & Snowboarding" },
  { icon: Footprints, label: "Tramping" },
  { icon: Mountain, label: "Mountaineering" },
  { icon: Camera, label: "Photography" },
  { icon: Sun, label: "Summer Adventures" },
  { icon: Users, label: "Working Bees" },
];

export default function HomePage() {
  return (
    <>
      {/* Hero */}
      <section className="relative overflow-hidden text-brand-snow">
        <Image
          src="/branding/lodge.jpg"
          alt={`${CLUB_NAME} lodge on Mt Ruapehu`}
          fill
          className="object-cover"
          priority
        />
        <div className="absolute inset-0 bg-gradient-to-r from-brand-deep/92 via-brand-charcoal/82 to-brand-charcoal/48" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(255,203,5,0.24),transparent_30%)]" />
        <div className="relative mx-auto max-w-7xl px-4 py-24 sm:px-6 sm:py-32 lg:px-8 lg:py-40">
          <div className="max-w-2xl">
            <span className="website-eyebrow mb-5">Mt Ruapehu lodge since 1969</span>
            <Image
              src="/branding/logo.png"
              alt={`${CLUB_NAME} logo`}
              width={200}
              height={68}
              className="mb-6 h-16 w-auto"
              priority
            />
            <h1 className="font-heading text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl">
              {CLUB_NAME}
            </h1>
            <p className="mt-4 max-w-xl text-lg text-brand-snow/86 sm:text-xl">
              A members&apos; club on Mt Ruapehu. We operate a {LODGE_CAPACITY}-bed lodge in
              the Whakapapa ski area, open year-round for members and their
              guests.
            </p>
            <div className="mt-8 flex flex-wrap gap-4">
              <Button size="lg" asChild className="shadow-lg shadow-brand-gold/20">
                <Link href="/login">Member Login</Link>
              </Button>
              <Button
                size="lg"
                asChild
                className="border-2 border-brand-snow/70 bg-transparent text-brand-snow hover:bg-brand-snow/10 hover:text-brand-snow"
              >
                <Link href="/join">How to Join</Link>
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* Highlights */}
      <section className="bg-brand-snow py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <span className="website-eyebrow mb-4">A practical alpine club</span>
            <h2 className="font-heading text-3xl font-bold text-brand-charcoal">
              About the Club
            </h2>
            <p className="mx-auto mt-3 max-w-2xl text-brand-deep/80">
              The {CLUB_NAME} has been connecting people with New
              Zealand&apos;s mountains since 1969. We&apos;re a community of
              outdoor enthusiasts who share a love of the alpine environment.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {highlights.map((item) => (
              <Card
                key={item.title}
                className="border-brand-ridge/20 bg-brand-snow/90 shadow-[0_20px_45px_-35px_rgba(47,47,43,0.45)]"
              >
                <CardContent className="pt-6">
                  <item.icon className="mb-3 h-8 w-8 text-brand-gold" />
                  <h3 className="font-heading mb-2 text-lg font-semibold text-brand-charcoal">
                    {item.title}
                  </h3>
                  <p className="text-sm text-brand-deep/75">{item.description}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* Life on the Mountain — photo gallery */}
      <section className="bg-brand-mist/55 py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <span className="website-eyebrow mb-4">Life around the lodge</span>
            <h2 className="font-heading text-3xl font-bold text-brand-charcoal">
              Life on the Mountain
            </h2>
            <p className="mx-auto mt-3 max-w-2xl text-brand-deep/78">
              Our members enjoy a wide range of activities throughout the year,
              from winter sports to summer tramping and everything in between.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="relative aspect-[4/3] overflow-hidden rounded-xl shadow-md">
              <Image
                src="/branding/snowboarder.jpg"
                alt="Snowboarding on Mt Ruapehu with mountain panorama"
                fill
                className="object-cover hover:scale-105 transition-transform duration-500"
              />
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-brand-deep/75 to-transparent p-4">
                <span className="text-brand-snow text-sm font-medium">Skiing & Snowboarding</span>
              </div>
            </div>
            <div className="relative aspect-[4/3] overflow-hidden rounded-xl shadow-md">
              <Image
                src="/branding/ski-field.jpg"
                alt="Whakapapa ski field on Mt Ruapehu"
                fill
                className="object-cover hover:scale-105 transition-transform duration-500"
              />
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-brand-deep/75 to-transparent p-4">
                <span className="text-brand-snow text-sm font-medium">Whakapapa Ski Area</span>
              </div>
            </div>
            <div className="relative aspect-[4/3] overflow-hidden rounded-xl shadow-md sm:col-span-2 lg:col-span-1">
              <Image
                src="/branding/sunset.jpg"
                alt="Sunset from Mt Ruapehu"
                fill
                className="object-cover hover:scale-105 transition-transform duration-500"
              />
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-brand-deep/75 to-transparent p-4">
                <span className="text-brand-snow text-sm font-medium">Mountain Sunsets</span>
              </div>
            </div>
          </div>
          <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            {activities.map((activity) => (
              <div
                key={activity.label}
                className="flex flex-col items-center gap-2 rounded-2xl border border-brand-ridge/15 bg-brand-snow p-4 shadow-[0_18px_34px_-28px_rgba(77,77,70,0.45)]"
              >
                <activity.icon className="h-6 w-6 text-brand-gold" />
                <span className="text-center text-sm font-medium text-brand-charcoal">
                  {activity.label}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How guests work */}
      <section className="bg-brand-snow py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="max-w-3xl mx-auto">
            <span className="website-eyebrow mb-4 justify-center">Members first</span>
            <h2 className="mb-6 text-center font-heading text-3xl font-bold text-brand-charcoal">
              Visiting the Lodge
            </h2>
            <div className="space-y-4 text-brand-deep/80">
              <p>
                The {CLUB_NAME} is a members&apos; club. To stay at the
                lodge, you need to either be a member or be invited as a guest
                by an existing member. Non-member guests must be accompanied by
                the member who booked them.
              </p>
              <p>
                If you&apos;re interested in experiencing the lodge, the best
                way is to get to know a current member and arrange to visit as
                their guest. If the club is a good fit for you, two existing
                members can nominate you for membership.
              </p>
            </div>
            <div className="mt-8 flex flex-wrap gap-4 justify-center">
              <Button size="lg" asChild>
                <Link href="/join">How to Join</Link>
              </Button>
              <Button
                size="lg"
                variant="outline"
                asChild
                className="border-brand-charcoal/20 bg-transparent text-brand-charcoal hover:bg-brand-mist/45 hover:text-brand-charcoal"
              >
                <Link href="/contact">Get in Touch</Link>
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="bg-brand-charcoal py-16 text-brand-snow sm:py-20">
        <div className="mx-auto max-w-7xl px-4 text-center sm:px-6 lg:px-8">
          <span className="website-eyebrow mb-4">Booking ready</span>
          <h2 className="font-heading text-3xl font-bold">Already a Member?</h2>
          <p className="mx-auto mt-3 max-w-xl text-brand-snow/78">
            Log in to book your next stay at the lodge, view upcoming bookings,
            or manage your profile.
          </p>
          <div className="mt-8 flex flex-wrap gap-4 justify-center">
            <Button size="lg" asChild className="shadow-lg shadow-brand-gold/15">
              <Link href="/login">Member Login</Link>
            </Button>
            <Button
              size="lg"
              asChild
              className="border-2 border-brand-snow/70 bg-transparent text-brand-snow hover:bg-brand-snow/10 hover:text-brand-snow"
            >
              <Link href="/about">Learn More</Link>
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}
