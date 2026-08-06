import assert from "node:assert/strict";
import test from "node:test";
import { TailscaleAperturePlugin } from "../dist/index.js";

const cases = [
  ["responses", { openai_chat: true, openai_responses: true }, "@ai-sdk/openai", "/v1"],
  ["anthropic", { anthropic_messages: true }, "@ai-sdk/anthropic", "/v1"],
  ["chat", { openai_chat: true }, "@ai-sdk/openai-compatible", "/v1"],
  ["vertex-generate", { google_generate_content: true }, "@ai-sdk/google-vertex", "/v1/projects/_aperture_auto_vertex_project_id_/locations/_aperture_auto_vertex_region_/publishers/google"],
  ["vertex-predict", { google_raw_predict: true }, "@ai-sdk/google-vertex", "/v1/projects/_aperture_auto_vertex_project_id_/locations/_aperture_auto_vertex_region_/publishers/google"],
  ["bedrock-invoke", { bedrock_model_invoke: true }, "@ai-sdk/amazon-bedrock", "/bedrock"],
  ["bedrock-converse", { bedrock_converse: true }, "@ai-sdk/amazon-bedrock", "/bedrock"],
  ["gemini", { gemini_generate_content: true }, "@ai-sdk/google", "/v1beta"],
];

test("maps every Aperture protocol to its AI SDK configuration", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const entry = cases.find(([name]) => url.hostname === `${name}.example`);
    assert.ok(entry, `unexpected host ${url.hostname}`);
    const [name, compatibility] = entry;

    if (url.pathname === "/api/providers") {
      return Response.json([{ id: name, name, models: ["model"], compatibility }]);
    }
    if (url.pathname === "/v1/models") {
      return Response.json({
        data: [{
          id: "model",
          object: "model",
          created: 0,
          owned_by: name,
          metadata: { provider: { id: name, name } },
        }],
      });
    }
    assert.fail(`unexpected path ${url.pathname}`);
  };

  try {
    await Promise.all(cases.map(async ([name, , npm, path]) => {
      const plugin = await TailscaleAperturePlugin({
        directory: "/tmp",
        client: {
          app: { log: async () => ({}) },
          tui: { showToast: async () => ({}) },
        },
      }, {
        baseUrl: `https://${name}.example`,
        disableModelsDev: true,
      });
      const config = {};
      await plugin.config(config);

      const provider = config.provider[`aperture-${name}`];
      assert.equal(provider.npm, npm, name);
      assert.equal(provider.options.baseURL, `https://${name}.example${path}`, name);
      if (name.startsWith("bedrock")) {
        assert.equal(provider.options.region, "us-east-1", name);
        assert.equal(provider.options.accessKeyId, "not-needed", name);
        assert.equal(provider.options.secretAccessKey, "not-needed", name);
      } else {
        assert.equal(provider.options.apiKey, "not-required", name);
      }
    }));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
