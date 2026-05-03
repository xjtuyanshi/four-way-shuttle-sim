# Pixel Streaming Runbook

This repo keeps SimCore and the dashboard as the authoritative validation layer. Pixel Streaming is a presentation/runtime path for the Unreal visual twin.

## Current Local Contract

- Unreal Engine: 5.7.4 under `/Users/Shared/Epic Games/UE_5.7`.
- Generated project: `output/unreal/ShuttleVisualTwin/ShuttleVisualTwin.uproject`.
- Project plugin enabled today: `PixelStreaming`.
- UE 5.7 also includes `PixelStreaming2`, but the generated project currently targets the legacy `PixelStreaming` plugin because that is the plugin already validated by `pnpm unreal:smoke`.
- SimCore bridge URL remains `ws://localhost:8791/shuttle-ws` unless overridden on `AShuttleVisualTwinRuntimeActor`.

## Readiness Check

Run:

```bash
pnpm unreal:pixelstreaming:check
```

The check verifies:

- UE editor executable is present.
- Generated Unreal project exists.
- Enabled project plugins.
- Pixel Streaming plugin directories.
- Official UE `get_ps_servers.sh` downloader location.
- Whether `SignallingWebServer` infrastructure has already been fetched.

It does not download or run anything.

## Infrastructure Download Gate

Pixel Streaming needs Epic's Pixel Streaming Infrastructure web server assets before browser streaming can be tested. On this Mac, the selected downloader is:

```bash
"/Users/Shared/Epic Games/UE_5.7/Engine/Plugins/Media/PixelStreaming/Resources/WebServers/get_ps_servers.sh" -v 5.7
```

That command downloads and installs web-server assets under the UE plugin `Resources/WebServers` directory. Treat it as an install step: run it only after explicit action-time confirmation.

## Validation Sequence After Download

1. Run `pnpm unreal:pixelstreaming:check -- --require-infra` to confirm the signalling server assets exist.
2. Run the existing software validation gates:

```bash
pnpm unreal:smoke
pnpm typecheck
pnpm test
pnpm build
pnpm shuttle:validate
pnpm shuttle:ws-smoke
```

3. Start `shuttle-api` on `localhost:8791`.
4. Launch the Unreal visual twin in a non-headless mode with Pixel Streaming enabled.
5. Start the signalling web server from the downloaded Pixel Streaming Infrastructure.
6. Open the Pixel Streaming viewer in the browser and verify:

- stream connects;
- camera shows the single-level dense 6x8 shuttle scene;
- vehicles update from the SimCore WebSocket;
- carried/stored load placeholders do not duplicate;
- playback speed remains controlled by the dashboard/API, not Unreal;
- no bridge disconnects during a short smoke session.

## Still Out Of Scope

- Packaged application release.
- Public internet TURN/STUN deployment.
- Multi-user Pixel Streaming.
- Unreal-side dispatch or KPI authority.
- Mechanical approval of placeholder geometry.
