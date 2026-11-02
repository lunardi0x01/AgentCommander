import { memo, useState } from "react";
import { ChevronIcon, FileIcon, LogoIcon, SpeakerIcon, StopSquareIcon } from "./icons.tsx";
import { BACKEND_LABEL, type BackendId, type Block, type ChatMessage, type ImageBlock } from "../../shared/types.ts";
import { Markdown } from "./Markdown.tsx";
import { speak, canSpeak, stopSpeaking, useSpeaking } from "./speech.ts";
import { ToolCall } from "./ToolCall.tsx";

interface Props {
  message: ChatMessage;
  hideTools?: boolean; // collapse thinking and tool calls (a setting)
  backend?: BackendId; // who the assistant is; Claude when absent
}

// Memoized: when a live session grows, earlier messages keep their identity
// and aren't re-rendered.
export const Message = memo(function Message({ message, hideTools, backend }: Props) {
  if (message.role === "notice") {
    return (
      <div className="notice">
        {message.blocks.map((b, i) =>
          b.type !== "text" ? null : looksLikeMarkdown(b.text) ? <Markdown key={i} text={b.text} /> : <pre key={i}>{b.text}</pre>,
        )}
      </div>
    );
  }

  if (message.role === "user") {
    return (
      <div className="message user">
        <Speaker who="user" timestamp={message.timestamp} />
        <div className="bubble">
          {message.blocks.map((b, i) =>
            b.type === "text" ? (
              <div key={i} className="user-text">
                {b.text}
              </div>
            ) : b.type === "image" ? (
              <Image key={i} image={b} />
            ) : b.type === "file" ? (
              <FileChip key={i} name={b.name} />
            ) : null,
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="message assistant">
      <Speaker who="assistant" backend={backend} timestamp={message.timestamp} readAloud={{ id: message.id, markdown: replyText(message) }} />
      {hideTools
        ? groupSteps(message.blocks).map((g, i) => (Array.isArray(g) ? <Steps key={i} blocks={g} /> : <AssistantBlock key={i} block={g} />))
        : message.blocks.map((b, i) => <AssistantBlock key={i} block={b} />)}
    </div>
  );
});

// Who's talking, above each message: "You" or Claude's robot, with the time.
// `readAloud` adds a Listen button for that text.
export function Speaker({
  who,
  backend,
  timestamp,
  readAloud,
}: {
  who: "user" | "assistant";
  backend?: BackendId;
  timestamp?: string;
  readAloud?: { id: string; markdown: string };
}) {
  const time = timestamp ? new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
  return (
    <div className="speaker">
      {who === "assistant" && (backend ?? "claude") === "claude" && <LogoIcon size={16} />}
      <span className="speaker-name">{who === "user" ? "You" : BACKEND_LABEL[backend ?? "claude"]}</span>
      {time && <span className="speaker-time">{time}</span>}
      {readAloud?.markdown && canSpeak && <ListenButton id={readAloud.id} markdown={readAloud.markdown} />}
    </div>
  );
}

const replyText = (m: ChatMessage) => m.blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n\n");

function ListenButton({ id, markdown }: { id: string; markdown: string }) {
  const speaking = useSpeaking() === id;
  const [problem, setProblem] = useState<string | undefined>();
  return (
    <>
      <button
        className={`listen${speaking ? " active" : ""}`}
        title={problem ?? (speaking ? "Stop reading" : "Read aloud")}
        aria-label={speaking ? "Stop reading" : "Read aloud"}
        onClick={() => (speaking ? stopSpeaking() : void speak(id, markdown).then(setProblem))}
      >
        {speaking ? <StopSquareIcon /> : <SpeakerIcon />}
      </button>
      {problem && <span className="listen-problem">{problem}</span>}
    </>
  );
}

// An attached document, shown by name.
export function FileChip({ name }: { name: string }) {
  return (
    <div className="file-chip">
      <FileIcon /> <span>{name}</span>
    </div>
  );
}

// Runs of thinking and tool blocks become arrays, to show as one line.
function groupSteps(blocks: Block[]): Array<Block | Block[]> {
  const out: Array<Block | Block[]> = [];
  for (const b of blocks) {
    const step = b.type === "thinking" || b.type === "tool";
    const last = out[out.length - 1];
    if (step && Array.isArray(last)) last.push(b);
    else out.push(step ? [b] : b);
  }
  return out;
}

// "Thought · 4 tool calls · 1 failed", expandable in place.
function Steps({ blocks }: { blocks: Block[] }) {
  const [open, setOpen] = useState(false);
  const thought = blocks.some((b) => b.type === "thinking");
  const tools = blocks.filter((b) => b.type === "tool");
  const failed = tools.filter((b) => b.result?.isError).length;
  return (
    <div className={`steps${open ? " open" : ""}`}>
      <button className="disclosure" onClick={() => setOpen(!open)}>
        <ChevronIcon open={open} /> {stepsLabel(thought, tools.length)}
        {failed > 0 && <span className="steps-failed"> · {failed} failed</span>}
      </button>
      {open && (
        <div className="steps-body">
          {blocks.map((b, i) => (
            <AssistantBlock key={i} block={b} />
          ))}
        </div>
      )}
    </div>
  );
}

export function stepsLabel(thought: boolean, tools: number, working = false): string {
  const parts = [thought ? (working && !tools ? "Thinking…" : "Thought") : "", tools ? `${tools} tool call${tools === 1 ? "" : "s"}` : ""];
  return parts.filter(Boolean).join(" · ") + (working && tools ? "…" : "");
}

function AssistantBlock({ block }: { block: Block }) {
  switch (block.type) {
    case "text":
      return <Markdown text={block.text} />;
    case "thinking":
      return <Thinking text={block.text} />;
    case "tool":
      return <ToolCall tool={block} />;
    case "image":
      return <Image image={block} />;
    case "file":
      return <FileChip name={block.name} />;
  }
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`thinking${open ? " open" : ""}`}>
      <button className="disclosure" onClick={() => setOpen(!open)}>
        <ChevronIcon open={open} /> Thinking
      </button>
      {open && <div className="thinking-body">{text}</div>}
    </div>
  );
}

export function Image({ image }: { image: ImageBlock }) {
  return (
    <a href={image.url} target="_blank" rel="noreferrer" className="image-link">
      <img src={image.url} alt="" className="image" loading="lazy" />
    </a>
  );
}

// Slash-command output like /context is Markdown (headings, tables); other
// notices (shell output) are plain text.
function looksLikeMarkdown(text: string): boolean {
  return /^#{1,4} |\n\|.*\|/m.test(text) || /\*\*[^*]+\*\*/.test(text);
}
