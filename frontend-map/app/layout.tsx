import type { Metadata } from 'next';
import { IBM_Plex_Sans, IBM_Plex_Mono } from 'next/font/google';
import { CameraRegistryProvider } from '@/context/CameraRegistryContext';
import './globals.css';

// Two roles, one contract: Plex Sans carries every label a dispatcher reads
// for meaning, Plex Mono carries every value they scan for a match (ids,
// coordinates, timestamps, stream URLs). Keeping that split consistent across
// the whole app is the one typographic rule everything else follows.
const plexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-sans',
  display: 'swap',
});

const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'NETRA - Camera Registry & GIS Map',
  description: 'Real-time CCTV Monitoring & GIS Map',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${plexSans.variable} ${plexMono.variable}`}>
      <body className="bg-ink text-slate-100 antialiased font-sans">
        <CameraRegistryProvider>
          {children}
        </CameraRegistryProvider>
      </body>
    </html>
  );
}