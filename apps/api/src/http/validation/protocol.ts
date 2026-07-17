/**
 * OpenAI / Anthropic / playground request Effect schemas.
 * Intentionally permissive (passthrough extras) for provider compatibility.
 * Production routes decode via safeParseSchema / sValidator.
 *
 * Bounds (max messages / string lengths) defend against memory DoS from
 * authenticated keys; wire size is also capped by hono bodyLimit.
 */
import { Schema } from "effect";
import {
  Email,
  exactOptional,
  PositiveSafeInt,
  SafeInt,
} from "@tokenpanel/contracts/effect";
import {
  MAX_CHAT_MEDIA_BASE64_CHARS,
  MAX_CHAT_MESSAGES_COUNT,
  MAX_CHAT_TEXT_CHARS,
  MAX_CHAT_TOOLS_COUNT,
} from "../../config/security-policy.ts";

/** Passthrough bag for unknown compatibility fields. */
const PassthroughRecord = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
});

const BoundedText = Schema.String.pipe(Schema.maxLength(MAX_CHAT_TEXT_CHARS));
const BoundedMediaData = Schema.String.pipe(
  Schema.maxLength(MAX_CHAT_MEDIA_BASE64_CHARS),
);
const BoundedModelId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(256),
);
const BoundedMessages = <A, I, R>(item: Schema.Schema<A, I, R>) =>
  Schema.Array(item).pipe(
    Schema.minItems(1),
    Schema.maxItems(MAX_CHAT_MESSAGES_COUNT),
  );
const BoundedTools = Schema.Array(Schema.Unknown).pipe(
  Schema.maxItems(MAX_CHAT_TOOLS_COUNT),
);

// ---------------------------------------------------------------------------
// OpenAI chat completions
// ---------------------------------------------------------------------------

const OpenAIContentPart = Schema.Struct(
  {
    type: Schema.Literal("text", "image_url", "input_audio"),
    text: exactOptional(BoundedText),
    image_url: exactOptional(
      Schema.Struct({ url: Schema.String.pipe(Schema.maxLength(MAX_CHAT_MEDIA_BASE64_CHARS)) }),
    ),
    input_audio: exactOptional(Schema.Struct({ data: BoundedMediaData })),
  },
  PassthroughRecord,
);

export const OpenAIMessage = Schema.Struct({
  role: Schema.Literal("system", "user", "assistant", "tool"),
  content: Schema.Union(
    BoundedText,
    Schema.Array(OpenAIContentPart).pipe(
      Schema.maxItems(MAX_CHAT_MESSAGES_COUNT),
    ),
  ),
  tool_call_id: exactOptional(
    Schema.String.pipe(Schema.maxLength(256)),
  ),
  tool_calls: exactOptional(BoundedTools),
});
export type OpenAIMessage = Schema.Schema.Type<typeof OpenAIMessage>;

export const OpenAIChatCompletionBody = Schema.Struct(
  {
    model: BoundedModelId,
    messages: BoundedMessages(OpenAIMessage),
    stream: exactOptional(Schema.Boolean),
    temperature: exactOptional(Schema.Number),
    max_tokens: exactOptional(PositiveSafeInt),
    max_completion_tokens: exactOptional(PositiveSafeInt),
    top_p: exactOptional(Schema.Number),
    tools: exactOptional(BoundedTools),
    tool_choice: exactOptional(Schema.Unknown),
    stop: exactOptional(
      Schema.Union(
        Schema.String.pipe(Schema.maxLength(200)),
        Schema.Array(Schema.String.pipe(Schema.maxLength(200))).pipe(
          Schema.maxItems(16),
        ),
      ),
    ),
    response_format: exactOptional(Schema.Unknown),
    reasoning_effort: exactOptional(
      Schema.Literal("low", "medium", "high"),
    ),
    n: exactOptional(PositiveSafeInt),
    customerEmail: exactOptional(Email),
  },
  PassthroughRecord,
);
export type OpenAIChatCompletionBody = Schema.Schema.Type<
  typeof OpenAIChatCompletionBody
>;

// ---------------------------------------------------------------------------
// Anthropic messages
// ---------------------------------------------------------------------------

const AnthropicContentBlock = Schema.Struct(
  {
    type: Schema.Literal("text", "image", "tool_use", "tool_result"),
    text: exactOptional(BoundedText),
    source: exactOptional(
      Schema.Struct({
        type: Schema.String.pipe(Schema.maxLength(64)),
        media_type: Schema.String.pipe(Schema.maxLength(128)),
        data: BoundedMediaData,
      }),
    ),
    id: exactOptional(Schema.String.pipe(Schema.maxLength(256))),
    name: exactOptional(Schema.String.pipe(Schema.maxLength(256))),
    input: exactOptional(Schema.Unknown),
    tool_use_id: exactOptional(Schema.String.pipe(Schema.maxLength(256))),
    content: exactOptional(Schema.Unknown),
  },
  PassthroughRecord,
);

export const AnthropicMessage = Schema.Struct({
  role: Schema.Literal("user", "assistant"),
  content: Schema.Union(
    BoundedText,
    Schema.Array(AnthropicContentBlock).pipe(
      Schema.maxItems(MAX_CHAT_MESSAGES_COUNT),
    ),
  ),
});
export type AnthropicMessage = Schema.Schema.Type<typeof AnthropicMessage>;

export const AnthropicMessagesBody = Schema.Struct(
  {
    model: BoundedModelId,
    messages: BoundedMessages(AnthropicMessage),
    system: exactOptional(
      Schema.Union(
        BoundedText,
        Schema.Array(Schema.Unknown).pipe(
          Schema.maxItems(MAX_CHAT_MESSAGES_COUNT),
        ),
      ),
    ),
    stream: exactOptional(Schema.Boolean),
    max_tokens: PositiveSafeInt,
    temperature: exactOptional(Schema.Number),
    top_p: exactOptional(Schema.Number),
    stop_sequences: exactOptional(
      Schema.Array(Schema.String.pipe(Schema.maxLength(200))).pipe(
        Schema.maxItems(16),
      ),
    ),
    tools: exactOptional(BoundedTools),
    tool_choice: exactOptional(Schema.Unknown),
    customerEmail: exactOptional(Email),
  },
  PassthroughRecord,
);
export type AnthropicMessagesBody = Schema.Schema.Type<
  typeof AnthropicMessagesBody
>;

// ---------------------------------------------------------------------------
// Playground (admin panel)
// ---------------------------------------------------------------------------

const PlaygroundMessage = Schema.Struct({
  role: Schema.Literal("system", "user", "assistant", "tool"),
  content: Schema.Union(
    BoundedText,
    Schema.Array(
      Schema.Struct(
        {
          type: Schema.Literal("text", "image_url", "input_audio"),
          text: exactOptional(BoundedText),
          image_url: exactOptional(
            Schema.Struct({
              url: Schema.String.pipe(
                Schema.maxLength(MAX_CHAT_MEDIA_BASE64_CHARS),
              ),
            }),
          ),
          input_audio: exactOptional(Schema.Struct({ data: BoundedMediaData })),
        },
        PassthroughRecord,
      ),
    ).pipe(Schema.maxItems(MAX_CHAT_MESSAGES_COUNT)),
  ),
  tool_call_id: exactOptional(Schema.String.pipe(Schema.maxLength(256))),
  tool_calls: exactOptional(BoundedTools),
});

export const PlaygroundChatBody = Schema.Struct(
  {
    model: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(80)),
    messages: BoundedMessages(PlaygroundMessage),
    stream: exactOptional(Schema.Boolean),
    temperature: exactOptional(Schema.Number),
    max_tokens: exactOptional(PositiveSafeInt),
    max_completion_tokens: exactOptional(PositiveSafeInt),
    top_p: exactOptional(Schema.Number),
    top_k: exactOptional(SafeInt.pipe(Schema.nonNegative())),
    frequency_penalty: exactOptional(Schema.Number),
    presence_penalty: exactOptional(Schema.Number),
    seed: exactOptional(SafeInt),
    stop: exactOptional(
      Schema.Union(
        Schema.String.pipe(Schema.maxLength(200)),
        Schema.Array(Schema.String.pipe(Schema.maxLength(200))).pipe(
          Schema.maxItems(16),
        ),
      ),
    ),
    response_format: exactOptional(Schema.Unknown),
    reasoning_effort: exactOptional(
      Schema.Literal("low", "medium", "high"),
    ),
    customerId: exactOptional(
      Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64)),
    ),
  },
  PassthroughRecord,
);
export type PlaygroundChatBody = Schema.Schema.Type<typeof PlaygroundChatBody>;
