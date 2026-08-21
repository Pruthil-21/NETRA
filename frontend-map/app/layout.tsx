import type { Metadata } from 'next';
// Next.js handles this global stylesheet at build time.
// @ts-expect-error No TypeScript declaration is needed for CSS side-effect imports.
import './globals.css';

export const metadata: Metadata = {
  title: 'NETRA — GIS Camera Registry',
  description: 'Gujarat Govt Unified CCTV Integration System',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased min-h-screen bg-slate-950 text-slate-100">
        {children}
      </body>
    </html>
  );
}