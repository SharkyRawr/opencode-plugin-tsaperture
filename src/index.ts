import type { Plugin, Config, Hooks } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { homedir } from "os";
import { join } from "path";
import { readFile } from "fs/promises";
import { platform } from "process";

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
  data: ApertureModel[];
}

interface ApertureConfig {
  baseUrl?: string;
  apiKey?: string;
}

type InterleavedConfig = true | {
  field: "reasoning_content" | "reasoning_details";
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
      clear_thinking?: boolean;
    };
    [key: string]: unknown;
  };
  headers?: Record<string, string>;
};

type ThinkingConfig = {
  type?: string;
  clear_thinking?: boolean;
};

type ProviderHook = NonNullable<Hooks["provider"]>;
type ProviderModelsHook = NonNullable<ProviderHook["models"]>;
type ProviderV2 = Parameters<ProviderModelsHook>[0];
type ModelV2 = Awaited<ReturnType<ProviderModelsHook>>[string];

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

function getModelDefaults(model: ApertureModel): Omit<ApertureModelConfig, "id" | "name"> {
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
          clear_thinking: false,
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
          clear_thinking: false,
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
        clear_thinking: false,
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

  return {
    ...defaults,
    ...existing,
    ...(limit ? { limit } : {}),
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
  };
}

function toModelV2(
  provider: ProviderV2,
  sourceModel: ApertureModel,
  existingModel?: ModelV2,
): ModelV2 {
  const mergedConfig = mergeModelConfig(getModelDefaults(sourceModel));

  return {
    id: sourceModel.id,
    providerID: provider.id,
    api: {
      id: existingModel?.api.id ?? mergedConfig.id ?? sourceModel.id,
      npm: existingModel?.api.npm ?? "@ai-sdk/openai-compatible",
      url: existingModel?.api.url ?? String(provider.options?.baseURL ?? ""),
    },
    name: mergedConfig.name ?? existingModel?.name ?? sourceModel.id,
    family: existingModel?.family ?? mergedConfig.family ?? "",
    capabilities: {
      temperature: mergedConfig.temperature ?? existingModel?.capabilities.temperature ?? false,
      reasoning: mergedConfig.reasoning ?? existingModel?.capabilities.reasoning ?? false,
      attachment: existingModel?.capabilities.attachment ?? false,
      toolcall: mergedConfig.tool_call ?? existingModel?.capabilities.toolcall ?? true,
      input: {
        text: mergedConfig.modalities?.input?.includes("text") ?? existingModel?.capabilities.input.text ?? true,
        audio: mergedConfig.modalities?.input?.includes("audio") ?? existingModel?.capabilities.input.audio ?? false,
        image: mergedConfig.modalities?.input?.includes("image") ?? existingModel?.capabilities.input.image ?? false,
        video: mergedConfig.modalities?.input?.includes("video") ?? existingModel?.capabilities.input.video ?? false,
        pdf: mergedConfig.modalities?.input?.includes("pdf") ?? existingModel?.capabilities.input.pdf ?? false,
      },
      output: {
        text: mergedConfig.modalities?.output?.includes("text") ?? existingModel?.capabilities.output.text ?? true,
        audio: mergedConfig.modalities?.output?.includes("audio") ?? existingModel?.capabilities.output.audio ?? false,
        image: mergedConfig.modalities?.output?.includes("image") ?? existingModel?.capabilities.output.image ?? false,
        video: mergedConfig.modalities?.output?.includes("video") ?? existingModel?.capabilities.output.video ?? false,
        pdf: mergedConfig.modalities?.output?.includes("pdf") ?? existingModel?.capabilities.output.pdf ?? false,
      },
      interleaved: mergedConfig.interleaved ?? existingModel?.capabilities.interleaved ?? false,
    },
    cost: {
      input: existingModel?.cost.input ?? 0,
      output: existingModel?.cost.output ?? 0,
      cache: {
        read: existingModel?.cost.cache.read ?? 0,
        write: existingModel?.cost.cache.write ?? 0,
      },
      ...(existingModel?.cost.experimentalOver200K ? {
        experimentalOver200K: existingModel.cost.experimentalOver200K,
      } : {}),
    },
    limit: {
      context: mergedConfig.limit?.context ?? existingModel?.limit.context ?? 0,
      input: mergedConfig.limit?.input ?? existingModel?.limit.input,
      output: mergedConfig.limit?.output ?? existingModel?.limit.output ?? 0,
    },
    status: existingModel?.status ?? mergedConfig.status ?? "active",
    options: {
      ...existingModel?.options,
      ...mergedConfig.options,
    },
    headers: {
      ...existingModel?.headers,
      ...mergedConfig.headers,
    },
    release_date: existingModel?.release_date || mergedConfig.release_date || getDefaultReleaseDate(sourceModel.created),
    variants: existingModel?.variants,
  };
}

async function fetchApertureModels(baseUrl: string, apiKey: string, timeoutMs = 15_000): Promise<ApertureModel[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/v1/models`, {
      signal: controller.signal,
      headers: apiKey ? {
        Authorization: `Bearer ${apiKey}`,
      } : undefined,
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as ApertureResponse;
    return data.data || [];
  } finally {
    clearTimeout(timer);
  }
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

async function loadApertureConfig(): Promise<ApertureConfig> {
  for (const configDir of openCodeConfigDirs) {
    const configPath = join(configDir, "aperture.json");
    try {
      const content = await readFile(configPath, "utf-8");
      console.log(`[TailscaleAperture] Loaded config from ${configPath}`);
      return JSON.parse(content) as ApertureConfig;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[TailscaleAperture] Failed to read ${configPath}:`, error);
      }
    }
  }

  return {};
}

export const TailscaleAperturePlugin: Plugin = async (_ctx, options) => {
  const fileConfig = await loadApertureConfig();
  const rawBaseUrl = (options?.baseUrl as string) || process.env.APERTURE_BASE_URL || fileConfig.baseUrl;
  const apiKey = (options?.apiKey as string) || process.env.APERTURE_API_KEY || fileConfig.apiKey || "";

  if (!rawBaseUrl) {
    console.warn("[TailscaleAperture] No baseUrl configured. Set APERTURE_BASE_URL, add baseUrl to plugin options, or create aperture.json in opencode config directory.");
    return {};
  }

  if (!apiKey) {
    console.info("[TailscaleAperture] No API key configured. This may be okay if you don't use authorization.");
  }

  const baseUrl = normalizeBaseUrl(rawBaseUrl);
  let discoveredModels: ApertureModel[] = [];
  let modelsLoaded = false;

  async function loadModels(refresh = false): Promise<ApertureModel[]> {
    if (!refresh && modelsLoaded) {
      return discoveredModels;
    }

    discoveredModels = await fetchApertureModels(baseUrl, apiKey);
    modelsLoaded = true;
    return discoveredModels;
  }

  try {
    discoveredModels = await loadModels(true);
    if (discoveredModels.length === 0) {
      console.warn("[TailscaleAperture] No models found");
    } else {
      console.log(`[TailscaleAperture] Discovered ${discoveredModels.length} models from ${baseUrl}`);
    }
  } catch (error) {
    console.warn("[TailscaleAperture] Failed to preload models:", error);
  }

  return {
    config: async (config: Config) => {
      try {
        config.provider ??= {};

        if (discoveredModels.length === 0) {
          return;
        }

        const existingProvider = config.provider.aperture ?? {};
        const modelsObj: Record<string, ApertureModelConfig> = {
          ...(existingProvider.models as Record<string, ApertureModelConfig> ?? {}),
        };
        config.provider.aperture = {
          ...existingProvider,
          npm: existingProvider.npm ?? "@ai-sdk/openai-compatible",
          name: existingProvider.name ?? "Tailscale Aperture",
          options: {
            ...existingProvider.options,
            baseURL: `${baseUrl}/v1`,
            apiKey: existingProvider.options?.apiKey ?? apiKey,
          },
          models: modelsObj,
        };

        for (const model of discoveredModels) {
          const existingModel = modelsObj[model.id] ?? {};
          modelsObj[model.id] = {
            ...mergeModelConfig(getModelDefaults(model), existingModel),
            id: model.id,
            name: existingModel.name ?? model.id,
          };
        }
        console.log(`[TailscaleAperture] Registered provider aperture for ${discoveredModels.length} discovered models`);
      } catch (error) {
        console.error("[TailscaleAperture] Failed to register models:", error);
      }
    },

    provider: {
      id: "aperture",
      models: async (provider: ProviderV2) => {
        const nextModels = Object.fromEntries(discoveredModels.map((model) => {
          const existingModel = provider.models[model.id];
          return [model.id, toModelV2(provider, model, existingModel)];
        }));

        console.log(`[TailscaleAperture] Loaded ${Object.keys(nextModels).length} ModelV2 models`);
        return nextModels;
      },
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
