import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'Brief — Your inbox, in focus',
  icons: { icon: '/favicon.svg' },
  description: 'A calmer inbox. See what matters, reply thoughtfully, and clear the noise with Brief.',
};
export default function RootLayout({children}: {children: React.ReactNode}) {
  return <html lang="en"><body>{children}</body></html>;
}
