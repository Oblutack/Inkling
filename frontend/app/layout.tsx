import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "@fontsource-variable/inter";
import "@fontsource-variable/source-serif-4";
import "./globals.css";
import { THEME_SCRIPT } from "../lib/theme";
import Footer from "../components/Footer";
import MotionReady from "../components/MotionReady";
import Navbar from "../components/Navbar";
import Providers from "../components/Providers";
import RegisterServiceWorker from "../components/RegisterServiceWorker";
import SkipLink from "../components/SkipLink";
import VerifyBanner from "../components/VerifyBanner";

export const metadata: Metadata = {
  title: "Inkling",
  description: "Read, question and verify your documents. Every answer shows its source.",
};

// The browser's own bars take the colour of the page.
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#e6e5d6" },
    { media: "(prefers-color-scheme: dark)", color: "#1e1e1b" },
  ],
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Reading the per-request nonce makes every page render dynamically, which a nonce-based
  // Content-Security-Policy requires (a pre-rendered page has no nonce to put on its scripts).
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    // The theme script sets data-theme before React hydrates, so the attribute may differ from the server's.
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Browsers hide a script's nonce once it has run, so the client always sees it empty: expected. */}
        <script nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="flex min-h-screen flex-col bg-canvas font-sans text-ink">
        <RegisterServiceWorker />
        <MotionReady />
        <Providers nonce={nonce}>
          <SkipLink />
          <Navbar />
          <VerifyBanner />
          <main id="main" className="flex-1">
            {children}
          </main>
          <Footer />
        </Providers>
      </body>
    </html>
  );
}
