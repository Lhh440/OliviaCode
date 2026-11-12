import { useMemo, useState, type ReactNode } from 'react';
import { Icon } from '../icons';

/**
 * 轻量 Markdown 渲染：只产出 React 元素，不拼 HTML 字符串，
 * 因此模型输出里的 <script> 之类不会被当成标签执行。
 * 支持：标题、段落、加粗/斜体/删除线、行内代码、围栏代码块、
 * 有序/无序列表、引用、分隔线、链接。
 */

type InlineToken =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'italic'; text: string }
  | { kind: 'strike'; text: string }
  | { kind: 'link'; text: string; href: string };

const INLINE_RE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(~~[^~\n]+~~)|(\[[^\]\n]+\]\([^)\s]+\))/g;

function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE_RE)) {
    const index = match.index ?? 0;
    if (index > last) tokens.push({ kind: 'text', text: text.slice(last, index) });
    const raw = match[0];
    if (raw.startsWith('`')) {
      tokens.push({ kind: 'code', text: raw.slice(1, -1) });
    } else if (raw.startsWith('**') || raw.startsWith('__')) {
      tokens.push({ kind: 'bold', text: raw.slice(2, -2) });
    } else if (raw.startsWith('~~')) {
      tokens.push({ kind: 'strike', text: raw.slice(2, -2) });
    } else if (raw.startsWith('[')) {
      const close = raw.indexOf('](');
      tokens.push({
        kind: 'link',
        text: raw.slice(1, close),
        href: raw.slice(close + 2, -1),
      });
    } else {
      tokens.push({ kind: 'italic', text: raw.slice(1, -1) });
    }
    last = index + raw.length;
  }
  if (last < text.length) tokens.push({ kind: 'text', text: text.slice(last) });
  return tokens;
}

function inline(text: string): ReactNode[] {
  return parseInline(text).map((token, index) => {
    switch (token.kind) {
      case 'code':
        return (
          <code className="md-code" key={index}>
            {token.text}
          </code>
        );
      case 'bold':
        return <strong key={index}>{token.text}</strong>;
      case 'italic':
        return <em key={index}>{token.text}</em>;
      case 'strike':
        return <del key={index}>{token.text}</del>;
      case 'link':
        return (
          <a key={index} href={token.href} target="_blank" rel="noreferrer">
            {token.text}
          </a>
        );
      default:
        return <span key={index}>{token.text}</span>;
    }
  });
}

type Block =
  | { kind: 'code'; lang: string; code: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; items: { depth: number; text: string }[] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'hr' }
  | { kind: 'para'; lines: string[] };

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;

    if (/^\s*```/.test(line)) {
      const lang = line.trim().replace(/^```/, '').trim();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```/.test(lines[index]!)) {
        body.push(lines[index]!);
        index += 1;
      }
      index += 1;
      blocks.push({ kind: 'code', lang, code: body.join('\n') });
      continue;
    }

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1]!.length, text: heading[2]!.trim() });
      index += 1;
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s\S]*$/.test(line) && line.trim().replace(/[-*_\s]/g, '') === '') {
      blocks.push({ kind: 'hr' });
      index += 1;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index]!)) {
        quoted.push(lines[index]!.replace(/^\s*>\s?/, ''));
        index += 1;
      }
      blocks.push({ kind: 'quote', lines: quoted });
      continue;
    }

    const listMatch = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (listMatch) {
      const ordered = /\d/.test(listMatch[2]!);
      const items: { depth: number; text: string }[] = [];
      while (index < lines.length) {
        const current = lines[index]!;
        const m = current.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (!m) {
          // 续行：缩进的普通文本算作上一项的延续
          if (items.length > 0 && /^\s{2,}\S/.test(current)) {
            items[items.length - 1]!.text += ` ${current.trim()}`;
            index += 1;
            continue;
          }
          break;
        }
        items.push({ depth: Math.floor((m[1]?.length ?? 0) / 2), text: m[3]! });
        index += 1;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    const para: string[] = [];
    while (index < lines.length) {
      const current = lines[index]!;
      if (
        !current.trim() ||
        /^\s*```/.test(current) ||
        /^(#{1,6})\s+/.test(current) ||
        /^\s*>/.test(current) ||
        /^(\s*)([-*+]|\d+[.)])\s+/.test(current)
      ) {
        break;
      }
      para.push(current.trim());
      index += 1;
    }
    blocks.push({ kind: 'para', lines: para });
  }

  return blocks;
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="md-pre">
      <div className="md-pre-head">
        <span>{lang || 'text'}</span>
        <button
          className="md-copy"
          onClick={() => {
            void navigator.clipboard?.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          }}
        >
          <Icon name={copied ? 'check' : 'file'} size={12} />
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return (
    <div className="md">
      {blocks.map((block, index) => {
        switch (block.kind) {
          case 'code':
            return <CodeBlock key={index} lang={block.lang} code={block.code} />;
          case 'heading': {
            const level = Math.min(3, block.level);
            const Tag = (`h${level + 2}` as unknown) as 'h3';
            return (
              <Tag className={`md-h md-h${level}`} key={index}>
                {inline(block.text)}
              </Tag>
            );
          }
          case 'hr':
            return <hr className="md-hr" key={index} />;
          case 'quote':
            return (
              <blockquote className="md-quote" key={index}>
                {inline(block.lines.join(' '))}
              </blockquote>
            );
          case 'list': {
            const Tag = block.ordered ? 'ol' : 'ul';
            return (
              <Tag className="md-list" key={index}>
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex} style={{ marginLeft: item.depth * 16 }}>
                    {inline(item.text)}
                  </li>
                ))}
              </Tag>
            );
          }
          default:
            return (
              <p className="md-p" key={index}>
                {block.lines.map((line, lineIndex) => (
                  <span key={lineIndex}>
                    {inline(line)}
                    {lineIndex < block.lines.length - 1 ? <br /> : null}
                  </span>
                ))}
              </p>
            );
        }
      })}
    </div>
  );
}
