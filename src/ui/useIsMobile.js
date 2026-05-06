import { useEffect, useState } from 'react';

// Track whether the viewport is below Tailwind's `sm` breakpoint (640px).
// Used by InventoryView to render only the mobile cards OR only the desktop
// table — not both — since CSS-only `hidden` would still mount both trees
// and double the React work on phones.
export function useIsMobile() {
  const query = '(max-width: 639px)';
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (e) => setIsMobile(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return isMobile;
}
