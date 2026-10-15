import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';

const components = {
  p: ({ children }) => <p className="my-3 leading-7 text-slate-700">{children}</p>,
  h1: ({ children }) => <h1 className="mb-3 mt-5 text-2xl font-semibold leading-snug text-slate-900">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-3 mt-5 text-xl font-semibold leading-snug text-slate-900">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-3 mt-5 text-lg font-semibold leading-snug text-slate-900">{children}</h3>,
  h4: ({ children }) => <h4 className="mb-3 mt-5 font-semibold leading-snug text-slate-900">{children}</h4>,
  h5: ({ children }) => <h5 className="mb-3 mt-5 text-sm font-semibold leading-snug text-slate-900">{children}</h5>,
  h6: ({ children }) => <h6 className="mb-3 mt-5 text-sm font-semibold leading-snug text-slate-900">{children}</h6>,
  strong: ({ children }) => <strong className="font-semibold text-slate-900">{children}</strong>,
  a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer" className="text-blue-700 underline underline-offset-2">{children}</a>,
  ul: ({ children }) => <ul className="my-3 list-disc space-y-1 pl-6 text-slate-700">{children}</ul>,
  ol: ({ children }) => <ol className="my-3 list-decimal space-y-1 pl-6 text-slate-700">{children}</ol>,
  li: ({ children }) => <li className="pl-1">{children}</li>,
  blockquote: ({ children }) => <blockquote className="my-4 border-l-4 border-blue-300 pl-4 text-slate-600">{children}</blockquote>,
  hr: () => <hr className="my-5 border-slate-200" />,
  table: ({ children }) => <div className="my-5 w-full max-w-full overflow-x-auto rounded-xl border border-slate-200"><table className="w-full min-w-[520px] border-collapse text-left text-sm">{children}</table></div>,
  thead: ({ children }) => <thead className="bg-slate-100 text-slate-900">{children}</thead>,
  tr: ({ children }) => <tr className="even:bg-slate-50">{children}</tr>,
  th: ({ children }) => <th className="border-b border-slate-200 px-4 py-3 font-semibold">{children}</th>,
  td: ({ children }) => <td className="border-b border-slate-100 px-4 py-3 align-top text-slate-700">{children}</td>,
  pre: ({ children }) => <pre className="my-4 max-w-full overflow-x-auto rounded-xl bg-slate-900 p-4 text-sm leading-6 text-slate-100">{children}</pre>,
  code: ({ children, className }) => className
    ? <code className={`${className} font-mono`}>{children}</code>
    : <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[0.9em] text-slate-800">{children}</code>,
};

function normalizeMathDelimiters(markdown) {
  // Keep examples inside code fences and inline code untouched.
  return markdown.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g).map((part) => {
    if (part.startsWith('```') || part.startsWith('~~~') || part.startsWith('`')) return part;
    return part
      .replace(/\\\[([\s\S]*?)\\\]/g, (_, formula) => `\n$$\n${formula}\n$$\n`)
      .replace(/\\\(([\s\S]*?)\\\)/g, (_, formula) => `$${formula}$`);
  }).join('');
}

export default function MarkdownRenderer({ children, className = '' }) {
  const markdown = normalizeMathDelimiters(String(children ?? '').replace(/\r\n?/g, '\n'));

  return (
    <div className={`markdown-response font-radio-canada w-full min-w-0 max-w-full text-[15px] ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: 'ignore', trust: false }]]} components={components}>
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
