import type { AiProviderType } from "./types.js";

export interface AiProviderCatalogEntry {
  id: AiProviderType;
  name: string;
  shortName: string;
  description: string;
  defaultBaseUrl: string;
  requiresApiKey: boolean;
  supportsCustomBaseUrl: boolean;
  keyPlaceholder: string;
  defaultModel: string;
  suggestedModels: ReadonlyArray<{ id: string; label: string }>;
}

export const AI_PROVIDER_CATALOG: Readonly<Record<AiProviderType, AiProviderCatalogEntry>> = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic Claude",
    shortName: "Claude",
    description: "Connect your Anthropic API key for Claude Sonnet or Haiku models.",
    defaultBaseUrl: "https://api.anthropic.com",
    requiresApiKey: true,
    supportsCustomBaseUrl: true,
    keyPlaceholder: "sk-ant-api03-...",
    defaultModel: "claude-sonnet-4-5",
    suggestedModels: [
      { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
      { id: "claude-3-7-sonnet-latest", label: "Claude 3.7 Sonnet" },
      { id: "claude-3-5-haiku-latest", label: "Claude 3.5 Haiku (Fast)" },
    ],
  },
  openai: {
    id: "openai",
    name: "OpenAI ChatGPT",
    shortName: "ChatGPT",
    description: "Connect your OpenAI API key for GPT-4.1, GPT-4o, or o4-mini.",
    defaultBaseUrl: "https://api.openai.com/v1",
    requiresApiKey: true,
    supportsCustomBaseUrl: true,
    keyPlaceholder: "sk-proj-...",
    defaultModel: "gpt-4.1",
    suggestedModels: [
      { id: "gpt-4.1", label: "GPT-4.1" },
      { id: "gpt-4o", label: "GPT-4o" },
      { id: "gpt-4o-mini", label: "GPT-4o Mini (Fast)" },
      { id: "o4-mini", label: "o4-mini (Reasoning)" },
    ],
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    shortName: "OpenRouter",
    description: "Access Claude, GPT, Gemini, DeepSeek, and Llama through one API key.",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    requiresApiKey: true,
    supportsCustomBaseUrl: true,
    keyPlaceholder: "sk-or-v1-...",
    defaultModel: "anthropic/claude-sonnet-4.5",
    suggestedModels: [
      { id: "anthropic/claude-sonnet-4.5", label: "Claude Sonnet 4.5 (via OpenRouter)" },
      { id: "openai/gpt-4o", label: "GPT-4o (via OpenRouter)" },
      { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro (via OpenRouter)" },
      { id: "deepseek/deepseek-chat-v3-0324", label: "DeepSeek V3" },
      { id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B" },
    ],
  },
  google: {
    id: "google",
    name: "Google Gemini",
    shortName: "Gemini",
    description: "Connect a Google AI Studio key for Gemini 2.5 Pro or Flash.",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    requiresApiKey: true,
    supportsCustomBaseUrl: true,
    keyPlaceholder: "AIza...",
    defaultModel: "gemini-2.5-flash",
    suggestedModels: [
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    ],
  },
  groq: {
    id: "groq",
    name: "Groq Cloud",
    shortName: "Groq",
    description: "Ultra-fast inference for Llama and DeepSeek models.",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    requiresApiKey: true,
    supportsCustomBaseUrl: true,
    keyPlaceholder: "gsk_...",
    defaultModel: "llama-3.3-70b-versatile",
    suggestedModels: [
      { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B Versatile" },
      { id: "deepseek-r1-distill-llama-70b", label: "DeepSeek R1 Distill 70B" },
    ],
  },
  custom: {
    id: "custom",
    name: "Local / Custom Endpoint",
    shortName: "Local / Custom",
    description: "Connect Ollama, LM Studio, vLLM, or any OpenAI-compatible local server.",
    defaultBaseUrl: "http://localhost:11434/v1",
    requiresApiKey: false,
    supportsCustomBaseUrl: true,
    keyPlaceholder: "Optional for local servers",
    defaultModel: "llama3.2",
    suggestedModels: [
      { id: "llama3.2", label: "Ollama Llama 3.2" },
      { id: "qwen2.5:14b", label: "Ollama Qwen 2.5 14B" },
      { id: "mistral", label: "Ollama Mistral" },
    ],
  },
};

export const AI_PROVIDER_LIST: ReadonlyArray<AiProviderCatalogEntry> = [
  AI_PROVIDER_CATALOG.anthropic,
  AI_PROVIDER_CATALOG.openai,
  AI_PROVIDER_CATALOG.openrouter,
  AI_PROVIDER_CATALOG.google,
  AI_PROVIDER_CATALOG.groq,
  AI_PROVIDER_CATALOG.custom,
];
