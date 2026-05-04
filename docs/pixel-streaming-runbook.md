# Pixel Streaming Runbook

This repo keeps SimCore and the dashboard as the authoritative validation layer. Pixel Streaming is a presentation/runtime path for the Unreal visual twin.

## Current Local Contract

- Unreal Engine: 5.7.4 under `/Users/Shared/Epic Games/UE_5.7`.
- Generated project: `output/unreal/ShuttleVisualTwin/ShuttleVisualTwin.uproject`.
- Project plugin enabled today: `PixelStreaming2`.
- The generated project uses a render-target video producer instead of viewport/backbuffer capture. On this Mac, viewport capture connected but streamed black frames; render-target capture streamed the expected warehouse scene in the browser on May 4, 2026.
- SimCore bridge URL remains `ws://localhost:8791/shuttle-ws` unless overridden on `AShuttleVisualTwinRuntimeActor`.
- `pnpm unreal:setup` generates a bootstrap game mode for runtime viewing. It spawns the visual twin runtime actor, a top-down orthographic camera, a scene-capture render target, a key light, and binds Pixel Streaming 2 to that render target when the Unreal process is launched with `-PixelStreamingConnectionURL=...`.

## Readiness Check

Run:

```bash
pnpm unreal:pixelstreaming:check
```

The check verifies:

- UE editor executable is present.
- Generated Unreal project exists.
- Enabled project plugins.
- Pixel Streaming 2 plugin directories.
- Compatible Pixel Streaming Infrastructure is installed. UE 5.7 keeps the tested web server under the `PixelStreaming` plugin resources even though the generated project streams through `PixelStreaming2`.
- Official UE `get_ps_servers.sh` downloader location.
- Whether `SignallingWebServer` infrastructure has already been fetched.

It does not download or run anything.

## Infrastructure Download Gate

Pixel Streaming needs Epic's Pixel Streaming Infrastructure web server assets before browser streaming can be tested. On this Mac, the selected downloader is:

```bash
"/Users/Shared/Epic Games/UE_5.7/Engine/Plugins/Media/PixelStreaming/Resources/WebServers/get_ps_servers.sh" -v 5.7
```

That command downloads and installs web-server assets under the UE plugin `Resources/WebServers` directory. Treat it as an install step: run it only after explicit action-time confirmation.

## Local Runtime Smoke Sequence

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
4. Start the signalling web server from the downloaded Pixel Streaming Infrastructure:

```bash
cd "/Users/Shared/Epic Games/UE_5.7/Engine/Plugins/Media/PixelStreaming/Resources/WebServers/SignallingWebServer"
npm start -- --player_port 8080 --streamer_port 8888 --http_root www --homepage player.html --log_level_console info
```

5. Launch the Unreal visual twin in a non-headless mode with Pixel Streaming enabled:

```bash
"/Users/luke/codex projects/DES Sim/four-way-shuttle-sim/output/unreal/ShuttleVisualTwin/Saved/StagedBuilds/Mac/ShuttleVisualTwin.app/Contents/MacOS/ShuttleVisualTwin" \
  -ResX=1280 -ResY=720 -Windowed \
  -PixelStreamingConnectionURL=ws://127.0.0.1:8888 \
  -PixelStreamingUseMediaCapture \
  -AudioMixer -NoSplash -stdout -FullStdOutLogOutput
```

6. Open `http://127.0.0.1:8080/player.html` in the browser and verify:

- stream connects;
- camera shows the single-level multi-bank shuttle scene;
- browser video is non-black and shows the render-target view;
- vehicles update from the SimCore WebSocket;
- carried/stored load placeholders do not duplicate;
- playback speed remains controlled by the dashboard/API, not Unreal;
- no bridge disconnects during a short smoke session.

## Mac Packaging Gate

A packaged or staged Mac runtime requires Xcode first-launch components to be fully available. On this Mac, Xcode/CoreSimulator is now ready, and `BuildCookRun -cook -stage -skippackage` has produced a runnable staged `.app`.

```bash
xcodebuild -checkFirstLaunchStatus
```

If this command fails later, or `/Library/Developer/PrivateFrameworks/CoreSimulator.framework` is missing on a new machine, Unreal packaging may fail while copying Swift standard libraries. Finish Xcode first launch from the signed-in macOS user session before treating packaged Pixel Streaming as blocked by project code.

## Still Out Of Scope

- Packaged application release.
- Public internet TURN/STUN deployment.
- Multi-user Pixel Streaming.
- Unreal-side dispatch or KPI authority.
- Mechanical approval of placeholder geometry.
