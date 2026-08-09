import type { Metadata } from "next";
import { Instrument_Sans, JetBrains_Mono, Martian_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { SyncProvider } from "@/components/sync/SyncProvider";
import { AppNav } from "@/components/nav/AppNav";

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
      <body className="min-h-full flex flex-col">
        <AppNav />
        <div className="flex flex-1 flex-col">{children}</div>
        {/* Invisible — no chrome added to the sacred test screen (docs/DESIGN.md
            §7). Owns the sign-in-flush and window.online sync triggers
            (PHASE-2.md §4); "on test completion" is wired in
            src/lib/db/local.ts instead, where the trigger actually happens. */}
        <SyncProvider />
        {/* Sync never runs mid-test (saveTest only fires at completion), so a
            failure toast can only appear before or after typing, never during
            it — consistent with the sacred-test-screen rule above. */}
        <Toaster />
      </body>
    </html>
  );
}
