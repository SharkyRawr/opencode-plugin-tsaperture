![NPM Version](https://img.shields.io/npm/v/opencode-plugin-tsaperture)

# OpenCode Tailscale Aperture Plugin

Automatically populate models from Tailscale Aperture.

## OpenCode compatibility

The same package supports OpenCode v1 (1.4.0 or newer) and the new v2
plugin API. The default export provides v1 `server` and v2 `setup` entry
points; direct callers can still import the named `TailscaleAperturePlugin`
function for v1. The v2 adapter targets the API shipped in
`@opencode/plugin` 2.0.5.

Both entry points share model discovery, provider grouping, protocol selection,
and Models.dev enrichment. V2 registers replayable provider transforms and maps
limits, modalities, costs, release dates, and reasoning variants to its model
schema. Existing catalog settings take precedence over discovery defaults.
Effort variants use each protocol's wire format; they are not generated for
Bedrock or custom SDKs, which have no common effort parameter.

The two model lookup tools remain v1-only and v2 diagnostics go to stderr.
OpenCode v2 supplies project, session, and client headers to model requests.
V2's model schema also has no
equivalent for v1's reasoning, temperature, attachment, or interleaved flags;
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

`apiKey` is optional. Set it when your Aperture endpoint requires bearer auth. If omitted, the plugin passes an empty key to the generated providers.

### API compatibility

The plugin reads Aperture provider compatibility metadata and registers each provider with the matching OpenCode provider package and endpoint. It supports OpenAI Responses and Chat Completions, Anthropic Messages, Google Vertex, Amazon Bedrock, and Gemini Generate Content routes.

### Models.dev enrichment

The plugin enriches Aperture's `/v1/models` response with the same Models.dev catalog OpenCode uses. When a discovered model matches a catalog provider/model ID, the generated OpenCode config includes the catalog's family, release date, cost, modalities, reasoning/tool/temperature support, interleaved reasoning field, variants, and accurate `limit.context`, `limit.input`, and `limit.output` values.

**Important:** For full provider-specific feature support, the Aperture provider `id` and model `id` should match the Models.dev respective IDs. Provider IDs with an `-x-` suffix use the base ID for Models.dev lookup, so `opencode-go-x-anthropic` and `opencode-go-x-responses` both use the `opencode-go` catalog entry while retaining their separate API compatibility and SDK configuration.

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
