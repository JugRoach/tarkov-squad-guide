import { useEffect, useRef, useState } from "react";

// Returns a debounced copy of `value` that updates only after it has been
// stable for `delay` ms. Callers typically feed this into a search effect.
export function useDebouncedValue(value, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

// Lower-level: returns a stable ref-backed `schedule(fn)` that reschedules a
// pending timeout and a `cancel()` to clear it. For call sites that need to
// run custom logic (not just a value swap) on the debounced tick.
export function useDebouncedCallback(delay = 300) {
  const timerRef = useRef(null);
  const schedule = (fn) => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(fn, delay);
  };
  const cancel = () => clearTimeout(timerRef.current);
  useEffect(() => cancel, []);
  return { schedule, cancel };
}
