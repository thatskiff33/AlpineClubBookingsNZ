import type { Metadata } from "next";
import { Mountain, Hammer, Users, Calendar } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

export const metadata: Metadata = {
  title: "About the Club",
  description:
    "Learn about the Tokoroa Alpine Club, established in 1969 to encourage tramping, mountaineering, climbing, skiing, and alpine activities in New Zealand.",
};

export default function AboutPage() {
  return (
    <>
      {/* Header */}
      <section className="bg-gradient-to-br from-slate-800 to-slate-900 text-white py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            About the Club
          </h1>
          <p className="mt-4 text-lg text-slate-300 max-w-2xl">
            The Tokoroa Alpine Club has been connecting people with New
            Zealand&apos;s mountains since 1969.
          </p>
        </div>
      </section>

      {/* History */}
      <section className="bg-white py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="max-w-3xl">
            <h2 className="text-2xl font-bold text-slate-900 mb-6">
              Our History
            </h2>
            <div className="prose prose-slate max-w-none space-y-4 text-slate-600">
              <p>
                The club was formed by a group of Tokoroa people of varied outdoor
                interests and means of employment at a time when the Tongariro
                National Park authorities were making building sites available to
                clubs. The primary objective of the club as stated in its
                constitution is: to encourage tramping, mountaineering, climbing,
                skiing, and alpine activities in New Zealand.
              </p>
              <p>
                The initially very small group decided they would put a lodge on
                Ruapehu and were fortunate enough to have their application accepted
                and were allocated a site. The first stage of the lodge was built
                within two years: raising the money occupied half of that time, site
                preparation and foundation work most of the rest of the available
                time (when the site was not buried in snow). The actual lodge
                building was carried out on one weekend &mdash; the floor was put
                down on Friday 21/3/69, the lodge went up on Saturday, and the roof
                cladding was completed on Sunday. Two more extensions have since
                been added to provide reasonably comfortable lodge accommodation for
                up to twenty-nine people.
              </p>
              <p>
                The largest group of club lodge users are winter sports enthusiasts,
                but there are a significant number of others who make use of the
                facilities throughout the year: photographers, trampers, family
                parties, school groups, naturalists, various social clubs, and some
                who just want to get away for some peace and quiet on the mountain.
                The club has always encouraged family participation in its
                activities and family membership charges are currently at a cheaper
                rate than the equivalent individual memberships.
              </p>
              <p>
                Lodge fees have been kept to a minimum and are probably among the
                lowest on the mountain. This is achieved by the members doing just
                about everything they possibly can for themselves. The lodge was
                almost entirely built with members&apos; voluntary labour and all
                subsequent maintenance, cooking, cleaning and other tasks are
                conducted on the same basis.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Key facts */}
      <section className="bg-slate-50 py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <h2 className="text-2xl font-bold text-slate-900 mb-8">
            At a Glance
          </h2>
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardContent className="pt-6">
                <Calendar className="h-7 w-7 text-blue-600 mb-3" />
                <h3 className="font-semibold text-slate-900">Established 1969</h3>
                <p className="text-sm text-slate-600 mt-1">
                  Over 55 years of alpine club history.
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <Mountain className="h-7 w-7 text-blue-600 mb-3" />
                <h3 className="font-semibold text-slate-900">Mt Ruapehu Lodge</h3>
                <p className="text-sm text-slate-600 mt-1">
                  29-bed lodge in the Whakapapa ski area. Open year-round.
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <Hammer className="h-7 w-7 text-blue-600 mb-3" />
                <h3 className="font-semibold text-slate-900">
                  Member Built & Maintained
                </h3>
                <p className="text-sm text-slate-600 mt-1">
                  Built in a weekend and maintained entirely by voluntary labour.
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <Users className="h-7 w-7 text-blue-600 mb-3" />
                <h3 className="font-semibold text-slate-900">~410 Members</h3>
                <p className="text-sm text-slate-600 mt-1">
                  Adults, youth, and children from across New Zealand.
                </p>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      {/* Objectives */}
      <section className="bg-white py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="max-w-3xl">
            <h2 className="text-2xl font-bold text-slate-900 mb-6">
              Club Objectives
            </h2>
            <ul className="space-y-3 text-slate-600">
              <li className="flex gap-3">
                <span className="text-blue-600 font-bold">&#8226;</span>
                Encourage tramping, mountaineering, climbing, skiing, and alpine
                activities
              </li>
              <li className="flex gap-3">
                <span className="text-blue-600 font-bold">&#8226;</span>
                Provide affordable lodge accommodation on Mt Ruapehu for members
                and guests
              </li>
              <li className="flex gap-3">
                <span className="text-blue-600 font-bold">&#8226;</span>
                Foster a community of outdoor enthusiasts and mountain lovers
              </li>
              <li className="flex gap-3">
                <span className="text-blue-600 font-bold">&#8226;</span>
                Maintain and improve the club lodge through voluntary labour
              </li>
              <li className="flex gap-3">
                <span className="text-blue-600 font-bold">&#8226;</span>
                Support conservation and responsible use of New Zealand&apos;s
                alpine environments
              </li>
            </ul>
          </div>
        </div>
      </section>
    </>
  );
}
