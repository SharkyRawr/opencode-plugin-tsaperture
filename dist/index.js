import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";
import { tool } from "@opencode-ai/plugin";
const STARTUP_MODEL_STABILIZATION_DEADLINE_MS = 4_000;
const STARTUP_FETCH_TIMEOUT_MS = 2_000;
const STARTUP_POLL_INTERVAL_MS = 250;
const STARTUP_MIN_FETCH_TIMEOUT_MS = 750;
const INTERACTIVE_FETCH_TIMEOUT_MS = 5_000;
const MODELS_DEV_FETCH_TIMEOUT_MS = 3_000;
function normalizeBaseUrl(baseUrl) {
    return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}
function slugifyProviderSegment(value) {
    const normalized = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return normalized || "default";
}
function getProviderDisplayName(providerID) {
    const slug = slugifyProviderSegment(providerID);
    return providerID.trim() || slug;
}
function normalizeModelLookup(value) {
    return value
        .trim()
        .toLowerCase()
        .replace(/[_:\s.]+/g, "-")
        .replace(/\/+/g, "/")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "");
}
function stripLookupTag(value) {
    const tagIndex = value.indexOf(":", value.lastIndexOf("/") + 1);
    return tagIndex === -1 ? value : value.slice(0, tagIndex);
}
function findProviderModel(provider, modelKeys) {
    for (const key of modelKeys) {
        const candidate = provider.models[key];
        if (candidate) {
            return candidate;
        }
    }
    return undefined;
}
function findModelsDevEntry(model, catalog, apertureProvider) {
    if (!catalog) {
        return undefined;
    }
    const untaggedModelID = stripLookupTag(model.id);
    const modelKeys = new Set([
        model.id,
        model.id.toLowerCase(),
        untaggedModelID,
        untaggedModelID.toLowerCase(),
        normalizeModelLookup(untaggedModelID),
        normalizeModelLookup(model.id),
    ]);
    const apertureProviderID = apertureProvider?.id ?? model.metadata?.provider?.id;
    const modelsDevProviderID = apertureProviderID?.split("-x-", 1)[0];
    const untaggedProviderID = modelsDevProviderID
        ? stripLookupTag(modelsDevProviderID)
        : undefined;
    const provider = modelsDevProviderID
        ? (catalog[modelsDevProviderID] ??
            catalog[modelsDevProviderID.toLowerCase()] ??
            (untaggedProviderID
                ? (catalog[untaggedProviderID] ??
                    catalog[untaggedProviderID.toLowerCase()])
                : undefined))
        : undefined;
    if (provider) {
        const candidate = findProviderModel(provider, modelKeys);
        if (candidate) {
            return { provider, model: candidate };
        }
    }
    const exactMatches = [];
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
function getApertureProtocol(compatibility) {
    if (compatibility?.openai_responses)
        return "openai_responses";
    if (compatibility?.anthropic_messages)
        return "anthropic_messages";
    if (compatibility?.openai_chat)
        return "openai_chat";
    if (compatibility?.google_generate_content ||
        compatibility?.google_raw_predict)
        return "google_vertex";
    if (compatibility?.bedrock_model_invoke || compatibility?.bedrock_converse)
        return "bedrock";
    if (compatibility?.gemini_generate_content)
        return "gemini_generate_content";
    return "openai_chat";
}
function getProviderGroup(model, providers) {
    const providerID = model.metadata?.provider?.id?.trim();
    const providerName = model.metadata?.provider?.name?.trim();
    const providerSegment = providerName || providerID;
    const routeProviderID = providerID || providerName;
    if (!providerSegment || !routeProviderID) {
        return {
            id: "aperture",
            name: "Aperture",
            protocol: "openai_chat",
        };
    }
    const protocol = getApertureProtocol(providers?.get(routeProviderID)?.compatibility);
    return {
        id: `aperture-${slugifyProviderSegment(providerSegment)}`,
        name: `Aperture/${providerName || getProviderDisplayName(providerSegment)}`,
        routeProviderID,
        protocol,
    };
}
function getModelProviderKey(model, providers) {
    const group = getProviderGroup(model, providers);
    return `${group.id}:${group.protocol}:${model.id}`;
}
function getApertureRouteModelID(model, providers) {
    const routeProviderID = getProviderGroup(model, providers).routeProviderID;
    return routeProviderID ? `${routeProviderID}/${model.id}` : model.id;
}
function requiresOpenCodeSessionHeader(routeProviderID) {
    const providerID = routeProviderID?.split("-x-", 1)[0].toLowerCase();
    return providerID === "opencode" || providerID === "opencode-go";
}
function getProviderSDKConfig(protocol, baseUrl, apiKey) {
    const key = apiKey || "not-required";
    switch (protocol) {
        case "openai_responses":
            return {
                npm: "@ai-sdk/openai",
                options: { baseURL: `${baseUrl}/v1`, apiKey: key },
            };
        case "anthropic_messages":
            return {
                npm: "@ai-sdk/anthropic",
                options: { baseURL: `${baseUrl}/v1`, apiKey: key },
            };
        case "openai_chat":
            return {
                npm: "@ai-sdk/openai-compatible",
                options: { baseURL: `${baseUrl}/v1`, apiKey: key },
            };
        case "google_vertex":
            // apiKey selects Vertex express mode; Aperture rewrites the placeholder project and region.
            return {
                npm: "@ai-sdk/google-vertex",
                options: {
                    baseURL: `${baseUrl}/v1/projects/_aperture_auto_vertex_project_id_/locations/_aperture_auto_vertex_region_/publishers/google`,
                    apiKey: key,
                },
            };
        case "bedrock":
            // Generated provider IDs bypass OpenCode's built-in Bedrock loader, so configure the SDK directly.
            return {
                npm: "@ai-sdk/amazon-bedrock",
                options: apiKey
                    ? { baseURL: `${baseUrl}/bedrock`, region: "us-east-1", apiKey }
                    : {
                        baseURL: `${baseUrl}/bedrock`,
                        region: "us-east-1",
                        accessKeyId: "not-needed",
                        secretAccessKey: "not-needed",
                    },
            };
        case "gemini_generate_content":
            return {
                npm: "@ai-sdk/google",
                options: { baseURL: `${baseUrl}/v1beta`, apiKey: key },
            };
    }
}
function getCatalogReasoningVariants(model) {
    const effort = model.reasoning_options?.find((option) => option.type === "effort");
    const values = effort?.values
        ?.map((value) => value.trim())
        .filter((value) => value.length > 0);
    if (!values || values.length === 0) {
        return undefined;
    }
    return Object.fromEntries(values.map((value) => [value, { reasoningEffort: value }]));
}
function getModelsDevDefaults(entry) {
    const defaults = {
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
    const variants = getCatalogReasoningVariants(entry.model);
    if (variants) {
        defaults.variants = variants;
    }
    return Object.fromEntries(Object.entries(defaults).filter(([, value]) => value !== undefined));
}
function getModelDefaults(model, catalog, providers) {
    const routeProviderID = getProviderGroup(model, providers).routeProviderID;
    const apertureProvider = routeProviderID
        ? providers?.get(routeProviderID)
        : undefined;
    const modelsDevEntry = findModelsDevEntry(model, catalog, apertureProvider);
    if (modelsDevEntry) {
        return {
            defaults: getModelsDevDefaults(modelsDevEntry),
            matchedModelsDev: true,
        };
    }
    return {
        defaults: {
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
        },
        matchedModelsDev: false,
    };
}
// ponytail: defaults never set options/headers, so only limit/modalities/cost/interleaved need merging
function mergeModelConfig(defaults, existing = {}) {
    const limit = defaults.limit || existing.limit
        ? {
            context: existing.limit?.context ?? defaults.limit?.context ?? 0,
            input: existing.limit?.input ?? defaults.limit?.input,
            output: existing.limit?.output ?? defaults.limit?.output ?? 0,
        }
        : undefined;
    const modalities = defaults.modalities || existing.modalities
        ? {
            input: existing.modalities?.input ??
                defaults.modalities?.input ?? ["text"],
            output: existing.modalities?.output ??
                defaults.modalities?.output ?? ["text"],
        }
        : undefined;
    const cost = defaults.cost || existing.cost
        ? {
            ...defaults.cost,
            ...existing.cost,
            ...(defaults.cost?.context_over_200k ||
                existing.cost?.context_over_200k
                ? {
                    context_over_200k: {
                        ...defaults.cost?.context_over_200k,
                        ...existing.cost?.context_over_200k,
                    },
                }
                : {}),
        }
        : undefined;
    return {
        ...defaults,
        ...existing,
        ...(limit ? { limit } : {}),
        ...(cost ? { cost } : {}),
        ...(modalities ? { modalities } : {}),
        ...(defaults.interleaved || existing.interleaved
            ? {
                interleaved: existing.interleaved ?? defaults.interleaved,
            }
            : {}),
        ...(defaults.variants || existing.variants
            ? {
                variants: {
                    ...defaults.variants,
                    ...existing.variants,
                },
            }
            : {}),
    };
}
/**
 * Poll the models endpoint until the set of model IDs stabilizes (two
 * consecutive fetches return the same IDs) or the deadline is exceeded.
 * Transient fetch errors are retried within the deadline.
 */
async function waitForStableModels(baseUrl, apiKey, logger, { pollIntervalMs = STARTUP_POLL_INTERVAL_MS, deadlineMs = STARTUP_MODEL_STABILIZATION_DEADLINE_MS, fetchTimeoutMs = STARTUP_FETCH_TIMEOUT_MS, minFetchTimeoutMs = STARTUP_MIN_FETCH_TIMEOUT_MS, previousModels = [], previousProviders = new Map(), } = {}) {
    const deadline = Date.now() + deadlineMs;
    let previousIds = previousModels.length > 0
        ? previousModels
            .map((model) => getModelProviderKey(model, previousProviders))
            .sort()
            .join("\n")
        : undefined;
    let lastGoodResult = previousModels;
    let lastGoodProviders = previousProviders;
    let lastGoodProvidersDegraded = false;
    let sawSuccessfulFetch = previousModels.length > 0;
    let lastError;
    while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        if (remaining < minFetchTimeoutMs && lastGoodResult.length > 0) {
            return {
                models: lastGoodResult,
                providers: lastGoodProviders,
                providersDegraded: lastGoodProvidersDegraded,
            };
        }
        try {
            const providerResult = await fetchApertureProviders(baseUrl, apiKey, logger, Math.min(remaining, fetchTimeoutMs));
            const providers = providerResult.providers;
            const models = await fetchApertureModels(baseUrl, apiKey, logger, Math.min(remaining, fetchTimeoutMs), providers);
            const ids = models
                .map((model) => getModelProviderKey(model, providers))
                .sort()
                .join("\n");
            lastGoodResult = models;
            lastGoodProviders = providers;
            lastGoodProvidersDegraded = providerResult.degraded;
            sawSuccessfulFetch = true;
            if (ids === previousIds) {
                return {
                    models,
                    providers,
                    providersDegraded: providerResult.degraded,
                };
            }
            previousIds = ids;
        }
        catch (error) {
            lastError = error;
            // Transient error — retry until deadline.
        }
        if (Date.now() + pollIntervalMs >= deadline && lastGoodResult.length > 0) {
            return {
                models: lastGoodResult,
                providers: lastGoodProviders,
                providersDegraded: lastGoodProvidersDegraded,
            };
        }
        await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    if (!sawSuccessfulFetch && lastError) {
        throw lastError;
    }
    return {
        models: lastGoodResult,
        providers: lastGoodProviders,
        providersDegraded: lastGoodProvidersDegraded,
    };
}
async function fetchApertureProviders(baseUrl, apiKey, logger, timeoutMs = INTERACTIVE_FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const url = `${baseUrl}/api/providers`;
    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: apiKey
                ? {
                    Authorization: `Bearer ${apiKey}`,
                }
                : undefined,
        });
        if (!response.ok) {
            logger.warn(`[TailscaleAperture] Aperture API request failed: GET /api/providers ${response.status} ${response.statusText}`);
            return { providers: new Map(), degraded: true };
        }
        const providers = (await response.json());
        return {
            providers: new Map(providers.map((provider) => [provider.id, provider])),
            degraded: false,
        };
    }
    catch (error) {
        logger.warn("[TailscaleAperture] Aperture API request failed: GET /api/providers", error);
        return { providers: new Map(), degraded: true };
    }
    finally {
        clearTimeout(timer);
    }
}
async function fetchApertureModels(baseUrl, apiKey, logger, timeoutMs = INTERACTIVE_FETCH_TIMEOUT_MS, providers = new Map()) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const url = `${baseUrl}/v1/models`;
    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: apiKey
                ? {
                    Authorization: `Bearer ${apiKey}`,
                }
                : undefined,
        });
        if (!response.ok) {
            logger.warn(`[TailscaleAperture] Aperture API request failed: GET /v1/models ${response.status} ${response.statusText}`);
            throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
        }
        const data = (await response.json());
        return Array.from(new Map((data.data ?? [])
            .filter((model) => model.id)
            .map((model) => [getModelProviderKey(model, providers), model])).values());
    }
    catch (error) {
        if (!(error instanceof Error &&
            error.message.startsWith("Failed to fetch models:"))) {
            logger.warn("[TailscaleAperture] Aperture API request failed: GET /v1/models", error);
        }
        throw error;
    }
    finally {
        clearTimeout(timer);
    }
}
async function readModelsDevCatalog(path, logger) {
    try {
        const content = await readFile(path, "utf-8");
        return JSON.parse(content);
    }
    catch (error) {
        logger.warn(`[TailscaleAperture] Failed to read Models.dev catalog from ${path}:`, error);
        return undefined;
    }
}
async function fetchModelsDevCatalog(url, logger, timeoutMs = MODELS_DEV_FETCH_TIMEOUT_MS) {
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
        return (await response.json());
    }
    catch (error) {
        logger.warn("[TailscaleAperture] Models.dev request failed: GET /api.json", error);
        return undefined;
    }
    finally {
        clearTimeout(timer);
    }
}
async function loadModelsDevCatalog(config, logger) {
    if (config.disableModelsDev || process.env.OPENCODE_DISABLE_MODELS_FETCH) {
        logger.info("[TailscaleAperture] Models.dev enrichment disabled");
        return undefined;
    }
    const path = config.modelsDevPath || process.env.OPENCODE_MODELS_PATH;
    if (path) {
        return readModelsDevCatalog(path, logger);
    }
    const url = config.modelsDevUrl ||
        process.env.OPENCODE_MODELS_URL ||
        "https://models.dev";
    return fetchModelsDevCatalog(url, logger);
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
async function loadApertureConfig(logger) {
    for (const configDir of getOpenCodeConfigDirs()) {
        const configPath = join(configDir, "aperture.json");
        try {
            const content = await readFile(configPath, "utf-8");
            logger.info(`[TailscaleAperture] Loaded config from ${configPath}`);
            return JSON.parse(content);
        }
        catch (error) {
            if (error.code !== "ENOENT") {
                logger.warn(`[TailscaleAperture] Failed to read ${configPath}:`, error);
            }
        }
    }
    return {};
}
export const TailscaleAperturePlugin = async (input, options) => {
    const client = input.client;
    function writeLog(level, message, args) {
        client.app
            .log({
            body: {
                service: "TailscaleAperture",
                level,
                message,
                extra: args.length > 0
                    ? {
                        args: args.map((a) => a instanceof Error ? a.stack || a.message : String(a)),
                    }
                    : undefined,
            },
        })
            .catch(() => { });
    }
    const logger = {
        info: (message, ...args) => writeLog("info", message, args),
        warn: (message, ...args) => writeLog("warn", message, args),
        error: (message, ...args) => writeLog("error", message, args),
        debug: (message, ...args) => writeLog("debug", message, args),
    };
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json");
    logger.info(`[TailscaleAperture] ${pkg.name} v${pkg.version}`);
    const pendingToasts = [];
    let tuiReady = false;
    async function flushToasts() {
        if (!tuiReady) {
            return;
        }
        while (true) {
            const toast = pendingToasts.shift();
            if (!toast) {
                break;
            }
            try {
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
                    logger.warn(`[TailscaleAperture] Failed to show opencode toast: ${JSON.stringify(result.error)}`);
                }
            }
            catch (error) {
                logger.warn("[TailscaleAperture] Failed to show opencode toast:", error);
            }
        }
    }
    function showMessage(variant, message) {
        pendingToasts.push({ variant, message });
        void flushToasts();
    }
    function markTuiReady() {
        tuiReady = true;
        void flushToasts();
    }
    return createApertureHooks(options, logger, showMessage, markTuiReady);
};
async function createApertureHooks(options, logger, showMessage = () => { }, markTuiReady = () => { }) {
    const fileConfig = await loadApertureConfig(logger);
    const rawBaseUrl = options?.baseUrl ||
        process.env.APERTURE_BASE_URL ||
        fileConfig.baseUrl;
    const apiKey = options?.apiKey ||
        process.env.APERTURE_API_KEY ||
        fileConfig.apiKey ||
        "";
    const openCodeClient = process.env.OPENCODE_CLIENT || "cli";
    const modelsDevConfig = {
        ...fileConfig,
        modelsDevUrl: options?.modelsDevUrl ?? fileConfig.modelsDevUrl,
        modelsDevPath: options?.modelsDevPath ??
            fileConfig.modelsDevPath,
        disableModelsDev: options?.disableModelsDev ??
            fileConfig.disableModelsDev,
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
    let discoveredModels = [];
    let discoveredProviders = new Map();
    let providerMetadataDegraded = false;
    let providerMetadataWarningShown = false;
    let modelsDevCatalog;
    let modelsLoaded = false;
    let modelLoadPromise;
    const warnedModelsDevFallbacks = new Set();
    const openCodeSessionProviderIDs = new Set();
    function formatError(error) {
        return error instanceof Error ? error.message : String(error);
    }
    function formatDuration(ms) {
        return ms === undefined ? "unknown" : `${ms}ms`;
    }
    function warnProviderMetadataDegraded() {
        if (!providerMetadataDegraded || providerMetadataWarningShown) {
            return;
        }
        providerMetadataWarningShown = true;
        const message = "Aperture provider metadata could not be loaded. Models were registered in degraded mode; provider grouping or wire API selection may be less accurate.";
        logger.warn(`[TailscaleAperture] ${message}`);
        showMessage("error", message);
    }
    async function loadModels(refresh = false) {
        if (!refresh && modelsLoaded) {
            return discoveredModels;
        }
        if (refresh && modelsLoaded) {
            // Interactive refresh: single fetch, no stabilization wait.
            const providerResult = await fetchApertureProviders(baseUrl, apiKey, logger);
            discoveredProviders = providerResult.providers;
            providerMetadataDegraded = providerResult.degraded;
            discoveredModels = await fetchApertureModels(baseUrl, apiKey, logger, INTERACTIVE_FETCH_TIMEOUT_MS, discoveredProviders);
            warnProviderMetadataDegraded();
            return discoveredModels;
        }
        if (!refresh && modelLoadPromise) {
            return modelLoadPromise;
        }
        modelLoadPromise = waitForStableModels(baseUrl, apiKey, logger, {
            previousModels: discoveredModels,
            previousProviders: discoveredProviders,
        })
            .then((result) => {
            discoveredModels = result.models;
            discoveredProviders = result.providers;
            providerMetadataDegraded = result.providersDegraded;
            modelsLoaded = true;
            warnProviderMetadataDegraded();
            return discoveredModels;
        })
            .finally(() => {
            modelLoadPromise = undefined;
        });
        return modelLoadPromise;
    }
    function mutateConfig(config) {
        config.provider ??= {};
        openCodeSessionProviderIDs.clear();
        if (discoveredModels.length === 0) {
            return 0;
        }
        const hadBaseProvider = Object.hasOwn(config.provider, "aperture");
        const baseProvider = config.provider.aperture ?? {};
        const modelsByProvider = new Map();
        for (const model of discoveredModels) {
            const group = getProviderGroup(model, discoveredProviders);
            const existingGroup = modelsByProvider.get(group.id);
            if (existingGroup) {
                existingGroup.models.push(model);
            }
            else {
                modelsByProvider.set(group.id, {
                    group,
                    models: [model],
                });
            }
        }
        for (const { group, models } of modelsByProvider.values()) {
            if (requiresOpenCodeSessionHeader(group.routeProviderID)) {
                openCodeSessionProviderIDs.add(group.id);
            }
            const existingProvider = config.provider[group.id] ?? {};
            const modelsObj = {
                ...(existingProvider.models ??
                    {}),
            };
            const configuredApiKey = existingProvider.options?.apiKey ??
                baseProvider.options?.apiKey ??
                apiKey;
            const sdk = getProviderSDKConfig(group.protocol, baseUrl, typeof configuredApiKey === "string" ? configuredApiKey : apiKey);
            config.provider[group.id] = {
                ...baseProvider,
                ...existingProvider,
                npm: existingProvider.npm ??
                    (group.protocol === "openai_chat" ||
                        group.protocol === "openai_responses"
                        ? baseProvider.npm
                        : undefined) ??
                    sdk.npm,
                name: existingProvider.name ?? group.name,
                options: {
                    ...baseProvider.options,
                    ...existingProvider.options,
                    ...sdk.options,
                },
                models: modelsObj,
            };
            for (const model of models) {
                const existingModel = modelsObj[model.id] ?? {};
                const routeModelID = getApertureRouteModelID(model, discoveredProviders);
                const modelDefaults = getModelDefaults(model, modelsDevCatalog, discoveredProviders);
                if (!modelDefaults.matchedModelsDev &&
                    !warnedModelsDevFallbacks.has(routeModelID)) {
                    warnedModelsDevFallbacks.add(routeModelID);
                    logger.warn(`[TailscaleAperture] Model ${routeModelID} could not be matched to Models.dev specs; using conservative defaults`);
                }
                modelsObj[model.id] = {
                    ...mergeModelConfig(modelDefaults.defaults, existingModel),
                    id: existingModel.id ?? routeModelID,
                    name: existingModel.name ?? model.id,
                };
            }
        }
        for (const providerID of Object.keys(config.provider)) {
            if (providerID.startsWith("aperture-") &&
                !modelsByProvider.has(providerID)) {
                delete config.provider[providerID];
            }
        }
        const hasDefaultGroup = modelsByProvider.has("aperture");
        if (!hasDefaultGroup && !hadBaseProvider) {
            delete config.provider.aperture;
        }
        return modelsByProvider.size;
    }
    function countProviderGroups(models) {
        return new Set(models.map((model) => getProviderGroup(model, discoveredProviders).id)).size;
    }
    async function loadModelsOnStartup() {
        try {
            discoveredModels = await loadModels(false);
            if (discoveredModels.length === 0) {
                logger.warn("[TailscaleAperture] No models found");
                showMessage("warning", `No Aperture models found at ${baseUrl}`);
                return discoveredModels;
            }
            logger.info(`[TailscaleAperture] Discovered ${discoveredModels.length} models from ${baseUrl}`);
            const providerGroupCount = countProviderGroups(discoveredModels);
            logger.info(`[TailscaleAperture] Registered ${providerGroupCount} Aperture provider groups for ${discoveredModels.length} discovered models`);
            showMessage("success", `Registered ${discoveredModels.length} Aperture models across ${providerGroupCount} provider groups`);
            return discoveredModels;
        }
        catch (error) {
            const errmsg = formatError(error);
            logger.error("[TailscaleAperture] Failed to register models:", error);
            showMessage("error", errmsg);
            throw error;
        }
    }
    const startupStartedAt = Date.now();
    let startupModelsDurationMs;
    let startupModelsDevDurationMs;
    const startupModels = (async () => {
        const startedAt = Date.now();
        try {
            return await loadModelsOnStartup();
        }
        finally {
            startupModelsDurationMs = Date.now() - startedAt;
            logger.info(`[TailscaleAperture] Startup step Aperture model discovery finished in ${formatDuration(startupModelsDurationMs)}`);
        }
    })();
    // Discovery may reject before the config hook starts awaiting it.
    // Keep the original promise so the hook still receives the failure.
    void startupModels.catch(() => { });
    const startupModelsDevCatalog = (async () => {
        const startedAt = Date.now();
        try {
            const catalog = await loadModelsDevCatalog(modelsDevConfig, logger);
            modelsDevCatalog = catalog;
            if (catalog) {
                logger.info(`[TailscaleAperture] Loaded Models.dev catalog with ${Object.keys(catalog).length} providers`);
            }
            return catalog;
        }
        finally {
            startupModelsDevDurationMs = Date.now() - startedAt;
            logger.info(`[TailscaleAperture] Startup step Models.dev catalog load finished in ${formatDuration(startupModelsDevDurationMs)}`);
        }
    })();
    return {
        config: async (config) => {
            const configWaitStartedAt = Date.now();
            try {
                await Promise.all([startupModels, startupModelsDevCatalog]);
                const configWaitDurationMs = Date.now() - configWaitStartedAt;
                const startupDurationMs = Date.now() - startupStartedAt;
                logger.info(`[TailscaleAperture] Startup finished in ${formatDuration(startupDurationMs)} (Aperture models: ${formatDuration(startupModelsDurationMs)}, Models.dev catalog: ${formatDuration(startupModelsDevDurationMs)}, config wait: ${formatDuration(configWaitDurationMs)})`);
                mutateConfig(config);
            }
            catch (error) {
                logger.error("[TailscaleAperture] Failed to register models:", error);
                showMessage("error", formatError(error));
            }
            finally {
                markTuiReady();
            }
        },
        event: async ({ event }) => {
            if (event.type === "server.connected") {
                markTuiReady();
            }
        },
        "chat.headers": async ({ sessionID, model, message }, output) => {
            if (openCodeSessionProviderIDs.has(model.providerID)) {
                output.headers["x-opencode-session"] = sessionID;
                output.headers["x-opencode-request"] = message.id;
                output.headers["x-opencode-client"] = openCodeClient;
            }
        },
        tool: {
            list_aperture_models: tool({
                description: "List available models from Tailscale Aperture",
                args: {
                    refresh: tool.schema
                        .boolean()
                        .optional()
                        .describe("Refresh the cached Aperture model list before returning it"),
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
                    refresh: tool.schema
                        .boolean()
                        .optional()
                        .describe("Refresh the cached Aperture model list before looking up the model"),
                },
                async execute(args) {
                    try {
                        const models = await loadModels(args.refresh ?? false);
                        const model = models.find((m) => m.id === args.modelId);
                        if (!model) {
                            return JSON.stringify({
                                error: `Model ${args.modelId} not found`,
                            });
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
}
export default {
    id: "opencode-plugin-tsaperture",
    server: TailscaleAperturePlugin,
    async setup(context) {
        // The v2 promise API has no logging client or toast/tool registration hooks.
        const logger = {
            info: (message, ...args) => console.error(message, ...args),
            warn: (message, ...args) => console.error(message, ...args),
            error: (message, ...args) => console.error(message, ...args),
            debug: () => { },
        };
        const hooks = await createApertureHooks(context.options, logger);
        const config = {};
        await hooks.config?.(config);
        await context.catalog.transform((catalog) => {
            for (const [providerID, provider] of Object.entries(config.provider ?? {})) {
                const { baseURL, ...settings } = provider.options ?? {};
                catalog.provider.update(providerID, (draft) => {
                    if (draft.name === providerID)
                        draft.name = provider.name ?? draft.name;
                    draft.api = {
                        type: "aisdk",
                        package: draft.api.type === "aisdk"
                            ? draft.api.package
                            : (provider.npm ?? "@ai-sdk/openai-compatible"),
                        url: draft.api.url ??
                            (typeof baseURL === "string" ? baseURL : undefined),
                        settings: { ...settings, ...draft.api.settings },
                    };
                });
                for (const [modelID, model] of Object.entries(provider.models ?? {})) {
                    applyV2Model(catalog, providerID, modelID, model);
                }
            }
        });
        await context.aisdk.language((event) => {
            const provider = config.provider?.[event.model.providerID];
            if (!provider ||
                !requiresOpenCodeSessionHeader(event.model.api.id.split("/", 1)[0]))
                return;
            const language = event.language ?? event.sdk.languageModel(event.model.api.id);
            // Read session context per call: language instances are cached across sessions.
            const headers = (input = {}) => {
                const sessionID = Object.entries(input).find(([key]) => key.toLowerCase() === "x-session-id")?.[1];
                // The v2 request has no user-message ID, so keep any supplied request header.
                return {
                    ...(sessionID ? { "x-opencode-session": sessionID } : {}),
                    "x-opencode-client": process.env.OPENCODE_CLIENT || "cli",
                    ...input,
                };
            };
            event.language = {
                specificationVersion: language.specificationVersion,
                provider: language.provider,
                modelId: language.modelId,
                supportedUrls: language.supportedUrls,
                doGenerate: (options) => language.doGenerate({
                    ...options,
                    headers: headers(options.headers),
                }),
                doStream: (options) => language.doStream({ ...options, headers: headers(options.headers) }),
            };
        });
        // Async discovery can finish after the host's initial catalog batch has flushed.
        await context.catalog.reload();
    },
};
function applyV2Model(catalog, providerID, modelID, config) {
    catalog.model.update(providerID, modelID, (model) => {
        // V2 drafts include empty defaults; fill these while retaining authored overrides.
        if (model.api.id === modelID)
            model.api.id = config.id ?? modelID;
        if (model.name === modelID)
            model.name = config.name ?? modelID;
        model.family ??= config.family;
        if (!model.capabilities.input.length && !model.capabilities.output.length) {
            model.capabilities = {
                tools: config.tool_call ?? true,
                input: config.modalities?.input ?? ["text"],
                output: config.modalities?.output ?? ["text"],
            };
        }
        model.limit = {
            context: model.limit.context || config.limit?.context || 128_000,
            input: model.limit.input ?? config.limit?.input,
            output: model.limit.output || config.limit?.output || 8_192,
        };
        if (model.status === "active")
            model.status = config.status ?? "active";
        if (model.status === "deprecated")
            model.enabled = false;
        model.time.released ||= Date.parse(config.release_date ?? "") || 0;
        const cost = config.cost;
        if (!model.cost.length)
            model.cost = [
                {
                    input: cost?.input ?? 0,
                    output: cost?.output ?? 0,
                    cache: { read: cost?.cache_read ?? 0, write: cost?.cache_write ?? 0 },
                },
                ...(cost?.context_over_200k
                    ? [
                        {
                            tier: { type: "context", size: 200_000 },
                            input: cost.context_over_200k.input,
                            output: cost.context_over_200k.output,
                            cache: {
                                read: cost.context_over_200k.cache_read ?? 0,
                                write: cost.context_over_200k.cache_write ?? 0,
                            },
                        },
                    ]
                    : []),
            ];
        const api = catalog.provider.get(providerID)?.provider.api;
        const existingVariants = new Set(model.variants.map((variant) => variant.id));
        model.variants.push(...Object.keys(config.variants ?? {})
            .filter((id) => !existingVariants.has(id))
            .flatMap((id) => {
            const body = getV2ReasoningBody(api?.type === "aisdk" ? api.package : undefined, id);
            return body ? [{ id, headers: {}, body }] : [];
        }));
    });
}
function getV2ReasoningBody(npm, effort) {
    // V2 request bodies use wire fields, unlike v1's AI SDK option names.
    switch (npm) {
        case "@ai-sdk/openai":
            return { reasoning: { effort } };
        case "@ai-sdk/openai-compatible":
            return { reasoning_effort: effort };
        case "@ai-sdk/anthropic":
            return { output_config: { effort } };
        case "@ai-sdk/google":
        case "@ai-sdk/google-vertex":
            return {
                generationConfig: { thinkingConfig: { thinkingLevel: effort } },
            };
        default:
            return undefined;
    }
}
//# sourceMappingURL=index.js.map