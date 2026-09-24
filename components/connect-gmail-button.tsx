'use client';
import { Mail } from 'lucide-react';
import type { ConnectionStatus } from '@/hooks/use-inbox';

/** Chooses between starting OAuth now and opening settings for missing configuration. */
export function ConnectGmailButton({
  status,
  signInUrl,
  onSetup,
}: {
  status: ConnectionStatus | null;
  signInUrl?: string;
  onSetup: () => void;
}) {
  if (signInUrl || status?.configured) {
    // Finish platform sign-in, then continue directly into Google consent.
    const href = signInUrl
      ? '/signin-with-chatgpt?return_to=%2Fapi%2Fauth%2Fgoogle'
      : '/api/auth/google';
    return (
      <a className="button blue" href={href} target="_top">
        <Mail size={16} />
        Connect Gmail
      </a>
    );
  }
  return (
    <button className="button blue" onClick={onSetup}>
      <Mail size={16} />
      Connect Gmail
    </button>
  );
}
