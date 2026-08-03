import assert from "node:assert/strict";
import test from "node:test";
import { TailscaleAperturePlugin } from "../dist/index.js";

import { mockModelsResponse } from "./mock-data.mjs";

test("processes real mock data from local llm correctly", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    
    // Stub models.dev API to return an empty catalog for simplicity in this test
    if (url.hostname === "models.dev" && url.pathname === "/api.json") {
      return Response.json({});
    }

    if (url.hostname === "aperture.example") {
      if (url.pathname === "/api/providers") {
        return Response.json([
          { id: "zai-coding-plan", name: "Z.AI Coding Plan", compatibility: { openai_chat: true } },
          { id: "xiaomi", name: "Xiaomi MiMo", compatibility: { openai_chat: true } },
          { id: "openai-sub", name: "OpenAI (Subscription)", compatibility: { openai_chat: true } },
          { id: "opencode-go", name: "OpenCode Go", compatibility: { openai_chat: true } },
          { id: "opencode-go-x-anthropic", name: "OpenCode Go Anthropic API", compatibility: { anthropic_messages: true } },
          { id: "opencode-go-x-responses", name: "OpenCode Go (v1/responses)", compatibility: { openai_responses: true } },
          { id: "ollama-cloud", name: "Ollama Cloud", compatibility: { openai_chat: true } }
        ]);
      }
      if (url.pathname === "/v1/models") {
        return Response.json(mockModelsResponse);
      }
    }

    // Throwing here lands in waitForStableModels' retry loop, so the test
    // fails after the ~4s stabilization deadline rather than instantly.
    assert.fail(`unexpected fetch: ${url.toString()}`);
  };

  try {
    const plugin = await TailscaleAperturePlugin({
      directory: "/tmp",
      client: {
        app: { log: async () => ({}) },
        tui: { showToast: async () => ({}) },
        session: { list: async () => ({ data: [] }) },
      },
    }, {
      baseUrl: "https://aperture.example",
      modelsDevUrl: "https://models.dev",
      disableModelsDev: false,
    });

    const config = { provider: {} };
    await plugin.config(config);

    // Provider groups are keyed by slugified provider NAME (not id),
    // so "Xiaomi MiMo" groups under aperture-xiaomi-mimo, etc.
    assert.deepEqual(
      Object.keys(config.provider).filter((k) => k.startsWith("aperture")).sort(),
      [
        "aperture-opencode-go",
        "aperture-opencode-go-anthropic-api",
        "aperture-opencode-go-v1-responses",
        "aperture-openai-subscription",
        "aperture-ollama-cloud",
        "aperture-xiaomi-mimo",
        "aperture-z-ai-coding-plan",
      ].sort(),
      "Should populate all 7 provider groups",
    );

    assert.ok(config.provider["aperture-z-ai-coding-plan"], "ZAI coding plan provider should exist");
    const zaiModels = config.provider["aperture-z-ai-coding-plan"].models;
    assert.ok(zaiModels["GLM-4.5-Air"], "GLM-4.5-Air should exist");
    assert.equal(zaiModels["GLM-4.5-Air"].name, "GLM-4.5-Air");
    
    assert.ok(config.provider["aperture-opencode-go-anthropic-api"], "OpenCode Go Anthropic provider should exist");
    assert.equal(config.provider["aperture-opencode-go-anthropic-api"].npm, "@ai-sdk/anthropic", "Anthropic messages compatibility mapped correctly");
    
    assert.ok(config.provider["aperture-opencode-go-v1-responses"], "OpenCode Go Responses provider should exist");
    assert.equal(config.provider["aperture-opencode-go-v1-responses"].npm, "@ai-sdk/openai", "OpenAI responses compatibility mapped correctly");

  } finally {
    globalThis.fetch = originalFetch;
  }
});
