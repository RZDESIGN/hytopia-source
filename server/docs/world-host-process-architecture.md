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

The next code change should move outbound and inbound gameplay traffic behind the same boundary:

- replace direct `player.connection.send(...)` calls in world-local systems with a host-owned packet sink
- forward client gameplay packets through a gateway-facing router before they reach `Player`
- keep inline mode as the execution path while matching the process-host contract
