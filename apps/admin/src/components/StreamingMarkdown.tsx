import { memo, useMemo, useRef, useEffect, useLayoutEffect, useState, startTransition, useCallback } from "react";
import { marked } from "marked";
import DOMPurify, { type Config } from "dompurify";
import { cn } from "@/lib/utils";

marked.setOptions({
  gfm: true,
  breaks: true,
});

const purifyConfig: Config = {
  ALLOWED_TAGS: [
    "p", "br", "hr", "strong", "em", "del", "code", "pre", "blockquote",
    "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6",
    "a", "span", "table", "thead", "tbody", "tr", "th", "td",
    "img", "mark", "s", "sub", "sup",
  ],
  ALLOWED_ATTR: ["href", "title", "src", "alt", "class", "target", "rel"],
  ALLOW_DATA_ATTR: false,
};

const mdCache = new Map<string, string>();
const MD_CACHE_LIMIT = 256;

function renderMarkdown(text: string): string {
  const cached = mdCache.get(text);
  if (cached !== undefined) return cached;
  const raw = marked.parse(text, { async: false }) as string;
  const clean = DOMPurify.sanitize(raw, purifyConfig) as string;
  if (mdCache.size >= MD_CACHE_LIMIT) mdCache.delete(mdCache.keys().next().value!);
  mdCache.set(text, clean);
  return clean;
}

function splitBlocks(text: string): string[] {
  const trimmed = text.replace(/\n+$/, "");
  if (trimmed === "") return [];
  const blocks = trimmed.split(/\n{2,}/);
  return blocks;
}

interface MarkdownBlockProps {
  html: string;
  className?: string;
}

const MarkdownBlock = memo(function MarkdownBlock({ html, className }: MarkdownBlockProps) {
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}, (prev, next) => prev.html === next.html && prev.className === next.className);

interface StreamingMarkdownProps {
  content: string;
  streaming?: boolean;
  className?: string;
}

export function StreamingMarkdown({ content, streaming = false, className }: StreamingMarkdownProps): React.ReactElement {
  const blocks = useMemo(() => splitBlocks(content), [content]);

  const renderedBlocks = useMemo(() => {
    return blocks.map((block, i) => {
      const html = renderMarkdown(block);
      return { html, key: i };
    });
  }, [blocks]);

  return (
    <div className={cn("streaming-md", className)}>
      {renderedBlocks.map((block) => (
        <MarkdownBlock
          key={block.key}
          html={block.html}
          className="streaming-md-block"
        />
      ))}
      {streaming && <TypingCursor />}
    </div>
  );
}

function TypingCursor(): React.ReactElement {
  return (
    <span
      className="streaming-cursor"
      aria-hidden="true"
    />
  );
}

interface ReasoningPanelProps {
  reasoning: string;
  streaming?: boolean;
  defaultOpen?: boolean;
  reasoningTokens?: number;
  hasContent?: boolean;
}

export function ReasoningPanel({ reasoning, streaming, defaultOpen = true, reasoningTokens, hasContent }: ReasoningPanelProps): React.ReactElement | null {
  const [open, setOpen] = useState(defaultOpen);
  const [displayReasoning, setDisplayReasoning] = useState(reasoning);
  const rafRef = useRef<number | null>(null);
  const pendingRef = useRef(reasoning);

  useEffect(() => {
    pendingRef.current = reasoning;
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      setDisplayReasoning(pendingRef.current);
    });
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [reasoning]);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // Show panel when: reasoning content exists, OR still streaming before content,
  // OR stream done with reasoning tokens but no content (OpenAI reasoning models).
  const showPanel = displayReasoning || (streaming && !hasContent) || (!streaming && reasoningTokens && reasoningTokens > 0 && !displayReasoning);
  if (!showPanel) return null;

  const isThinking = streaming && !displayReasoning && !hasContent;
  const label = isThinking
    ? "Thinking…"
    : displayReasoning
      ? "Reasoning"
      : reasoningTokens && reasoningTokens > 0
        ? `Reasoned · ${reasoningTokens} tokens`
        : "Reasoning";

  return (
    <div className="rounded-md border border-dashed border-border bg-muted/20">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <svg
          className={cn("size-3 transition-transform", open && "rotate-90")}
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="M4 3l4 3-4 3" />
        </svg>
        <span className="font-medium">{label}</span>
        {streaming && displayReasoning && (
          <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground/50" />
        )}
        {isThinking && (
          <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground/50" />
        )}
      </button>
      {open && displayReasoning && (
        <div className="border-t border-border px-2 py-1.5">
          <div className="whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground font-mono">
            {displayReasoning}
          </div>
        </div>
      )}
    </div>
  );
}

export function useRafBuffer<T>(initial: T): [T, (updater: T | ((prev: T) => T)) => void, () => void, () => void] {
  const [state, setState] = useState(initial);
  const pendingRef = useRef<Array<T | ((prev: T) => T)> | null>(null);
  const rafRef = useRef<number | null>(null);

  const flush = useCallback((): void => {
    // Cancel any scheduled frame so a manual flush (e.g. on stream completion)
    // does not leave a dangling RAF that re-fires flush later. Safe when invoked
    // as the RAF callback itself (cancel of an already-fired id is a no-op).
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const queue = pendingRef.current;
    pendingRef.current = null;
    if (queue === null || queue.length === 0) return;
    startTransition(() => {
      setState((prev) => {
        let next = prev;
        for (const updater of queue) {
          next = typeof updater === "function" ? (updater as (prev: T) => T)(next) : updater;
        }
        return next;
      });
    });
  }, []);

  const update = useCallback((updater: T | ((prev: T) => T)): void => {
    if (pendingRef.current === null) pendingRef.current = [];
    pendingRef.current.push(updater);
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(flush);
    }
  }, [flush]);

  const cancel = useCallback((): void => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    pendingRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return [state, update, flush, cancel];
}

export function useAutoScroll(deps: unknown[]): {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  isNearBottomRef: React.RefObject<boolean>;
} {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const isNearBottomRef = useRef(true);

  // useLayoutEffect — runs AFTER DOM commit but BEFORE paint.
  // This is critical: with useEffect (post-paint), the browser shows one frame
  // where content grew but scrollTop hasn't caught up, causing a visible
  // up-then-down flicker on every token. useLayoutEffect sets scrollTop in the
  // same frame so the user never sees the intermediate state.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (isNearBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, deps);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = (): void => {
      const threshold = 80;
      isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  return { scrollRef, isNearBottomRef };
}
