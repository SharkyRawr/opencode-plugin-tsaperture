![NPM Version](https://img.shields.io/npm/v/opencode-plugin-tsaperture)

# OpenCode Tailscale Aperture Plugin

Automatically populate models from Tailscale Aperture.

## Configuration

Configure the Aperture base URL using one of these methods (in order of precedence):

### 1. Plugin Options (opencode.json)

```json
{
  "plugins": [
    ["opencode-plugin-tsaperture"]
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

The plugin reads Aperture provider compatibility metadata and registers each provider with the matching OpenCode provider package. It supports both OpenAI-compatible chat providers and Anthropic Messages API providers, including Aperture routes where the same model is only available through one API flavor.

### Models.dev enrichment

The plugin enriches Aperture's `/v1/models` response with the same Models.dev catalog OpenCode uses. When a discovered model matches a catalog provider/model ID, the generated OpenCode config includes the catalog's family, release date, cost, modalities, reasoning/tool/temperature support, interleaved reasoning field, variants, and accurate `limit.context`, `limit.input`, and `limit.output` values.

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

Once configured, models will be available via the plugin tools:

- `/list_aperture_models` - List available models from Aperture
- `/get_aperture_model modelId=<id>` - Get model details
