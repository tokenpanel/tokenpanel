import { useCallback, useEffect, useRef, useState } from "react";
import * as playgroundApi from "../api/playground.ts";
import { apiStreamPost, ApiError } from "../api/client.ts";
import {
  applyEventToState,
  safeErr,
  round,
} from "./playground/stream-utils.ts";
import { formatMicros } from "../utils/format.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Send,
  Square,
  Trash2,
  Plus,
  Loader2,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Bot,
  Brain,
  Coins,
  Server,
  X,
  SlidersHorizontal,
} from "lucide-react";
import { Panel } from "@/components/Instrument";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { Slider } from "@/components/ui/slider";
import { hasPermission, useAuth } from "../auth/AuthContext.tsx";
import { StreamingMarkdown, ReasoningPanel, useRafBuffer, useAutoScroll } from "@/components/StreamingMarkdown";
import { cn } from "@/lib/utils";
import type {
  PlaygroundModel,
  PlaygroundCustomer,
} from "../api/types.ts";

type Role = "system" | "user" | "assistant";

interface ChatMessage {
  role: Role;
  content: string;
}

interface StreamState {
  // One entry per active model stream. Keyed by model aliasId.
  [modelAliasId: string]: {
    content: string;
    reasoning: string;
    done: boolean;
    error: string | null;
    provider: { providerId: string; upstreamModelId: string; sdkType: string } | null;
    cost: { costMicros: number; priceMicros: number; currency: string } | null;
    billed: boolean;
    usage: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      reasoningTokens?: number | undefined;
    } | null;
  };
}

interface Params {
  temperature: number; // 0..2, default 1
  topP: number; // 0..1, default 1
  topK: number; // 0..100, 0 = off
  maxTokens: number; // 0 = unset
  frequencyPenalty: number; // -2..2
  presencePenalty: number; // -2..2
  reasoningEffort: "none" | "low" | "medium" | "high";
  stop: string;
  seed: string;
}

const DEFAULT_PARAMS: Params = {
  temperature: 1,
  topP: 1,
  topK: 0,
  maxTokens: 0,
  frequencyPenalty: 0,
  presencePenalty: 0,
  reasoningEffort: "none",
  stop: "",
  seed: "",
};

const CUSTOMER_LIMIT = 200;

export default function PlaygroundPage(): React.ReactElement {
  const { user } = useAuth();
  const canReadCustomers = hasPermission(user, "customers:read");

  const [models, setModels] = useState<PlaygroundModel[]>([]);
  const [customers, setCustomers] = useState<PlaygroundCustomer[]>([]);

  // Selected models for comparison. At least one required. Multiple = side-by-side.
  const [selectedModelAliases, setSelectedModelAliases] = useState<string[]>([]);
  const [customerId, setCustomerId] = useState<string>("");
  const [paramsOpenMobile, setParamsOpenMobile] = useState(false);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [input, setInput] = useState("");
  const [params, setParams] = useState<Params>(DEFAULT_PARAMS);
  const [showParams, setShowParams] = useState(true);
  const [streaming, setStreaming] = useState(false);
  const [streamStates, setStreamStates, flushStreamStates] = useRafBuffer<StreamState>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const { scrollRef } = useAutoScroll([streamStates, messages]);

  // Load models + customers once ------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [modelRes, custRes] = await Promise.all([
          playgroundApi.listPlaygroundModels(),
          canReadCustomers
            ? playgroundApi.listPlaygroundCustomers(CUSTOMER_LIMIT)
            : Promise.resolve({ items: [], total: 0 }),
        ]);
        if (cancelled) return;
        const active = modelRes.items.filter((m) => m.active);
        setModels(active);
        setCustomers(custRes.items.filter((c) => c.status === "active"));
        if (active.length > 0) setSelectedModelAliases([active[0]!.aliasId]);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Failed to load models");
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [canReadCustomers]);

  const stopStream = useCallback(() => {
    abortRef.current?.abort();
    setStreaming(false);
    setStreamStates((s) => {
      const next = { ...s };
      for (const k of Object.keys(next)) {
        const v = next[k]!;
        if (!v.done && !v.error) next[k] = { ...v, done: true, error: v.error ?? "aborted" };
      }
      return next;
    });
    // Commit the aborted terminal state immediately; a paint RAF may never fire
    // once the tab is idle/headless, which would strand the "done" badge.
    flushStreamStates();
  }, [setStreamStates, flushStreamStates]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  function addModel(aliasId: string): void {
    setSelectedModelAliases((cur) => (cur.includes(aliasId) ? cur : [...cur, aliasId]));
  }
  function removeModel(aliasId: string): void {
    setSelectedModelAliases((cur) => cur.filter((a) => a !== aliasId));
  }

  function clearConversation(): void {
    setMessages([]);
    setStreamStates({});
  }

  async function send(): Promise<void> {
    const text = input.trim();
    if (!text || streaming || selectedModelAliases.length === 0) return;
    const userMsg: ChatMessage = { role: "user", content: text };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput("");

    // Initialise a stream-state per selected model.
    const init: StreamState = {};
    for (const alias of selectedModelAliases) init[alias] = { content: "", reasoning: "", done: false, error: null, provider: null, cost: null, billed: false, usage: null };
    setStreamStates(init);

    const bodyMessages: Array<{ role: Role; content: string }> = [];
    if (systemPrompt.trim()) bodyMessages.push({ role: "system", content: systemPrompt.trim() });
    for (const m of newMessages) bodyMessages.push({ role: m.role, content: m.content });

    const payload: Record<string, unknown> = {
      messages: bodyMessages,
      stream: true,
      temperature: params.temperature,
      top_p: params.topP,
      ...(params.topK > 0 ? { top_k: params.topK } : {}),
      ...(params.maxTokens > 0 ? { max_tokens: params.maxTokens } : {}),
      frequency_penalty: params.frequencyPenalty,
      presence_penalty: params.presencePenalty,
      ...(params.reasoningEffort !== "none" ? { reasoning_effort: params.reasoningEffort } : {}),
      ...(params.stop.trim() ? { stop: params.stop } : {}),
      ...(params.seed.trim() ? { seed: Number(params.seed) } : {}),
      ...(customerId ? { customerId } : {}),
    };

    const ac = new AbortController();
    abortRef.current = ac;
    setStreaming(true);

    // Fire one streaming request per selected model, in parallel. Each stream
    // writes into its own slot in streamStates so the UI shows side-by-side.
    // streamOne return st final slot so we can fold replies into `messages`
    // without nesting setMessages inside a setStreamStates updater (which
    // StrictMode double-invokes in dev and would duplicate the fold).
    const tasks = selectedModelAliases.map((alias) => streamOne(alias, { ...payload, model: alias }, ac.signal));
    const results = await Promise.allSettled(tasks);
    setStreaming(false);
    abortRef.current = null;

    // After all streams finish, fold the assistant replies into `messages` so a
    // follow-up message has full context. When only one model is selected, fold
    // its content as a single assistant turn; with multiple, keep them separate
    // by prefixing the model alias (so the next round sees distinct replies).
    const folded: ChatMessage[] = [];
    results.forEach((r, i) => {
      if (r.status !== "fulfilled") return;
      const st = r.value;
      if (st.error || !st.content) return;
      const alias = selectedModelAliases[i]!;
      if (selectedModelAliases.length === 1) {
        folded.push({ role: "assistant", content: st.content });
      } else {
        folded.push({ role: "assistant", content: `**${alias}**\n\n${st.content}` });
      }
    });
    if (folded.length > 0) setMessages((m) => [...m, ...folded]);
    setStreamStates({});
  }

  async function streamOne(aliasId: string, payload: Record<string, unknown>, signal: AbortSignal): Promise<StreamState[string]> {
    let st: StreamState[string] = { content: "", reasoning: "", done: false, error: null, provider: null, cost: null, billed: false, usage: null };
    const sync = (): void => setStreamStates((s) => (s[aliasId] ? { ...s, [aliasId]: st } : s));
    try {
      // Use central client (API_BASE + Bearer + 401 invalidation) — not raw same-origin fetch.
      const res = await apiStreamPost("/admin/playground/chat", payload, { signal });
      if (!res.ok || !res.body) {
        const msg = await safeErr(res);
        st = { ...st, done: true, error: msg };
        sync();
        flushStreamStates();
        return st;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          let line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          line = line.trim();
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          let evt: Record<string, unknown>;
          try {
            evt = JSON.parse(data) as Record<string, unknown>;
          } catch {
            continue;
          }
          st = applyEventToState(st, evt);
          sync();
        }
      }
      st = { ...st, done: true };
      sync();
      flushStreamStates();
      return st;
    } catch (err) {
      if (signal.aborted) {
        st = { ...st, done: true, error: "aborted" };
        return st;
      }
      const msg =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "stream failed";
      st = { ...st, done: true, error: msg };
      sync();
      flushStreamStates();
      return st;
    }
  }

  const hasActiveStream = Object.values(streamStates).some((s) => s && !s.done && !s.error);
  const anySelectedModelReasoning = selectedModelAliases.some((alias) => models.find((m) => m.aliasId === alias)?.reasoning);

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex flex-col gap-5">
        <PageHeader
          title="Playground"
          description="Send one prompt to several models side by side. Compare output, tokens, cost, and price before rollout."
        >
          <Button variant="outline" className="lg:hidden" onClick={() => setParamsOpenMobile((v) => !v)} aria-expanded={paramsOpenMobile}>
            <SlidersHorizontal />
            Parameters
          </Button>
          <Button variant="outline" onClick={clearConversation} disabled={streaming || messages.length === 0}>
            <Trash2 />
            Clear
          </Button>
        </PageHeader>
        {loadError && (
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertDescription>{loadError}</AlertDescription>
          </Alert>
        )}

        <Panel className="relative flex h-[calc(100dvh-13.5rem)] min-h-[34rem] overflow-hidden">
          {/* Parameter rail */}
          <aside
            className={cn(
              "w-72 shrink-0 flex-col border-r border-border bg-background",
              paramsOpenMobile ? "absolute inset-0 z-20 flex w-full lg:static lg:w-72" : "hidden lg:flex",
            )}
            aria-label="Parameters"
          >
            <div className="flex h-12 items-center justify-between border-b border-rule px-4">
              <span className="legend text-muted-foreground">Parameters</span>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setParams(DEFAULT_PARAMS)}>
                  Reset
                </Button>
                <Button variant="ghost" size="icon-sm" className="hidden lg:inline-flex" onClick={() => setShowParams((v) => !v)} aria-label={showParams ? "Collapse parameters" : "Expand parameters"}>
                  {showParams ? <ChevronUp /> : <ChevronDown />}
                </Button>
                <Button variant="ghost" size="icon-sm" className="lg:hidden" onClick={() => setParamsOpenMobile(false)} aria-label="Close parameters">
                  <X />
                </Button>
              </div>
            </div>
            {showParams || paramsOpenMobile ? (
              <div className="flex flex-col gap-5 overflow-y-auto px-4 py-4">
                <ParamSlider label="Temperature" value={params.temperature} min={0} max={2} step={0.05} onChange={(v) => setParams((p) => ({ ...p, temperature: round(v, 2) }))} />
                <ParamSlider label="Top P" value={params.topP} min={0} max={1} step={0.05} onChange={(v) => setParams((p) => ({ ...p, topP: round(v, 2) }))} />
                <ParamSlider label="Top K" value={params.topK} min={0} max={100} step={1} onChange={(v) => setParams((p) => ({ ...p, topK: v }))} hint="0 = off" />
                <ParamSlider label="Max tokens" value={params.maxTokens} min={0} max={8192} step={1} onChange={(v) => setParams((p) => ({ ...p, maxTokens: v }))} hint="0 = unset" />
                <ParamSlider label="Frequency penalty" value={params.frequencyPenalty} min={-2} max={2} step={0.1} onChange={(v) => setParams((p) => ({ ...p, frequencyPenalty: round(v, 1) }))} />
                <ParamSlider label="Presence penalty" value={params.presencePenalty} min={-2} max={2} step={0.1} onChange={(v) => setParams((p) => ({ ...p, presencePenalty: round(v, 1) }))} />

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="pg-effort" className="text-xs">
                    Reasoning effort
                  </Label>
                  <Select
                    value={params.reasoningEffort}
                    onValueChange={(v) => setParams((p) => ({ ...p, reasoningEffort: v as Params["reasoningEffort"] }))}
                    disabled={!anySelectedModelReasoning}
                  >
                    <SelectTrigger id="pg-effort" className="h-8 text-[13px]"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None</SelectItem>
                      <SelectItem value="low">Low</SelectItem>
                      <SelectItem value="medium">Medium</SelectItem>
                      <SelectItem value="high">High</SelectItem>
                    </SelectContent>
                  </Select>
                  {!anySelectedModelReasoning ? (
                    <span className="text-[11px] text-muted-foreground">No reasoning model selected.</span>
                  ) : null}
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="pg-stop" className="text-xs">Stop</Label>
                    <Input id="pg-stop" value={params.stop} onChange={(e) => setParams((p) => ({ ...p, stop: e.target.value }))} placeholder="\n" className="h-8 font-mono text-xs" />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="pg-seed" className="text-xs">Seed</Label>
                    <Input id="pg-seed" inputMode="numeric" value={params.seed} onChange={(e) => setParams((p) => ({ ...p, seed: e.target.value.replace(/[^0-9]/g, "") }))} placeholder="Unset" className="h-8 text-xs tabular-nums" />
                  </div>
                </div>

                <div className="flex flex-col gap-1.5 border-t border-rule pt-4">
                  <Label htmlFor="pg-bill" className="text-xs">Bill to customer</Label>
                  <Select value={customerId || "__none"} onValueChange={(v) => setCustomerId(v === "__none" ? "" : v)}>
                    <SelectTrigger id="pg-bill" className="h-8 text-[13px]"><SelectValue placeholder="No billing (admin test)" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none">No billing (admin test)</SelectItem>
                      {customers.map((c) => (
                        <SelectItem key={c._id} value={c._id}>{c.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] leading-snug text-muted-foreground">
                    {customerId
                      ? "Usage debits this customer's balance and counts toward their rolling limits."
                      : "Requests are not billed to anyone. Cost is still shown."}
                  </p>
                </div>
              </div>
            ) : null}
          </aside>

          {/* Chat */}
          <section className="flex min-w-0 flex-1 flex-col" aria-label="Conversation">
            <div className="flex min-h-12 flex-wrap items-center gap-2 border-b border-rule px-4 py-2 sm:px-5">
              <span className="legend mr-1 text-muted-foreground">Models</span>
              {selectedModelAliases.map((alias) => {
                const m = models.find((x) => x.aliasId === alias);
                return (
                  <span key={alias} className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-card pl-2.5 pr-1 text-[13px] font-medium">
                    <span className="max-w-[160px] truncate">{m?.displayName ?? alias}</span>
                    {m?.reasoning ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Brain className="size-3.5 text-muted-foreground" aria-label="Reasoning capable" />
                        </TooltipTrigger>
                        <TooltipContent>Reasoning capable</TooltipContent>
                      </Tooltip>
                    ) : null}
                    <button
                      type="button"
                      className="flex size-5 items-center justify-center rounded-[4px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
                      onClick={() => removeModel(alias)}
                      disabled={streaming || selectedModelAliases.length <= 1}
                      aria-label={`Remove ${alias}`}
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                );
              })}
              <ModelAddMenu models={models} selected={selectedModelAliases} onAdd={addModel} disabled={streaming} />
            </div>

            <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-6 sm:px-6" style={{ overflowAnchor: "none" }}>
              {messages.length === 0 && Object.keys(streamStates).length === 0 ? (
                <EmptyState
                  className="h-full"
                  icon={<Bot />}
                  title="Ask the selected models anything"
                  description="Each model answers in its own panel with token counts, upstream cost, and the price a customer would pay."
                />
              ) : (
                <div className="mx-auto flex max-w-3xl flex-col gap-4">
                  {systemPrompt.trim() && (
                    <div className="rounded-lg border border-dashed border-border px-3.5 py-2.5 text-sm">
                      <div className="legend mb-1 text-muted-foreground">System</div>
                      <div className="whitespace-pre-wrap text-foreground/85">{systemPrompt}</div>
                    </div>
                  )}
                  {messages.map((m, i) => (
                    <MessageBubble key={i} role={m.role} content={m.content} />
                  ))}
                  {Object.entries(streamStates).map(([alias, st]) => (
                    <StreamPanel
                      key={alias}
                      displayName={models.find((x) => x.aliasId === alias)?.displayName ?? alias}
                      state={st}
                      streaming={streaming}
                      modelReasoning={models.find((x) => x.aliasId === alias)?.reasoning ?? false}
                      reasoningEffort={params.reasoningEffort}
                    />
                  ))}
                </div>
              )}
            </div>

            <div className="border-t border-rule bg-background px-4 py-3 sm:px-5">
              <div className="mx-auto flex max-w-3xl flex-col gap-2">
                <details className="group">
                  <summary className="cursor-pointer list-none text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground [&::-webkit-details-marker]:hidden">
                    <span className="inline-flex items-center gap-1">
                      <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
                      System prompt{systemPrompt.trim() ? " · set" : ""}
                    </span>
                  </summary>
                  <Textarea
                    aria-label="System prompt"
                    value={systemPrompt}
                    onChange={(e) => setSystemPrompt(e.target.value)}
                    placeholder="Optional instructions sent before every message"
                    rows={2}
                    className="mt-2 text-sm"
                  />
                </details>
                <div className="flex items-end gap-2">
                  <Textarea
                    aria-label="Message"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder={selectedModelAliases.length === 0 ? "Add a model first" : "Message the selected models · Enter to send, Shift+Enter for a new line"}
                    rows={2}
                    className="min-h-[48px] flex-1 resize-none text-sm"
                    disabled={streaming || selectedModelAliases.length === 0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void send();
                      }
                    }}
                  />
                  {streaming ? (
                    <Button variant="outline" size="icon" className="size-12" onClick={stopStream} aria-label="Stop">
                      <Square className="fill-current" />
                    </Button>
                  ) : (
                    <Button size="icon" className="size-12" onClick={() => void send()} disabled={!input.trim() || selectedModelAliases.length === 0} aria-label="Send">
                      {hasActiveStream ? <Loader2 className="animate-spin" /> : <Send />}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </section>
        </Panel>
      </div>
    </TooltipProvider>
  );
}

// ---- Child components (module scope) -----------------------------------------
// These MUST live at module scope, not inside PlaygroundPage. A component
// declared inside another component gets a new function identity on every
// render, which makes React unmount + remount the subtree each time. During
// streaming that meant every token tore down + recreated the StreamPanel /
// MessageBubble DOM, replaying entrance animations (the visible "transparent
// flash" flicker) and thrashing the markdown DOM. Stable identity = React
// reconciles in place = zero flicker.

function MessageBubble({ role, content }: { role: Role; content: string }): React.ReactElement {
  const isUser = role === "user";
  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-lg px-3.5 py-2.5 text-sm",
          isUser ? "bg-secondary text-secondary-foreground" : "border border-border bg-card text-card-foreground",
        )}
      >
        {isUser ? (
          <div className="whitespace-pre-wrap break-words">{content}</div>
        ) : (
          <StreamingMarkdown content={content} />
        )}
      </div>
    </div>
  );
}

function StreamPanel({ displayName, state, streaming: isStreaming, modelReasoning, reasoningEffort }: {
  displayName: string;
  state: StreamState[string];
  streaming: boolean;
  modelReasoning: boolean;
  reasoningEffort: string;
}): React.ReactElement {
  const loading = isStreaming && !state.content && !state.reasoning && !state.error;
  const isActivelyStreaming = isStreaming && !state.done && !state.error;
  const reasoningEnabled = modelReasoning && reasoningEffort !== "none";
  const reasoningTokens = state.usage?.reasoningTokens ?? 0;
  return (
    // Plain div, NOT FadeIn. FadeIn's opacity:0->1 keyframe re-runs if this
    // node ever re-mounts; a stable div keeps the panel painted at all times.
    <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card px-3.5 py-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="text-[13px] font-semibold text-foreground">{displayName}</span>
          {state.provider && (
            <span className="inline-flex items-center gap-1 font-mono text-[11px]">
              <Server className="size-3" />
              {state.provider.upstreamModelId}
            </span>
          )}
          <span className="ml-auto">
            {state.error ? (
              <Badge variant="destructive">Error</Badge>
            ) : state.done ? (
              <Badge variant="success">Done</Badge>
            ) : isActivelyStreaming ? (
              <Badge variant="info">Streaming</Badge>
            ) : null}
          </span>
        </div>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Calling model…
          </div>
        ) : null}
        {(state.reasoning || reasoningEnabled) ? (
          <ReasoningPanel
            reasoning={state.reasoning}
            streaming={isActivelyStreaming}
            defaultOpen={true}
            reasoningTokens={reasoningTokens}
            hasContent={!!state.content}
          />
        ) : null}
        {state.content ? (
          <StreamingMarkdown content={state.content} streaming={isActivelyStreaming} />
        ) : null}
        {state.error ? (
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertDescription className="text-xs">{state.error}</AlertDescription>
          </Alert>
        ) : null}
        {(state.usage || state.cost) && !isActivelyStreaming && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-rule pt-2 text-[11.5px] tabular-nums text-muted-foreground">
            {state.usage && (
              <span className="flex items-center gap-1">
                <Coins className="size-3" />
                {state.usage.promptTokens} in · {state.usage.completionTokens} out
                {state.usage.reasoningTokens ? ` · ${state.usage.reasoningTokens} reasoning` : ""}
              </span>
            )}
            {state.cost && (
              <span className="flex items-center gap-1">
                cost {formatMicros(state.cost.costMicros, state.cost.currency)}
                {state.billed ? ` · billed ${formatMicros(state.cost.priceMicros, state.cost.currency)}` : " · not billed"}
              </span>
            )}
          </div>
        )}
    </div>
  );
}

function ModelAddMenu({ models, selected, onAdd, disabled }: { models: PlaygroundModel[]; selected: string[]; onAdd: (alias: string) => void; disabled: boolean }): React.ReactElement {
  const available = models.filter((m) => !selected.includes(m.aliasId));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7" disabled={disabled || available.length === 0}>
          <Plus />
          Add model
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 w-64 overflow-y-auto">
        <DropdownMenuLabel>Compare with</DropdownMenuLabel>
        {available.map((m) => (
          <DropdownMenuItem key={m.aliasId} onClick={() => onAdd(m.aliasId)} className="justify-between gap-3">
            <span className="truncate">{m.displayName}</span>
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{m.aliasId}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ParamSlider({ label, value, min, max, step, onChange, hint }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; hint?: string }): React.ReactElement {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-xs">{label}</Label>
        <span className="text-xs font-medium tabular-nums">{value}</span>
      </div>
      <Slider value={value} min={min} max={max} step={step} onChange={onChange} aria-label={label} />
      {hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

// ---- helpers ----------------------------------------------------------------

