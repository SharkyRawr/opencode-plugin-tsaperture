import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { homedir } from "os";
import { join } from "path";
import { readFileSync, existsSync } from "fs";
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

type ModelConfig = {
  id: string;
  name: string;
  limit: {
    context: number;
    output: number;
  };
  reasoning: boolean;
  temperature: boolean;
  tool_call: boolean;
  modalities: {
    input: Array<"text">;
    output: Array<"text">;
  };
  interleaved?: true | {
    field: "reasoning_content" | "reasoning_details";
  };
};

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

function getModelDefaults(model: ApertureModel): Omit<ModelConfig, "id" | "name"> {
  const id = model.id.toLowerCase();
  const providerID = model.metadata?.provider?.id?.toLowerCase();

  if (id.includes("glm") || providerID === "zai") {
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
    };
  }

  if (id.includes("kimi")) {
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
  };
}

async function fetchApertureModels(baseUrl: string): Promise<ApertureModel[]> {
  const response = await fetch(`${baseUrl}/v1/models`);
  if (!response.ok) {
    throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as ApertureResponse;
  return data.data || [];
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

function loadApertureConfig(): ApertureConfig {
  const configDirs = getOpenCodeConfigDirs();

  for (const configDir of configDirs) {
    const configPath = join(configDir, "aperture.json");
    if (existsSync(configPath)) {
      try {
        const content = readFileSync(configPath, "utf-8");
        console.log(`[TailscaleAperture] Loaded config from ${configPath}`);
        return JSON.parse(content) as ApertureConfig;
      } catch (error) {
        console.warn(`[TailscaleAperture] Failed to read ${configPath}:`, error);
      }
    }
  }

  return {};
}

export const TailscaleAperturePlugin: Plugin = async (_ctx, options) => {
  const fileConfig = loadApertureConfig();
  const rawBaseUrl = (options?.baseUrl as string) || process.env.APERTURE_BASE_URL || fileConfig.baseUrl;
  const apiKey = (options?.apiKey as string) || process.env.APERTURE_API_KEY || fileConfig.apiKey || "";

  if (!rawBaseUrl) {
    console.warn("[TailscaleAperture] No baseUrl configured. Set APERTURE_BASE_URL, add baseUrl to plugin options, or create aperture.json in opencode config directory.");
    return {};
  }

  const baseUrl = normalizeBaseUrl(rawBaseUrl);
  let discoveredModels: ApertureModel[] = [];

  try {
    discoveredModels = await fetchApertureModels(baseUrl);
    if (discoveredModels.length === 0) {
      console.warn("[TailscaleAperture] No models found");
    } else {
      console.log(`[TailscaleAperture] Discovered ${discoveredModels.length} models from ${baseUrl}`);
    }
  } catch (error) {
    console.warn("[TailscaleAperture] Failed to preload models:", error);
  }

  return {
    config: async (config: any) => {
      try {
        config.provider ??= {};

        if (discoveredModels.length === 0) {
          return;
        }

        const existingProvider = config.provider.aperture ?? {};
        config.provider.aperture = {
          ...existingProvider,
          npm: existingProvider.npm ?? "@ai-sdk/openai-compatible",
          name: existingProvider.name ?? "Tailscale Aperture",
          options: {
            ...existingProvider.options,
            baseURL: `${baseUrl}/v1`,
            apiKey: existingProvider.options?.apiKey ?? apiKey,
          },
          models: {
            ...existingProvider.models,
          },
        };

        // Add discovered models while preserving explicit user overrides.
        for (const model of discoveredModels) {
          const existingModel = config.provider.aperture.models[model.id] ?? {};
          const defaults = getModelDefaults(model);
          config.provider.aperture.models[model.id] = {
            ...defaults,
            ...existingModel,
            id: model.id,
            name: existingModel.name ?? model.id,
          };
        }

        console.log(`[TailscaleAperture] Registered ${discoveredModels.length} models`);
      } catch (error) {
        console.error("[TailscaleAperture] Failed to register models:", error);
      }
    },

    tool: {
      list_aperture_models: tool({
        description: "List available models from Tailscale Aperture",
        args: {},
        async execute() {
          try {
            const models = await fetchApertureModels(baseUrl);
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
        },
        async execute(args) {
          try {
            const models = await fetchApertureModels(baseUrl);
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
