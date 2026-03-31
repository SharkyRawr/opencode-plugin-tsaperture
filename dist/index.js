import { tool } from "@opencode-ai/plugin";
import { homedir } from "os";
import { join } from "path";
import { readFile } from "fs/promises";
import { platform } from "process";
function normalizeBaseUrl(baseUrl) {
    return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}
function getModelDefaults(model) {
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
async function fetchApertureModels(baseUrl) {
    const response = await fetch(`${baseUrl}/v1/models`);
    if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    return data.data || [];
}
function getOpenCodeConfigDirs() {
    const home = homedir();
    const dirs = [];
    if (platform === "win32") {
        dirs.push(join(process.env.APPDATA || process.env.LOCALAPPDATA || home, "opencode"));
    }
    else if (platform === "darwin") {
        const xdgConfig = process.env.XDG_CONFIG_HOME;
        if (xdgConfig) {
            dirs.push(join(xdgConfig, "opencode"));
        }
        dirs.push(join(home, ".config", "opencode"));
        dirs.push(join(home, "Library", "Application Support", "opencode"));
    }
    else {
        const xdgConfig = process.env.XDG_CONFIG_HOME;
        if (xdgConfig) {
            dirs.push(join(xdgConfig, "opencode"));
        }
        dirs.push(join(home, ".config", "opencode"));
    }
    return dirs;
}
const openCodeConfigDirs = getOpenCodeConfigDirs();
async function loadApertureConfig() {
    for (const configDir of openCodeConfigDirs) {
        const configPath = join(configDir, "aperture.json");
        try {
            const content = await readFile(configPath, "utf-8");
            console.log(`[TailscaleAperture] Loaded config from ${configPath}`);
            return JSON.parse(content);
        }
        catch (error) {
            if (error.code !== "ENOENT") {
                console.warn(`[TailscaleAperture] Failed to read ${configPath}:`, error);
            }
        }
    }
    return {};
}
export const TailscaleAperturePlugin = async (_ctx, options) => {
    const fileConfig = await loadApertureConfig();
    const rawBaseUrl = options?.baseUrl || process.env.APERTURE_BASE_URL || fileConfig.baseUrl;
    const apiKey = options?.apiKey || process.env.APERTURE_API_KEY || fileConfig.apiKey || "";
    if (!rawBaseUrl) {
        console.warn("[TailscaleAperture] No baseUrl configured. Set APERTURE_BASE_URL, add baseUrl to plugin options, or create aperture.json in opencode config directory.");
        return {};
    }
    const baseUrl = normalizeBaseUrl(rawBaseUrl);
    let discoveredModels = [];
    let modelsLoaded = false;
    async function loadModels(refresh = false) {
        if (!refresh && modelsLoaded) {
            return discoveredModels;
        }
        discoveredModels = await fetchApertureModels(baseUrl);
        modelsLoaded = true;
        return discoveredModels;
    }
    try {
        discoveredModels = await loadModels(true);
        if (discoveredModels.length === 0) {
            console.warn("[TailscaleAperture] No models found");
        }
        else {
            console.log(`[TailscaleAperture] Discovered ${discoveredModels.length} models from ${baseUrl}`);
        }
    }
    catch (error) {
        console.warn("[TailscaleAperture] Failed to preload models:", error);
    }
    return {
        config: async (config) => {
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
                        limit: {
                            ...defaults.limit,
                            ...existingModel.limit,
                        },
                        modalities: {
                            ...defaults.modalities,
                            ...existingModel.modalities,
                        },
                        ...(defaults.interleaved || existingModel.interleaved ? {
                            interleaved: existingModel.interleaved ?? defaults.interleaved,
                        } : {}),
                        ...(defaults.options || existingModel.options ? {
                            options: {
                                ...defaults.options,
                                ...existingModel.options,
                                ...(defaults.options?.thinking || existingModel.options?.thinking ? {
                                    thinking: {
                                        ...defaults.options?.thinking,
                                        ...existingModel.options?.thinking,
                                    },
                                } : {}),
                            },
                        } : {}),
                        ...(defaults.headers || existingModel.headers ? {
                            headers: {
                                ...defaults.headers,
                                ...existingModel.headers,
                            },
                        } : {}),
                        id: model.id,
                        name: existingModel.name ?? model.id,
                    };
                }
                console.log(`[TailscaleAperture] Registered ${discoveredModels.length} models`);
            }
            catch (error) {
                console.error("[TailscaleAperture] Failed to register models:", error);
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
                    }
                    catch (error) {
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
                    }
                    catch (error) {
                        return JSON.stringify({ error: String(error) });
                    }
                },
            }),
        },
    };
};
export default TailscaleAperturePlugin;
//# sourceMappingURL=index.js.map