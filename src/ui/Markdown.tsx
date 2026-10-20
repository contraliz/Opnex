import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Render user-authored or model-authored Markdown without enabling raw HTML. */
export function Markdown({ children }: { children: string }) {
  return <ReactMarkdown
    remarkPlugins={[remarkGfm]}
    components={{
      a: ({ href, children, ...props }) => <a href={href} {...props} target="_blank" rel="noopener noreferrer">{children}</a>,
    }}
  >{children}</ReactMarkdown>;
}
