import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

// Agents link files as relative paths (docs/x.md). The browser would resolve
// those against this server's own address, so show them as plain code.
const hasScheme = /^([a-z][a-z0-9+.-]*:|#|\/\/)/i;

// Only our own images and inline data: images load; a remote URL would let a
// hostile reply leak data by making the browser fetch it.
const localImage = /^(\/(?![\/\\])|data:image\/)[^\x00-\x1f]*$/i;

const components: Components = {
  img: ({ node: _node, src, alt }) =>
    typeof src === "string" && localImage.test(src) ? (
      <img src={src} alt={alt ?? ""} />
    ) : (
      <code title={typeof src === "string" ? src : undefined}>{alt || src || "image"}</code>
    ),
  a: ({ node: _node, href, children, ...props }) =>
    !href || !hasScheme.test(href) ? (
      <code title={href || undefined}>{children}</code>
    ) : (
      <a {...props} href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    ),
};

// remark-breaks keeps single line breaks, as Claude Code's terminal does.
const PLUGINS = [remarkGfm, remarkBreaks];

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={PLUGINS} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
