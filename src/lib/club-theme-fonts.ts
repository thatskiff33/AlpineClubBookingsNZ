import {
  Inter,
  League_Spartan,
  Lora,
  Nunito_Sans,
  Source_Serif_4,
} from "next/font/google";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-theme-inter",
});

const leagueSpartan = League_Spartan({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-theme-league-spartan",
});

const lora = Lora({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-theme-lora",
});

const sourceSerif = Source_Serif_4({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-theme-source-serif-4",
});

const nunitoSans = Nunito_Sans({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-theme-nunito-sans",
});

export const clubThemeFontVariableClassName = [
  inter.variable,
  leagueSpartan.variable,
  lora.variable,
  sourceSerif.variable,
  nunitoSans.variable,
].join(" ");
