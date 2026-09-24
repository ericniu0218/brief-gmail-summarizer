import * as React from 'react';

const MOBILE_BREAKPOINT = 768;

/**
 * Reactive match for the layout breakpoint used by responsive navigation components.
 *
 * The media query is an external store, so it is read through `useSyncExternalStore`
 * rather than mirrored into state from an effect. That keeps the first client render
 * consistent with the query instead of rendering once as "not mobile" and correcting
 * immediately afterwards. The server snapshot stays `false` so markup is stable.
 */
const query = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`;

function subscribe(onChange: () => void) {
  const media = window.matchMedia(query);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

const getSnapshot = () => window.matchMedia(query).matches;
const getServerSnapshot = () => false;

export function useIsMobile() {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
