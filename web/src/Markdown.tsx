import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

// Agents link files as relative paths (docs/x.md). The browser would resolve
// those against this server's own address, so show them as plain code.
const hasScheme = /^([a-z][a-z0-9+.-]*:|#|\/\/)/i;

const components: Components = {
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
