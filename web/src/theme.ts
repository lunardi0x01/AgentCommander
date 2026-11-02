import { useState } from "react";

// Per-device theme: dark (default) or light.
export type Theme = "dark" | "light";

function saved(): Theme {
  try {
    if (localStorage.getItem("theme") === "light") return "light";
  } catch {}
  return "dark";
}

// Returns the current theme and a function that switches to the other one.
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState(saved);
  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("theme", next);
    } catch {}
    setTheme(next);
  };
  return [theme, toggle];
}
