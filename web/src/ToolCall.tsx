import { useState } from "react";
import { ChevronIcon } from "./icons.tsx";
import type { ToolBlock } from "../../shared/types.ts";
import { Image } from "./Message.tsx";

type Input = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

// One-line description shown on the collapsed tool call.
export function summarize(name: string, input: Input): string {
  switch (name) {
    case "Bash":
      return str(input.description) ?? str(input.command) ?? "";
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return str(input.file_path) ?? str(input.notebook_path) ?? "";
    case "Grep":
    case "Glob":
      return [str(input.pattern), str(input.path)].filter(Boolean).join("  in  ");
    case "WebFetch":
      return str(input.url) ?? "";
    case "WebSearch":
      return str(input.query) ?? "";
    case "Agent":
    case "Task":
      return str(input.description) ?? "";
    case "AskUserQuestion": {
      const first = Array.isArray(input.questions) ? (input.questions[0] as { question?: unknown } | undefined) : undefined;
      return str(first?.question) ?? "";
    }
    default: {
      const first = Object.values(input).find((v) => typeof v === "string");
      return typeof first === "string" ? first : "";
    }
  }
}

export function ToolInput({ name, input }: { name: string; input: Input }) {
  if (name === "Bash" && str(input.command)) {
    return <pre className="tool-code">$ {String(input.command)}</pre>;
  }
  if (name === "Edit" && typeof input.old_string === "string") {
    return (
      <div className="tool-diff">
        <pre className="diff-old">{String(input.old_string)}</pre>
        <pre className="diff-new">{String(input.new_string ?? "")}</pre>
      </div>
    );
  }
  if (name === "Write" && typeof input.content === "string") {
    return <pre className="tool-code">{input.content}</pre>;
  }
  return <pre className="tool-code">{JSON.stringify(input, null, 2)}</pre>;
}

// Images a tool returned (e.g. Read on a PNG) show under the call even when it
// is collapsed, so what Claude looked at or made is visible without digging.
export function ToolImages({ tool }: { tool: ToolBlock }) {
  const images = tool.result?.images ?? [];
  if (!images.length) return null;
  return (
    <div className="tool-images">
      {images.map((img, i) => (
        <Image key={i} image={img} />
      ))}
    </div>
  );
}

export function ToolCall({ tool }: { tool: ToolBlock }) {
  const [open, setOpen] = useState(false);
  const input = (tool.input && typeof tool.input === "object" ? tool.input : {}) as Input;
  const status = !tool.result ? "pending" : tool.result.isError ? "error" : "ok";

  return (
    <div className={`tool ${status}${open ? " open" : ""}`}>
      <button className="tool-header" onClick={() => setOpen(!open)}>
        <ChevronIcon open={open} />
        <span className="tool-name">{tool.name}</span>
        <span className="tool-summary">{summarize(tool.name, input)}</span>
        {status === "error" && <span className="tool-badge">error</span>}
      </button>
      {open && (
        <div className="tool-body">
          <ToolInput name={tool.name} input={input} />
          {tool.result && (
            <>
              {tool.result.text && (
                <pre className={`tool-result${tool.result.isError ? " error" : ""}`}>
                  {tool.result.text}
                  {tool.result.truncated && "\n… (truncated)"}
                </pre>
              )}
            </>
          )}
        </div>
      )}
      <ToolImages tool={tool} />
    </div>
  );
}
