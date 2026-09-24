import type { Metadata } from 'next';
import './globals.css';

// Run before React paints so a saved dark preference does not briefly flash the light theme.
const themeScript = `(()=>{try{const dark=localStorage.getItem('brief-theme')==='dark';document.documentElement.classList.toggle('dark',dark);document.documentElement.style.colorScheme=dark?'dark':'light'}catch{}})()`;
export const metadata: Metadata = {
  title: 'Brief — Your inbox, in focus',
  icons: { icon: '/favicon.svg' },
  description: 'A calmer inbox. See what matters, reply thoughtfully, and clear the noise with Brief.',
};
export default function RootLayout({children}: {children: React.ReactNode}) {
  // Hydration warnings are suppressed because the pre-paint script may add the dark class
  // before React reads the server-rendered document.
  return <html lang="en" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{__html:themeScript}}/></head><body>{children}</body></html>;
}
