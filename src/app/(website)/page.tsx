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

export const metadata: Metadata = {
  title: "Tokoroa Alpine Club — Mt Ruapehu Lodge",
  description:
    "The Tokoroa Alpine Club operates a 29-bed lodge on Mt Ruapehu, Whakapapa. A members' club est. 1969 — join us on the mountain.",
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
      <section className="relative text-white overflow-hidden">
        <Image
          src="/images/lodge.jpg"
          alt="Tokoroa Alpine Club lodge on Mt Ruapehu"
          fill
          className="object-cover"
          priority
        />
        <div className="absolute inset-0 bg-gradient-to-r from-slate-900/85 via-slate-900/70 to-slate-900/40" />
        <div className="relative mx-auto max-w-7xl px-4 py-24 sm:px-6 sm:py-32 lg:px-8 lg:py-40">
          <div className="max-w-2xl">
            <Image
              src="/images/tac-logo.png"
              alt="Tokoroa Alpine Club logo"
              width={200}
              height={68}
              className="h-16 w-auto mb-6"
              priority
            />
            <h1 className="text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl">
              Tokoroa Alpine Club
            </h1>
            <p className="mt-4 text-lg text-slate-200 sm:text-xl max-w-xl">
              A members&apos; club on Mt Ruapehu. We operate a 29-bed lodge in
              the Whakapapa ski area, open year-round for members and their
              guests.
            </p>
            <div className="mt-8 flex flex-wrap gap-4">
              <Button size="lg" asChild className="bg-blue-600 hover:bg-blue-700">
                <Link href="/login">Member Login</Link>
              </Button>
              <Button
                size="lg"
                asChild
                className="bg-transparent border-2 border-white text-white hover:bg-white/10"
              >
                <Link href="/join">How to Join</Link>
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
              About the Club
            </h2>
            <p className="mt-3 text-slate-600 max-w-2xl mx-auto">
              The Tokoroa Alpine Club has been connecting people with New
              Zealand&apos;s mountains since 1969. We&apos;re a community of
              outdoor enthusiasts who share a love of the alpine environment.
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

      {/* Life on the Mountain — photo gallery */}
      <section className="bg-slate-50 py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold text-slate-900">
              Life on the Mountain
            </h2>
            <p className="mt-3 text-slate-600 max-w-2xl mx-auto">
              Our members enjoy a wide range of activities throughout the year,
              from winter sports to summer tramping and everything in between.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="relative aspect-[4/3] overflow-hidden rounded-xl shadow-md">
              <Image
                src="/images/snowboarder.jpg"
                alt="Snowboarding on Mt Ruapehu with mountain panorama"
                fill
                className="object-cover hover:scale-105 transition-transform duration-500"
              />
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent p-4">
                <span className="text-white font-medium text-sm">Skiing & Snowboarding</span>
              </div>
            </div>
            <div className="relative aspect-[4/3] overflow-hidden rounded-xl shadow-md">
              <Image
                src="/images/ski-field.jpg"
                alt="Whakapapa ski field on Mt Ruapehu"
                fill
                className="object-cover hover:scale-105 transition-transform duration-500"
              />
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent p-4">
                <span className="text-white font-medium text-sm">Whakapapa Ski Area</span>
              </div>
            </div>
            <div className="relative aspect-[4/3] overflow-hidden rounded-xl shadow-md sm:col-span-2 lg:col-span-1">
              <Image
                src="/images/sunset.jpg"
                alt="Sunset from Mt Ruapehu"
                fill
                className="object-cover hover:scale-105 transition-transform duration-500"
              />
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent p-4">
                <span className="text-white font-medium text-sm">Mountain Sunsets</span>
              </div>
            </div>
          </div>
          <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
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

      {/* How guests work */}
      <section className="bg-white py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="max-w-3xl mx-auto">
            <h2 className="text-3xl font-bold text-slate-900 text-center mb-6">
              Visiting the Lodge
            </h2>
            <div className="space-y-4 text-slate-600">
              <p>
                The Tokoroa Alpine Club is a members&apos; club. To stay at the
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
              <Button size="lg" variant="outline" asChild>
                <Link href="/contact">Get in Touch</Link>
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="bg-blue-900 text-white py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 text-center sm:px-6 lg:px-8">
          <h2 className="text-3xl font-bold">Already a Member?</h2>
          <p className="mt-3 text-blue-200 max-w-xl mx-auto">
            Log in to book your next stay at the lodge, view upcoming bookings,
            or manage your profile.
          </p>
          <div className="mt-8 flex flex-wrap gap-4 justify-center">
            <Button size="lg" asChild className="bg-white text-blue-900 hover:bg-blue-50">
              <Link href="/login">Member Login</Link>
            </Button>
            <Button
              size="lg"
              asChild
              className="bg-transparent border-2 border-white text-white hover:bg-white/10"
            >
              <Link href="/about">Learn More</Link>
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}
