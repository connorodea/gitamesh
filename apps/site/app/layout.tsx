import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://gitamesh.com"),
  title: "Gitamesh — The coordination mesh for autonomous coding agents",
  description:
    "Gitamesh prevents duplicate work, conflicting implementations, and stale-worker races when multiple AI coding agents operate across repos, branches, and worktrees concurrently.",
  icons: {
    icon: "/favicon.svg",
  },
  openGraph: {
    title: "Gitamesh — The coordination mesh for autonomous coding agents",
    description:
      "Atomic claims, fencing tokens, leases, and an append-only event log for teams of AI coding agents working the same repos.",
    url: "https://gitamesh.com",
    siteName: "Gitamesh",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Gitamesh — The coordination mesh for autonomous coding agents",
    description:
      "Atomic claims, fencing tokens, leases, and an append-only event log for teams of AI coding agents working the same repos.",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-dvh bg-ink-950 font-sans text-fg antialiased">
        <a
          href="#main"
          className="focus-ring sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-ink-800 focus:px-4 focus:py-2 focus:text-sm"
        >
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
