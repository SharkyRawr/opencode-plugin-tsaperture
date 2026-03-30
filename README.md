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

`apiKey` is optional. Set it when your Aperture endpoint requires bearer auth. If omitted, the plugin passes an empty key to the OpenAI-compatible provider.

## Usage

Once configured, models will be available via the plugin tools:

- `/list_aperture_models` - List available models from Aperture
- `/get_aperture_model modelId=<id>` - Get model details
