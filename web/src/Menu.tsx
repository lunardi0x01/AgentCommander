import { useEffect, useRef, useState, type ReactNode } from "react";
import { MoreIcon } from "./icons.tsx";

export type MenuEntry =
  | {
      label: string;
      onClick: () => void;
      disabled?: boolean;
      hint?: string; // tooltip
      detail?: string; // a second, muted line
      checked?: boolean; // the current choice
      className?: string;
    }
  | "divider";

interface Props {
  title: string; // tooltip and accessible name of the button
  items: MenuEntry[];
  onOpen?: () => void;
  className?: string;
  trigger?: ReactNode; // button content; a ⋯ icon by default
  buttonClass?: string;
}

// A button (⋯ unless given a trigger) with a dropdown. Closes on picking an
// item, Escape or a tap outside.
export function Menu({ title, items, onOpen, className, trigger, buttonClass = "icon-button small" }: Props) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false); // open upwards near the bottom of the screen
  const [maxHeight, setMaxHeight] = useState<number>();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const toggle = () => {
    if (!open) {
      const anchor = ref.current;
      if (anchor) {
        // Fit inside whatever would clip the menu: a scrolling ancestor (a
        // page body) or else the window.
        const rect = anchor.getBoundingClientRect();
        const bounds = clipBounds(anchor);
        const below = bounds.bottom - rect.bottom - 12;
        const above = rect.top - bounds.top - 12;
        const goUp = 52 * items.length > below && above > below;
        setUp(goUp);
        setMaxHeight(Math.min(560, Math.max(120, goUp ? above : below)));
      }
      onOpen?.();
    }
    setOpen(!open);
  };

  return (
    <div className={`menu-anchor${open ? " open" : ""}${className ? ` ${className}` : ""}`} ref={ref}>
      <button className={buttonClass} title={title} aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
        {trigger ?? <MoreIcon />}
      </button>
      {open && (
        <div className={`menu${up ? " up" : ""}`} role="menu" style={{ maxHeight }}>
          {items.map((entry, i) =>
            entry === "divider" ? (
              <div key={i} className="menu-divider" role="separator" />
            ) : (
              <button
                key={i}
                className={`menu-item${entry.checked ? " checked" : ""}${entry.className ? ` ${entry.className}` : ""}`}
                role={entry.checked === undefined ? "menuitem" : "menuitemradio"}
                aria-checked={entry.checked}
                disabled={entry.disabled}
                title={entry.hint}
                onClick={() => {
                  setOpen(false);
                  entry.onClick();
                }}
              >
                <span className="menu-label">{entry.label}</span>
                {entry.detail && <span className="menu-detail">{entry.detail}</span>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

// The box of the nearest ancestor that clips overflow, or the window.
function clipBounds(el: HTMLElement): { top: number; bottom: number } {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (getComputedStyle(p).overflowY !== "visible") {
      const r = p.getBoundingClientRect();
      return { top: Math.max(0, r.top), bottom: Math.min(window.innerHeight, r.bottom) };
    }
  }
  return { top: 0, bottom: window.innerHeight };
}
