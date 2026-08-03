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
        "moonshot": {
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
              reasoning: false
            }
          }
        }
      });
    }

    if (url.hostname === "aperture.example") {
      if (url.pathname === "/api/providers") {
        return Response.json([
          { id: "opencode-go", name: "OpenCode Go", compatibility: { openai_chat: true } }
        ]);
      }
      if (url.pathname === "/v1/models") {
        return Response.json(mockModelsResponse);
      }
    }

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
      disableModelsDev: false, // Ensure it's enabled
    });

    const config = {};
    await plugin.config(config);

    const providerModel = config.provider["aperture-opencode-go"].models["kimi-k3"];
    
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
