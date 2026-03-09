# World Host Process Architecture

This document defines the first migration target for splitting simulation into isolated processes without breaking the current SDK shape all at once.

## Current constraints

Today, world simulation, player ownership, and network transport all live in one Node process:

- `WorldManager` creates in-memory `World` instances and starts them immediately.
- `PlayerManager` creates `Player` objects directly from `ConnectionEvent.OPENED`.
- `Player.joinWorld(world)` assumes the destination is a local `World` object.
- `NetworkSynchronizer` sends packets straight to each player's live `connection`.

That is simple, but it means one overloaded world shares a failure domain with every other world on the same server process.

## Target split

Introduce two runtime roles:

- `Gateway process`
  - Owns sockets, auth, reconnect windows, and player connections.
  - Routes inbound client packets to the correct world host.
  - Forwards outbound packet batches from world hosts to client transports.
  - Maintains a directory of `worldId -> host process`.

- `World host process`
  - Owns one or more worlds.
  - Runs world tick, physics, entity logic, and network synchronization planning.
  - Does not own browser sockets.
  - Emits already-serialized outbound packet batches back to the gateway.

This is the first meaningful boundary because WebTransport/WebSocket ownership is hard to move between processes, while simulation state is relatively self-contained.

## Why process isolation instead of worker threads

Start with OS processes, not `worker_threads`.

- Crash isolation is materially better.
- Memory limits and restarts are easier to manage operationally.
- CPU pinning and per-host telemetry are clearer.
- The IPC overhead is acceptable if the boundary is packet batches, not individual entity mutations.

`worker_threads` can still be useful later for chunk generation, navigation, or asset preprocessing inside a world host.

## Ownership changes required

### 1. Split player identity from player simulation presence

The current `Player` type mixes:

- connection ownership
- persisted identity
- world membership
- gameplay-facing methods

That needs to become two layers:

- `GatewayPlayerSession`
  - connection, reconnect state, auth/session, persistence identity

- `WorldPlayerReplica` or `WorldPlayerHandle`
  - simulation-facing representation used inside a world host

The gateway remains the source of truth for the live socket. The world host becomes authoritative for gameplay state.

Status:

- `GatewayPlayerSession` now exists as the gateway-facing routing identity
- `GatewayPlayerSessionManager` owns lookup by connection and player id
- host client ingress/egress now use gateway sessions instead of raw `Player` objects

### 2. Stop using live `World` instances as routing keys outside the host

The gateway should route by metadata:

- `worldId`
- `processId`
- optional tags/capacity/region

The new protocol types in [`server/src/worlds/hosting/WorldHostProtocol.ts`](/Users/ricardodezoete/HYTOPIA/HYTOPIA/server/src/worlds/hosting/WorldHostProtocol.ts) define that descriptor layer.

### 3. Replace direct `player.connection.send(...)` assumptions

The world host should build packet batches and send them to the gateway as:

- `playerId`
- `worldId`
- `reliable`
- `wireBytes`

That keeps serialization work near the simulation that produced the state and prevents the gateway from reconstructing gameplay packets.

## Initial IPC protocol

The first version should stay narrow:

- Gateway -> host
  - `world_boot`
  - `world_stop`
  - `player_attach`
  - `player_detach`
  - `player_packets`

- Host -> gateway
  - `world_ready`
  - `world_stopped`
  - `player_packet_batch`
  - `player_transfer_request`
  - `world_log`

Do not start with generic RPC. The simulation path is high-volume and benefits from explicit, typed messages.

## Migration plan

### Phase 1: Define the boundary

Done in this change:

- add host/gateway protocol types
- document ownership and migration rules

No behavior changes yet.

### Phase 2: Local host adapter

Create an in-process adapter that implements the same protocol while still running worlds inline. This gives the codebase one execution model while preserving current behavior.

Goal:

- gateway code talks to a `WorldHostClient`
- inline mode remains the default

Status:

- `InlineWorldHostClient` now owns hosted-world descriptors for local worlds
- `WorldManager` registers worlds with the inline host
- `PlayerManager` routes initial world assignment through the host client
- inbound gameplay packets are forwarded through the host client before reaching `Player`
- outbound world packets are emitted through the host client instead of world systems calling the connection directly

### Phase 3: Gateway-owned routing

Move these responsibilities to a gateway-facing directory:

- `worldId -> host`
- `playerId -> worldId`
- `connectionId -> player session`

At this point, world switching becomes a routing operation first and a simulation operation second.

### Phase 4: Single external world host process

Run one real child process and host one non-critical world in it.

Success criteria:

- connect
- receive state
- send input
- disconnect/reconnect
- no gameplay feature parity requirement yet beyond a smoke-tested world

Status:

- `ProcessWorldHostClient` now exists and can be enabled with `HYTOPIA_WORLD_HOST_MODE=process_shadow`
- the active host client is selected at server startup through `WorldHostManager`
- selected worlds can be mirrored to a child process for lifecycle/session traffic while inline simulation remains authoritative
- the gateway can now forward pre-serialized packet batches from a child host directly to client transports
- `SYNC_REQUEST -> SYNC_RESPONSE` is now the first gameplay packet slice produced remotely by the child host instead of inline for mirrored worlds
- notification permission prompts are now host-owned targeted sends, and mirrored worlds have the child host serialize that packet instead of relying on `NetworkSynchronizer` tick queues
- `UI` and `UI_DATAS` now stay coalesced per tick inside `NetworkSynchronizer`, but packet construction is host-owned and mirrored worlds have the child host serialize those per-player UI batches
- `CAMERA` now follows the same model: `NetworkSynchronizer` still coalesces camera state per player, but final packet construction is host-owned and mirrored worlds have the child host serialize it
- `CHAT_MESSAGES` now follows the same model too: chat is still coalesced per tick with broadcast entries sent before player-specific entries, but final packet construction is host-owned and mirrored worlds have the child host serialize it
- mirrored worlds now have a child-owned per-world runtime that tracks attached players and batches those targeted packet families into outbound packet batches before handing them back to the gateway
- `WORLD` and `PLAYERS` now also go through that child-owned runtime, so a broader player/world state family is batched and serialized in the child instead of the inline host path
- initial `WORLD` and `PLAYERS` state for mirrored-world attach/detach is now derived directly from child-owned runtime data and player descriptors instead of being fully planned by the inline `NetworkSynchronizer`
- ongoing mirrored-world `WORLD` property updates are now sent as world-scoped patches to the child runtime, which updates its own world state and broadcasts those patches to attached players
- derived `WORLD` and `PLAYERS` ownership now falls back cleanly to inline behavior when the mirrored child process is unavailable, instead of suppressing inline bootstrap/removal solely because a world descriptor is marked `process`
- mirrored-world `SceneUI` state is now maintained in the child runtime too, with child-owned bootstrap for newly attached players and ongoing `SceneUI` load/update/unload patches mirrored from `NetworkSynchronizer`
- mirrored-world block type registration and chunk/block terrain state are now maintained in the child runtime too, with child-owned bootstrap for newly attached players and ongoing register/add/remove/set-block patches mirrored from `NetworkSynchronizer`
- mirrored-world audio state is now maintained in the child runtime too, with child-owned bootstrap for newly attached players, ongoing play/pause/property patches mirrored from `NetworkSynchronizer`, and an internal unload signal to keep the child bootstrap roster accurate for future joins
- mirrored-world particle emitter state is now maintained in the child runtime too, with child-owned bootstrap for newly attached players and ongoing spawn/despawn/property patches mirrored from `NetworkSynchronizer`
- mirrored-world broadcast entity state is now maintained in the child runtime too, with child-owned bootstrap for newly attached players and ongoing spawn/despawn/property/model-animation/model-node-override patches mirrored from `NetworkSynchronizer`, while per-player prediction/outline exceptions stay inline for now
- mirrored-world per-player entity batches now also cross the host boundary for child-side packet construction, so owner-prediction and other player-specific entity exceptions are still derived inline for now but no longer require inline entity packet serialization
- if the shadow host child exits, `ProcessWorldHostClient` now respawns it and replays mirrored-world bootstrap state plus attached player sessions, so child-owned derived state can recover instead of waiting for future incremental patches
- child rebootstrap now also replays recoverable player-local entity state for attached sessions, specifically owner-prediction sync fields and camera/viewmodel-driven entity model overrides, so mirrored worlds recover those client-visible states after shadow-host restart too
- `ProcessWorldHostClient` now keeps a replayable cache of per-player entity overlay state that crosses the host boundary, so player-specific entity exceptions such as owner-prediction batches and per-player outlines can be restored into a restarted child host instead of existing only in flight

### Phase 5: Full world-per-process

Once the protocol is stable:

- isolate hot worlds
- restart failed hosts independently
- add placement and rebalance policies

## What not to do

- Do not attempt cross-process world hosting while `Player.joinWorld(world)` still requires a local `World`.
- Do not mirror every engine object over IPC.
- Do not send per-entity diffs over IPC if serialized player packet batches are sufficient.
- Do not start with zone migration inside a world. World-per-process is the simpler first win.

## Next implementation step

The next code change should start moving world-owned state planning itself into the child runtime:

- introduce child-side player/world runtime objects that can own more than packet batching
- choose the next authoritative planning slice beyond world-state patches, such as child-owned player-state derivation or another piece of sync planning instead of forwarding already-planned sync objects from the inline `World`
- continue shrinking the set of gameplay decisions that require the gateway to keep a live local `World` authoritative
