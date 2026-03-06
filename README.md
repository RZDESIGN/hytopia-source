# HYTOPIA Game Engine

This is the monorepo for the HYTOPIA game engine — a multiplayer voxel game platform that lets developers build and host browser-based block games. The engine powers [hytopia.com](https://hytopia.com) and is what the public [HYTOPIA SDK](https://github.com/hytopiagg/sdk) (`npm install hytopia`) is compiled from.

## Repository Structure

```
hytopia-source/
├── assets/       # Default game assets (textures, maps). Published as @hytopia.com/assets
├── client/       # Browser game client (play.hytopia.com)
├── protocol/     # Packet schema definitions. Published as @hytopia.com/server-protocol
├── sdk/          # Git submodule → hytopiagg/sdk. Build output (server.mjs, types, docs) lands here
├── sdk-examples/ # Reference games built with the SDK (zombie FPS, RPG, battle royale, etc.)
└── server/       # Server source. Compiles to sdk/server.mjs
```

## Quick Start

Install dependencies:

```bash
cd server && npm install && cd ../client && npm install
```

Start the server (terminal 1) — runs on `localhost:8080` with hot reload:

```bash
cd server && npm run dev
```

Start the client (terminal 2) — runs on `localhost:5173`:

```bash
cd client && npm run dev
```

Open `http://localhost:5173` in your browser. Game server logic is written in `server/src/playground.ts` and hot-reloads on save.

### Simulating Network Conditions

For client-side prediction tuning, the dev client can inject artificial one-way latency, jitter, and unreliable packet loss from the browser URL:

- `simNetLagMs`: base one-way delay added to incoming and outgoing packets
- `simNetJitterMs`: random `+/-` jitter added per packet
- `simNetLossPct`: loss percentage applied only to unreliable packets

Check the debug panel's send/receive protocol while testing. Loss simulation is most representative on the WebTransport path, because WebSocket fallback still carries inbound traffic over a reliable channel.

Example URLs:

- `http://localhost:5173/?debug&simNetLagMs=60`
- `http://localhost:5173/?debug&simNetLagMs=60&simNetJitterMs=30`
- `http://localhost:5173/?debug&simNetLagMs=60&simNetJitterMs=30&simNetLossPct=5`

Suggested CSP review matrix:

- Baseline: `?debug`
- Added latency: `?debug&simNetLagMs=60`
- Latency + jitter: `?debug&simNetLagMs=60&simNetJitterMs=30`
- Latency + jitter + unreliable loss: `?debug&simNetLagMs=60&simNetJitterMs=30&simNetLossPct=5`

Open the `Prediction` section in the debug panel while testing. Watch buffered commands, last/peak replay work, and current horizontal/vertical/rotation error while moving, stopping, jumping, and rapidly changing camera yaw.

## Architecture

### Client (`client/`)

Entry point: `src/main.ts` → `Game.instance.start()`

The `Game` singleton owns all subsystem managers. Key systems:

| System | Description |
|---|---|
| `NetworkManager` | WebTransport (HTTP/3) with WebSocket fallback. Deserializes msgpack packets and dispatches typed events |
| `Renderer` | Three.js `WebGLRenderer` + `EffectComposer`. Post-processing: SMAA, selective bloom, outline pass, `CSS2DRenderer` for in-world UI |
| `ChunkMeshManager` + `ChunkWorkerClient` | Voxel mesh generation via greedy meshing with ambient occlusion, offloaded to a Web Worker |
| `EntityManager` | Entity lifecycle and GLTF model rendering |
| `InputManager` + `MobileManager` | Keyboard/mouse/gamepad input and touch/joystick for mobile |
| `UIManager` | HTML/CSS overlay UI system for game developer UIs and in-world `SceneUI` elements |
| `BridgeManager` | `postMessage` bridge to the parent `hytopia.com` iframe (pointer lock, chat, quality settings) |
| `AudioManager` | Spatial audio |
| `SettingsManager` | Quality presets, view distance, FPS cap |

Block geometry is built in a Web Worker to avoid blocking the main thread. The rendering pipeline uses `MeshBasicMaterial` (no dynamic lighting from Three.js lights) — ambient light and block lighting are applied via custom logic and shader uniforms.

### Server (`server/`)

Entry point for the SDK: `src/index.ts`  
Dev entry: `src/playground.ts` (hot-reloaded via nodemon

Developers using the SDK call `startServer({ init })`. Internally, `GameServer` bootstraps:
1. Rapier3D physics init
2. Asset preloads (textures, models)
3. Developer `init` callback
4. `WebServer.start()` — begins accepting connections

Key server systems:

| System | Description |
|---|---|
| `WebServer` | HTTP/2 + Express v5. Serves static assets, handles WebSocket upgrades, exposes health-check at `/` |
| `Socket` | Dual-transport server: `ws.WebSocketServer` + `@fails-components/webtransport` HTTP/3 on the same port. Handles session auth via `PlatformGateway` |
| `Connection` | Per-client transport abstraction. Batches packets per tick, serializes via msgpackr, gzips large payloads. 30s reconnection window |
| `WorldManager` | Multi-world support. Each world runs an independent physics simulation and tick loop |
| `World` | Contains `ChunkLattice`, `EntityManager`, `Simulation`, `NetworkSynchronizer`, `AudioManager`, `ChatManager`, `SceneUIManager`, `ParticleEmitterManager` |
| `WorldLoop` | Fixed 60 Hz game loop: entity logic → physics step → update events → network sync |
| `Simulation` | Wraps Rapier3D at 60 Hz. Default gravity: `y = -32`. Exposes raycasts, rigid bodies, colliders, collision groups |
| `NetworkSynchronizer` | Listens to world events, queues deltas, flushes to all players at **30 Hz** (every 2 physics ticks) |
| `ChunkLattice` | Voxel world storage. Chunks are 16×16×16 blocks |
| `PersistenceManager` | Player/global KV data storage via `@hytopia.com/save-states` |
| `Telemetry` | Span-based performance profiling wrapper |

### Networking & Protocol (`protocol/`)

The `@hytopia.com/server-protocol` package defines all packet schemas (AJV-validated). Packets are serialized with **msgpackr** and optionally **gzip** compressed for large payloads like chunks.

**Transport:** WebTransport (QUIC) is preferred over WebSocket. WebTransport uses two channels — a reliable bidirectional stream for state updates and unreliable datagrams for high-frequency position data. The client sends input at ~60 Hz on the unreliable channel; the server sends world state at 30 Hz.

**Packet directions:**

- **Server → Client:** Chunks, Entities, Blocks, BlockTypes, Players, Audios, ParticleEmitters, Camera, ChatMessages, SceneUIs, UI, UIDatas, World, SyncResponse, PhysicsDebugRender
- **Client → Server:** Input, ChatMessageSend, SyncRequest, UIDataSend, DebugConfig

**Auth:** URL query param `sessionToken` is validated against the HYTOPIA platform on connection. No auth is required in local dev.

### SDK Build Pipeline

The `sdk/` folder is a git submodule pointing to [hytopiagg/sdk](https://github.com/hytopiagg/sdk) — the public npm package. Building the server compiles directly into it:

```
cd server && npm run build
  ├── build:server      → bun build src/index.ts → ../sdk/server.mjs
  ├── build:declaration → tsc → ../sdk/server.d.ts
  ├── build:api         → api-extractor → ../sdk/server.api.json
  └── build:docs        → api-documenter → ../sdk/docs/
```

The client is built separately with Vite and deployed to `play.hytopia.com`.

## Building & Testing with SDK Examples

To test server changes against real games, build the server into the `sdk/` folder and run any of the examples in `sdk-examples/`. Each example references the local `sdk/` directory as its server runtime rather than the published npm package.

**1. Build the server into `sdk/`:**

```bash
cd server && npm run build
```

This compiles `server/src/index.ts` into `sdk/server.mjs` (plus types and docs). Any changes made to the server source are reflected here after a build.

**2. Install dependencies for an example:**

```bash
cd sdk-examples/<example-name> && npm install
```

**3. Run the example:**

```bash
npm run dev
```

Then open `http://localhost:5173` with the client running (see Quick Start above). The example's `package.json` resolves `hytopia` to the local `sdk/` directory, so it will use your freshly built server code.

Available examples in `sdk-examples/` include zombie FPS, battle royale, RPG, tower defense, and more — each is a self-contained game that exercises different parts of the engine API.

## Contributing

This is the publicly available source of the HYTOPIA game engine. To propose improvements, submit a PR. Merged contributions are consolidated into a private deployment repo for scheduled releases to hytopia.com and the public SDK on npm.
