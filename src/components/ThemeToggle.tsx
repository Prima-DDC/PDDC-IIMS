"use client";

import { useCallback, useSyncExternalStore } from "react";
import { Monitor, Moon, Sun } from "lucide-react";

type Theme = "light" | "dark" | "system";
const KEY = "pddc.theme";
const CHANGE_EVENT = "pddc:theme-change";

/**
 * Light / dark / system switch.
 *
 * Dark mode is a working requirement, not a preference: night-shift and
 * surveillance work happens in the dark (PRD §23). "System" is the default so
 * the app follows the device until someone chooses otherwise.
 *
 * The stored theme lives in localStorage, which is exactly the kind of
 * non-sensitive UI preference PRD §21.3 permits there. No tokens, no case
 * data, ever.
 *
 * Read through useSyncExternalStore rather than an effect, because
 * localStorage is an external store: that keeps the server render consistent
 * ("system"), picks up changes made in another tab, and avoids a
 * setState-in-effect cascade.
 */
function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

function getSnapshot(): Theme {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored;
    }
  } catch {
    // Private mode or blocked storage: fall through to the system default.
  }
  return "system";
}

// The server cannot know the choice, and the inline script in <head> has
// already applied it to <html> before paint, so there is no flash either way.
const getServerSnapshot = (): Theme => "system";

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const apply = useCallback((next: Theme) => {
    const root = document.documentElement;
    if (next === "system") {
      root.removeAttribute("data-theme");
    } else {
      root.setAttribute("data-theme", next);
    }
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // Non-fatal: the attribute above still applies for this page view.
    }
    // `storage` does not fire in the tab that wrote it, so notify ourselves.
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  const options: Array<{ value: Theme; icon: typeof Sun; label: string }> = [
    { value: "light", icon: Sun, label: "Light" },
    { value: "dark", icon: Moon, label: "Dark" },
    { value: "system", icon: Monitor, label: "System" },
  ];

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className="inline-flex items-center gap-0.5 rounded-full border border-line bg-surface-sunken p-0.5"
    >
      {options.map(({ value, icon: Icon, label }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={theme === value}
          aria-label={label}
          title={label}
          onClick={() => apply(value)}
          className={`grid size-7 place-items-center rounded-full transition-colors ${
            theme === value
              ? "bg-surface text-signal-dark shadow-sm"
              : "text-faint hover:text-body"
          }`}
        >
          <Icon className="size-3.5" aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}

/**
 * Applies the stored theme before first paint, so a dark-mode user never sees
 * a white flash. Injected into <head> as a blocking inline script.
 */
export const THEME_INIT_SCRIPT = `
(function(){
  try {
    var t = localStorage.getItem(${JSON.stringify(KEY)});
    if (t === "light" || t === "dark") {
      document.documentElement.setAttribute("data-theme", t);
    }
  } catch (e) {}
})();
`;
