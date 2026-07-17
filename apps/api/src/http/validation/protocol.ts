/**
 * OpenAI / Anthropic / playground request Effect schemas.
 * Intentionally permissive (passthrough extras) for provider compatibility.
 * Production routes decode via safeParseSchema / sValidator.
 */
import { Schema } from "effect";
import {
  Email,
  exactOptional,
  PositiveSafeInt,
  SafeInt,
} from "@tokenpanel/contracts/effect";

/** Passthrough bag for unknown compatibility fields. */
const PassthroughRecord = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
});

// ---------------------------------------------------------------------------
// OpenAI chat completions
// ---------------------------------------------------------------------------

const OpenAIContentPart = Schema.Struct(
  {
    type: Schema.Literal("text", "image_url", "input_audio"),
    text: exactOptional(Schema.String),
    image_url: exactOptional(Schema.Struct({ url: Schema.String })),
    input_audio: exactOptional(Schema.Struct({ data: Schema.String })),
  },
  PassthroughRecord,
);

export const OpenAIMessage = Schema.Struct({
  role: Schema.Literal("system", "user", "assistant", "tool"),
  content: Schema.Union(
    Schema.String,
    Schema.Array(OpenAIContentPart),
  ),
  tool_call_id: exactOptional(Schema.String),
  tool_calls: exactOptional(Schema.Array(Schema.Unknown)),
});
export type OpenAIMessage = Schema.Schema.Type<typeof OpenAIMessage>;

export const OpenAIChatCompletionBody = Schema.Struct(
  {
    model: Schema.String.pipe(Schema.minLength(1)),
    messages: Schema.Array(OpenAIMessage).pipe(Schema.minItems(1)),
    stream: exactOptional(Schema.Boolean),
    temperature: exactOptional(Schema.Number),
    max_tokens: exactOptional(PositiveSafeInt),
    max_completion_tokens: exactOptional(PositiveSafeInt),
    top_p: exactOptional(Schema.Number),
    tools: exactOptional(Schema.Array(Schema.Unknown)),
    tool_choice: exactOptional(Schema.Unknown),
    stop: exactOptional(
      Schema.Union(Schema.String, Schema.Array(Schema.String)),
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
    text: exactOptional(Schema.String),
    source: exactOptional(
      Schema.Struct({
        type: Schema.String,
        media_type: Schema.String,
        data: Schema.String,
      }),
    ),
    id: exactOptional(Schema.String),
    name: exactOptional(Schema.String),
    input: exactOptional(Schema.Unknown),
    tool_use_id: exactOptional(Schema.String),
    content: exactOptional(Schema.Unknown),
  },
  PassthroughRecord,
);

export const AnthropicMessage = Schema.Struct({
  role: Schema.Literal("user", "assistant"),
  content: Schema.Union(
    Schema.String,
    Schema.Array(AnthropicContentBlock),
  ),
});
export type AnthropicMessage = Schema.Schema.Type<typeof AnthropicMessage>;

export const AnthropicMessagesBody = Schema.Struct(
  {
    model: Schema.String.pipe(Schema.minLength(1)),
    messages: Schema.Array(AnthropicMessage).pipe(Schema.minItems(1)),
    system: exactOptional(
      Schema.Union(Schema.String, Schema.Array(Schema.Unknown)),
    ),
    stream: exactOptional(Schema.Boolean),
    max_tokens: PositiveSafeInt,
    temperature: exactOptional(Schema.Number),
    top_p: exactOptional(Schema.Number),
    stop_sequences: exactOptional(Schema.Array(Schema.String)),
    tools: exactOptional(Schema.Array(Schema.Unknown)),
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
    Schema.String,
    Schema.Array(
      Schema.Struct(
        {
          type: Schema.Literal("text", "image_url", "input_audio"),
          text: exactOptional(Schema.String),
          image_url: exactOptional(Schema.Struct({ url: Schema.String })),
          input_audio: exactOptional(Schema.Struct({ data: Schema.String })),
        },
        PassthroughRecord,
      ),
    ),
  ),
  tool_call_id: exactOptional(Schema.String),
  tool_calls: exactOptional(Schema.Array(Schema.Unknown)),
});

export const PlaygroundChatBody = Schema.Struct(
  {
    model: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(80)),
    messages: Schema.Array(PlaygroundMessage).pipe(Schema.minItems(1)),
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
      Schema.Union(Schema.String, Schema.Array(Schema.String)),
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
