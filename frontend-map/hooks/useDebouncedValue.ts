import { useEffect, useState } from 'react';

/** Delays updating the returned value until `value` has stopped changing for
 * `delayMs` -- for a search/filter input whose every keystroke would
 * otherwise re-filter a list (or, worse, re-fire a request) on every
 * character. The input itself stays bound to the immediate, un-debounced
 * state so typing never feels laggy; only the value used to actually filter
 * or fetch should be the debounced one this hook returns. */
export function useDebouncedValue<T>(value: T, delayMs = 250): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(handle);
  }, [value, delayMs]);

  return debounced;
}
