# ChatGPT Pro Review Response Round 2 - Station Transition Grant

Date: 2026-06-24

ChatGPT conversation: https://chatgpt.com/c/6a3b54be-f470-83ea-9dcb-e3404b6f9fec

## Reviewer Decision

Decision: request changes.

Round 2 confirms that the latest WIP still should not be expanded to 30m/1h/12h/24h. The v4/v5 experiments added gates that reject unsafe or out-of-order moves, but did not add the authoritative station transition that tells a shuttle exactly which station resource it may move from and to.

In short:

- v3 allowed movement but multiple local rules produced contradictory station authority, causing deadlock.
- v4/v5 rejected more bad movement, but no authoritative component issued slot compression or service handoff, causing outbound starvation.
- Changing head ordering is not the fix. Physical slot order mismatch should become an invariant violation, not a reason to redefine FIFO head.

The missing object is `StationTransitionGrant`.

## Key Diagnosis

The current WIP still mixes three control layers:

- coordinator/token logic decides who is FIFO head;
- vehicle route fields infer who owns a slot;
- dispatch/movement gates decide where the vehicle goes and whether movement is allowed.

That creates a loop:

```text
physical position -> head decision -> route -> plannedGoal/route field as lease -> physical movement
```

This violates the prior recommendation because station authority is still derived from physical route state rather than issued by the station coordinator.

The reviewer specifically called out that these must not control station behavior in coordinator mode:

- dynamic `outboundTaskHasEarlierDropoffTask`;
- `topLiftOutboundQueueNodeIdForTask`;
- sticky `plannedGoalNodeId` queue ownership;
- movement-time outbound FIFO holds that compute head dynamically;
- dock corridor station-order inference;
- bottom-lane/service-clearance station-specific deadlock breakers.

## Minimal Next Architecture Cut

Do not build a broad generic `ResourceManager` yet. Add a narrow outbound station runtime per outbound station.

The minimum runtime should own:

```ts
type OutboundStationRuntime = {
  stationId: string;
  requests: OutboundStationRequest[];
  slots: Array<{
    slotIndex: number;
    ownerRequestId: string | null;
    incomingTransitionId: string | null;
  }>;
  serviceOwnerRequestId: string | null;
  activeTransition: StationTransitionGrant | null;
  nextQueueSeq: number;
};

type StationTransitionGrant = {
  id: string;
  stationId: string;
  requestId: string;
  vehicleId: string;
  kind: 'enter-tail' | 'compress-slot' | 'enter-service' | 'clear-service';
  fromResource: 'approach-boundary' | `queue-slot:${number}` | 'service';
  toResource: `queue-slot:${number}` | 'service' | 'clear-through';
  routeNodeIds: string[];
  issuedAtSec: number;
  lastProgressAtSec: number;
  expiresAtSec: number;
  phase: 'granted' | 'moving';
};
```

Separate these contracts:

- `workAdmission`: controls whether an outbound task can bind a vehicle and enter station WIP.
- `queueSlotLease`: states that the vehicle owns a specific waiting slot.
- `StationTransitionGrant`: authorizes exactly one movement from one station resource to the next.

A queue lease is ownership; it is not movement authorization.

## First Implementation Gate

Start with physical queue depth 1 before debugging slot2/slot3.

Configuration for the first cut:

- `maxAdmittedOutboundWipPerStation = 1`
- physical queue depth = 1
- active transition count = 1 per station

Lifecycle:

```text
work admission
-> loaded-ready
-> approach boundary
-> slot1
-> service
-> clear-through
-> release
```

This is not the final model. It is a diagnostic cut:

- If depth=1 still cannot complete outbound, the bug is in throat/service/clearance lifecycle.
- If depth=1 works, then re-enable slot2/slot3 as pure compression, without changing service logic.

Do not keep tuning follower sorting before depth=1 works.

## Authorization Rules

Do not require `queueSlotLease` before task assignment. That would reserve physical station slots too early and can suppress outbound again.

Required authority by stage:

- Global dispatcher binds outbound task to AMR: requires `workAdmission`.
- AMR completes pickup and drives on ordinary yellow network toward station approach: requires `workAdmission`.
- Approach boundary to queue tail: requires `enter-tail` transition grant, which reserves the tail slot.
- `slot3 -> slot2 -> slot1`: requires `compress-slot` transition grant.
- `slot1 -> throat/service`: requires `enter-service` transition grant.
- Service to clear-through: requires `clear-service` transition grant.

When no transition grant exists, a station-managed vehicle should wait with:

- `targetNodeId = null`
- `blockingVehicleId = null`
- `waitReason = outbound-station-await-transition`

It must not set:

- `targetNodeId = currentNodeId`
- `plannedGoalNodeId = currentNodeId`

`outbound-station-lease-missing` should not be a normal wait reason inside a protected station resource. If a vehicle is already inside the protected station area without the required lease/grant, that is a critical invariant failure.

## Slot Compression

Only one station transition should be active in the first implementation.

Decision order:

```ts
function chooseNextTransition(station: OutboundStationRuntime) {
  if (station.activeTransition) return null;

  if (serviceVehicleNeedsClearance(station)) {
    return grantClearService();
  }

  if (
    station.serviceOwnerRequestId === null &&
    station.slots[0]?.ownerRequestId !== null &&
    slot1OwnerIsQueueHead(station) &&
    serviceRoutePhysicallyAdmissible(station)
  ) {
    return grantSlot1ToService();
  }

  for (let slot = 1; slot < station.slots.length; slot += 1) {
    if (
      station.slots[slot - 1]!.ownerRequestId === null &&
      station.slots[slot]!.ownerRequestId !== null
    ) {
      return grantCompression(slot + 1, slot);
    }
  }

  if (tailSlotIsFree(station) && nextRequestIsAtApproachBoundary(station)) {
    return grantEntryToTail();
  }

  return null;
}
```

Transitions must be two-phase:

- Grant: source owner remains, target slot has `incomingTransitionId`.
- Physical arrival at target: source owner clears, target owner commits, active transition clears.
- Grant revoked before movement: source owner stays, target incoming clears.

This prevents duplicate slot targeting, mid-corridor orphan states, self-goal holds, and generic deadlock breakers reordering the station.

## FIFO Semantics

Do not use outbound task creation time as station service FIFO.

Use:

- `demandSeq`: task/work-admission audit order.
- `queueSeq`: assigned when the loaded AMR formally joins the physical station queue.

Service FIFO should be `queueSeq + slot1 ownership`, not task age and not physical slot order as a fallback.

Replace the local test named like "physical outbound meter slot order beats lease age" with a stronger invariant:

```text
physical outbound meter slot order inconsistent with coordinator queueSeq is a critical invariant violation
```

## Station Topology

Only explicitly declared queue/throat/service resources should be station-exclusive. Do not dynamically make the entire bottom-a/b lane exclusive at runtime.

Add explicit topology:

```ts
type OutboundStationTopology = {
  approachBoundaryNodeIds: string[];
  queueSlotNodeIds: string[];
  protectedThroatNodeIds: string[];
  protectedEdgeIds: string[];
  protectedConflictGroupIds: string[];
  serviceNodeId: string;
  clearThroughNodeId: string;
};
```

Invariant:

```text
A node cannot be both a long-wait queue slot and an unrelated traffic through node.
```

If current slot2/slot3 are shared through nodes and there is no safe follower hold pocket, keep queue depth at 1 until the topology is corrected.

If sibling inbound/outbound stations share a conflict group, each directional station owns its queue slots, but the `StationPairCoordinator` owns the shared throat token. In the first implementation, one lift pair should have at most one active throat transition.

## Tick Order

Recommended tick sequence:

1. Read tick-start physical observation.
2. Reconcile station request, lease, transition, and occupancy state.
3. Complete release/fault/service transition.
4. Station chooses admission, slot advance, and throat grant.
5. Global dispatcher handles only station-approved tasks and non-station AMRs.
6. Planner builds routes only for coordinator-issued station targets.
7. Traffic controller installs bounded reservations.
8. Execute physical movement/lift/lower.
9. Feed arrival, lift-started, lift-complete, clear-through events back to coordinator.

Station choices must move out of movement recovery branches. Movement should consume station authorization, not create station order.

## Per-Tick Outbound Station Invariants

At each tick boundary:

- Each slot has at most one committed owner.
- Each slot has at most one incoming transition.
- Service has at most one owner.
- Each vehicle/request has at most one station role.
- Each station has at most one active transition in the first cut.
- Every protected-resource occupant is either the committed owner, active transition vehicle, or service owner.
- Any other vehicle inside the protected set is critical.
- A transition target has no conflicting owner or incoming transition.
- A transition source remains owned until target arrival.
- Only the transition vehicle may use protected resources in `transition.routeNodeIds`.
- No transition grant means no station movement target.
- If `i < j` and both slots are occupied, `queueSeq(slot[i]) < queueSeq(slot[j])`.
- Service grant requires queue head, slot1 owner, free service, and free pair throat token.
- If no active transition exists and a legal service/compression/entry action exists, the coordinator must issue a grant in that tick.
- Service ownership is not released at lower-complete; it is released only after physical clear-through arrival.

## What To Keep / Replace / Revert

Keep:

- outbound-task demand token;
- outbound station shadow contract;
- station pair coordinator diagnostics;
- schema/snapshot fields for outbound station state;
- route/kernel invariant tests, strengthened;
- the intent of "follower cannot go to slot1", rewritten around transition grants.

Replace:

- movement-time throat gate: check explicit transition grant only, do not compute head;
- dispatch-time follower gate: no grant means no station target, not follower fallback or self-goal;
- `outbound-station-lease-missing`: protected-region missing lease/grant becomes critical invariant failure.

Downgrade to observation-only:

- derived outbound queue lease collection from `currentNodeId`, `targetNodeId`, and `plannedGoalNodeId`.

Revert or stop using as control:

- physical slot order first as head selection;
- plannedGoal/route-tail station ownership;
- self-goal station waits;
- station-specific deadlock breakers;
- dynamic bottom-lane priority hacks.

## Required Deterministic Test From v5

Use the v5 relationship directly:

```text
SH-07 owns/occupies bottom-b-c03
SH-08 is at bottom-a-c03
SH-08 wants to enter bottom-b-c03
```

Expected result:

- No transition is issued to SH-08 while SH-07 owns the resource.
- `SH-08.targetNodeId = null`
- `SH-08.blockingVehicleId = null`
- No `node-occupied` wait cycle.
- SH-07 clears through and releases.
- On the next tick, SH-08 receives a grant.
- SH-08 eventually completes outbound.

## Stop Conditions

Stop and fix topology before coordinator logic if:

- a queue slot is an unrelated traffic cut node;
- a queue slot is marked no-parking/no-stop;
- removing protected nodes breaks ordinary non-station routing;
- no safe station approach boundary exists;
- sibling inbound/outbound share conflict group without a single pair owner.

Do not run physical smoke if unit tests show:

- one vehicle has two station roles;
- one slot has two owners;
- protected occupant differs from owner/transition/service vehicle;
- vehicle enters protected set without grant;
- station-managed vehicle gets a self-goal;
- physical slot order disagrees with `queueSeq`;
- snapshot/restore changes station state/hash/event sequence;
- generic deadlock breaker modifies station transition route.

10-minute depth=1 smoke must satisfy:

- `completedOutbound > 0`
- physical violations = 0
- station invariant violations = 0
- station lease missing = 0
- self-goal dispatch = 0
- generic deadlock breaker on station vehicle = 0
- station node-ping-pong = 0

The first loaded-ready outbound should complete within predicted route/service ETA plus 30s. Any active transition with no progress beyond `max(30s, 2 * predictedTransitionETA + 5s)` is a failure.

If this fails:

- save the full snapshot one tick before the first invariant failure;
- do not add fallback;
- do not change head ordering;
- do not add a breaker;
- write a deterministic test from that snapshot.

10-minute depth=3 smoke must observe all transition types:

- `enter-tail > 0`
- `compress-slot > 0`
- `enter-service > 0`
- `clear-service > 0`

And must keep queueSeq order, no slot hole longer than one transition timeout, no follower slot1 target without grant, and `completedOutbound > 0`.

Before 30-minute gate:

- compare against same-seed baseline;
- total/inbound/outbound PPH each at least 90% of baseline;
- no station critical/warn invariant;
- no station wait over 300s;
- no station ping-pong;
- physical violations = 0;
- prove station/traffic/snapshot/reservation/physical movement tests are green.

Before 12h/24h:

- full sim-core suite must be green.

## Final Recommendation

Next commit should only be:

```text
refactor(sim-core): make outbound station slot transitions authoritative
```

Do not commit more:

- physical slot head sorting fixes;
- follower slot fallback;
- station lease missing wait recovery;
- outbound station deadlock breakers;
- dynamic bottom-lane priority.

The failure is not a more precise "who goes first" problem. It is missing the coordinator-issued, source-and-target-reserving "this exact step may move now" authorization.

