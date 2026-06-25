# ChatGPT Pro Review Response - 2026-06-24 Round 11

- Source conversation: `https://chatgpt.com/c/6a3c2970-b70c-83ea-988b-315e46dfb629`
- Submitted context: `docs/chatgpt-pro-review-handoff-2026-06-24-round10.md` plus local V7 validation summary.
- Note: ChatGPT Pro confirmed it could only inspect GitHub HEAD, not this uncommitted local WIP. Treat comments about V7 as review of the provided evidence, not direct code inspection.

## Response

审查结论

暂不批准进入 2h/8h/24h physical run，也不建议回滚整个 V7。

我的判断是：

- V7 的主方向正确，确实修复了一个真实的仲裁顺序 bug。
- 新增的 reciprocal-storage-swap 失败应当视为一个尚未分类的 P0 regression，不能仅凭净减少 7 个失败就忽略，但它很可能是“旧测试过度约束动作顺序”，而不一定是真安全回归。
- 剩余 12 个失败不是 12 个独立 pathing bug。大部分来自三个尚未落地或只落地一半的控制边界：VehicleIntent、StationLease、ConflictSession。
- 下一步应暂停按失败名称继续加分支，先用小规模 PR 实现最小 controlling intent/resource layer，再迁移现有逻辑，不需要大改重写。
- 还有一个需要立即纳入 P0 的远端 HEAD 问题：OutboundStationRuntime、request/transition sequence 已经是控制状态，但没有进入 ShuttleEngineSnapshotV1。因此当前 snapshot hash 无法覆盖完整的 station controlling state，active station pass 期间 snapshot/restore 可能表面 hash 正常、后续决策却分叉。

### 1. V7 是真实修复，还是 unsafe priority inversion？

当前判定：

V7 确实修了真实 bug，但新失败尚不能直接标为 stale。

远端 HEAD 的顺序是：

- `agentRefreshFirstTargetClaimBlocker` 看到 first target 已被占用或声明。
- 立即 `agentSetWaiting()` 并返回。
- 后面的 `agentRefreshHandleMoveBlock()` 根本没机会建立 side-yield / ConflictSession。

也就是说，first-target claim 这个本应作为“冲突输入”的信息，被提前当成了最终控制决策。后面的通用 move-block 才真正包含 side-yield 安装和 ConflictSession 仲裁。

所以 V7 应保留的语义是：

> first-target claim 生成 blocker，但不能绕过统一冲突仲裁直接决定 wait。

但 unsafe inversion 仍然可能发生。现有代码在初始 yielder 无法安装 side-yield 时，可以交换 winner/yielder；而全局优先级主要由 loaded、task、waiting、task age 等字段计算，并没有把 StationLease/FIFO ownership 当成第一权威。

如何明确区分：

对 reciprocal-swap fixture 做 V6/V7 同 seed 的 first-divergence trace。第一处动作不同前，必须记录：

- 两台 swap AMR 和 follower 的 intent、task、loaded、current/target。
- queue slot、service、physical node/edge 的 authoritative owner。
- FIFO sequence。
- active ConflictSession 及 winner/yielder。
- wait-for graph 的 SCC。
- 是否产生 `conflict-session-reassigned`。
- follower 下一跳与 swap contested resource set 是否相交。

判定标准：

| stale expectation | unsafe inversion |
| --- | --- |
| follower 使用的是与 swap 完全不相交的 node/edge/queue resource | follower 占用了 swap 任一参与者完成解除所需的 node/edge/pocket |
| station FIFO、service owner、physical owner 均不变化 | queue follower 越过 predecessor，或 active service/queue head 被迫 yield |
| swap 在 12 秒 deadline 内仍被正常解除 | session 超时、wait-for SCC 扩大，或 swap 解除时间恶化 |
| 没有 hard duplicate owner、穿模、off-grid | 出现硬 ownership 冲突或 physical anomaly |
| 测试原来只断言“必须先清 swap，再动 follower” | 原测试断言的是明确资源依赖或 FIFO 约束 |

建议把该测试改成契约断言：

```text
follower may move
IFF followerNextResources ∩ swapResolutionResources = empty
AND station/FIFO authority permits it
AND swap resolves before ConflictSession deadline
AND no new wait-for SCC is created
```

在这组 trace 完成前，V7 可以保留在分支上，但不能进入长跑。

### 2. 剩余 12 个失败的性质

它们不是同一个 bug，但明显不是 12 个独立 pathing bug。

| 类别 | 对应失败 | 判断 |
| --- | --- | --- |
| StationLease / active service ownership | 1、2、5、6 | 同一控制面问题 |
| VehicleIntent / post-service / parking ownership | 3、4、9 | intent 缺失或从路径推导 |
| ConflictSession / temporary yield / physical lease | 7、8、12 | 同一仲裁边界问题 |
| 路径与资源约束混合 | 4、11 | 路由器缺少明确的占用输入 |
| 独立模型/spec | 10 | capacity 公式，不应混入交通修复 |

所以大约可以看成：

- 9 个 contract-dominant。
- 2 个 contract + routing 混合。
- 1 个纯 capacity/spec。

当前最危险的是 station 存在双控制源：

- StationKernelDiagnostics 的 schema 明确写着 `mode: 'shadow'`。
- 但实际控制查询会刷新这个 shadow，并用其 head queue lease 决定 throat grant。
- 同时 OutboundStationRuntime 又独立维护 envelope/service owner，并按另一套 request sequence 选择下一个 transition。

这实际上是两套 FIFO/order authority。失败 1、2、5、6 很可能就是两套控制面在边界时刻给出了不同答案。

### 3. 下一步：继续小 contract groups，还是先做 controlling layer？

暂停行为特例 patch，先实现 minimal controlling layer；但仍然按小 contract groups 提交。

不是大 rewrite，建议分三个连续的迁移组：

Contract Group A：VehicleIntent + atomic assignment

目标：

- 每台车最多一个 active controlling intent。
- assignment 必须一次提交 task、vehicle、intent、route 或 explicit hold。
- route 不可用时，task 保持 queued；不得出现 assigned + no route + no hold。
- 把 intent 和 sequence 纳入 snapshot/hash。

远端现在的 assignment 是依次释放 queue lease、修改 vehicle、安装 route、修改 task、再建立 outbound request，不是一个明确事务。

Contract Group B：统一 StationLease

目标：

- 选择一个 station authority。
- inbound queue、outbound queue、service envelope、clear-through 都由同一 lease registry 控制。
- StationKernel 不再以 shadow 名义参与控制。
- OutboundStationRuntime 可以保留，但它必须成为 StationLease 的状态机，而不能再有第二套 owner/FIFO。

Contract Group C：ConflictSession 只消费 intent/lease

目标：

- ConflictSession 不能覆盖 station ownership。
- yield 是原 intent 的临时 child intent。
- deadlock detector 只观察和确认；recovery 作为独立 command 执行。

当前 `updateDeadlockSmokeCounters()` 在建立 confirmed observation 前先执行大量 recovery side effect，然后才识别 cycle 和累计 deadlock，这会让“发现了什么”和“修了什么”不可区分。

### 4. 最小数据模型和 lifecycle

下面已经足够，不需要先构造通用资源框架。

```ts
type VehicleIntent = {
  id: string;
  generation: number;
  vehicleId: string;
  kind:
    | 'task'
    | 'station-queue'
    | 'station-service'
    | 'station-clear'
    | 'yield'
    | 'park'
    | 'hold';
  phase:
    | 'committed'
    | 'executing'
    | 'holding'
    | 'completed'
    | 'cancelled';
  taskId: string | null;
  stationId: string | null;
  goalNodeId: string | null;
  routeNodeIds: string[];
  hold: null | {
    reasonCode: string;
    resourceKey: string;
    blockingOwnerId: string | null;
  };
  parentIntentId: string | null;
  commitSeq: number;
  lastProgressTick: number;
};

type StationLease = {
  id: string;
  generation: number;
  stationId: string;
  vehicleId: string;
  intentGeneration: number;
  taskId: string | null;
  requestId: string | null;
  kind:
    | 'queue-slot'
    | 'service-envelope'
    | 'clear-through';
  resourceKeys: string[];
  slotIndex: number | null;
  fifoSeq: number | null;
  phase:
    | 'reserved'
    | 'occupied'
    | 'active'
    | 'releasing';
  issuedAtTick: number;
  lastProgressTick: number;
};

type PhysicalLease = {
  resourceKey: string;
  vehicleId: string;
  intentGeneration: number;
  phase: 'occupied' | 'entering';
  acquiredAtTick: number;
};

type ConflictSession = {
  id: string;
  resourceKeys: string[];
  participantVehicleIds: string[];
  winnerVehicleId: string;
  yielderVehicleId: string;
  winnerIntentGeneration: number;
  yielderIntentGeneration: number;
  authority:
    | 'station-lease'
    | 'physical-occupancy'
    | 'traffic-priority';
  prioritySnapshot: string;
  yieldIntentId: string | null;
  state:
    | 'open'
    | 'yielding'
    | 'holding'
    | 'resuming'
    | 'cleared'
    | 'timed-out';
  createdAtTick: number;
  lastProgressTick: number;
  deadlineTick: number;
  closeReason: string | null;
};
```

语义上：

- queueReservation 就是 `StationLease(kind='queue-slot', phase='reserved'|'occupied')`，不要另建一套表。
- physical slot occupancy 必须是独立 `PhysicalLease`。queue reservation 不等于车已经占着 slot。
- active service 是 `StationLease(kind='service-envelope', phase='active')`。
- planned route 永远不算 hard ownership。
- occupied physical lease 不允许靠 TTL 自动失效，只能在物理 move commit 时释放。

生命周期：

Assignment

- 在局部变量中规划 route 和 intent。
- 校验 route、station admission 和第一跳资源。
- 一次性 commit：`task.vehicleId + vehicle.intent + route/hold`。
- 任一环节失败，task 保持 queued。

Queue

- station 按 FIFO 先发 queue lease。
- 然后 vehicle 获得 station-queue intent。
- 到达 slot 后，queue lease 变 occupied；同时建立独立 physical occupancy。

Service

- 只有 FIFO head 且 service envelope 空闲时才能 grant。
- `reserved/occupied -> active -> releasing`。
- 车辆实际通过 clear-through node 后才能 release。

Move

- reserve target node/edge。
- commit movement。
- target 变 physical owner。
- source physical lease 释放。

这四步不能由 planned route 或 observer 重建。

Yield

- 先判断 station/physical authority。
- station owner 不允许被普通 traffic priority 覆盖。
- 合法时创建 ConflictSession 和 child yield intent。
- contested resource 真正清空后关闭 session，并恢复 parent intent。

Snapshot/observer

- intent、全部 lease、station runtime、ConflictSession 和全部 sequence 都进入 snapshot/hash。
- observer 只 clone，不 reconcile、不发 event、不做 recovery。

### 5. V7 哪些保留、哪些回退、哪些加 guard？

| V7 改动 | 结论 | physical 前的要求 |
| --- | --- | --- |
| first-target blocker 不再提前 return | 保留 | 不能简单删掉检查；必须将 blocker 送入统一 arbitration |
| bottom-lane meter clearance 对 await-transition 的窄 bypass | 不批准原样进入 physical | 必须要求 active clear-through/transition lease，且 from/to edge 都在该 lease 中；否则回退 |
| queue blocker deeper 使用真实相邻 yellow-grid route | 保留 | destination 必须已有同 station 的 queue-slot lease；projected slot 只能用于诊断，不能自行产生 ownership |
| reciprocal swap 行为变化 | 暂不回滚整个 V7 | 加 resource-disjoint/FIFO/priority guard，并完成 first-divergence trace |

特别是 bottom-lane bypass，不能仅凭：

```text
waitReason === outbound-station-await-transition
+ 当前节点/对侧节点组合
```

就获得通行权。必须有显式 station transition generation/lease。否则这是另一个从临时路径状态“涌现 ownership”的入口。

### 6. 返回 2h/8h/24h 前的验证 ladder

Gate 0：编译和全量契约

必须全部满足：

- core `tsc --noEmit` 通过。
- full suite 534/534。
- V7 focused 6/6。
- 当前 12 个 regression 全部有明确结论并通过。
- 无 skipped/todo safety test。
- route 每一跳都为相邻 feasible-grid edge。
- active station transition 中 snapshot/restore 测试通过。

522/534 时不进入 2h。

Gate 1：observer/snapshot determinism

同 seed、同 scenario，运行以下采样方式：

- 仅最终 `getState()`。
- 每 tick `getState()`。
- 每 1 秒 `getState()`，每 10 秒 snapshot。
- 每 5 秒重复 `getState()` 三次、snapshot 两次。
- 在 active queue/service/ConflictSession 中 snapshot，restore 后继续 120 秒。

在 60s、300s、600s checkpoint 必须精确相同：

- stateHash
- eventLogHash
- RNG state
- task/intent/lease/session sequence
- completed task counts
- station owner/FIFO state

现有 HEAD snapshot 没有 outbound station runtime，因此这一项必须先补，否则 hash 并没有覆盖完整控制状态。

Gate 2：短 micro physical

对以下每个 fixture 跑 30-120 秒：

- 6 个 V7 focused。
- 12 个 remaining。
- reciprocal swap 的 vehicle-ID 交换版本。
- active outbound service + trailing queue。
- inbound departure 与 outbound crossing。
- snapshot/restore during conflict。

硬门槛：

- physical violation = 0
- off-grid edge/pose = 0
- pass-through/teleport = 0
- hard duplicate owner = 0
- assigned-without-route = 0
- FIFO violation = 0
- orphan/stale lease = 0
- ConflictSession timed-out = 0
- session duration <= 当前 12 秒 deadline

2D 和 3D 必须使用同一 authoritative pose/edge。渲染插值也要做 swept-footprint 检查，不能只检查 tick 边界。

Gate 3：10 分钟 physical qualification

- 固定 8 台 shuttle。
- canonical seed 加两个相邻 seed，共 3 次。
- collision avoidance on。
- 每次都写 rolling log，失败或提前停止也必须写。

每次要求：

- 全部 Gate 2 硬指标为零。
- inbound/outbound 在存在对应 demand 时均有 completion。
- 无 critical AMR window。
- 无 AMR 在 assigned/loaded 状态连续 300 秒无进展。
- 无 station active lease 超过 expected service deadline。
- 无 unresolved ConflictSession。

审计脚本已经记录 hourly PPH、每台 AMR 每 10 分钟完成任务数、loopiness、ping-pong、long wait 和 assigned-without-route，并默认 8 台车。

Gate 4：1 小时 qualification baseline

跑 3 个 seed。前 20 分钟作为 warm-up。

定义：

- `P_ref_in`
- `P_ref_out`
- `P_ref_total`

为三次 clean run 中，20-60 分钟所有 10 分钟窗口 annualized PPH 的中位数。

若有客户批准的绝对 PPH target，则后续使用：

```text
required = max(customerTarget, relativeThreshold)
```

未给出业务最低 PPH 时，不应编造一个绝对数字。

Gate 5：2 小时

至少两个 seed。第 1 小时后：

- 每小时 total PPH >= 0.80 * `P_ref_total`
- 对于该小时内 backlog 持续至少 1800 秒的 stream：
  - inbound >= 0.70 * `P_ref_in`
  - outbound >= 0.70 * `P_ref_out`
- 不允许 backlog 存在时出现整个 10 分钟 fleet completion = 0。
- 所有硬安全指标仍为零。

Gate 6：8 小时

V7 修改 traffic arbitration，因此至少两个 seed。

额外要求：

- 每小时满足 2h 门槛。
- 任意连续 3 小时 total PPH 平均值 >= 0.90 * `P_ref_total`。
- 不允许某台 eligible AMR 在有 fleet backlog 时连续 3 个 10 分钟窗口零完成，除非每个窗口都有合法且可解释的 station queue/service lease。
- queued task 数不能连续 3 小时单调恶化。

Gate 7：24 小时

在两个 8h 均通过后运行 canonical seed。

要求：

- 所有小时满足上述门槛。
- 最后稳定 4 小时平均 PPH 不低于前一稳定 4 小时的 85%。
- H8 或 H16 checkpoint restore 后重放 30 分钟，hash 与原运行精确一致。
- 无 critical anomaly、无未关闭 session、无 stale lease。
- rolling log 包含完整 hourly PPH 和 144 个 10 分钟窗口。

AMR stuck/loop 硬门槛：

- `assigned-without-route`：立即 hard fail。现有脚本已经将其列为 critical。
- 10 分钟窗口中 path < 0.5m 且 active >= 540s：hard fail。
- blocked >= 300s：hard fail；合法 queue wait 也必须证明 predecessor/head 在进展。
- bbox <= 3m、path >= 8m、loopiness >= 6：首窗口 warn，连续两窗口 hard fail。
- unique nodes <= 3、transitions >= 6、path >= 8m：首窗口 warn，连续两窗口 hard fail。
- completed tasks = 0 且 moving >= 300s、bbox <= 3m、path >= 8m：hard fail。

这些基础阈值已经存在于 audit 脚本；当前脚本把部分 loop/long-wait 只标成 warn，长跑 gate 应提升为上述规则。

Rolling log 现有实现已能记录 reason、observed/solved、decision、PPH、hourly rows、10-minute windows、anomalies 和 output path。但应再加两个要求：

- 仿真开始前先写 `run-started`。
- 在 `finally` / `stop-on-critical` / 错误路径中更新为 `completed` / `stopped` / `failed`。

否则进程异常时，“每次验证必须留记录”仍无法保证。

### 7. 接下来明确停止做什么

- 停止按测试标题、waitReason、node-id 组合增加 bypass。
- 停止从 current/target/plannedGoal/localRoute 推导 station ownership。
- 停止把 planned route claim 当 hard physical owner。
- 停止 task 先 assigned，再依赖后续 tick 补 route/hold/lease。
- 停止让 deadlock detector 同时承担 observation、recovery 和 accounting。
- 停止让 ConflictSession 在没有 lease authority 检查时重新分配 winner。
- 停止在 full suite 未全绿或出现新 safety regression 时启动长跑。
- 停止用增加 shuttle、扩大 queue 或降低 collision 参数掩盖资源问题。
- 停止把 exact local movement sequence 当成唯一正确答案；测试应优先断言 ownership、FIFO、安全和 bounded progress。
- 停止以“净减少失败数”作为继续 patch 的依据。只要新增的是未分类 safety/priority regression，就执行 stop rule。

建议执行优先级：

- P0-A：为 reciprocal 新失败加 first-divergence trace，判定 stale expectation 或 inversion。
- P0-B：补齐 snapshot 中的 outbound runtime、intent、lease、sequence。
- P0-C：落地 atomic VehicleIntent assignment。
- P0-D：统一 StationLease authority，删除 shadow controlling reads 和双 FIFO。
- P1：ConflictSession 改为消费 intent/lease authority，拆开 deadlock observation/recovery/accounting。
- P2：534/534 后执行 determinism、micro physical、10m、1h qualification，再开放 2h。

最终建议是：保留 V7 分支方向，冻结新的局部 queue/yield patch；先完成 P0-A 到 P0-D。
