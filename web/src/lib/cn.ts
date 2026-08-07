import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Compose class names, letting later Tailwind utilities win over earlier ones.
 *
 * Without the merge step, `cn("px-4", condition && "px-6")` emits both and the
 * winner is decided by stylesheet order rather than by intent — which is how the
 * ad-hoc template literals in this app have been behaving.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
