import assert from "node:assert/strict";
import test from "node:test";
import plugin, { TailscaleAperturePlugin } from "../dist/index.js";

// Same empty records and upsert semantics as OpenCode's v2 CatalogDraft.
function createCatalog() {
  const records = new Map();
  const catalog = {
    provider: {
      get: (id) => records.get(id),
      update(id, update) {
        if (!records.has(id))
          records.set(id, {
            provider: {
              id,
              name: id,
              api: { type: "native", settings: {} },
              request: { headers: {}, body: {} },
            },
            models: new Map(),
          });
        update(records.get(id).provider);
      },
    },
    model: {
      get: (providerID, id) => records.get(providerID)?.models.get(id),
      update(providerID, id, update) {
        const models = records.get(providerID).models;
        if (!models.has(id))
          models.set(id, {
            id,
            providerID,
            name: id,
            api: { id, type: "native", settings: {} },
            capabilities: { tools: false, input: [], output: [] },
            request: { headers: {}, body: {} },
            variants: [],
            time: { released: 0 },
            cost: [],
            status: "active",
            enabled: true,
            limit: { context: 0, output: 0 },
          });
        update(models.get(id));
      },
    },
  };
  return catalog;
}

test("one package supports v1 server hooks and v2 catalog and request hooks", async (t) => {
  assert.equal(plugin.server, TailscaleAperturePlugin);
  assert.equal(plugin.id, "opencode-plugin-tsaperture");
  const protocols = [
    ["chat", { openai_chat: true }],
    ["responses", { openai_responses: true }],
    ["anthropic", { anthropic_messages: true }],
    ["vertex", { google_generate_content: true }],
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
  let languageHook;
  let reloaded = false;
  await plugin.setup({
    options,
    catalog: {
      transform: async (callback) => {
        transform = callback;
      },
      reload: async () => {
        reloaded = true;
      },
    },
    aisdk: {
      language: async (callback) => {
        languageHook = callback;
      },
    },
  });
  assert.equal(reloaded, true, "publish catalog after asynchronous discovery");
  const catalog = createCatalog();
  await transform(catalog);
  for (const [id] of protocols) {
    const providerID = `aperture-${id}`;
    const expected = config.provider[providerID];
    const { provider, models } = catalog.provider.get(providerID);
    assert.equal(provider.api.package, expected.npm, id);
    assert.equal(provider.api.url, expected.options.baseURL, id);
    assert.equal(provider.api.settings.apiKey, "test-key", id);
    if (id === "bedrock")
      assert.equal(provider.api.settings.region, "us-east-1");
    const model = models.get("model");
    assert.equal(model.api.id, expected.models.model.id, id);
    assert.deepEqual(model.limit, expected.models.model.limit, id);
    assert.deepEqual(model.capabilities, {
      tools: true,
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
  await transform(catalog);
  assert.equal(catalog.model.get("aperture-chat", "model").variants.length, 2);

  const overrides = createCatalog();
  overrides.provider.update("aperture-chat", (provider) => {
    provider.name = "My Aperture";
    provider.api = {
      type: "aisdk",
      package: "custom-sdk",
      url: "https://custom.example",
      settings: { apiKey: "custom-key" },
    };
  });
  overrides.model.update("aperture-chat", "model", (model) => {
    model.name = "My Model";
    model.api.id = "custom/model";
    model.enabled = false;
    model.limit.output = 100;
    model.request.body = { temperature: 0.2 };
    model.variants = [
      { id: "low", headers: { custom: "value" }, body: { custom: true } },
    ];
  });
  await transform(overrides);
  const custom = overrides.model.get("aperture-chat", "model");
  assert.equal(
    overrides.provider.get("aperture-chat").provider.name,
    "My Aperture",
  );
  assert.equal(
    overrides.provider.get("aperture-chat").provider.api.settings.apiKey,
    "custom-key",
  );
  assert.equal(custom.name, "My Model");
  assert.equal(custom.api.id, "custom/model");
  assert.equal(custom.enabled, false);
  assert.deepEqual(custom.limit, {
    context: 200_000,
    input: 180_000,
    output: 100,
  });
  assert.deepEqual(custom.request.body, { temperature: 0.2 });
  assert.deepEqual(custom.variants[0].body, { custom: true });

  const language = {
    specificationVersion: "v3",
    provider: "mock",
    modelId: "model",
    supportedUrls: {},
    doGenerate(options) {
      assert.equal(this, language);
      return options;
    },
    doStream(options) {
      assert.equal(this, language);
      return options;
    },
  };
  const event = {
    model: catalog.model.get("aperture-opencode-go-x-responses", "model"),
    language,
  };
  await languageHook(event);
  for (const [method, session] of [
    ["doGenerate", "session-a"],
    ["doStream", "session-b"],
  ]) {
    const input = {
      headers: {
        "X-Session-Id": session,
        "x-opencode-request": "existing",
        custom: "value",
      },
    };
    const result = await event.language[method](input);
    assert.equal(result.headers["x-opencode-session"], session);
    assert.equal(result.headers["x-opencode-request"], "existing");
    assert.equal(
      result.headers["x-opencode-client"],
      process.env.OPENCODE_CLIENT || "cli",
    );
    assert.equal(result.headers.custom, "value");
    assert.equal(input.headers["x-opencode-session"], undefined);
  }
  assert.equal(
    (await event.language.doGenerate({})).headers["x-opencode-request"],
    undefined,
  );
  const unrelated = {
    model: catalog.model.get("aperture-chat", "model"),
    language,
  };
  await languageHook(unrelated);
  assert.equal(unrelated.language, language);
});
