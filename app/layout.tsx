import type { Metadata } from 'next';
import './globals.css';
const themeScript = `(()=>{try{const dark=localStorage.getItem('brief-theme')==='dark';document.documentElement.classList.toggle('dark',dark);document.documentElement.style.colorScheme=dark?'dark':'light'}catch{}})()`;
export const metadata: Metadata = {
  title: 'Brief — Your inbox, in focus',
  icons: { icon: '/favicon.svg' },
  description: 'A calmer inbox. See what matters, reply thoughtfully, and clear the noise with Brief.',
};
export default function RootLayout({children}: {children: React.ReactNode}) {
  return <html lang="en" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{__html:themeScript}}/></head><body>{children}</body></html>;
}
