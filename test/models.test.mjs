import assert from "node:assert/strict";
import test from "node:test";
import { TailscaleAperturePlugin } from "../dist/index.js";

import { mockModelsResponse } from "./mock-data.mjs";

test("merges model configurations from models.dev catalog", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));

    if (url.hostname === "models.dev" && url.pathname === "/api.json") {
      return Response.json({
        moonshot: {
          id: "moonshot",
          name: "Moonshot",
          models: {
            "kimi-k3": {
              id: "kimi-k3",
              name: "Kimi K3",
              limit: { context: 128000, output: 8192 },
              cost: { input: 3.0, output: 15.0 },
              temperature: true,
              tool_call: true,
              reasoning: false,
            },
          },
        },
      });
    }

    if (url.hostname === "aperture.example") {
      if (url.pathname === "/api/providers") {
        return Response.json([
          {
            id: "opencode-go",
            name: "OpenCode Go",
            compatibility: { openai_chat: true },
          },
        ]);
      }
      if (url.pathname === "/v1/models") {
        return Response.json(mockModelsResponse);
      }
    }

    assert.fail(`unexpected fetch: ${url.toString()}`);
  };

  try {
    const plugin = await TailscaleAperturePlugin(
      {
        directory: "/tmp",
        client: {
          app: { log: async () => ({}) },
          tui: { showToast: async () => ({}) },
        },
      },
      {
        baseUrl: "https://aperture.example",
        modelsDevUrl: "https://models.dev",
        disableModelsDev: false, // Ensure it's enabled
      },
    );

    const config = {};
    await plugin.config(config);

    const providerModel =
      config.provider["aperture-opencode-go"].models["kimi-k3"];

    // The defaults from Models.dev catalog are merged with Aperture models.
    assert.equal(providerModel.limit.context, 128000);
    assert.equal(providerModel.limit.output, 8192);
    assert.equal(providerModel.temperature, true);
    assert.equal(providerModel.tool_call, true);
    // Aperture's pricing field is not consumed by the plugin; cost comes only
    // from the Models.dev catalog and mergeModelConfig preserves it untouched.
    assert.deepEqual(providerModel.cost, { input: 3.0, output: 15.0 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("maps models.dev reasoning_options effort values to variants", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));

    if (url.hostname === "models.dev" && url.pathname === "/api.json") {
      return Response.json({
        "test-provider": {
          id: "test-provider",
          name: "Test Provider",
          models: {
            "reasoning-model": {
              id: "reasoning-model",
              name: "Reasoning Model",
              reasoning: true,
              reasoning_options: [
                { type: "effort", values: [" low ", "high", "", "  "] },
                { type: "toggle" },
              ],
            },
          },
        },
      });
    }

    if (url.hostname === "aperture.example") {
      if (url.pathname === "/api/providers") {
        return Response.json([
          {
            id: "test-provider",
            name: "Test Provider",
            compatibility: { openai_chat: true },
          },
        ]);
      }
      if (url.pathname === "/v1/models") {
        return Response.json({
          data: [
            {
              id: "reasoning-model",
              object: "model",
              created: 0,
              owned_by: "test-provider",
              metadata: {
                provider: { id: "test-provider", name: "Test Provider" },
              },
            },
          ],
        });
      }
    }

    assert.fail(`unexpected fetch: ${url.toString()}`);
  };

  try {
    const plugin = await TailscaleAperturePlugin(
      {
        directory: "/tmp",
        client: {
          app: { log: async () => ({}) },
          tui: { showToast: async () => ({}) },
        },
      },
      {
        baseUrl: "https://aperture.example",
        modelsDevUrl: "https://models.dev",
      },
    );

    const config = {};
    await plugin.config(config);

    const model =
      config.provider["aperture-test-provider"].models["reasoning-model"];
    assert.equal(model.reasoning, true);
    // Values are trimmed, blank/whitespace-only values dropped; non-effort
    // option types ignored.
    assert.deepEqual(model.variants, {
      low: { reasoningEffort: "low" },
      high: { reasoningEffort: "high" },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uses the base provider for -x- Aperture variants", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));

    if (url.hostname === "models.dev" && url.pathname === "/api.json") {
      return Response.json({
        "opencode-go": {
          id: "opencode-go",
          name: "OpenCode Go",
          models: {
            "minimax-m2.7": {
              id: "minimax-m2.7",
              name: "MiniMax M2.7",
              limit: { context: 128000, output: 8192 },
              reasoning: true,
            },
          },
        },
      });
    }

    if (url.hostname === "aperture.example") {
      if (url.pathname === "/api/providers") {
        return Response.json([
          {
            id: "opencode-go-x-anthropic",
            name: "OpenCode Go Anthropic API",
            compatibility: { anthropic_messages: true },
          },
          {
            id: "opencode-go-x-responses",
            name: "OpenCode Go Responses API",
            compatibility: { openai_responses: true },
          },
        ]);
      }
      if (url.pathname === "/v1/models") {
        return Response.json({
          data: [
            {
              id: "minimax-m2.7",
              object: "model",
              created: 0,
              owned_by: "opencode-go-x-anthropic",
              metadata: {
                provider: {
                  id: "opencode-go-x-anthropic",
                  name: "OpenCode Go Anthropic API",
                },
              },
            },
            {
              id: "minimax-m2.7",
              object: "model",
              created: 0,
              owned_by: "opencode-go-x-responses",
              metadata: {
                provider: {
                  id: "opencode-go-x-responses",
                  name: "OpenCode Go Responses API",
                },
              },
            },
          ],
        });
      }
    }

    assert.fail(`unexpected fetch: ${url.toString()}`);
  };

  try {
    const plugin = await TailscaleAperturePlugin(
      {
        directory: "/tmp",
        client: {
          app: { log: async () => ({}) },
          tui: { showToast: async () => ({}) },
        },
      },
      {
        baseUrl: "https://aperture.example",
        modelsDevUrl: "https://models.dev",
      },
    );

    const config = {};
    await plugin.config(config);

    assert.equal(
      config.provider["aperture-opencode-go-anthropic-api"].npm,
      "@ai-sdk/anthropic",
    );
    assert.equal(
      config.provider["aperture-opencode-go-anthropic-api"].models[
        "minimax-m2.7"
      ].limit.context,
      128000,
    );
    assert.equal(
      config.provider["aperture-opencode-go-responses-api"].npm,
      "@ai-sdk/openai",
    );
    assert.equal(
      config.provider["aperture-opencode-go-responses-api"].models[
        "minimax-m2.7"
      ].reasoning,
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ignores routing tags when matching Models.dev providers and models", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));

    if (url.hostname === "models.dev" && url.pathname === "/api.json") {
      return Response.json({
        openrouter: {
          id: "openrouter",
          name: "OpenRouter",
          models: {
            "openai/gpt-5.6-luna": {
              id: "openai/gpt-5.6-luna",
              name: "GPT-5.6 Luna",
              limit: { context: 256000, output: 32768 },
              reasoning: true,
            },
          },
        },
      });
    }

    if (url.hostname === "aperture.example") {
      if (url.pathname === "/api/providers") {
        return Response.json([
          {
            id: "openrouter:floor",
            name: "OpenRouter Floor",
            compatibility: { openai_chat: true },
          },
        ]);
      }
      if (url.pathname === "/v1/models") {
        return Response.json({
          data: [
            {
              id: "openai/gpt-5.6-luna:floor",
              object: "model",
              created: 0,
              owned_by: "openrouter:floor",
              metadata: {
                provider: { id: "openrouter:floor", name: "OpenRouter Floor" },
              },
            },
          ],
        });
      }
    }

    assert.fail(`unexpected fetch: ${url.toString()}`);
  };

  try {
    const plugin = await TailscaleAperturePlugin(
      {
        directory: "/tmp",
        client: {
          app: { log: async () => ({}) },
          tui: { showToast: async () => ({}) },
        },
      },
      {
        baseUrl: "https://aperture.example",
        modelsDevUrl: "https://models.dev",
      },
    );

    const config = {};
    await plugin.config(config);

    const model =
      config.provider["aperture-openrouter-floor"].models[
        "openai/gpt-5.6-luna:floor"
      ];
    assert.equal(model.limit.context, 256000);
    assert.equal(model.limit.output, 32768);
    assert.equal(model.reasoning, true);
    assert.equal(model.id, "openrouter:floor/openai/gpt-5.6-luna:floor");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
