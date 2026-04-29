import type { Plugin, Config } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { homedir } from "os";
import { join } from "path";
import { readFile } from "fs/promises";
import { platform } from "process";
import { createRequire } from "module";

interface ApertureModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  metadata?: {
    provider?: {
      id: string;
      name: string;
      description?: string;
    };
  };
}

interface ApertureResponse {
  object: string;
  data?: ApertureModel[];
  models?: Array<ApertureModel & {
    model?: string;
  }>;
}

interface ApertureConfig {
  baseUrl?: string;
  apiKey?: string;
  modelsDevUrl?: string;
  modelsDevPath?: string;
  disableModelsDev?: boolean;
}

type InterleavedConfig = true | {
  field: "reasoning_content" | "reasoning_details";
};

type ModelCost = {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
  context_over_200k?: {
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
  };
};

type ApertureModelConfig = {
  id?: string;
  name?: string;
  family?: string;
  release_date?: string;
  attachment?: boolean;
  status?: "alpha" | "beta" | "deprecated";
  limit?: {
    context: number;
    input?: number;
    output: number;
  };
  cost?: ModelCost;
  reasoning?: boolean;
  temperature?: boolean;
  tool_call?: boolean;
  modalities?: {
    input: Array<"text" | "audio" | "image" | "video" | "pdf">;
    output: Array<"text" | "audio" | "image" | "video" | "pdf">;
  };
  interleaved?: InterleavedConfig;
  options?: {
    thinking?: {
      type?: string;
    };
    [key: string]: unknown;
  };
  headers?: Record<string, string>;
  variants?: Record<string, Record<string, unknown>>;
};

type ThinkingConfig = {
  type?: string;
};

type ToastVariant = "success" | "error";

type PendingToast = {
  variant: ToastVariant;
  message: string;
  attempts: number;
};

type ModelsDevModel = {
  id: string;
  name: string;
  family?: string;
  release_date?: string;
  attachment?: boolean;
  status?: "alpha" | "beta" | "deprecated";
  cost?: ModelCost;
  limit?: {
    context: number;
    input?: number;
    output: number;
  };
  reasoning?: boolean;
  temperature?: boolean;
  tool_call?: boolean;
  modalities?: {
    input: Array<"text" | "audio" | "image" | "video" | "pdf">;
    output: Array<"text" | "audio" | "image" | "video" | "pdf">;
  };
  interleaved?: InterleavedConfig;
};

type ModelsDevProvider = {
  id: string;
  name: string;
  npm?: string;
  api?: string;
  models: Record<string, ModelsDevModel>;
};

type ModelsDevCatalog = Record<string, ModelsDevProvider>;

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

type ApertureProviderGroup = {
  id: string;
  name: string;
};

function slugifyProviderSegment(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || "default";
}

function normalizeModelLookup(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_:\s.]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function getProviderAliases(model: ApertureModel): string[] {
  const providerID = model.metadata?.provider?.id ?? "";
  const providerName = model.metadata?.provider?.name ?? "";
  const ownedBy = model.owned_by ?? "";
  const id = model.id.toLowerCase();
  const raw = [providerID, providerName, ownedBy].filter(Boolean);
  const aliases = new Set(raw.flatMap((value) => [
    value,
    slugifyProviderSegment(value),
    normalizeModelLookup(value),
  ]));

  if (id.includes("glm") || [...aliases].some((value) => ["zai", "z-ai", "z.ai", "zai-coding-plan"].includes(value))) {
    aliases.add("zai");
    aliases.add("zai-coding-plan");
  }

  if (id.includes("kimi") || id.includes("k2p") || [...aliases].some((value) => ["kimi", "kimi-for-coding", "moonshot", "moonshotai"].includes(value))) {
    aliases.add("kimi-for-coding");
    aliases.add("moonshotai");
    aliases.add("moonshotai-cn");
  }

  return [...aliases].filter(Boolean);
}

function findModelsDevEntry(model: ApertureModel, catalog?: ModelsDevCatalog): {
  provider: ModelsDevProvider;
  model: ModelsDevModel;
} | undefined {
  if (!catalog) {
    return undefined;
  }

  const modelKeys = new Set([
    model.id,
    model.id.toLowerCase(),
    normalizeModelLookup(model.id),
  ]);
  const providerAliases = getProviderAliases(model);

  for (const alias of providerAliases) {
    const provider = catalog[alias];
    if (!provider) {
      continue;
    }

    for (const key of modelKeys) {
      const candidate = provider.models[key];
      if (candidate) {
        return { provider, model: candidate };
      }
    }
  }

  const exactMatches: Array<{ provider: ModelsDevProvider; model: ModelsDevModel }> = [];
  for (const provider of Object.values(catalog)) {
    for (const key of modelKeys) {
      const candidate = provider.models[key];
      if (candidate) {
        exactMatches.push({ provider, model: candidate });
      }
    }
  }

  return exactMatches.length === 1 ? exactMatches[0] : undefined;
}

function getProviderGroup(model: ApertureModel): ApertureProviderGroup {
  const providerID = model.metadata?.provider?.id?.trim();
  const providerName = model.metadata?.provider?.name?.trim();
  if (!providerName) {
    return {
      id: "aperture",
      name: "Aperture",
    };
  }

  return {
    id: `aperture-${slugifyProviderSegment(providerID || providerName)}`,
    name: `Aperture/${providerName}`,
  };
}

function getModelProviderKey(model: ApertureModel): string {
  return `${getProviderGroup(model).id}:${model.id}`;
}

function getReasoningVariants(modelID: string, defaults: Omit<ApertureModelConfig, "id" | "name">): Record<string, Record<string, unknown>> | undefined {
  if (!defaults.reasoning) {
    return undefined;
  }

  const id = modelID.toLowerCase();
  if (
    id.includes("deepseek-chat") ||
    id.includes("deepseek-reasoner") ||
    id.includes("deepseek-r1") ||
    id.includes("deepseek-v3") ||
    id.includes("minimax") ||
    id.includes("glm") ||
    id.includes("kimi") ||
    id.includes("k2p") ||
    id.includes("qwen") ||
    id.includes("big-pickle")
  ) {
    return undefined;
  }

  if (id.includes("grok") && id.includes("grok-3-mini")) {
    return {
      low: { reasoningEffort: "low" },
      high: { reasoningEffort: "high" },
    };
  }
  if (id.includes("grok")) {
    return undefined;
  }

  if (id.includes("claude")) {
    const output = defaults.limit?.output ?? 32_000;
    return {
      high: {
        thinking: {
          type: "enabled",
          budgetTokens: Math.min(16_000, Math.floor(output / 2 - 1)),
        },
      },
      max: {
        thinking: {
          type: "enabled",
          budgetTokens: Math.min(31_999, output - 1),
        },
      },
    };
  }

  if (id.includes("gemini")) {
    if (id.includes("2.5")) {
      return {
        high: {
          thinkingConfig: {
            includeThoughts: true,
            thinkingBudget: 16_000,
          },
        },
        max: {
          thinkingConfig: {
            includeThoughts: true,
            thinkingBudget: 24_576,
          },
        },
      };
    }

    const levels = id.includes("3.1") ? ["low", "medium", "high"] : ["low", "high"];
    return Object.fromEntries(levels.map((effort) => [
      effort,
      {
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: effort,
        },
      },
    ]));
  }

  return Object.fromEntries(["low", "medium", "high"].map((effort) => [
    effort,
    { reasoningEffort: effort },
  ]));
}

function getModelsDevDefaults(entry: {
  provider: ModelsDevProvider;
  model: ModelsDevModel;
}): Omit<ApertureModelConfig, "id" | "name"> {
  const defaults: Omit<ApertureModelConfig, "id" | "name"> = {
    family: entry.model.family,
    release_date: entry.model.release_date,
    attachment: entry.model.attachment,
    status: entry.model.status,
    cost: entry.model.cost,
    limit: entry.model.limit,
    reasoning: entry.model.reasoning,
    temperature: entry.model.temperature,
    tool_call: entry.model.tool_call,
    modalities: entry.model.modalities,
    interleaved: entry.model.interleaved,
  };

  const variants = getReasoningVariants(entry.model.id, defaults);
  if (variants && Object.keys(variants).length > 0) {
    defaults.variants = variants;
  }

  return Object.fromEntries(
    Object.entries(defaults).filter(([, value]) => value !== undefined),
  ) as Omit<ApertureModelConfig, "id" | "name">;
}

function getOperationalDefaults(model: ApertureModel): Omit<ApertureModelConfig, "id" | "name"> {
  const id = model.id.toLowerCase();
  const providerID = model.metadata?.provider?.id?.toLowerCase();
  const providerName = model.metadata?.provider?.name?.toLowerCase();
  const isZai = id.includes("glm")
    || providerID === "zai"
    || providerID === "z.ai"
    || providerID === "zai-coding-plan"
    || providerName === "z.ai"
    || providerName === "zai-coding-plan";
  const isKimi = id.includes("kimi")
    || id.includes("k2p")
    || providerID === "kimi"
    || providerID === "kimi-for-coding"
    || providerName === "kimi"
    || providerName === "kimi-for-coding";

  if (!isZai && !isKimi) {
    return {};
  }

  return {
    interleaved: {
      field: "reasoning_content",
    },
    options: {
      thinking: {
        type: "enabled",
      },
    },
    ...(isKimi ? {
      headers: {
        "User-Agent": "KimiCLI/1.3",
      },
    } : {}),
  };
}

function getModelDefaults(model: ApertureModel, catalog?: ModelsDevCatalog): Omit<ApertureModelConfig, "id" | "name"> {
  const modelsDevEntry = findModelsDevEntry(model, catalog);
  if (modelsDevEntry) {
    return mergeModelConfig(getModelsDevDefaults(modelsDevEntry), getOperationalDefaults(model));
  }

  const id = model.id.toLowerCase();
  const providerID = model.metadata?.provider?.id?.toLowerCase();
  const providerName = model.metadata?.provider?.name?.toLowerCase();
  const isZai = id.includes("glm")
    || providerID === "zai"
    || providerID === "z.ai"
    || providerID === "zai-coding-plan"
    || providerName === "z.ai"
    || providerName === "zai-coding-plan";
  const isKimi = id.includes("kimi")
    || providerID === "kimi"
    || providerID === "kimi-for-coding"
    || providerName === "kimi"
    || providerName === "kimi-for-coding";

  if (isZai) {
    return {
      limit: {
        context: 200_000,
        output: 8_192,
      },
      reasoning: true,
      temperature: true,
      tool_call: true,
      modalities: {
        input: ["text"],
        output: ["text"],
      },
      interleaved: {
        field: "reasoning_content",
      },
      options: {
        thinking: {
          type: "enabled",
        },
      },
    };
  }

  if (isKimi) {
    return {
      limit: {
        context: 200_000,
        output: 128_000,
      },
      reasoning: true,
      temperature: true,
      tool_call: true,
      modalities: {
        input: ["text"],
        output: ["text"],
      },
      interleaved: {
        field: "reasoning_content",
      },
      options: {
        thinking: {
          type: "enabled",
        },
      },
      headers: {
        "User-Agent": "KimiCLI/1.3",
      },
    };
  }

  return {
    limit: {
      context: 128_000,
      output: 8_192,
    },
    reasoning: false,
    temperature: true,
    tool_call: true,
    modalities: {
      input: ["text"],
      output: ["text"],
    },
    interleaved: {
      field: "reasoning_content",
    },
    options: {
      thinking: {
        type: "enabled",
      },
    },
  };
}

function getDefaultReleaseDate(created?: number): string {
  if (!created || created <= 0) {
    return "";
  }

  return new Date(created * 1000).toISOString().slice(0, 10);
}

function mergeThinkingConfig(defaults?: ThinkingConfig, existing?: ThinkingConfig): ThinkingConfig | undefined {
  if (!defaults && !existing) {
    return undefined;
  }

  return {
    ...defaults,
    ...existing,
  };
}

function mergeModelConfig(defaults: Omit<ApertureModelConfig, "id" | "name">, existing: ApertureModelConfig = {}): ApertureModelConfig {
  const thinking = mergeThinkingConfig(
    defaults.options?.thinking as ThinkingConfig | undefined,
    existing.options?.thinking as ThinkingConfig | undefined,
  );
  const limit = defaults.limit || existing.limit ? {
    context: existing.limit?.context ?? defaults.limit?.context ?? 0,
    input: existing.limit?.input ?? defaults.limit?.input,
    output: existing.limit?.output ?? defaults.limit?.output ?? 0,
  } : undefined;
  const modalities = defaults.modalities || existing.modalities ? {
    input: existing.modalities?.input ?? defaults.modalities?.input ?? ["text"],
    output: existing.modalities?.output ?? defaults.modalities?.output ?? ["text"],
  } : undefined;
  const cost = defaults.cost || existing.cost ? {
    ...defaults.cost,
    ...existing.cost,
    ...(defaults.cost?.context_over_200k || existing.cost?.context_over_200k ? {
      context_over_200k: {
        ...defaults.cost?.context_over_200k,
        ...existing.cost?.context_over_200k,
      },
    } : {}),
  } as ModelCost : undefined;

  return {
    ...defaults,
    ...existing,
    ...(limit ? { limit } : {}),
    ...(cost ? { cost } : {}),
    ...(modalities ? { modalities } : {}),
    ...(defaults.interleaved || existing.interleaved ? {
      interleaved: existing.interleaved ?? defaults.interleaved,
    } : {}),
    ...(defaults.options || existing.options ? {
      options: {
        ...defaults.options,
        ...existing.options,
        ...(thinking ? { thinking } : {}),
      },
    } : {}),
    ...(defaults.headers || existing.headers ? {
      headers: {
        ...defaults.headers,
        ...existing.headers,
      },
    } : {}),
    ...(defaults.variants || existing.variants ? {
      variants: {
        ...defaults.variants,
        ...existing.variants,
      },
    } : {}),
  };
}

/**
 * Poll the models endpoint until the set of model IDs stabilizes (two
 * consecutive fetches return the same IDs) or the deadline is exceeded.
 * Transient fetch errors are retried within the deadline.
 */
async function waitForStableModels(
  baseUrl: string,
  apiKey: string,
  logger: Logger,
  { pollIntervalMs = 500, deadlineMs = 10_000, fetchTimeoutMs = 5_000, minFetchTimeoutMs = 2_000, previousModels = [] as ApertureModel[] } = {},
): Promise<ApertureModel[]> {
  const deadline = Date.now() + deadlineMs;
  let previousIds: string | undefined = previousModels.length > 0
    ? previousModels.map(getModelProviderKey).sort().join("\n")
    : undefined;
  let lastGoodResult: ApertureModel[] = previousModels;
  let sawSuccessfulFetch = previousModels.length > 0;
  let lastError: unknown;

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining < minFetchTimeoutMs && lastGoodResult.length > 0) {
      return lastGoodResult;
    }

    try {
      const models = await fetchApertureModels(baseUrl, apiKey, logger, Math.min(remaining, fetchTimeoutMs));
      const ids = models.map(getModelProviderKey).sort().join("\n");

      lastGoodResult = models;
      sawSuccessfulFetch = true;

      if (ids === previousIds) {
        return models;
      }
      previousIds = ids;
    } catch (error) {
      lastError = error;
      // Transient error — retry until deadline.
    }

    if (Date.now() + pollIntervalMs >= deadline) {
      return lastGoodResult;
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  if (!sawSuccessfulFetch && lastError) {
    throw lastError;
  }

  return lastGoodResult;
}

async function fetchApertureModels(baseUrl: string, apiKey: string, logger: Logger, timeoutMs = 15_000): Promise<ApertureModel[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const url = `${baseUrl}/v1/models`;
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: apiKey ? {
        Authorization: `Bearer ${apiKey}`,
      } : undefined,
    });
    if (!response.ok) {
      logger.warn(`[TailscaleAperture] Aperture API request failed: GET /v1/models ${response.status} ${response.statusText}`);
      throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as ApertureResponse;
    const openAIModels = data.data ?? [];
    const llamaCppModels = (data.models ?? []).map((model) => ({
      ...model,
      id: model.id || model.model || "",
      object: model.object || "model",
      created: model.created || 0,
      owned_by: model.owned_by || "unknown",
    }));
    const mergedModels = [...openAIModels, ...llamaCppModels]
      .filter((model) => model.id);

    return Array.from(
      new Map(mergedModels.map((model) => [getModelProviderKey(model), model])).values(),
    );
  } catch (error) {
    if (!(error instanceof Error && error.message.startsWith("Failed to fetch models:"))) {
      logger.warn("[TailscaleAperture] Aperture API request failed: GET /v1/models", error);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readModelsDevCatalog(path: string, logger: Logger): Promise<ModelsDevCatalog | undefined> {
  try {
    const content = await readFile(path, "utf-8");
    return JSON.parse(content) as ModelsDevCatalog;
  } catch (error) {
    logger.warn(`[TailscaleAperture] Failed to read Models.dev catalog from ${path}:`, error);
    return undefined;
  }
}

async function fetchModelsDevCatalog(url: string, logger: Logger, timeoutMs = 10_000): Promise<ModelsDevCatalog | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const baseUrl = url.replace(/\/+$/, "");

  try {
    const response = await fetch(`${baseUrl}/api.json`, {
      signal: controller.signal,
      headers: {
        "User-Agent": "opencode-plugin-tsaperture",
      },
    });
    if (!response.ok) {
      logger.warn(`[TailscaleAperture] Models.dev request failed: GET /api.json ${response.status} ${response.statusText}`);
      return undefined;
    }

    return await response.json() as ModelsDevCatalog;
  } catch (error) {
    logger.warn("[TailscaleAperture] Models.dev request failed: GET /api.json", error);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function loadModelsDevCatalog(config: ApertureConfig, logger: Logger): Promise<ModelsDevCatalog | undefined> {
  if (config.disableModelsDev || process.env.OPENCODE_DISABLE_MODELS_FETCH) {
    logger.info("[TailscaleAperture] Models.dev enrichment disabled");
    return undefined;
  }

  const path = config.modelsDevPath || process.env.OPENCODE_MODELS_PATH;
  if (path) {
    return readModelsDevCatalog(path, logger);
  }

  const url = config.modelsDevUrl || process.env.OPENCODE_MODELS_URL || "https://models.dev";
  return fetchModelsDevCatalog(url, logger);
}

function getOpenCodeConfigDirs(): string[] {
  const home = homedir();
  const dirs: string[] = [];

  if (platform === "win32") {
    dirs.push(join(process.env.APPDATA || process.env.LOCALAPPDATA || home, "opencode"));
  } else if (platform === "darwin") {
    const xdgConfig = process.env.XDG_CONFIG_HOME;
    if (xdgConfig) {
      dirs.push(join(xdgConfig, "opencode"));
    }
    dirs.push(join(home, ".config", "opencode"));
    dirs.push(join(home, "Library", "Application Support", "opencode"));
  } else {
    const xdgConfig = process.env.XDG_CONFIG_HOME;
    if (xdgConfig) {
      dirs.push(join(xdgConfig, "opencode"));
    }
    dirs.push(join(home, ".config", "opencode"));
  }

  return dirs;
}

const openCodeConfigDirs = getOpenCodeConfigDirs();

type Logger = {
  log: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
  info: (message: string, ...args: unknown[]) => void;
  debug: (message: string, ...args: unknown[]) => void;
};

async function loadApertureConfig(logger: Logger): Promise<ApertureConfig> {
  for (const configDir of openCodeConfigDirs) {
    const configPath = join(configDir, "aperture.json");
    try {
      const content = await readFile(configPath, "utf-8");
      logger.log(`[TailscaleAperture] Loaded config from ${configPath}`);
      return JSON.parse(content) as ApertureConfig;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn(`[TailscaleAperture] Failed to read ${configPath}:`, error);
      }
    }
  }

  return {};
}

export const TailscaleAperturePlugin: Plugin = async (input, options) => {
  const client = input.client;

  const logger: Logger = {
    log: (message: string, ...args: unknown[]) => {
      client.app.log({
        body: {
          service: "TailscaleAperture",
          level: "info",
          message,
          extra: args.length > 0 ? { args: args.map((a) => a instanceof Error ? a.stack || a.message : String(a)) } : undefined,
        },
      }).catch(() => {});
    },
    warn: (message: string, ...args: unknown[]) => {
      client.app.log({
        body: {
          service: "TailscaleAperture",
          level: "warn",
          message,
          extra: args.length > 0 ? { args: args.map((a) => a instanceof Error ? a.stack || a.message : String(a)) } : undefined,
        },
      }).catch(() => {});
    },
    error: (message: string, ...args: unknown[]) => {
      client.app.log({
        body: {
          service: "TailscaleAperture",
          level: "error",
          message,
          extra: args.length > 0 ? { args: args.map((a) => a instanceof Error ? a.stack || a.message : String(a)) } : undefined,
        },
      }).catch(() => {});
    },
    info: (message: string, ...args: unknown[]) => {
      client.app.log({
        body: {
          service: "TailscaleAperture",
          level: "info",
          message,
          extra: args.length > 0 ? { args: args.map((a) => a instanceof Error ? a.stack || a.message : String(a)) } : undefined,
        },
      }).catch(() => {});
    },
    debug: (message: string, ...args: unknown[]) => {
      client.app.log({
        body: {
          service: "TailscaleAperture",
          level: "debug",
          message,
          extra: args.length > 0 ? { args: args.map((a) => a instanceof Error ? a.stack || a.message : String(a)) } : undefined,
        },
      }).catch(() => {});
    },
  };

  const require = createRequire(import.meta.url);
  const pkg = require("../package.json") as { name: string; version: string };
  logger.log(`[TailscaleAperture] ${pkg.name} v${pkg.version}`);

  const pendingToasts: PendingToast[] = [];
  let tuiReady = false;
  let toastFlushTimer: ReturnType<typeof setTimeout> | undefined;

  async function sendToast(toast: PendingToast): Promise<void> {
    const result = await client.tui.showToast({
      body: {
        title: "Tailscale Aperture",
        message: toast.message,
        variant: toast.variant,
        duration: 10_000,
      },
      query: {
        directory: input.directory,
      },
    });
    if (result.error) {
      throw new Error(`Failed to show opencode toast: ${JSON.stringify(result.error)}`);
    }
  }

  function scheduleToastFlush(): void {
    if (!tuiReady || toastFlushTimer) {
      return;
    }

    toastFlushTimer = setTimeout(() => {
      toastFlushTimer = undefined;
      flushToastQueue().catch((error) => {
        logger.warn("[TailscaleAperture] Failed to flush queued toasts:", error);
      });
    }, 1_000);
    toastFlushTimer.unref?.();
  }

  async function flushToastQueue(): Promise<void> {
    if (!tuiReady || pendingToasts.length === 0) {
      return;
    }

    const toasts = pendingToasts.splice(0, pendingToasts.length);
    for (const toast of toasts) {
      try {
        await sendToast(toast);
      } catch (error) {
        logger.warn("[TailscaleAperture] Failed to show opencode toast:", error);
        if (toast.attempts < 5) {
          pendingToasts.push({
            ...toast,
            attempts: toast.attempts + 1,
          });
        }
      }
    }

    if (pendingToasts.length > 0) {
      scheduleToastFlush();
    }
  }

  function showMessage(variant: ToastVariant, message: string): void {
    if (pendingToasts.some((toast) => toast.variant === variant && toast.message === message)) {
      return;
    }

    pendingToasts.push({
      variant,
      message,
      attempts: 0,
    });

    if (tuiReady) {
      flushToastQueue().catch((error) => {
        logger.warn("[TailscaleAperture] Failed to flush queued toasts:", error);
      });
    }
  }

  function markTuiReady(): void {
    tuiReady = true;
    flushToastQueue().catch((error) => {
      logger.warn("[TailscaleAperture] Failed to flush queued toasts:", error);
    });
  }

  const fileConfig = await loadApertureConfig(logger);
  const rawBaseUrl = (options?.baseUrl as string) || process.env.APERTURE_BASE_URL || fileConfig.baseUrl;
  const apiKey = (options?.apiKey as string) || process.env.APERTURE_API_KEY || fileConfig.apiKey || "";
  const modelsDevConfig: ApertureConfig = {
    ...fileConfig,
    modelsDevUrl: (options?.modelsDevUrl as string | undefined) ?? fileConfig.modelsDevUrl,
    modelsDevPath: (options?.modelsDevPath as string | undefined) ?? fileConfig.modelsDevPath,
    disableModelsDev: (options?.disableModelsDev as boolean | undefined) ?? fileConfig.disableModelsDev,
  };

  if (!rawBaseUrl) {
    const message = "No baseUrl configured. Set APERTURE_BASE_URL, add baseUrl to plugin options, or create aperture.json in opencode config directory.";
    logger.warn(`[TailscaleAperture] ${message}`);
    showMessage("error", message);
    return {
      config: async () => {
        markTuiReady();
      },
      event: async ({ event }) => {
        if (event.type === "server.connected") {
          markTuiReady();
        }
      },
    };
  }

  if (!apiKey) {
    logger.info("[TailscaleAperture] No API key configured. This may be okay if you don't use authorization.");
  }

  const baseUrl = normalizeBaseUrl(rawBaseUrl);
  let discoveredModels: ApertureModel[] = [];
  let modelsDevCatalog: ModelsDevCatalog | undefined;
  let modelsLoaded = false;
  let modelLoadPromise: Promise<ApertureModel[]> | undefined;

  function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  async function printErrorToChat(message: string): Promise<void> {
    try {
      const sessionsResult = await client.session.list({
        query: {
          directory: input.directory,
        },
      });
      if (sessionsResult.error) {
        throw new Error(`Failed to list opencode sessions: ${JSON.stringify(sessionsResult.error)}`);
      }

      const session = sessionsResult.data
        ?.filter((candidate) => candidate.directory === input.directory)
        .sort((a, b) => b.time.updated - a.time.updated)[0];
      if (!session) {
        logger.warn("[TailscaleAperture] Failed to print error to chat: no opencode session found");
        return;
      }

      const promptResult = await client.session.promptAsync({
        path: {
          id: session.id,
        },
        query: {
          directory: input.directory,
        },
        body: {
          noReply: true,
          parts: [{
            type: "text",
            text: message,
            synthetic: true,
          }],
        },
      });
      if (promptResult.error) {
        throw new Error(`Failed to print error to chat: ${JSON.stringify(promptResult.error)}`);
      }
    } catch (error) {
      logger.warn("[TailscaleAperture] Failed to print error to chat:", error);
    }
  }

  async function loadModels(refresh = false): Promise<ApertureModel[]> {
    if (!refresh && modelsLoaded) {
      return discoveredModels;
    }

    if (refresh && modelsLoaded) {
      // Interactive refresh: single fetch, no stabilization wait.
      discoveredModels = await fetchApertureModels(baseUrl, apiKey, logger);
      return discoveredModels;
    }

    if (!refresh && modelLoadPromise) {
      return modelLoadPromise;
    }

    modelLoadPromise = waitForStableModels(baseUrl, apiKey, logger, {
      previousModels: discoveredModels,
    }).then((models) => {
      discoveredModels = models;
      modelsLoaded = true;
      return discoveredModels;
    }).finally(() => {
      modelLoadPromise = undefined;
    });

    return modelLoadPromise;
  }

  function mutateConfig(config: Config): number {
    config.provider ??= {};

    if (discoveredModels.length === 0) {
      return 0;
    }

    const baseProvider = config.provider.aperture ?? {};
    const modelsByProvider = new Map<string, {
      group: ApertureProviderGroup;
      models: ApertureModel[];
    }>();

    for (const model of discoveredModels) {
      const group = getProviderGroup(model);
      const existingGroup = modelsByProvider.get(group.id);
      if (existingGroup) {
        existingGroup.models.push(model);
      } else {
        modelsByProvider.set(group.id, {
          group,
          models: [model],
        });
      }
    }

    for (const { group, models } of modelsByProvider.values()) {
      const existingProvider = config.provider[group.id] ?? {};
      const modelsObj: Record<string, ApertureModelConfig> = {
        ...(existingProvider.models as Record<string, ApertureModelConfig> ?? {}),
      };

      config.provider[group.id] = {
        ...baseProvider,
        ...existingProvider,
        npm: existingProvider.npm ?? baseProvider.npm ?? "@ai-sdk/openai-compatible",
        name: existingProvider.name ?? group.name,
        options: {
          ...baseProvider.options,
          ...existingProvider.options,
          baseURL: `${baseUrl}/v1`,
          apiKey: existingProvider.options?.apiKey ?? baseProvider.options?.apiKey ?? apiKey,
        },
        models: modelsObj,
      };

      for (const model of models) {
        const existingModel = modelsObj[model.id] ?? {};
        modelsObj[model.id] = {
          ...mergeModelConfig(getModelDefaults(model, modelsDevCatalog), existingModel),
          id: model.id,
          name: existingModel.name ?? model.id,
        };
      }
    }

    for (const providerID of Object.keys(config.provider)) {
      if (providerID.startsWith("aperture-") && !modelsByProvider.has(providerID)) {
        delete config.provider[providerID];
      }
    }

    const hasDefaultGroup = modelsByProvider.has("aperture");
    if (!hasDefaultGroup) {
      delete config.provider.aperture;
    }

    return modelsByProvider.size;
  }

  function countProviderGroups(models: ApertureModel[]): number {
    return new Set(models.map((model) => getProviderGroup(model).id)).size;
  }

  async function loadModelsOnStartup(): Promise<ApertureModel[]> {
    try {
      discoveredModels = await loadModels(false);
      if (discoveredModels.length === 0) {
        logger.warn("[TailscaleAperture] No models found");
        showMessage("success", `No Aperture models found at ${baseUrl}`);
        return discoveredModels;
      }

      logger.log(`[TailscaleAperture] Discovered ${discoveredModels.length} models from ${baseUrl}`);
      const providerGroupCount = countProviderGroups(discoveredModels);
      logger.log(`[TailscaleAperture] Registered ${providerGroupCount} Aperture provider groups for ${discoveredModels.length} discovered models`);
      showMessage("success", `Registered ${discoveredModels.length} Aperture models across ${providerGroupCount} provider groups`);
      return discoveredModels;
    } catch (error) {
      const errmsg = formatError(error);
      logger.error("[TailscaleAperture] Failed to register models:", error);
      showMessage("error", errmsg);
      await printErrorToChat(errmsg);
      throw error;
    }
  }

  const startupModels = loadModelsOnStartup();
  const startupModelsDevCatalog = loadModelsDevCatalog(modelsDevConfig, logger).then((catalog) => {
    modelsDevCatalog = catalog;
    if (catalog) {
      logger.log(`[TailscaleAperture] Loaded Models.dev catalog with ${Object.keys(catalog).length} providers`);
    }
    return catalog;
  });

  return {
    config: async (config: Config) => {
      try {
        await Promise.all([startupModels, startupModelsDevCatalog]);
        mutateConfig(config);
      } catch (error) {
        logger.error("[TailscaleAperture] Failed to register models:", error);
        showMessage("error", formatError(error));
      } finally {
        markTuiReady();
      }
    },

    event: async ({ event }) => {
      if (event.type === "server.connected") {
        markTuiReady();
      }
    },

    tool: {
      list_aperture_models: tool({
        description: "List available models from Tailscale Aperture",
        args: {
          refresh: tool.schema.boolean().optional().describe("Refresh the cached Aperture model list before returning it"),
        },
        async execute(args) {
          try {
            const models = await loadModels(args.refresh ?? false);
            return JSON.stringify({
              models,
              count: models.length,
            }, null, 2);
          } catch (error) {
            return JSON.stringify({ error: String(error) });
          }
        },
      }),

      get_aperture_model: tool({
        description: "Get details for a specific Aperture model",
        args: {
          modelId: tool.schema.string().describe("Model ID"),
          refresh: tool.schema.boolean().optional().describe("Refresh the cached Aperture model list before looking up the model"),
        },
        async execute(args) {
          try {
            const models = await loadModels(args.refresh ?? false);
            const model = models.find(m => m.id === args.modelId);
            if (!model) {
              return JSON.stringify({ error: `Model ${args.modelId} not found` });
            }
            return JSON.stringify({ model }, null, 2);
          } catch (error) {
            return JSON.stringify({ error: String(error) });
          }
        },
      }),
    },
  };
};

export default TailscaleAperturePlugin;
