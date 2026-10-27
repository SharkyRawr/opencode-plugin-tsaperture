import assert from "node:assert/strict";
import { createRequire, findPackageJSON } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";
import plugin, { TailscaleAperturePlugin } from "../dist/index.js";

// Same empty records and upsert semantics as OpenCode v2's ProviderEditor.
function createProviders() {
  const records = new Map();
  const editor = {
    get: (id) => records.get(id),
    update(id, update) {
      if (!records.has(id))
        records.set(id, {
          provider: { id, name: id, activation: "auto", package: "" },
          models: new Map(),
        });
      update(records.get(id).provider);
    },
    models: {
      update(providerID, id, update) {
        if (!records.has(providerID))
          records.set(providerID, {
            provider: {
              id: providerID,
              name: providerID,
              activation: "auto",
              package: "",
            },
            models: new Map(),
          });
        const models = records.get(providerID).models;
        if (!models.has(id))
          models.set(id, {
            id,
            modelID: id,
            providerID,
            name: id,
            capabilities: {
              tools: true,
              input: ["text", "image"],
              output: ["text"],
            },
            variants: [],
            time: { released: 0 },
            cost: [],
            status: "active",
            enabled: true,
            limit: { context: 200_000, output: 32_000 },
          });
        update(models.get(id));
      },
    },
  };
  return { editor, records };
}

test("one package supports v1 server hooks and v2 provider transforms", async (t) => {
  assert.equal(plugin.server, TailscaleAperturePlugin);
  assert.equal(plugin.id, "opencode-plugin-tsaperture");
  const protocols = [
    ["chat", { openai_chat: true }],
    ["responses", { openai_responses: true }],
    ["anthropic", { anthropic_messages: true }],
    ["vertex", { google_generate_content: true }],
    ["vertex-raw", { google_raw_predict: true }],
    ["bedrock", { bedrock_converse: true }],
    ["gemini", { gemini_generate_content: true }],
    ["opencode-go-x-responses", { openai_responses: true }],
  ];
  const metadata = {
    id: "model",
    name: "Catalog Model",
    family: "example",
    release_date: "2026-09-01",
    tool_call: true,
    temperature: false,
    modalities: { input: ["text", "image"], output: ["text"] },
    limit: { context: 200_000, input: 180_000, output: 20_000 },
    cost: {
      input: 1,
      output: 2,
      cache_read: 0.1,
      cache_write: 0.2,
      context_over_200k: {
        input: 3,
        output: 4,
        cache_read: 0.3,
        cache_write: 0.4,
      },
    },
    reasoning_options: [{ type: "effort", values: ["low", "high"] }],
  };
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "catalog.example")
      return Response.json(
        Object.fromEntries(
          protocols.map(([id]) => [
            id.split("-x-", 1)[0],
            {
              id: id.split("-x-", 1)[0],
              name: id,
              models: { model: metadata },
            },
          ]),
        ),
      );
    assert.equal(url.hostname, "aperture.example");
    if (url.pathname === "/api/providers")
      return Response.json(
        protocols.map(([id, compatibility]) => ({
          id,
          name: id,
          compatibility,
        })),
      );
    assert.equal(url.pathname, "/v1/models");
    return Response.json({
      data: protocols.map(([id]) => ({
        id: "model",
        object: "model",
        created: 0,
        owned_by: id,
        metadata: { provider: { id, name: id } },
      })),
    });
  });
  const options = {
    baseUrl: "https://aperture.example",
    apiKey: "test-key",
    modelsDevUrl: "https://catalog.example",
    disableModelsDev: false,
  };
  const legacy = await plugin.server(
    {
      directory: "/tmp",
      client: {
        app: { log: async () => ({}) },
        tui: { showToast: async () => ({}) },
      },
    },
    options,
  );
  const config = {};
  await legacy.config(config);
  assert.equal(
    JSON.parse(await legacy.tool.list_aperture_models.execute({})).count,
    protocols.length,
  );

  let transform;
  let reloaded = false;
  await plugin.setup({
    options,
    provider: {
      transform: async (callback) => {
        transform = callback;
      },
      reload: async () => {
        reloaded = true;
      },
    },
  });
  assert.equal(
    reloaded,
    true,
    "publish providers after asynchronous discovery",
  );
  const { editor: providers, records } = createProviders();
  await transform(providers);
  for (const [id] of protocols) {
    const providerID = `aperture-${id}`;
    const expected = config.provider[providerID];
    const { provider, models } = records.get(providerID);
    assert.equal(
      provider.package,
      id === "vertex-raw"
        ? "@opencode/ai/providers/google-vertex-messages"
        : `aisdk:${expected.npm}`,
      id,
    );
    assert.equal(provider.settings.baseURL, expected.options.baseURL, id);
    if (id === "vertex-raw") {
      assert.equal(provider.settings.accessToken, "test-key");
      assert.equal(provider.settings.apiKey, undefined);
      assert.equal(provider.settings.generateAuthToken, undefined);
      assert.equal(await expected.options.generateAuthToken(), "test-key");
      const pluginURL = import.meta.resolve("@opencode/plugin");
      const aiPackage = pathToFileURL(
        findPackageJSON("@opencode/ai", pluginURL),
      );
      const sdk = await import(
        new URL("./dist/providers/google-vertex-messages.js", aiPackage)
      );
      const { Effect } = await import(
        createRequire(pluginURL).resolve("effect")
      );
      const nativeModel = sdk.model(
        expected.models.model.id,
        provider.settings,
      );
      const request = {
        model: nativeModel,
        system: [],
        tools: [],
        messages: [
          { role: "user", content: [{ type: "text", text: "Hello" }] },
        ],
        generation: { maxTokens: 16 },
      };
      const body = await Effect.runPromise(
        nativeModel.route.body.from(request),
      );
      assert.equal(body.anthropic_version, "vertex-2023-10-16");
      assert.equal(body.model, undefined);
      assert.equal(
        nativeModel.route.endpoint.path({ request, body }),
        "/vertex-raw/model:streamRawPredict",
      );
      const headers = await Effect.runPromise(
        nativeModel.route.auth.apply({
          request,
          method: "POST",
          url: provider.settings.baseURL,
          body: JSON.stringify(body),
          headers: {},
        }),
      );
      assert.equal(headers.authorization, "Bearer test-key");
    } else assert.equal(provider.settings.apiKey, "test-key", id);
    assert.equal(provider.activation, "enabled", id);
    if (id === "bedrock") assert.equal(provider.settings.region, "us-east-1");
    const model = models.get("model");
    assert.equal(model.modelID, expected.models.model.id, id);
    assert.deepEqual(model.limit, expected.models.model.limit, id);
    assert.deepEqual(model.capabilities, {
      tools: true,
      temperature: false,
      input: ["text", "image"],
      output: ["text"],
    });
    assert.equal(model.family, "example");
    assert.equal(model.time.released, Date.parse("2026-09-01"));
    assert.deepEqual(model.cost, [
      { input: 1, output: 2, cache: { read: 0.1, write: 0.2 } },
      {
        tier: { type: "context", size: 200_000 },
        input: 3,
        output: 4,
        cache: { read: 0.3, write: 0.4 },
      },
    ]);
    const bodies = {
      chat: { reasoning_effort: "low" },
      responses: { reasoning: { effort: "low" } },
      anthropic: { output_config: { effort: "low" } },
      "vertex-raw": { output_config: { effort: "low" } },
      vertex: {
        generationConfig: { thinkingConfig: { thinkingLevel: "low" } },
      },
      gemini: {
        generationConfig: { thinkingConfig: { thinkingLevel: "low" } },
      },
      "opencode-go-x-responses": { reasoning: { effort: "low" } },
    };
    assert.deepEqual(
      model.variants[0],
      bodies[id]
        ? {
            id: "low",
            headers: {},
            body: bodies[id],
          }
        : undefined,
    );
  }
  await transform(providers);
  assert.equal(
    records.get("aperture-chat").models.get("model").variants.length,
    2,
  );

  const { editor: overrides, records: overridden } = createProviders();
  overrides.update("aperture-chat", (provider) => {
    provider.name = "My Aperture";
    provider.package = "aisdk:custom-sdk";
    provider.settings = {
      baseURL: "https://custom.example",
      apiKey: "custom-key",
    };
  });
  overrides.models.update("aperture-chat", "model", (model) => {
    model.name = "My Model";
    model.modelID = "custom/model";
    model.enabled = false;
    model.limit.output = 100;
    model.capabilities.temperature = true;
    model.body = { temperature: 0.2 };
    model.variants = [
      { id: "low", headers: { custom: "value" }, body: { custom: true } },
    ];
  });
  await transform(overrides);
  const custom = overridden.get("aperture-chat").models.get("model");
  assert.equal(overridden.get("aperture-chat").provider.name, "My Aperture");
  assert.equal(
    overridden.get("aperture-chat").provider.settings.apiKey,
    "custom-key",
  );
  assert.equal(
    overridden.get("aperture-chat").provider.package,
    "aisdk:custom-sdk",
  );
  assert.equal(custom.name, "My Model");
  assert.equal(custom.modelID, "custom/model");
  assert.equal(custom.enabled, false);
  assert.equal(custom.capabilities.temperature, true);
  assert.deepEqual(custom.limit, {
    context: 200_000,
    input: 180_000,
    output: 100,
  });
  assert.deepEqual(custom.body, { temperature: 0.2 });
  assert.deepEqual(custom.variants[0].body, { custom: true });
  assert.equal(
    custom.variants.length,
    1,
    "custom SDKs receive no generated variants",
  );

  const { editor: rawOverrides, records: rawRecords } = createProviders();
  rawOverrides.update("aperture-vertex-raw", (provider) => {
    provider.settings = { apiKey: "override-key" };
  });
  await transform(rawOverrides);
  assert.equal(
    rawRecords.get("aperture-vertex-raw").provider.settings.accessToken,
    "override-key",
  );
  assert.equal(
    rawRecords.get("aperture-vertex-raw").provider.settings.apiKey,
    undefined,
  );

  for (const packageName of [
    "aisdk:@ai-sdk/anthropic",
    "@opencode/ai/providers/anthropic",
  ]) {
    const { editor, records: overridden } = createProviders();
    editor.update("aperture-chat", (provider) => {
      provider.package = packageName;
    });
    await transform(editor);
    assert.deepEqual(
      overridden.get("aperture-chat").models.get("model").variants,
      [
        { id: "low", headers: {}, body: { output_config: { effort: "low" } } },
        {
          id: "high",
          headers: {},
          body: { output_config: { effort: "high" } },
        },
      ],
    );
  }
});
