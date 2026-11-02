import { useRef, useState } from "react";

// The two draggable borders: the navigator's (left) and the side panel's (right).
type Column = "nav" | "side";

// By default the columns take 20 / 45 / 35 % of the window (list, chat, side).
const COLUMNS: Record<Column, { key: string; share: number; min: number }> = {
  nav: { key: "navWidth", share: 0.2, min: 220 },
  side: { key: "sideWidth", share: 0.35, min: 300 },
};
const MIN_CHAT_WIDTH = 360;

// The widest a column can be while the others keep their room.
export function clampWidth(column: Column, width: number, other = 0): number {
  return Math.round(Math.max(COLUMNS[column].min, Math.min(width, window.innerWidth - MIN_CHAT_WIDTH - other)));
}

function defaultWidth(column: Column): number {
  return clampWidth(column, window.innerWidth * COLUMNS[column].share);
}

export function savedWidth(column: Column): number {
  try {
    const saved = Number(localStorage.getItem(COLUMNS[column].key));
    if (saved > 0) return clampWidth(column, saved);
  } catch {}
  return defaultWidth(column);
}

interface Props {
  column: Column;
  width: number;
  other?: number; // the width of the other resizable column, if shown
  onWidth: (width: number) => void;
  onDragging: (dragging: boolean) => void;
}

// Drag handle between the columns. Drag (mouse or touch), arrow keys when
// focused, double-click to reset. The width is remembered per device.
export function ColumnResizer({ column, width, other, onWidth, onDragging }: Props) {
  const [dragging, setDragging] = useState(false);
  const start = useRef({ x: 0, width });
  // The side panel is on the right: dragging left makes it wider.
  const sign = column === "side" ? -1 : 1;

  const set = (next: number) => {
    const clamped = clampWidth(column, next, other);
    onWidth(clamped);
    try {
      localStorage.setItem(COLUMNS[column].key, String(clamped));
    } catch {}
  };

  const drag = (on: boolean) => {
    setDragging(on);
    onDragging(on);
  };

  return (
    <div
      className={`column-resizer ${column}${dragging ? " dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={column === "nav" ? "Resize the project list" : "Resize the side panel"}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, width };
        drag(true);
      }}
      onPointerMove={(e) => {
        if (dragging) set(start.current.width + sign * (e.clientX - start.current.x));
      }}
      onPointerUp={() => drag(false)}
      onPointerCancel={() => drag(false)}
      onDoubleClick={() => set(defaultWidth(column))}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") set(width - sign * 16);
        if (e.key === "ArrowRight") set(width + sign * 16);
      }}
    />
  );
}
