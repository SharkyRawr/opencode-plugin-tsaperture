import assert from "node:assert/strict";
import test from "node:test";
import { TailscaleAperturePlugin } from "../dist/index.js";

function stubFetch(handlers) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "models.dev" && url.pathname === "/api.json") {
      return Response.json({});
    }
    const handler = handlers[`${url.hostname}${url.pathname}`];
    assert.ok(handler, `unexpected fetch: ${url.toString()}`);
    return handler();
  };
  return () => { globalThis.fetch = originalFetch; };
}

async function createConfig(handlers, client = {}) {
  const restore = stubFetch(handlers);
  try {
    const plugin = await TailscaleAperturePlugin({
      directory: "/tmp",
      client: {
        app: { log: async () => ({}) },
        tui: { showToast: async () => ({}) },
        ...client,
      },
    }, { baseUrl: "https://aperture.example" });
    const config = {};
    await plugin.config(config);
    return config;
  } finally {
    restore();
  }
}

const providers = () => Response.json([
  { id: "opencode-go", name: "OpenCode Go", compatibility: { openai_chat: true } },
]);

const models = (data) => () => Response.json({ object: "list", data });

test("handles a /v1/models response with no data field", async () => {
  const config = await createConfig({
    "aperture.example/api/providers": providers,
    "aperture.example/v1/models": () => Response.json({ object: "list" }),
  });
  assert.deepEqual(config.provider, {});
});

test("filters out models without ids and dedupes duplicates", async () => {
  const model = (id) => ({
    id,
    object: "model",
    owned_by: "opencode-go",
    metadata: { provider: { id: "opencode-go", name: "OpenCode Go" } },
  });
  const config = await createConfig({
    "aperture.example/api/providers": providers,
    "aperture.example/v1/models": models([
      model("dupe"),
      model("dupe"),
      model(""),
      { object: "model", owned_by: "opencode-go", metadata: { provider: { id: "opencode-go", name: "OpenCode Go" } } },
      { id: "noprovider", object: "model", owned_by: "ts-llm-proxy" },
    ]),
  });

  const group = config.provider["aperture-opencode-go"];
  assert.ok(group, "openai_chat provider group should exist");
  assert.deepEqual(Object.keys(group.models), ["dupe"], "dupes collapse and blank-id models are dropped");
  assert.deepEqual(
    Object.keys(config.provider.aperture.models),
    ["noprovider"],
    "models without provider metadata fall back to the default aperture group",
  );
});

test("registers models in degraded mode when /api/providers fails", async () => {
  const config = await createConfig({
    "aperture.example/api/providers": () => Response.json({ error: "boom" }, { status: 500 }),
    "aperture.example/v1/models": models([
      { id: "gpt-5.5", object: "model", owned_by: "ts-llm-proxy", metadata: { provider: { id: "openai-sub", name: "OpenAI (Subscription)" } } },
    ]),
  });

  assert.deepEqual(Object.keys(config.provider), ["aperture-openai-subscription"]);
  assert.equal(config.provider["aperture-openai-subscription"].models["gpt-5.5"].name, "gpt-5.5");
});

test("surfaces a /v1/models HTTP error as a startup failure", async () => {
  const toasts = [];
  const restore = stubFetch({
    "aperture.example/api/providers": providers,
    "aperture.example/v1/models": () => Response.json({ error: "boom" }, { status: 500 }),
  });
  try {
    const plugin = await TailscaleAperturePlugin({
      directory: "/tmp",
      client: {
        app: { log: async () => ({}) },
        tui: { showToast: async ({ body }) => { toasts.push(body); return {}; } },
      },
    }, { baseUrl: "https://aperture.example" });
    const config = {};
    await plugin.config(config);
    assert.equal(config.provider, undefined, "no provider config is emitted on failure");
  } finally {
    restore();
  }

  assert.ok(
    toasts.some((t) => t.variant === "error" && t.message.includes("Failed to fetch models")),
    "an error toast is shown for the failed models fetch",
  );
});
