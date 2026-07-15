export type ContentPart = {
  type: "text" | "image_url" | "input_audio";
  text?: string;
  imageUrl?: { url: string };
  inputData?: string;
};

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  toolCallId?: string;
  toolCalls?: unknown[];
  reasoning?: string;
};

export type DiscoveredModel = {
  upstreamModelId: string;
  displayName: string;
  reasoning?: boolean;
  toolCall?: boolean;
  structuredOutput?: boolean;
  temperature?: boolean;
  attachment?: boolean;
  limits: { context: number; input?: number; output?: number };
  modalities: { input: string[]; output: string[] };
  status?: "alpha" | "beta" | "deprecated" | "ga";
  cost?: {
    inputMinorPerMillion: number;
    outputMinorPerMillion: number;
    reasoningMinorPerMillion?: number;
    cacheReadMinorPerMillion?: number;
    cacheWriteMinorPerMillion?: number;
    inputAudioMinorPerMillion?: number;
    outputAudioMinorPerMillion?: number;
  };
  raw?: Record<string, unknown>;
};

export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  tools?: unknown[];
  toolChoice?: unknown;
  stop?: string[];
  responseFormat?: unknown;
  reasoning?: { effort?: "low" | "medium" | "high" } | boolean;
  signal?: AbortSignal;
  extra?: Record<string, unknown>;
};

export type ChatResponse = {
  id: string;
  model: string;
  choices: {
    index: number;
    message: ChatMessage;
    finishReason: string;
  }[];
  usage: {
    promptTokens: number;
    completionTokens: number;
    reasoningTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    totalTokens: number;
    /** Adapter-stamped cache billing mode; see CacheAccountingMode. */
    cacheAccounting?: "subset" | "additive";
  };
  /** Explicit usage provenance; missing must not settle as free. */
  usageStatus?: "reported" | "missing";
  usageMissingReason?: string;
  providerRequestId?: string;
};

export type StreamChunk = {
  type: "delta" | "done" | "error";
  delta?: {
    content?: string;
    toolCalls?: unknown[];
    reasoning?: string;
  };
  finishReason?: string;
  usage?: ChatResponse["usage"];
  /**
   * True only when a protocol terminal event was observed
   * (OpenAI `[DONE]`, Anthropic `message_stop`). EOF without a terminal event
   * yields `done` with `streamComplete: false` so routes do not settle
   * partial/truncated usage as authoritative.
   */
  streamComplete?: boolean;
  error?: { code: string; message: string };
};

export type AdapterContext = {
  baseUrl: string;
  apiKey: string;
  providerOrg?: string | null;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

export type ProviderAdapter = {
  sdkType: string;
  listModels(ctx: AdapterContext): Promise<DiscoveredModel[]>;
  chatComplete(ctx: AdapterContext, req: ChatRequest): Promise<ChatResponse>;
  streamChat(
    ctx: AdapterContext,
    req: ChatRequest,
  ): AsyncGenerator<StreamChunk, void, void>;
};