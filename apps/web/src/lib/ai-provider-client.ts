import { AI_PROVIDER_CATALOG, type AiProviderType } from "@clipforge/core";

export interface AgentToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AgentToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

export type AgentConversationMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: AgentToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface LlmCompletionResult {
  content: string;
  toolCalls: AgentToolCall[];
  modelUsed: string;
}

export interface ResolvedProviderCredentials {
  provider: AiProviderType;
  model: string;
  baseUrl?: string | null;
  apiKey?: string | null;
}

function resolveBaseUrl(provider: AiProviderType, customBaseUrl?: string | null): string {
  const trimmed = customBaseUrl?.trim();
  if (trimmed) return trimmed.replace(/\/+$/, "");
  return AI_PROVIDER_CATALOG[provider].defaultBaseUrl.replace(/\/+$/, "");
}

function buildOpenAiMessages(messages: AgentConversationMessage[]) {
  return messages.map((msg) => {
    if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      return {
        role: "assistant",
        content: msg.content || null,
        tool_calls: msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: {
            name: tc.name,
            arguments: tc.argumentsJson,
          },
        })),
      };
    }
    if (msg.role === "tool") {
      return {
        role: "tool",
        tool_call_id: msg.toolCallId,
        content: msg.content,
      };
    }
    return {
      role: msg.role,
      content: msg.content,
    };
  });
}

async function callAnthropicMessages(params: {
  creds: ResolvedProviderCredentials;
  messages: AgentConversationMessage[];
  tools: AgentToolDefinition[];
  maxTokens: number;
  timeoutMs: number;
}): Promise<LlmCompletionResult> {
  const apiKey = params.creds.apiKey?.trim();
  if (!apiKey) {
    throw new Error("Anthropic API key is missing.");
  }
  const baseUrl = resolveBaseUrl("anthropic", params.creds.baseUrl);
  const url = baseUrl.endsWith("/v1/messages")
    ? baseUrl
    : baseUrl.endsWith("/v1")
      ? `${baseUrl}/messages`
      : `${baseUrl}/v1/messages`;

  const systemParts: string[] = [];
  const anthropicMessages: Array<{
    role: "user" | "assistant";
    content: string | Array<Record<string, unknown>>;
  }> = [];

  for (const msg of params.messages) {
    if (msg.role === "system") {
      systemParts.push(msg.content);
      continue;
    }
    if (msg.role === "user") {
      anthropicMessages.push({ role: "user", content: msg.content });
      continue;
    }
    if (msg.role === "assistant") {
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        const blocks: Array<Record<string, unknown>> = [];
        if (msg.content.trim()) {
          blocks.push({ type: "text", text: msg.content });
        }
        for (const tc of msg.toolCalls) {
          let parsedInput: Record<string, unknown> = {};
          try {
            parsedInput = JSON.parse(tc.argumentsJson) as Record<string, unknown>;
          } catch {
            parsedInput = {};
          }
          blocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: parsedInput,
          });
        }
        anthropicMessages.push({ role: "assistant", content: blocks });
      } else {
        anthropicMessages.push({ role: "assistant", content: msg.content });
      }
      continue;
    }
    if (msg.role === "tool") {
      const toolResultBlock = {
        type: "tool_result",
        tool_use_id: msg.toolCallId,
        content: msg.content,
      };
      const prev = anthropicMessages[anthropicMessages.length - 1];
      if (prev && prev.role === "user" && Array.isArray(prev.content)) {
        prev.content.push(toolResultBlock);
      } else {
        anthropicMessages.push({
          role: "user",
          content: [toolResultBlock],
        });
      }
    }
  }

  const body: Record<string, unknown> = {
    model: params.creds.model,
    max_tokens: params.maxTokens,
    messages: anthropicMessages,
  };
  if (systemParts.length > 0) {
    body.system = systemParts.join("\n\n");
  }
  if (params.tools.length > 0) {
    body.tools = params.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(params.timeoutMs),
  });

  const rawText = await res.text();
  if (!res.ok) {
    throw new Error(extractProviderErrorMessage("Anthropic", res.status, rawText));
  }

  const data = JSON.parse(rawText) as {
    model?: string;
    content?: Array<{
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
  };

  const textParts: string[] = [];
  const toolCalls: AgentToolCall[] = [];

  for (const block of data.content ?? []) {
    if (block.type === "text" && block.text) {
      textParts.push(block.text);
    } else if (block.type === "tool_use" && block.id && block.name) {
      toolCalls.push({
        id: block.id,
        name: block.name,
        argumentsJson: JSON.stringify(block.input ?? {}),
      });
    }
  }

  return {
    content: textParts.join("\n").trim(),
    toolCalls,
    modelUsed: data.model ?? params.creds.model,
  };
}

async function callOpenAiCompatible(params: {
  creds: ResolvedProviderCredentials;
  messages: AgentConversationMessage[];
  tools: AgentToolDefinition[];
  maxTokens: number;
  timeoutMs: number;
}): Promise<LlmCompletionResult> {
  const baseUrl = resolveBaseUrl(params.creds.provider, params.creds.baseUrl);
  const url = baseUrl.endsWith("/chat/completions")
    ? baseUrl
    : `${baseUrl}/chat/completions`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (params.creds.apiKey?.trim()) {
    headers.Authorization = `Bearer ${params.creds.apiKey.trim()}`;
  }
  if (params.creds.provider === "openrouter") {
    headers["HTTP-Referer"] = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    headers["X-Title"] = "ClipForge Studio";
  }

  const openAiTools =
    params.tools.length > 0
      ? params.tools.map((t) => ({
          type: "function",
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          },
        }))
      : undefined;

  const isReasoningModel = /^o[134](-|$)/i.test(params.creds.model);

  const buildPayload = (includeTools: boolean) => {
    const payload: Record<string, unknown> = {
      model: params.creds.model,
      messages: buildOpenAiMessages(params.messages),
    };
    if (isReasoningModel) {
      payload.max_completion_tokens = params.maxTokens;
    } else {
      payload.max_tokens = params.maxTokens;
      payload.temperature = 0.2;
    }
    if (includeTools && openAiTools) {
      payload.tools = openAiTools;
      payload.tool_choice = "auto";
    }
    return payload;
  };

  let res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(buildPayload(true)),
    signal: AbortSignal.timeout(params.timeoutMs),
  });

  let rawText = await res.text();

  // Some local OpenAI-compatible endpoints reject the `tools` parameter; retry cleanly without tools.
  if (!res.ok && res.status === 400 && openAiTools && /tool/i.test(rawText)) {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(buildPayload(false)),
      signal: AbortSignal.timeout(params.timeoutMs),
    });
    rawText = await res.text();
  }

  if (!res.ok) {
    const label = AI_PROVIDER_CATALOG[params.creds.provider].shortName;
    throw new Error(extractProviderErrorMessage(label, res.status, rawText));
  }

  const data = JSON.parse(rawText) as {
    model?: string;
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{
          id?: string;
          type?: string;
          function?: {
            name?: string;
            arguments?: string;
          };
        }>;
      };
    }>;
  };

  const choice = data.choices?.[0]?.message;
  const toolCalls: AgentToolCall[] = [];
  for (const tc of choice?.tool_calls ?? []) {
    if (tc.function?.name) {
      toolCalls.push({
        id: tc.id ?? `call_${Date.now()}_${toolCalls.length}`,
        name: tc.function.name,
        argumentsJson: tc.function.arguments ?? "{}",
      });
    }
  }

  return {
    content: (choice?.content ?? "").trim(),
    toolCalls,
    modelUsed: data.model ?? params.creds.model,
  };
}

function extractProviderErrorMessage(providerLabel: string, status: number, rawBody: string): string {
  try {
    const parsed = JSON.parse(rawBody) as {
      error?: { message?: string } | string;
      message?: string;
    };
    const msg =
      (typeof parsed.error === "object" ? parsed.error?.message : parsed.error) ??
      parsed.message;
    if (msg) {
      return `${providerLabel} (${status}): ${msg.slice(0, 260)}`;
    }
  } catch {
    // fallback to trimmed raw text
  }
  return `${providerLabel} returned HTTP ${status}: ${rawBody.slice(0, 200)}`;
}

export async function runLlmCompletion(params: {
  creds: ResolvedProviderCredentials;
  messages: AgentConversationMessage[];
  tools?: AgentToolDefinition[];
  maxTokens?: number;
  timeoutMs?: number;
}): Promise<LlmCompletionResult> {
  const tools = params.tools ?? [];
  const maxTokens = params.maxTokens ?? 1800;
  const timeoutMs = params.timeoutMs ?? 45_000;

  if (params.creds.provider === "anthropic") {
    return callAnthropicMessages({
      creds: params.creds,
      messages: params.messages,
      tools,
      maxTokens,
      timeoutMs,
    });
  }

  return callOpenAiCompatible({
    creds: params.creds,
    messages: params.messages,
    tools,
    maxTokens,
    timeoutMs,
  });
}
