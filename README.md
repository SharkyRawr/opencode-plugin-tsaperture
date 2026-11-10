![NPM Version](https://img.shields.io/npm/v/opencode-plugin-tsaperture)

# OpenCode Tailscale Aperture Plugin

Automatically populate models from Tailscale Aperture.

## v0.5.4 release notes

- Updated dependencies, including `@opencode-ai/plugin` 1.19.5 and `@opencode/plugin` 2.2.6, and refreshed the Biome schema.
- Applied `pnpm audit --fix` overrides for `glob`, `minimatch`, `toml`, and `zod` to resolve dependency security advisories.

## v0.5.3 release notes

- Conflicting canonical model identities now remain unmatched even when one catalog entry belongs to the publisher, preventing incorrect capability and limit defaults.

## v0.5.2 release notes

- Custom Aperture providers can resolve Models.dev capabilities and reasoning efforts by model name and canonical identity, including case differences and publisher-prefixed model IDs.
- A discovered model such as `deepseek/deepseek-v4.1-flash-1017` can match the catalog while retaining its Aperture provider route, such as `vllm/deepseek/deepseek-v4.1-flash-1017`.
- Inferred publisher profiles omit publisher pricing and retirement status. Provider-specific matches and explicit model settings retain precedence.
- Added custom-provider matching and reasoning-variant coverage for OpenCode v1 and v2.

## v0.5.1 release notes

- Updated dependencies, including `@opencode-ai/plugin` 1.19.4 and `@opencode/plugin` 2.2.0.
- V2 now preserves the catalog's temperature-support capability and explicit overrides.
- Runtime checks load the package root through its exports, and CI now tests OpenCode CLI 2.2.0.

## v0.5.0 release notes

- Providers are now registered in OpenCode by ID rather than display name. You may need to favorite some models again after upgrading.
- Explicitly empty API keys now clear inherited credentials.
- Vertex generate-content and Anthropic raw-predict routes use separate adapters; raw-predict authentication uses the Aperture key without loading Google credentials.
- V2 reasoning variants follow the effective SDK, including configured overrides.
- Invalid Models.dev catalog entries are skipped with warnings while valid entries remain available.
- Updated dependencies, including `@opencode-ai/plugin` 1.19.0 and `@opencode/plugin` 2.0.29.

## OpenCode compatibility

The same package supports OpenCode v1 (1.4.0 or newer) and the new v2
plugin API. The default export provides v1 `server` and v2 `setup` entry
points; direct callers can still import the named `TailscaleAperturePlugin`
function for v1. The v2 adapter targets `@opencode/plugin` 2.2.6.
CI runs the runtime smoke test against the lockfile's OpenCode v1 binary
(currently 1.19.5) and OpenCode CLI v2.2.0. These checks verify plugin loading
and provider/model publication against a local mock Aperture endpoint; they
do not exercise upstream inference. The declared supported range is
OpenCode `^1.4.0 || ^2.0.0`; CI does not test every version in that range.

OpenCode 2.2 resolves local plugin directories through their `package.json`
exports. This package's root export supplies the server plugin; no separate
`server` export is required. The v2 runtime smoke test loads the package root
to exercise this resolution path.

Both entry points share model discovery, provider grouping, protocol selection,
and Models.dev enrichment. V2 registers replayable provider transforms and maps
limits, modalities, costs, release dates, and reasoning variants to its model
schema, including the temperature-support capability. Existing catalog settings
take precedence over discovery defaults.
Effort variants use each protocol's wire format; they are not generated for
Bedrock or custom SDKs, which have no common effort parameter.

The two model lookup tools remain v1-only and v2 diagnostics go to stderr.
OpenCode v2 supplies project, session, and client headers to model requests.
V2's model schema also has no
equivalent for v1's reasoning, attachment, or interleaved flags;
input modalities still describe supported attachments.

## Configuration

Configure the Aperture base URL using one of these methods (in order of precedence):

### 1. Plugin Options (opencode.json)

OpenCode v1:

```json
{
  "plugin": [
    ["opencode-plugin-tsaperture", { "baseUrl": "http://ai.my-tailnet.ts.net" }]
  ]
}
```

OpenCode v2:

```json
{
  "plugins": [
    {
      "package": "opencode-plugin-tsaperture",
      "options": { "baseUrl": "http://ai.my-tailnet.ts.net" }
    }
  ]
}
```

### 2. Environment Variable

```bash
export APERTURE_BASE_URL="http://ai.my-tailnet.ts.net"
```

### 3. Config File (aperture.json)

Create `aperture.json` in the opencode config directory:

**macOS:**
```bash
~/Library/Application\ Support/opencode/aperture.json
```

**Linux:**
```bash
~/.config/opencode/aperture.json
```

**Windows:**
```
%APPDATA%\opencode\aperture.json
```

Contents:
```json
{
  "baseUrl": "http://ai.my-tailnet.ts.net",
  "apiKey": ""
}
```

`apiKey` is optional. Set it when your Aperture endpoint requires bearer auth.
An explicitly empty plugin option or `APERTURE_API_KEY` clears inherited credentials.
SDKs that require a key receive a harmless placeholder when authentication is disabled.

### API compatibility

The plugin reads Aperture provider compatibility metadata and registers each provider with the matching OpenCode provider package and endpoint. It supports OpenAI Responses and Chat Completions, Anthropic Messages, Google Vertex, Amazon Bedrock, and Gemini Generate Content routes.

Vertex generate-content and Anthropic raw-predict routes use separate adapters.
Raw-predict authentication uses the Aperture key, without loading Google credentials.

Provider keys use `aperture-` followed by the URL-encoded Aperture route ID;
display names are labels only. This keeps routes distinct when names coincide.
You may need to favorite some models again after upgrading.

### Models.dev enrichment

The plugin enriches Aperture's `/v1/models` response with the same Models.dev catalog OpenCode uses. When a discovered model matches a catalog provider/model ID, the generated OpenCode config includes the catalog's family, release date, cost, modalities, reasoning/tool/temperature support, interleaved reasoning field, variants, and accurate `limit.context`, `limit.input`, and `limit.output` values.

Provider-specific matches take precedence. Provider IDs with an `-x-` suffix use the base ID for Models.dev lookup, so `opencode-go-x-anthropic` and `opencode-go-x-responses` both use the `opencode-go` catalog entry while retaining their separate API compatibility and SDK configuration.

Custom providers can also match by model name, including case differences and publisher-prefixed IDs. For example, `vllm/deepseek/deepseek-v4.1-flash-1017` keeps its vLLM route while resolving `deepseek/deepseek-v4.1-flash-1017` through the catalog. When several hosts list the model, the plugin uses `canonical_model_id` to find the publisher's model profile and reasoning efforts, preferring an active publisher alias. It does not copy that publisher's pricing or retirement status into the inferred model. Conflicting model identities remain unmatched, and explicit model settings still override inferred defaults. These capabilities describe the catalog model; the self-hosted server must support the advertised inputs and effort parameters.

Optional `aperture.json` fields:

```json
{
  "modelsDevUrl": "https://models.dev",
  "modelsDevPath": "/path/to/models-dev-api.json",
  "disableModelsDev": false
}
```

The plugin also honors OpenCode's `OPENCODE_MODELS_URL`, `OPENCODE_MODELS_PATH`, and `OPENCODE_DISABLE_MODELS_FETCH` environment variables.

## Usage

Once configured, Aperture models appear in the model picker. On v1, the
assistant can also call these plugin tools:

- `list_aperture_models` - List available models from Aperture
- `get_aperture_model` with `modelId` - Get model details
