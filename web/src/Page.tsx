import type { ReactNode } from "react";

interface Props {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode; // buttons at the right of the header
  onBack: () => void;
  children: ReactNode;
  className?: string;
}

// The right column showing a page (Notes, Queue, Settings, Usage) instead
// of a chat: the same header height and reading column.
export function Page({ title, subtitle, actions, onBack, children, className }: Props) {
  return (
    <main className={`chat page${className ? ` ${className}` : ""}`}>
      <header className="chat-header">
        <button className="icon-button page-back" onClick={onBack} title="Back">
          ‹
        </button>
        <div className="chat-title">
          <div className="chat-title-main">
            <span className="chat-title-text">{title}</span>
          </div>
          {subtitle && <div className="chat-title-sub">{subtitle}</div>}
        </div>
        {actions}
      </header>
      <div className="chat-scroll">
        <div className="chat-column page-body">{children}</div>
      </div>
    </main>
  );
}
