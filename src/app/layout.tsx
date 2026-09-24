import type { Metadata } from "next";
import { Archivo, Geist } from "next/font/google";
import { InlineScript } from "./components/inline-script";
import { themeScript } from "./components/theme";
import { SITE_NAME, SITE_SUMMARY } from "./site";
import "./globals.css";

// Archivo for page titles, labels and the wordmark, with the landing
// page's exact config, so /app, the auth pages and the landing share one
// display face (DESIGN.md).
const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
  axes: ["wdth"],
});

// Geist for everything read: values, sentences, inputs.
const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

// Each page sets a short title ("Sign in", an organization's name) and the
// template adds the app's name, so tabs and history entries are told apart
// by their first words. The landing page sets none and gets the name alone.
export const metadata: Metadata = {
  title: { template: `%s · ${SITE_NAME}`, default: SITE_NAME },
  description: SITE_SUMMARY,
};

// data-theme="dark" is the server default. The inline script in <head>
// runs while the HTML is parsed, before first paint, and switches it to a
// stored "light", so a light visitor never sees a dark flash. It changes
// an attribute React rendered, hence suppressHydrationWarning (which covers
// <html>'s own attributes only, not its children).
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      data-theme="dark"
      suppressHydrationWarning
      className={`${geistSans.variable} ${archivo.variable} h-full antialiased`}
    >
      <head>
        <InlineScript html={themeScript} />
      </head>
      <body className="flex min-h-full flex-col bg-paper text-body text-ink">{children}</body>
    </html>
  );
}
