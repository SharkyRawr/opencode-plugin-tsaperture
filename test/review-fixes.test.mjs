import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TailscaleAperturePlugin } from "../dist/index.js";

const input = {
  directory: "/tmp",
  client: {
    app: { log: async () => ({}) },
    tui: { showToast: async () => ({}) },
  },
};
const options = {
  baseUrl: "https://aperture.example",
  modelsDevUrl: "https://catalog.example",
  apiKey: "",
};
const makeModel = (provider, id = "sample") => ({
  id,
  object: "model",
  metadata: { provider },
});

test("route IDs remain distinct through discovery, grouping, and display-name changes", async (t) => {
  const ids = ["route-a", "route_a", "ROUTE-A", "route/a"];
  let name = "Shared name";
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).endsWith("/api/providers"))
      return Response.json(
        ids.map((id, index) => ({
          id,
          name,
          compatibility:
            index % 2 ? { anthropic_messages: true } : { openai_chat: true },
        })),
      );
    return Response.json({ data: ids.map((id) => makeModel({ id, name })) });
  });
  const hooks = await TailscaleAperturePlugin(input, {
    ...options,
    disableModelsDev: true,
  });
  const config = {};
  await hooks.config(config);
  assert.equal(
    JSON.parse(await hooks.tool.list_aperture_models.execute({})).count,
    ids.length,
  );
  for (const [index, id] of ids.entries()) {
    const provider = config.provider[`aperture-${encodeURIComponent(id)}`];
    assert.equal(provider.models.sample.id, `${id}/sample`);
    assert.equal(
      provider.npm,
      index % 2 ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible",
    );
  }
  name = "Renamed";
  await hooks.tool.list_aperture_models.execute({ refresh: true });
  const renamed = {};
  await hooks.config(renamed);
  assert.deepEqual(Object.keys(renamed.provider), Object.keys(config.provider));
  assert.ok(
    Object.values(renamed.provider).every(
      (provider) => provider.name === "Aperture/Renamed",
    ),
  );
});

test("an explicit empty plugin key disables inherited discovery authentication", async (t) => {
  const original = process.env.APERTURE_API_KEY;
  process.env.APERTURE_API_KEY = "test-inherited-key";
  t.after(() => {
    if (original === undefined) delete process.env.APERTURE_API_KEY;
    else process.env.APERTURE_API_KEY = original;
  });
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    return Response.json(
      String(url).endsWith("/api/providers")
        ? []
        : { data: [makeModel({ id: "test", name: "Test" })] },
    );
  });
  const hooks = await TailscaleAperturePlugin(input, {
    ...options,
    disableModelsDev: true,
  });
  const config = {};
  await hooks.config(config);
  assert.equal(config.provider["aperture-test"].options.apiKey, "not-required");
});

test("catalog validation preserves good entries and falls back for invalid entries in HTTP and file catalogs", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aperture-catalog-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const valid = {
    id: "good",
    name: "Good",
    limit: { context: 64000, output: 2048 },
    reasoning: true,
  };
  let catalog = {
    brokenProvider: { models: null },
    catalog: {
      id: "catalog",
      name: "Catalog",
      models: {
        good: valid,
        brokenEffort: {
          id: "brokenEffort",
          name: "Bad effort",
          reasoning_options: [{ type: "effort", values: [1] }],
        },
        brokenLimit: {
          id: "brokenLimit",
          name: "Bad limit",
          limit: { context: "64000", output: 2048 },
        },
      },
    },
  };
  t.mock.method(globalThis, "fetch", async (url) => {
    if (new URL(url).hostname === "catalog.example")
      return Response.json(catalog);
    if (String(url).endsWith("/api/providers")) return Response.json([]);
    return Response.json({
      data: ["good", "brokenEffort", "brokenLimit"].map((id) =>
        makeModel({ id: "catalog", name: "Catalog" }, id),
      ),
    });
  });
  const path = join(directory, "catalog.json");
  await writeFile(path, JSON.stringify(catalog));
  for (const modelsDevPath of [undefined, path]) {
    const hooks = await TailscaleAperturePlugin(input, {
      ...options,
      modelsDevPath,
      disableModelsDev: false,
    });
    const config = {};
    await hooks.config(config);
    const models = config.provider["aperture-catalog"].models;
    assert.deepEqual(models.good.limit, {
      context: 64000,
      input: undefined,
      output: 2048,
    });
    assert.equal(models.good.reasoning, true);
    for (const id of ["brokenEffort", "brokenLimit"]) {
      assert.equal(models[id].limit.context, 128000);
      assert.equal(models[id].variants, undefined);
    }
  }
  catalog = [];
  const hooks = await TailscaleAperturePlugin(input, {
    ...options,
    disableModelsDev: false,
  });
  const config = {};
  await hooks.config(config);
  assert.equal(
    Object.keys(config.provider["aperture-catalog"].models).length,
    3,
  );
});
