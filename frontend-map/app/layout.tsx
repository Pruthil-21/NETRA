import type { Metadata } from 'next';
import { IBM_Plex_Sans, IBM_Plex_Mono } from 'next/font/google';
import { CameraRegistryProvider } from '@/context/CameraRegistryContext';
import { ShellGate } from '@/components/shell/ShellGate';
import { ServiceWorkerRegistration } from '@/components/common/ServiceWorkerRegistration';
import { THEME_INIT_SCRIPT } from '@/lib/theme';
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
  title: 'NETRA - Unified Video & GIS Command',
  description: 'Real-time CCTV monitoring, GIS camera registry, and vehicle-trace command center',
  manifest: '/manifest.json',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${plexSans.variable} ${plexMono.variable}`}>
      <body className="bg-ink text-slate-100 antialiased font-sans">
        {/* eslint-disable-next-line @next/next/no-sync-scripts, react/no-danger */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <ServiceWorkerRegistration />
        <CameraRegistryProvider>
          <ShellGate>{children}</ShellGate>
        </CameraRegistryProvider>
      </body>
    </html>
  );
}