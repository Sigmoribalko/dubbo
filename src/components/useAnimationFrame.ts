import { useEffect, useRef } from "react";

/** Run `fn` every animation frame while mounted. The latest `fn` is always used. */
export function useAnimationFrame(fn: () => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    let id = 0;
    const loop = () => { ref.current(); id = requestAnimationFrame(loop); };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, []);
}
