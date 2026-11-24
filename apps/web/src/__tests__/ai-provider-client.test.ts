import { afterEach, describe, expect, it, vi } from "vitest";
import { runLlmCompletion } from "../lib/ai-provider-client";

describe("runLlmCompletion", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("formats Anthropic Messages requests and parses tool_use responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "claude-sonnet-4-5",
          content: [
            { type: "text", text: "Searching transcript for boss moments." },
            {
              type: "tool_use",
              id: "toolu_01",
              name: "search_transcript",
              input: { query: "boss" },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await runLlmCompletion({
      creds: {
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        apiKey: "sk-ant-test-123456",
      },
      messages: [
        { role: "system", content: "You are a video editor." },
        { role: "user", content: "Find the boss fight." },
      ],
      tools: [
        {
          name: "search_transcript",
          description: "Search transcript",
          parameters: { type: "object", properties: { query: { type: "string" } } },
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("sk-ant-test-123456");
    expect(result.content).toBe("Searching transcript for boss moments.");
    expect(result.toolCalls).toEqual([
      {
        id: "toolu_01",
        name: "search_transcript",
        argumentsJson: JSON.stringify({ query: "boss" }),
      },
    ]);
  });

  it("formats OpenRouter / OpenAI-compatible requests and parses tool_calls", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "openai/gpt-4o",
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  {
                    id: "call_abc",
                    type: "function",
                    function: {
                      name: "create_clip_candidate",
                      arguments: JSON.stringify({
                        title: "Boss Clutch",
                        startSec: 120,
                        endSec: 152,
                      }),
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await runLlmCompletion({
      creds: {
        provider: "openrouter",
        model: "openai/gpt-4o",
        apiKey: "sk-or-v1-test-key",
      },
      messages: [{ role: "user", content: "Create a clip at 2:00" }],
      tools: [
        {
          name: "create_clip_candidate",
          description: "Create clip",
          parameters: { type: "object", properties: {} },
        },
      ],
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-or-v1-test-key");
    expect((init.headers as Record<string, string>)["X-Title"]).toBe("ClipForge Studio");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.name).toBe("create_clip_candidate");
  });
});
