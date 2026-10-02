import { Fragment, type ReactNode } from 'react';

/**
 * Just enough formatting for support replies: fenced code blocks, inline
 * `code`, **bold** and bare links. Built from React elements, never HTML, so
 * nothing a model or a customer writes can inject markup.
 */

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|https?:\/\/[^\s<>()"'`]+[^\s<>()"'`.,;:!?])/g;

function inline(text: string, keyPrefix: string): ReactNode[] {
  return text.split(INLINE).map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code key={key} className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[0.85em] text-zinc-900">
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={key} className="font-semibold">{part.slice(2, -2)}</strong>;
    }
    if (/^https?:\/\//.test(part)) {
      return (
        <a key={key} href={part} target="_blank" rel="noopener noreferrer" className="break-all underline">
          {part}
        </a>
      );
    }
    return <Fragment key={key}>{part}</Fragment>;
  });
}

export function RichText({ text }: { text: string }) {
  const blocks = text.split(/```[^\n]*\n?/);
  return (
    <div className="space-y-2 break-words text-sm leading-6">
      {blocks.map((block, index) => {
        if (index % 2 === 1) {
          return (
            <pre
              key={index}
              className="overflow-x-auto rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 font-mono text-xs leading-relaxed text-zinc-800"
            >
              {block.replace(/\n$/, '')}
            </pre>
          );
        }
        const trimmed = block.replace(/^\n+|\n+$/g, '');
        if (trimmed === '') return null;
        return (
          <p key={index} className="whitespace-pre-wrap">
            {inline(trimmed, String(index))}
          </p>
        );
      })}
    </div>
  );
}
