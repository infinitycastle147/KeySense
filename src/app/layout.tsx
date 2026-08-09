import type { Metadata } from "next";
import { Instrument_Sans, JetBrains_Mono, Martian_Mono } from "next/font/google";
import "./globals.css";

// Three roles, three families — see docs/DESIGN.md §3.
const instrumentSans = Instrument_Sans({
  variable: "--font-instrument-sans",
  subsets: ["latin"],
});

// The typing surface. Chosen for disambiguated l/1/I and 0/O, and for holding
// legibility at speed — it is what the user stares at for hours.
const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

// Loud by design; used sparingly for large numerals and the label role.
const martianMono = Martian_Mono({
  variable: "--font-martian-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "KeySense",
  description:
    "A typing trainer that diagnoses why you're slow, prescribes targeted practice, and measures whether it worked.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // Monitor mode is the default instrument state — see docs/DESIGN.md §1.
    // suppressHydrationWarning: the theme toggle stamps this class client-side.
    <html
      lang="en"
      className={`dark ${instrumentSans.variable} ${jetbrainsMono.variable} ${martianMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
