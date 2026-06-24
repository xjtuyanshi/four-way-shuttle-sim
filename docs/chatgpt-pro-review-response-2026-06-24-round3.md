# ChatGPT Pro Review Response - Round 3 - 2026-06-24

Source conversation: https://chatgpt.com/c/6a3b54be-f470-83ea-9dcb-e3404b6f9fec
Model/mode visible in Chrome: Pro Extended
Input handoff: docs/chatgpt-pro-review-handoff-2026-06-24-round3.md

---

# Round 3 Reviewer 结论

**R2.1e 的 30m 退化不是“depth=1 吞吐不足”造成的主要故障，而是 station ownership 覆盖范围仍然有缺口。**

Depth=1 会降低稳态吞吐、产生 station idle gap，但在资源正常释放的情况下，不应造成：

* loaded outbound 在 station 边界等待 200–300 秒；
* outbound 最后 5 分钟只剩 12 PPH；
* loaded outbound 停在 inbound 必经的 bottom-a 节点；
* station owner recovery 前后结果完全相同。

这些是 **station envelope 中存在无人负责的物理阶段** 的表现。R2.1d/e 已经证明 transition grant 方向正确，但当前 contract 只覆盖了几个语义节点，没有覆盖车辆从安全等待点进入、经过共享 bottom-a、完成 dropoff、再清出冲突区的完整临界区。

---

## 1. 为什么 10m 通过、30m 退化

### 10m 通过的原因

前 10 分钟 station 资源较空，首批 outbound 车辆大致按预期路径到达：

```text
work admitted
→ boundary
→ transition
→ service
→ clear
```

所以 R2.1d 从 v5 的 outbound=0 恢复到了 outbound=150 PPH。

这证明了：

* work admission 有效；
* transition grant 至少能完成一部分正常路径；
* station-await 清除旧 target/planned goal 的修正有效；
* 允许车辆进入真正 boundary 的修正有效。

这些改动应当保留。

### 30m 退化的原因

运行进入稳态后，车辆开始落入 coordinator 没有完整表达的区域：

```text
safe pre-gate
→ bottom-a station approach
→ station-adjacent bottom-a segment
→ bottom-a / bottom-b transfer
→ dropoff/service
→ outbound clearance sweep
→ clear-through
```

当前 FSM 似乎只明确识别：

* approach boundary；
* slot1；
* service；
* clear-through。

但 SH-03 最终在 `column-bottom-a-c21`，既不是已知 lift-02 boundary `c19`，又仍能阻塞 inbound SH-07。这说明车辆已经进入 station-adjacent corridor，却没有处于一个持续有效的 station-owned phase。

结果就是：

1. 车辆物理进入共享 corridor；
2. coordinator 不再认为它正确拥有 slot/service；
3. owner hygiene 将它降回 `loaded-ready`；
4. 车辆仍然物理占据 corridor；
5. coordinator 等待新的合法 transition；
6. inbound/general traffic 又把它视为普通 node occupant；
7. station 等待与通用交通等待互相锁住。

这也是为什么 R2.1e 的 owner recovery 没有改善：它在修补状态分类，却没有补齐资源所有权。

### 明确判断

* **Depth=1 对正确性足够。**
* **Depth=1 对最终吞吐可能不足。**
* 当前不能通过增加 depth=2/3 来解决，因为多放两辆车只会让更多 AMR 进入同一个 ownership gap。

如果 depth=1 contract 正确，最坏情况应是 station 利用率低，而不是已 admitted、loaded 的车辆等待数百秒。

---

# 2. 最小正确 FSM：不要再把 slot1 当成孤立节点

下一步最小切口应是：

> 将 boundary 后到 clear-through 的整段定义为一个 station-owned physical envelope，并用一个持续存在的 pass lease 覆盖整个服务过程。

第一版不需要增加 slot2/slot3。

## 最小 FSM

```text
ADMITTED
  已获 outbound work admission，车辆可以执行 storage pickup

LOADED_EN_ROUTE
  已 loaded，在普通黄色网络前往安全 pre-gate hold

WAITING_AT_GATE
  位于 station 外的安全等待点
  没有 station movement target

PASS_GRANTED
  station 原子取得 envelope ownership
  安装 gate → service 的受控路线

ENTERING
  车辆已经进入 station envelope

SERVICING
  车辆到达 dropoff，执行 lower
  envelope ownership 继续保持

CLEARING
  lower complete 后沿 station-owned clearance route 离开
  ownership 仍然保持

RELEASED
  车辆物理到达 clear-through 后才释放 envelope
```

其中最重要的不是增加更多 state 名字，而是：

```text
PASS_GRANTED → ENTERING → SERVICING → CLEARING
```

使用同一个 `stationPassLeaseId` 和同一个 owner，不允许在中间重新推导所有权。

## 最小运行时状态

```ts
type OutboundStationRuntime = {
  stationId: string;

  requests: OutboundStationRequest[];

  envelopeOwnerRequestId: string | null;
  serviceOwnerRequestId: string | null;

  activePass: OutboundStationPass | null;

  nextRequestSeq: number;
  nextPassSeq: number;
};

type OutboundStationPass = {
  id: string;
  stationId: string;
  requestId: string;
  vehicleId: string;

  phase: 'entering' | 'servicing' | 'clearing';

  entryNodeId: string;
  serviceNodeId: string;
  clearThroughNodeId: string;

  envelopeNodeIds: string[];
  envelopeEdgeIds: string[];
  envelopeConflictGroupIds: string[];

  issuedAtSec: number;
  lastProgressAtSec: number;
  expectedCompleteBySec: number;
};
```

这不是 route-wide hard lock。它只拥有一个很小的 station workcell envelope，而不是 storage→station 的完整 planned route。

---

# 3. 哪些 nodes/segments 必须 station-owned

## 正确边界：pre-gate 与 entry gate 必须分开

当前所谓 `approachBoundaryNodeId` 很可能混合了两个角色：

* 可以长期等待的 hold node；
* station corridor 的第一个入口节点。

这两个角色必须拆开。

### Pre-gate hold

车辆无 station pass 时可以停在这里，必须满足：

* 允许停车；
* 不在 protected envelope；
* 不是 inbound/general traffic 的必经 cut node；
* 不在 dock sweep 或 sibling lift conflict group；
* 不会因为等待而阻塞 unrelated AMR。

### Entry gate

这是 envelope 的入口。进入它或跨过它的第一条 edge 必须要求 station pass。

因此不要再使用：

> “移动到 approach boundary 不需要 grant。”

应该改成：

> “移动到 pre-gate hold 不需要 grant；从 pre-gate 跨入 entry gate 必须有 pass。”

如果 `column-bottom-a-c05`、`c19` 本身是共享 bottom-a through node，它们不能作为允许数百秒等待的 pre-gate。

## Station envelope 至少包括

对于每个 outbound lift：

1. pre-gate 后的第一条 entry edge；
2. 所有 station-adjacent bottom-a nodes；
3. bottom-a 到 bottom-b 的 transfer/crossover edges；
4. outbound service/dropoff node；
5. dock throat nodes；
6. dock sweep / clearance nodes；
7. service 后到 clear-through 的所有 edge；
8. 与这些路径共享的 conflict groups。

判断原则非常简单：

> 只要车辆停在某个 node/edge 上会阻止 station service、station clearance 或 sibling inbound traffic，它就必须属于 station envelope 或被移出等待路径。

SH-03 能在 `c21` 阻塞 inbound，说明 `c21` 要么必须：

* 属于 outbound station envelope，并且车辆在其中时必须拥有 pass；

要么：

* 完全不能作为 outbound 等待/停留位置。

不能继续维持现在这种“物理上进入、逻辑上不是 station owner”的中间状态。

## Shared bottom-a cross traffic

不建议永久关闭整条 bottom-a。

正确方式是：

* 没有 outbound pass 时，普通/inbound traffic 可以使用共享 segment；
* outbound pass 发出前，必须确认 envelope 没有 unrelated occupant；
* pass 生效后，非 owner 路由将 envelope nodes/edges 视为暂时不可用；
* inbound vehicle 必须停在它自己的安全 envelope 外，而不是进入后再 `node-occupied`；
* outbound 到达 clear-through 后释放，普通 traffic 恢复。

这是资源 ownership，不是动态优先级。

---

# 4. Slot1 应该保留还是折叠

只有在物理布局中存在真正的 dedicated waiting pocket 时，slot1 才应作为独立等待资源。

如果 slot1 位于共享 bottom-a/b through corridor，那么第一版应当折叠：

```text
entry → slot1 → service → clear
```

为一个连续的：

```text
station pass: pre-gate → service → clear-through
```

车辆不能在共享 approach segment 中等待下一次 grant。

可以在 service node 停下来执行 lower，因为整个 envelope 已由该车辆持有；但不能在 c21 这种共享 station-adjacent node 等待数百秒。

因此下一步不应增加 queue depth。先把 station 当成容量为 1 的单服务台 workcell：

```text
外部逻辑 FIFO queue
→ 安全 pre-gate
→ 独占 workcell
→ service
→ 独占 clearance
→ release
```

这正符合用户要求的简单 DES queue，同时实际运动仍由 3D tick 执行。

---

# 5. 对 max admitted outbound WIP=1 的处理

下一轮仍保持：

```text
station envelope capacity = 1
max admitted outbound WIP per station = 1
```

它是正确性隔离工具。

但需要明确：

* WIP=1 可能造成 station 空闲；
* 它会降低稳态 outbound PPH；
* 它不应造成 300 秒 station wait。

只有在新的 envelope FSM 连续通过 30m 和 1h，且唯一问题是 station 空闲/吞吐不足时，才能增加：

```text
work admission depth: 1 → 2
```

但仍保持：

```text
station envelope occupancy = 1
```

第二个 request 只能等待在 station 外的安全逻辑/物理 queue，不得提前进入 bottom-a station corridor。

不要直接启用 slot2/slot3，除非确认它们是物理 dedicated pockets。

---

# 6. 每 tick 必须成立的 station invariant

## 资源一致性

```text
insideEnvelopeVehicleCount <= 1
envelopeOwnerRequestId 最多一个
serviceOwnerRequestId 最多一个
每个 request 最多拥有一个 station pass
每个 vehicle 最多关联一个 outbound station request
```

## 物理一致性

```text
任意 vehicle 位于 envelopeNodeIds
  => 它必须是 envelope owner
```

反向也成立：

```text
存在 envelope owner
  => owner vehicle 必须位于：
     pre-gate 正在跨入、
     envelope 内、
     service 中、
     或 clearance route 上
```

### 禁止恢复式忽略

下面情况不是普通 recovery，而是 critical：

```text
vehicle inside envelope && no pass
pass owner != physical occupant
two vehicles inside same envelope
station-await vehicle inside envelope
non-owner target/planned route includes envelope node
```

遇到后立即保存 snapshot 并停止 smoke，不能 demote 成 `loaded-ready` 后继续跑。

## 等待位置

```text
waitReason == outbound-station-await-transition
  => currentNodeId 必须是 preGateHoldNodeId
  => targetNodeId == null
  => plannedGoalNodeId == null
  => blockingVehicleId == null
```

`outbound-station-await-transition` 不能出现在：

* station envelope；
* shared throat；
* service approach；
* clearance sweep。

## Grant liveness

```text
request 已 loaded
AND vehicle 在 pre-gate
AND envelope 空闲
AND service 空闲
AND envelope 无 unrelated occupant
AND station pass route 可行
```

若以上连续成立超过一个 coordinator tick，仍未发出 pass，立即判定：

```text
station-grant-liveness-violation
```

不能等 300 秒后依靠 long-wait audit 才发现。

## Progress watchdog

每个 active pass 必须有：

```text
lastProgressAtSec
expectedCompleteBySec
```

Progress 仅包括：

* 进入下一 node；
* 进入 service；
* lower-started；
* lower-complete；
* 进入 clearance；
* 到达 clear-through。

单纯每 tick reconcile 不算 progress。

若：

```text
now > expectedCompleteBySec
```

立即 critical，不做 owner demotion。

## Release

```text
lower-complete != station release
```

只有：

```text
vehicle.currentNodeId == clearThroughNodeId
AND vehicle 已离开所有 envelope conflict groups
```

才释放 pass。

---

# 7. 本地 WIP：保留、替换、回退

## 保留

* `OutboundStationRequest`
* request/transition sequence
* `OutboundStationRuntime`
* work admission block
* runtime 加入 snapshot/restore/hash
* station-await 清除：

  * `targetNodeId`
  * `plannedGoalNodeId`
  * visible planned route
  * `blockingVehicleId`
* movement blocker只认可显式 station grant 的方向
* coordinator reconciliation 插入 tick loop
* station shadow contract和 pair diagnostics
* audit/report/rolling-log 增强
* “仅 boundary vehicle 可取得 station transition”的测试意图

## 替换

### `outboundStationAuthoritativeGoalNodeId()`

替换成：

```ts
outboundStationPassRoute(pass)
```

无 pass 时不得为 station vehicle返回任何 station interior goal。

### `grantOutboundStationEnterTail()` / `grant...EnterService()`

若没有 dedicated queue pocket，替换为一个连续 pass：

```text
grantOutboundStationPass()
```

同一个 pass 在 service 前后只改变 phase，不释放 owner。

### `stationCoordinatorOutboundProtectedMoveBlocker()`

继续保留 gate，但资源输入必须来自：

```text
activePass.envelopeNodeIds
activePass.envelopeEdgeIds
activePass.envelopeConflictGroupIds
```

而不是重新扫描 task/head/route state。

### Approach boundary

改成两个静态概念：

```text
preGateHoldNodeId
entryGateNodeId
```

只有到 pre-gate 可无 grant。

## 回退

### Owner hygiene demotion

回退：

* stale slot owner不在 slot1 → loaded-ready；
* service owner不在 service area → loaded-ready。

这两条会让逻辑 owner 消失，而物理车辆仍留在 station corridor。

替换为：

```text
station-owner-physical-mismatch
```

critical + snapshot + stop。

### Orphan interior 自动 enter-service

从正常 runtime 中撤回。

它可以保留为：

* snapshot migration utility；
* 单元测试 fixture 修复；
* shadow diagnostic suggestion。

不能作为生产行为。否则任何误入 interior 的车辆都可能绕过 queue contract获得 service。

### Physical slot order beats lease age

撤回这项控制行为。

替换测试：

```text
physical order 与 coordinator queueSeq 不一致
=> invariant violation
```

不能用物理错误状态重新定义 FIFO。

### Derived lease ownership

任何从以下字段推导出的 outbound lease只能作为 shadow observation：

* `currentNodeId`
* `targetNodeId`
* `plannedGoalNodeId`
* route tail
* `localRouteReason`

远端旧实现就是通过 task scan 与这些 route fields 选择 outbound queue goal。

### Self-goal hold

继续确保 coordinator 模式不会进入旧的“route/target 都设为当前节点”的 station hold。远端旧逻辑确实有这种行为。

---

# 8. 下一步最小实现

建议提交范围命名为：

> `refactor(sim-core): make outbound station envelope pass authoritative`

严格只做以下内容。

## R3.1 Station envelope pass

1. 为每个 outbound station定义静态 `OutboundStationTopology`。
2. 验证并区分：

   * `preGateHoldNodeId`
   * `entryGateNodeId`
   * `serviceNodeId`
   * `clearThroughNodeId`
   * envelope nodes/edges/conflict groups
3. 将 slot/service 分散 ownership改成一个持续的 `envelopeOwnerRequestId`。
4. loaded vehicle 无 pass 时只能到 pre-gate。
5. station 发 pass 时原子完成：

   * 设置 envelope owner；
   * 设置 active pass；
   * 将 envelope 对非 owner关闭；
   * 安装 gate→service route。
6. lower complete 后：

   * 不释放 owner；
   * pass phase改为 clearing；
   * 安装 service→clear-through route。
7. clear-through arrival 后释放。
8. 删除正常 runtime中的 owner demotion/orphan service recovery。
9. station pass异常立即 critical，不调用 generic deadlock recovery。
10. depth/WIP 继续保持 1。

---

# 9. 测试 gate

## 单元/确定性 gate

必须增加并全部通过：

### Gate A：边界与 interior

```text
loaded outbound at pre-gate
envelope free
=> 同 tick获得 pass
```

```text
loaded outbound无 pass
=> 不得进入 entry gate
```

```text
vehicle inside envelope无 pass
=> critical
```

### Gate B：cross traffic

构造：

```text
outbound AMR at pre-gate
inbound AMR route 经过 c21/shared approach
```

要求：

1. outbound取得 envelope pass；
2. inbound停在 envelope 外的安全节点；
3. outbound到 service并 lower；
4. outbound clear-through；
5. envelope release；
6. inbound恢复；
7. 无 `node-occupied` 循环；
8. 无 generic deadlock breaker。

### Gate C：service lifecycle

```text
lower-complete 后 envelope 仍归 outbound owner
clear-through arrival 后才 release
```

### Gate D：无 owner demotion

在 entering/servicing/clearing 任意中间 node：

```text
reconcile 不得将 owner降为 loaded-ready
```

### Gate E：restore

snapshot→restore 后必须保持：

* request state；
* pass id；
* pass phase；
* envelope owner；
* progress timestamps；
* sequence；
* 后续事件 hash。

## 10m smoke

必须满足：

```text
completedOutbound > 0
physicalViolationCount = 0
stationInvariantViolationCount = 0
stationGrantLivenessViolation = 0
stationPassTimeout = 0
stationAwaitInsideEnvelope = 0
unownedEnvelopeOccupancy = 0
nonOwnerEnvelopeTarget = 0
genericStationDeadlockRecoveryCount = 0
```

并且没有：

* station node-ping-pong；
* > 60 秒 loaded station wait；
* pass 无进展超过预算。

## 30m gate

不能只看最终 PPH。增加阶段时长与 rolling liveness gate：

```text
每个已 admitted outbound request
必须在 cycle budget 内完成或明确 cancelled
```

Cycle budget建议动态计算：

```text
pickup route ETA
+ pre-gate route ETA
+ envelope entry ETA
+ lower time
+ clearance ETA
+ 30s tolerance
```

同时要求：

* 10–20m 至少有 outbound completion；
* 20–30m 至少有 outbound completion；
* 每个 5m saturated-demand window 的 outbound completion > 0；
* `max WAITING_AT_GATE age` 不超过 station cycle budget；
* `max ENTERING age` 不超过 pass ETA + 10s；
* `max CLEARING age` 不超过 clearance ETA + 10s；
* 最后 10m outbound PPH 不低于中间 10m 的 90%；
* waiting vehicle 数量没有连续三个采样点单调增加；
* physical/station critical 均为 0。

R2.1d/e 会被这些 gate 很早拦截，而不是到 30m 才通过 long-wait window发现。

## 1h 之前

当前 full test仍有约 28 个失败。可以继续做定向 10m/30m 架构验证，但在 1h gate 前必须：

* full sim-core 相比 R3.1 前没有新增失败；
* station/traffic/snapshot/movement/reservation 相关测试全部绿色；
* 已知失败有明确 baseline清单。

---

# Stop conditions

出现以下任一情况，立即停止，不加 fallback：

1. 车辆进入 station envelope但没有 pass；
2. physical occupant与 envelope owner不一致；
3. owner被 reconcile 自动降级但车辆仍在 envelope；
4. station-await出现在 pre-gate 之外；
5. non-owner获得 envelope 内 node/edge target；
6. active pass超过 expected budget无 progress；
7. generic deadlock breaker修改 station owner路线；
8. lower complete时提前释放 envelope；
9. 一个 loaded-ready车辆在 envelope 空闲时超过一个 tick拿不到 pass；
10. 30m depth=1仍有 phase age超限。

只有当 depth=1 连续通过 30m 和 1h，并且没有任何 ownership/liveness 异常，但 PPH仍因 station idle偏低时，才能增加：

```text
max work admission: 1 → 2
```

仍不得增加 station interior occupancy。第二个 request只能在安全 pre-gate 外排队。

---

## 最终 reviewer 决议

**保留 R2.1 的 request、grant、work admission、await cleanup 和 snapshot方向；撤回 owner demotion、orphan auto-service、physical-order head correction；下一刀将 boundary→service→clear-through 变成一个持续、权威、容量为 1 的 station envelope pass。**

当前失败不是需要更多 FIFO heuristic，而是 station contract在 `boundary` 与 `service/clearance` 之间仍然有一段物理世界没有 owner。

