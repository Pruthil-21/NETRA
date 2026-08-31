'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

/** Single auth gate for the whole app (was previously duplicated per-page,
 * inconsistently -- /alerts had none at all). localStorage only exists
 * client-side, so this starts false and flips after mount to keep the
 * server-rendered HTML and first client render identical (no hydration
 * mismatch), same reasoning the original per-page checks used. */
export function useAuthGuard(skip: boolean = false): boolean {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    if (skip) return;
    const auth = localStorage.getItem('netra_authenticated');
    if (!auth) {
      router.replace('/login');
    } else {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAuthChecked(true);
    }
  }, [router, skip]);

  return skip || authChecked;
}
