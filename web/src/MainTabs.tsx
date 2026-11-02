export type MainTab = "chat" | "terminal";

// Chat | Terminal, at the right of the middle column's header. Desktop only
// (the terminal isn't offered on phones).
export function MainTabs({ tab, onTab }: { tab: MainTab; onTab: (tab: MainTab) => void }) {
  return (
    <div className="main-tabs" role="tablist">
      {(["chat", "terminal"] as const).map((t) => (
        <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "active" : ""} onClick={() => onTab(t)}>
          {t === "chat" ? "Chat" : "Terminal"}
        </button>
      ))}
    </div>
  );
}
