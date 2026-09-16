import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("installed OpenCode loads v1 and publishes v2 providers when a v2 binary is supplied", {
  timeout: 30_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tsaperture-runtime-"));
  const entry = new URL("../dist/index.js", import.meta.url).href;
  const binary = fileURLToPath(
    new URL("../node_modules/opencode-ai/bin/opencode.exe", import.meta.url),
  );
  const endpoint = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        request.url === "/api/providers"
          ? [
              {
                id: "smoke",
                name: "smoke",
                compatibility: { openai_chat: true },
              },
            ]
          : {
              data: [
                {
                  id: "test-model",
                  object: "model",
                  created: 0,
                  owned_by: "smoke",
                  metadata: { provider: { id: "smoke", name: "smoke" } },
                },
              ],
            },
      ),
    );
  });
  let child;
  let exited;
  try {
    endpoint.listen(0, "127.0.0.1");
    await once(endpoint, "listening");
    const options = {
      baseUrl: `http://127.0.0.1:${endpoint.address().port}`,
      apiKey: "smoke-test",
      disableModelsDev: true,
    };
    const env = {
      ...process.env,
      XDG_CONFIG_HOME: join(directory, "config"),
      XDG_CACHE_HOME: join(directory, "cache"),
      XDG_DATA_HOME: join(directory, "data"),
      XDG_STATE_HOME: join(directory, "state"),
      OPENCODE_CONFIG_DIR: join(directory, "config", "opencode"),
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_MODELS_PATH: join(directory, "catalog.json"),
      OPENCODE_SERVER_USERNAME: "opencode",
      OPENCODE_SERVER_PASSWORD: "smoke-test",
    };
    delete env.OPENCODE_CONFIG;
    delete env.OPENCODE_CONFIG_CONTENT;
    await mkdir(env.OPENCODE_CONFIG_DIR, { recursive: true });
    await writeFile(env.OPENCODE_MODELS_PATH, "{}");
    await writeFile(
      join(directory, "opencode.json"),
      JSON.stringify({ plugin: [[entry, options]] }),
    );
    child = spawn(binary, ["models", "aperture-smoke"], {
      cwd: directory,
      env,
      timeout: 10_000,
    });
    exited = once(child, "exit");
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const [code] = await exited;
    assert.equal(code, 0, output);
    assert.match(output, /aperture-smoke\/test-model/);

    const v2Binary = process.env.OPENCODE_V2_BIN;
    if (!v2Binary) return;
    const v2Entry = fileURLToPath(new URL("../dist", import.meta.url));

    // Reserve an available port rather than using OpenCode's default port.
    const portServer = createServer();
    portServer.listen(0, "127.0.0.1");
    await once(portServer, "listening");
    const port = portServer.address().port;
    await new Promise((resolve) => portServer.close(resolve));
    await writeFile(
      join(env.OPENCODE_CONFIG_DIR, "opencode.json"),
      JSON.stringify({ plugins: [{ package: v2Entry, options }] }),
    );
    child = spawn(
      v2Binary,
      ["serve", "--hostname", "127.0.0.1", "--port", String(port)],
      { cwd: directory, env, timeout: 15_000 },
    );
    exited = once(child, "exit");
    output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    let model;
    for (let attempt = 0; attempt < 100; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (child.exitCode !== null) break;
      try {
        const response = await fetch(
          `http://127.0.0.1:${port}/api/model?location[directory]=${encodeURIComponent(directory)}`,
          {
            headers: {
              Authorization: `Basic ${Buffer.from("opencode:smoke-test").toString("base64")}`,
            },
            signal: AbortSignal.timeout(1_000),
          },
        );
        const result = await response.json();
        model = result.data?.find(
          (item) => item.providerID === "aperture-smoke",
        );
        if (model) break;
      } catch {
        /* Server may still be starting. */
      }
    }
    assert.ok(model, output);
    assert.equal(model.modelID, "smoke/test-model");
    assert.equal(model.package, "@opencode/ai/providers/openai-compatible");
    assert.equal(model.settings.baseURL, `${options.baseUrl}/v1`);
    assert.equal(model.settings.apiKey, "smoke-test");
  } finally {
    if (child?.exitCode === null) {
      child.kill();
      await exited;
    }
    await new Promise((resolve) => endpoint.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
