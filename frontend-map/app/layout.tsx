import type { Metadata } from 'next';
import { CameraRegistryProvider } from '@/context/CameraRegistryContext';
import './globals.css';

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
    <html lang="en">
      <body className="bg-slate-950 text-slate-100 antialiased">
        <CameraRegistryProvider>
          {children}
        </CameraRegistryProvider>
      </body>
    </html>
  );
}