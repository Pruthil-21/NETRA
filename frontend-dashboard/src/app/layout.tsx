import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NETRA — Unified Viewing Dashboard",
  description: "Gujarat Govt Unified CCTV Integration System",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="min-h-screen flex flex-col bg-brand-dark antialiased">
        {children}
      </body>
    </html>
  );
}