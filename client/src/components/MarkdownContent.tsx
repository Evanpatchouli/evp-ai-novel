import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const EXTERNAL_LINK = /^(?:https?:)?\/\//i;
const INLINE_ELEMENTS = ["strong", "em", "code", "del", "a", "br"];

const components: Components = {
  a({ href, ...props }) {
    const external = href ? EXTERNAL_LINK.test(href) : false;
    return (
      <a
        {...props}
        href={href}
        {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      />
    );
  },
};

/** 安全渲染审稿 Markdown；行内模式用于标题，块级模式用于问题上下文。 */
export function MarkdownContent({
  children,
  inline = false,
  className = "",
}: {
  children: string;
  inline?: boolean;
  className?: string;
}) {
  const content: ReactNode = (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={components}
      skipHtml
      {...(inline
        ? { allowedElements: INLINE_ELEMENTS, unwrapDisallowed: true }
        : {})}
    >
      {children}
    </ReactMarkdown>
  );
  const classes = `markdown-content${inline ? " markdown-content-inline" : ""}${className ? ` ${className}` : ""}`;

  return inline ? (
    <span className={classes}>{content}</span>
  ) : (
    <div className={classes}>{content}</div>
  );
}
