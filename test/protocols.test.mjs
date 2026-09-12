import assert from "node:assert/strict";
import test from "node:test";
import { TailscaleAperturePlugin } from "../dist/index.js";

const cases = [
  [
    "responses",
    { openai_chat: true, openai_responses: true },
    "@ai-sdk/openai",
    "/v1",
  ],
  ["anthropic", { anthropic_messages: true }, "@ai-sdk/anthropic", "/v1"],
  ["chat", { openai_chat: true }, "@ai-sdk/openai-compatible", "/v1"],
  [
    "vertex-generate",
    { google_generate_content: true },
    "@ai-sdk/google-vertex",
    "/v1/projects/_aperture_auto_vertex_project_id_/locations/_aperture_auto_vertex_region_/publishers/google",
  ],
  [
    "vertex-predict",
    { google_raw_predict: true },
    "@ai-sdk/google-vertex",
    "/v1/projects/_aperture_auto_vertex_project_id_/locations/_aperture_auto_vertex_region_/publishers/google",
  ],
  [
    "bedrock-invoke",
    { bedrock_model_invoke: true },
    "@ai-sdk/amazon-bedrock",
    "/bedrock",
  ],
  [
    "bedrock-converse",
    { bedrock_converse: true },
    "@ai-sdk/amazon-bedrock",
    "/bedrock",
  ],
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
      return Response.json([
        { id: name, name, models: ["model"], compatibility },
      ]);
    }
    if (url.pathname === "/v1/models") {
      return Response.json({
        data: [
          {
            id: "model",
            object: "model",
            created: 0,
            owned_by: name,
            metadata: { provider: { id: name, name } },
          },
        ],
      });
    }
    assert.fail(`unexpected path ${url.pathname}`);
  };

  try {
    await Promise.all(
      cases.map(async ([name, , npm, path]) => {
        const plugin = await TailscaleAperturePlugin(
          {
            directory: "/tmp",
            client: {
              app: { log: async () => ({}) },
              tui: { showToast: async () => ({}) },
            },
          },
          {
            baseUrl: `https://${name}.example`,
            disableModelsDev: true,
          },
        );
        const config = {};
        await plugin.config(config);

        const provider = config.provider[`aperture-${name}`];
        assert.equal(provider.npm, npm, name);
        assert.equal(
          provider.options.baseURL,
          `https://${name}.example${path}`,
          name,
        );
        if (name.startsWith("bedrock")) {
          assert.equal(provider.options.region, "us-east-1", name);
          assert.equal(provider.options.accessKeyId, "not-needed", name);
          assert.equal(provider.options.secretAccessKey, "not-needed", name);
        } else {
          assert.equal(provider.options.apiKey, "not-required", name);
        }
      }),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("passes the apiKey through to the Bedrock SDK when configured", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "bedrock.example");

    if (url.pathname === "/api/providers") {
      return Response.json([
        {
          id: "bedrock",
          name: "bedrock",
          models: ["model"],
          compatibility: { bedrock_converse: true },
        },
      ]);
    }
    if (url.pathname === "/v1/models") {
      return Response.json({
        data: [
          {
            id: "model",
            object: "model",
            created: 0,
            owned_by: "bedrock",
            metadata: { provider: { id: "bedrock", name: "bedrock" } },
          },
        ],
      });
    }
    assert.fail(`unexpected path ${url.pathname}`);
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
        baseUrl: "https://bedrock.example",
        apiKey: "test-key",
        disableModelsDev: true,
      },
    );
    const config = {};
    await plugin.config(config);

    const options = config.provider["aperture-bedrock"].options;
    assert.equal(options.apiKey, "test-key");
    assert.equal(options.accessKeyId, undefined);
    assert.equal(options.secretAccessKey, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("adds the OpenCode request headers to OpenCode Aperture provider groups", async () => {
  let emptyModels = false;
  const originalFetch = globalThis.fetch;
  const originalOpenCodeClient = process.env.OPENCODE_CLIENT;
  process.env.OPENCODE_CLIENT = "test-client";
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));

    if (url.pathname === "/api/providers") {
      return Response.json([
        {
          id: "opencode",
          name: "OpenCode",
          compatibility: { openai_chat: true },
        },
        {
          id: "opencode-go-x-anthropic",
          name: "OpenCode Go Anthropic API",
          compatibility: { anthropic_messages: true },
        },
        { id: "other", name: "Other", compatibility: { openai_chat: true } },
      ]);
    }
    if (url.pathname === "/v1/models") {
      return Response.json({
        data: emptyModels
          ? []
          : [
              {
                id: "zen-model",
                object: "model",
                created: 0,
                owned_by: "opencode",
                metadata: { provider: { id: "opencode", name: "OpenCode" } },
              },
              {
                id: "go-model",
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
                id: "other-model",
                object: "model",
                created: 0,
                owned_by: "other",
                metadata: { provider: { id: "other", name: "Other" } },
              },
            ],
      });
    }
    assert.fail(`unexpected path ${url.pathname}`);
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
        disableModelsDev: true,
      },
    );
    const config = {};
    await plugin.config(config);

    for (const providerID of [
      "aperture-opencode",
      "aperture-opencode-go-anthropic-api",
    ]) {
      const output = { headers: { existing: "value" } };
      await plugin["chat.headers"](
        {
          sessionID: "ses_test",
          model: { providerID },
          message: { id: "msg_test" },
        },
        output,
      );
      assert.deepEqual(output.headers, {
        existing: "value",
        "x-opencode-session": "ses_test",
        "x-opencode-request": "msg_test",
        "x-opencode-client": "test-client",
      });
    }

    const output = { headers: {} };
    await plugin["chat.headers"](
      {
        sessionID: "ses_test",
        model: { providerID: "aperture-other" },
        message: { id: "msg_test" },
      },
      output,
    );
    assert.deepEqual(output.headers, {});

    emptyModels = true;
    await plugin.tool.list_aperture_models.execute({ refresh: true });
    await plugin.config({});
    const refreshedOutput = { headers: {} };
    await plugin["chat.headers"](
      {
        sessionID: "ses_test",
        model: { providerID: "aperture-opencode" },
        message: { id: "msg_test" },
      },
      refreshedOutput,
    );
    assert.deepEqual(
      refreshedOutput.headers,
      {},
      "empty discovery clears previously registered header IDs",
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalOpenCodeClient === undefined) {
      delete process.env.OPENCODE_CLIENT;
    } else {
      process.env.OPENCODE_CLIENT = originalOpenCodeClient;
    }
  }
});
