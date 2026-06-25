## 结论

这不是“站台应该拥有多长的 approach lane”问题，而是一个更窄、更基础的契约缺口：

> **`module-02-spine-middle` 是 no-stop 冲突区，但当前系统没有在进入前原子获得“穿过公共节点并到达下一合法停靠点”的 clear-through permit。**

站台 coordinator 应当拥有需求、排队、服务顺序；**no-stop spine 的通行权必须由拓扑级 traffic resource 持有**。Wait-for graph 负责识别 SCC 和触发恢复，但不应取代正常通行许可。

---

# 1. 根因判断

## 1.1 SH-07 / SH-08 是端点互换，不是普通 station queue 冲突

最终关系是：

```text
SH-02 ──> SH-07 <──> SH-08
```

真正的 SCC 只有：

```text
SH-07 <──> SH-08
```

空间关系大致是：

```text
SH-07: column-middle-c21
       -> module-02-spine-middle
       -> module-02-spine-bottom-a   // SH-08 当前所在

SH-08: module-02-spine-bottom-a
       -> module-02-spine-middle
       -> column-middle-c21          // SH-07 当前所在
```

它们不是争抢一个可停车 queue slot，而是在容量为 1 的 no-stop 公共节点两侧尝试互换端点。没有一辆车先横向让入合法 hold pocket，这个状态在物理上不可解。

当前 `agentRefreshNoStopContinuationBlock` 只是查看目标 no-stop 节点之后的一个节点是否已占用或正被 targeting；它没有原子提交“公共节点 + continuation + 首个合法 hold”的整个 clear-through movement。于是两个车辆可以先各自保有一个端点，最后互相等待。

因此：

* `physicalViolations = 0` 表明安全层工作正常。
* deadlock 和 station wait-for cycle 表明活性层、资源所有权和恢复契约失败。
* 把 station active visit 扩大到 broad approach ownership，只会把局部 no-stop 冲突扩散成站台级互斥，与你们三次 rejected run 的 PPH 崩塌完全一致。

## 1.2 当前 wait-for 棰测会把 SH-02 错当成 cycle member

`deadlockCandidateVehicleIds()` 不是 SCC 算法。它从每个 waiter 沿单一 blocker 链向前走，一旦发现重复，就把整个 `seen` 集合全部加入 cycle。对于：

```text
SH-02 -> SH-07 -> SH-08 -> SH-07
```

它会把 SH-02、SH-07、SH-08 全部标成 cycle，尽管 SH-02 只是 SCC 上游的排队者。

与此同时，no-stop candidate collector 只是收集所有满足 wait reason 和节点条件的车辆，没有先缩减到真实 SCC。

这会产生三个后果：

1. breaker 可能先处理 SCC 外的 SH-02；
2. pairwise heuristic 可能选择与真正 cycle 无关的恢复；
3. 某个“看似成功”的恢复返回 `true` 后，本 tick 结束，但 SH-07/SH-08 仍保持闭环。

## 1.3 breaker 存在全局饥饿

`tryBreakAgentRefreshWaitCycle()` 排在多种全车队恢复动作之后。前面任意一个 recovery 返回 `true`，函数就立即退出，本 tick 不再检查 no-stop cycle。

这不是单纯的函数顺序问题，而是调度模型错误：

* 恢复动作按“函数优先级”串行；
* 没有按物理 resource region 分区；
* 没有保证已持续存在的 SCC 最终获得执行机会；
* 一个完全无关区域里的持续小恢复可以无限压制 module-02 的恢复。

## 1.4 即使 breaker 被调用，也可能无声失败

`tryYieldEmptyBottomASpineAwayFromNoStopCycle()` 包含大量布尔 guard，并且 yield pocket 必须通过 `agentRefreshLocalRouteNodesClear()`。

但 `agentRefreshLocalRouteNodesClear()` 只返回 `boolean`。它把以下原因全部压扁成同一个 `false`：

* 当前物理 occupant；
* `nodeClaimedByOtherVehicle`；
* 普通 node reservation；
* reservation 时间窗重叠。

所以现在无法区分：

```text
没有合法 pocket
pocket 被真实车辆占用
pocket 被 planned/local claim 占用
pocket 被过期或过宽的 reservation 占用
route 合法，但某个 station-derived claim 阻止了它
```

## 1.5 成功安装的 yield route 也可能在下一 tick 被覆盖

side-yield breaker 会直接改写 `routeNodeIds`、`targetNodeId`、`localRouteNodeIds` 和 `localRouteReason`。

但是正常 route planner 只在 committed local route 仍被判定 clear 时才继续使用它；否则会退回 nominal/planned route。

而 `installAgentRefreshPlannedRoute()` 会清空 `localRouteNodeIds` 和 `localRouteReason`。

所以可能出现：

```text
tick N:
breaker returns true
temporary-yield route 已安装

tick N+1:
一个 claim/reservation 使 committed local route 判定不 clear
正常 planner 重装 planned route
temporary-yield 被无声覆盖
SH-07/SH-08 再次形成同一循环
```

## 1.6 为什么 unit test 过，但 1h 仍失败

现有 focused test 直接调用：

```ts
tryBreakAgentRefreshWaitCycle([...])
```

然后立即检查 route 是否已被修改；它没有继续经过完整 tick、全局 recovery 调度、reservation 变化、下一 tick replanning 和 action completion。

甚至“loaded middle-access 在 distractor 前处理”的测试，也是手工传入 candidate list 后直接调用 breaker，并未验证真实 `updateDeadlockSmokeCounters()` 调度路径。

因此测试证明的只是：

> 在一个静态、人工构造、无隐藏动态 claim 的瞬间，某个 heuristic 能找到一条 route。

它没有证明：

* candidate collector 会选中正确 SCC；
* breaker 本 tick 会被调度；
* route 不会被覆盖；
* reservation 不会阻止第一步；
* loser 实际开始移动；
* winner 最终穿过；
* cycle 不会重新形成。

## 1.7 为什么 10m/30m 过，而 1h 才失败

原因不是 1h 使用了不同物理模型，而是当前控制是**反应式恢复，而非预防式 admission**。

10m/30m 尚未碰到这一精确相位组合：

* loaded outbound 到达 middle access；
* empty pickup/reposition 同时到达 bottom-a spine；
* 双方 continuation 分别被对方当前节点占住；
* lateral pocket 又受动态 claim/reservation 影响；
* 同时其他区域存在 recovery 活动。

一旦运行时间足够长，任务波、station queue、storage exit 和空车 reposition 的相位逐渐错开，命中这个稀有状态只是时间问题。

基线 deadlock 计数只有在 candidate 至少持续 30 秒后才增加，因此 `deadlocks = 1` 不是最后一两个 tick 的瞬时快照，而是一个已经持续存在的控制失败。

另外，当前 audit 默认每 5 秒采样，`longWaitSec=300`、`stationaryActiveSec=540`。这些阈值适合长周期 AMR 行为审计，不适合判定 no-stop resource 是否在几秒内失去活性。

---

# 2. 最小架构改动建议

## 2.1 采用四层资源契约，而不是单一 station ownership

建议明确以下所有权：

| 层                    | 权威 owner                   | 含义                         |
| -------------------- | -------------------------- | -------------------------- |
| Demand ledger        | Station coordinator        | 哪些 inbound/outbound 服务需求存在 |
| Queue lease          | Station coordinator        | 哪辆 AMR 被预留给哪个 station/slot |
| Physical occupancy   | 3D world state             | 节点、边、footprint 当前真实占用      |
| Service lease        | Station coordinator        | 哪辆 AMR 当前获得装卸服务            |
| Clear-through permit | **NoStopRegionKernel**     | 谁可以穿过某个 no-stop 冲突区        |
| Recovery action      | Traffic recovery scheduler | 已形成 SCC 时谁让行、让到哪里          |

现有 shadow station contract 已经分别统计 demand、queue reservation、physical occupancy、active service 和 route lease，这部分方向是正确的，应继续扩展，而不是推倒重做。

## 2.2 新增一个很窄的 `NoStopConflictRegion`

每个 `module-XX-spine-middle` 定义一个拓扑资源，例如：

```ts
type NoStopRegionState =
  | { mode: 'free' }
  | { mode: 'leased'; permit: ClearThroughPermit }
  | { mode: 'recovering'; action: RecoveryAction };

type ClearThroughPermit = {
  id: string;
  regionId: string;
  vehicleId: string;
  entryNodeId: string;
  noStopNodeId: string;
  exitHoldNodeId: string;
  routePrefix: string[];
  navigationRevision: number;
  issuedAtTick: number;
  progressDeadlineTick: number;
};
```

`routePrefix` 必须覆盖：

```text
当前位置/入口
-> no-stop 公共节点
-> continuation
-> 第一个允许停止的节点
```

只有当整个 prefix 同时满足以下条件时才能 grant：

* 无其他 conflicting permit；
* 所需出口不是被不能移动的 incumbent 占用；
* node/edge/zone reservation 可满足；
* swept footprint 安全；
* 最终节点允许 hold。

这不是 DES。车辆仍然在每个 3D tick 中连续运动，permit 只是进入冲突区前的离散通行授权。

## 2.3 已经形成 SH-07/SH-08 状态时，permit 本身不够

双方已经分别占住对方需要的出口。因此 region kernel 应先进入：

```text
recovering
```

选择 yielder，并生成一个有生命周期的 `RecoveryAction`：

```text
observed
-> selected
-> route-installed
-> first-leg-started
-> conflict-cleared
-> completed
```

winner 只有在 yielder 离开其 continuation 后，才获得 clear-through permit。

## 2.4 SH-07 与 SH-08 的优先级

推荐决策顺序：

1. **已进入冲突区者先完成撤离**；
2. 已持有且仍有效的 permit；
3. 能否为 loser 找到真实可执行的合法 lateral hold；
4. loaded service movement 优先于 empty pickup/reposition；
5. waiting age；
6. vehicle ID 作为确定性 tie-break。

因此在你描述的典型状态中：

* SH-07：loaded、正在向 outbound dropoff 清货；
* SH-08：empty、向上去 pickup；
* SH-08 存在安全 lateral bottom-a hold；

则应让 SH-08 横向退出，SH-07 获得 permit。

但不要硬编码“loaded 永远获胜”。若 SH-08 已经进入 region，或者只有 SH-07 能安全进入旁侧 storage pocket，则可执行性必须高于业务优先级。

站台只向 region kernel 提交：

```text
priorityClass = loaded-outbound-service
stationVisitId
waitingAge
```

它不直接拥有 bottom-a、middle column 或 broad throat。

## 2.5 长期拆分 `OutboundStationRuntime`

当前 runtime 同时包含：

* `activeVisitRequestId`
* `envelopeOwnerRequestId`
* `slotOwnerRequestId`
* `serviceOwnerRequestId`
* `activeTransition`
* `drainEpoch`

这些属于四个不同资源域，却被放在一个可任意组合的 mutable object 中。

长期应拆为：

```text
OutboundDemandQueue
OutboundSlotLease
OutboundServiceLease
TrafficClearThroughPermit
```

但这不是当前 SH-07/SH-08 修复的前置条件。当前最小改动就是先增加 no-stop region permit，停止扩大 station envelope。

---

# 3. 下一步最应该加的 instrumentation

## 3.1 证明 breaker 未调用

每个 tick 记录：

```ts
{
  type: 'no-stop-recovery-dispatch',
  tick,
  regionId,
  observedWaiters,
  exactSccVehicleIds,
  upstreamWaiterIds,
  candidateVehicleIds,
  breakerScheduled: boolean,
  breakerInvoked: boolean,
  priorRecoveryThatConsumedTick: string | null
}
```

判据：

```text
cycleObserved=true
&& exactScc=[SH-07,SH-08]
&& breakerInvoked=false
```

若同时存在 `priorRecoveryThatConsumedTick`，就直接证明是全局 early-return starvation。

## 3.2 证明 breaker 调用但返回 false

所有布尔 helper 改为可解释结果，至少在 diagnostics 模式：

```ts
type RecoveryAttemptResult =
  | { ok: true; actionId: string; routeNodeIds: string[] }
  | {
      ok: false;
      stage:
        | 'candidate-guard'
        | 'priority'
        | 'pocket-enumeration'
        | 'route-contract'
        | 'physical-clearance'
        | 'claim-clearance'
        | 'reservation-clearance';
      code: string;
      resourceId?: string;
      blockingVehicleId?: string;
      blockingReservationId?: string;
  };
```

尤其要把 `tryYieldEmptyBottomASpineAwayFromNoStopCycle()` 每个 guard 的真假和每个 pocket rejection 原因记录下来。

判据：

```text
breakerInvoked=true
&& result=false
&& reject stage/code 明确
```

## 3.3 证明 recovery route 被覆盖

为每辆车增加：

```ts
navigationRevision: number
lastNavigationWriter: string
lastNavigationActionId: string | null
```

所有关键 route 写操作必须经过统一入口：

```ts
commitNavigationMutation(vehicle, {
  writer,
  actionId,
  previousRouteHash,
  nextRoute,
  reason
});
```

第一批必须覆盖：

* `installAgentRefreshSideYieldRoute`
* `installAgentRefreshPlannedRoute`
* `restoreMissingTaskRouteAtCurrentNode`
* outbound station transition route
* taskless storage/standby dispatch
* conflict-session unwind

breaker 成功时保存：

```text
actionId
installedRevision
installedRouteHash
```

在：

* 本 tick 结束；
* 下一 tick pre-advance；
* 下一 tick post-advance；
* 后续 2/5 tick；

检查 revision。

证明被覆盖的条件：

```text
recovery action = route-installed
&& vehicle 尚未开始第一步
&& navigationRevision > installedRevision
&& lastNavigationActionId !== recoveryActionId
```

必须打印覆盖它的具体 writer，而不是只报“route changed”。

## 3.4 证明被隐藏 reservation/claim 阻塞

把 `agentRefreshLocalRouteNodesClear()` 保留为便捷 boolean wrapper，但底层增加：

```ts
explainAgentRefreshLocalRouteClearance(...)
```

输出每个 route node 的：

* physical occupant；
* moving target claimant；
* local-route claimant；
* node/edge/zone reservation；
* reservation ID、owner、reason、start/end；
* station queue/service lease；
* no-stop permit；
* conflict recovery action。

目前这些原因全部被压成 `false`，这是最需要修复的 observability 缺口。

## 3.5 增加 region-scoped ring buffer

不要依赖 5 秒 audit snapshot。为每个 no-stop region 保留最近 30 秒的内存 ring buffer：

```text
occupancy
route tails
target claims
reservations
permits
wait-for edges
route mutations
recovery attempts
```

首次形成 SCC 时自动写 checkpoint，保留形成前 10 秒和形成后 20 秒。

## 3.6 统一最终 verdict

当前 handoff 出现：

```text
critical anomaly count = 0
station contract = critical wait-for cycle
```

这是报告聚合错误。以下任意来源出现 critical，都必须进入同一个：

```text
runVerdict = failed
```

来源包括：

* physical safety；
* no-stop region contract；
* station contract；
* wait-for SCC；
* permit leak；
* recovery overwrite；
* AMR long-stuck/small-loop。

---

# 4. 具体代码路径的修改优先级

## P0：先建立可证伪证据，不改变通行行为

### `packages/shuttle-sim-core/src/index.ts`

1. 将 wait-for 检测改为真正的 Tarjan SCC。
2. 明确区分：

   * `exactSccVehicleIds`
   * `upstreamWaiterIds`
3. 加 breaker dispatch trace。
4. 将 route-clear boolean 改为 explainable result。
5. 增加 `navigationRevision` 和 route mutation journal。
6. 增加 recovery action lifecycle。

### `packages/shuttle-sim-core/src/index.test.ts`

增加四类测试：

* 真实 `step()` 驱动的 SH-07/SH-08 场景，而非直接调用 private breaker；
* 加入 SH-02 作为 SCC 上游 waiter，验证它不被算作 cycle member；
* 加入另一个无关区域的持续 recovery，验证 no-stop breaker 不会饥饿；
* 分别注入 occupancy、local claim、node reservation、edge/zone reservation，验证 rejection code。

## P1：修复 recovery 调度

停止在 `updateDeadlockSmokeCounters()` 中使用“第一个 recovery 成功就全局 return”的模型。

改为：

```text
detect all recovery proposals
-> group by resource region
-> select at most one action per region
-> commit mutually non-conflicting actions
```

至少必须保证：

* module-01 的恢复不能压制 module-02；
* SCC persistence 越长，调度优先级越高；
* 同一 SCC 不能连续安装无进展动作；
* upstream waiter 不参与 yielder 选择。

## P2：shadow-mode `NoStopRegionKernel`

在 `agentRefreshNoStopContinuationBlock()` 附近计算 shadow decision：

```text
legacy blocker result
shadow permit decision
actual movement outcome
```

记录 divergence，但暂不影响车辆。

Shadow 模式要求同 seed 下运动、完成任务和关键 event hash 与 accepted baseline 一致。

## P3：窄范围 authoritative cutover

只对拓扑识别出的：

```text
module-XX-spine-middle conflict region
```

启用 authoritative clear-through permit。

替换的是 no-stop admission 决策，不是：

* broad station approach；
* bottom-a storage exits；
* ordinary middle aisle；
* 所有 outbound routes。

原有 physical occupancy、reservation、swept-footprint collision check 保持最终安全 authority。

## P4：再整理 station runtime

等 no-stop region 通过 1h/12h 后，再拆分 station runtime 的多 owner 字段。不要把这次修复演变成一次大范围 station rewrite。

---

# 5. 应停止继续打补丁的方向

1. **停止 active visit 拥有 broad approach、throat 或 bottom-a storage exit。** 三次 rejected run 已经给出充分反证。

2. **停止为具体 SH 编号、节点组合或 wait reason 增加更多 pair-specific `if`。** 这会继续扩大 heuristic 顺序依赖。

3. **停止把 planned route、FIFO head 或 active visit 直接当作 physical lease。** 计划、排队和空间所有权是不同资源。

4. **停止让 breaker 直接改 route 后立即返回成功，却没有 action lifecycle 和 postcondition。**

5. **停止只调整 breaker 函数顺序。** 把 no-stop breaker临时挪到最前面可以作为诊断实验，但不是最终架构；最终必须按 resource region 调度。

6. **停止依赖 300 秒 long-wait 指标发现 no-stop deadlock。** 对 no-stop SCC 来说，几秒已经是控制失败。

7. **停止用放松 no-stop、collision、footprint 或 reservation 检查换 PPH。** 当前 safety 是有效的，不能牺牲它修 liveness。

8. **停止在 1h canonical failure 没过之前跑 12h/24h。**

---

# 6. 验证 ladder 和 stop rule

以下阈值建议作为第一版 gate；A 必须是相同 seed、相同配置的 accepted restore baseline，B 是候选改动。

| 阶段  | 必做验证                                                                       | Pass gate                                                                                                          | Stop rule                                                                                      |
| --- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| 微场景 | SH-07/08；加入 SH-02 tail；无关 recovery；四种 reservation/claim；强制 route overwrite | exact SCC 只含 07/08；1 tick 内产生 action；action 实际开始并完成；所有 rejection 可解释                                               | 任一不可解释 `false`、route 无声覆盖、错误选择 SH-02                                                           |
| 10m | canonical seed + 至少 2 个 alternate seed；shadow 与 active 分开                  | physical=0；critical=0；permit leak=0；未处理 SCC 不超过 1 tick；active total PPH ≥ A 的 95%，每方向 ≥ A 的 90%                    | total PPH < A 的 90% 或任一方向 <80%；任何 physical/critical；任何 recovery overwrite                      |
| 30m | 同配置 A/B；检查每个 10m AMR 窗口                                                    | 结束时无 wait cycle；无 unresolved action；总 PPH ≥ A 的 95%；无连续 backlog 增长                                                 | 同一 region SCC 重复形成且原因相同；连续 3 个 10m backlog 上升；PPH <90% A                                       |
| 1h  | 当前失败 seed 必须通过，另加 2 seeds；当前 seed 重复运行应完全确定                                | deadlock=0；station/no-stop critical=0；physical=0；permit/action leak=0；总 PPH ≥ A 的 95%（当前 A≈459，即约436）；每方向 ≥ A 的90% | 任意 SCC 未在动作安装后 2 ticks 内消失；no-stop 无进展 >30s；任一 active AMR 连续 3 个 10m 窗口零完成且持续 assigned/blocked |
| 12h | 至少 2 seeds；逐小时 PPH、queue slope、P95/P99 waits、per-AMR windows               | 所有安全/契约项为0；最后6小时 queue 无正斜率；每小时 PPH 无持续衰减；无累计 permit/recovery 泄漏                                                   | 连续2小时 PPH < A 的85%；连续3小时 backlog 增长；任何 critical、permit timeout 或相同 SCC recurrence storm        |
| 24h | canonical customer candidate；建议另一个 seed 至少跑12h                             | 24h physical/critical/deadlock=0；最终无 cycle；总 PPH ≥ A 的95%；各小时分布稳定；per-AMR 无异常长期失衡；3D checkpoint 无视觉违约              | 任一 hard safety/contract failure；任何 unresolved action；队列非稳态增长；小时吞吐持续下降                          |

额外要求：

* **Shadow 模式**：除新增 diagnostics 外，相同 seed 的运动与任务结果应与 A 一致。
* **Active 模式**：首次 diverge 必须能由 permit grant/reject 或 recovery action 解释。
* 3D 视觉检查至少覆盖：

  * first permit grant；
  * SH-08 lateral yield；
  * SH-07 clear-through；
  * recovery completion/rejoin；
  * 1h、6h、12h、24h checkpoint。

最终判断是：

> 站台 coordinator 方向没有错，但它不应拥有 SH-07/SH-08 所争的 spine。应由窄范围 `NoStopConflictRegionKernel` 原子授予 clear-through permit；真实 SCC scheduler 负责异常恢复；station 只提供服务优先级。当前最先该做的不是再加 movement exception，而是把“是否调用、为何失败、是否被覆盖、被谁 reservation 阻塞”四件事变成可直接证明的运行证据。
