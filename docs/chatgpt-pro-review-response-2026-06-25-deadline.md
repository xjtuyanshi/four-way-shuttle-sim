# ChatGPT Pro Review Response - 2026-06-25 Deadline Pass

Source: ChatGPT Pro Extended in Chrome.

Repo reviewed: `https://github.com/xjtuyanshi/four-way-shuttle-sim`

Branch: `codex/traffic-v2-flow-debug`

Prompt included:

- `docs/chatgpt-pro-review-handoff-2026-06-25-deadline.md`
- latest pushed commit at the time: `d16e06c checkpoint: document traffic v2 station throat blocker`

Note: the response below is preserved as the external review conclusion for the unresolved station/throat blocker.

## Response

结论

是。剩余失败的主因是 station-pair / throat 的资源契约和状态生命周期错误，不是单点 pathfinding。 我对此判断的置信度约为 85%。

最有力的证据是：c01/c02 的局部恢复修复后，12,000 秒 gate 已经做到 deadlock、livelock、station critical、AMR critical 全部为零；但 6h run 在 16,200 秒首先暴露的是 exclusive lease 有 foreign occupant、lease progress timeout，同时 SH-05 出现 loaded-moving、无 edge、无 wait、零移动。此时 physical violations 和 deadlocks 仍然是零。路径搜索无法解释“同一个资源同时被称为 exclusive，又允许别的车辆占据”这种矛盾。

更具体地说，SH-05 很可能走进了下面这个半 tick 振荡：

advanceVehicles() 已经执行完。

tick 末尾的 updateDeadlockSmokeCounters() 调用 tryClearOutboundStationAwaitTransitionBottomLaneBlockers()。

installer 给 SH-05 写入一跳 clearance route，设置 state='loaded-moving'，清空 waitReason，但没有启动 edge。

下一 tick，agentGoalNodeId() 并不承认 outbound-station-await-transition-clearance 是 authoritative goal；它先看到车辆仍在 awaiting transition，于是返回 null。

holdOutboundStationAwaitTransition() 又把刚安装的 route/local route 清掉。

tick 末尾 recovery 可能再次安装同一 route。

当前 tick 顺序确实是 movement 在前、deadlock recovery 在后；clearance installer 也确实只写 route/state 而不启动 edge；而 goal logic 只特别承认 bottom-lane-meter-clearance，不承认这个 outbound clearance reason。

这条链是基于代码和 handoff 状态的高置信推断，不是对本地 event log 的直接重放。但它与 SH-05 的节点、target、state、edge、wait 字段高度吻合。把该 local route 直接加进 goal logic 的实验反而在 3,600 秒更早失败，也说明“一行 goal patch”只会让没有资源契约的 clearance 真正冲进共享区域，不能解决根因。

## 1. 当前架构真正错在哪里

现在不是没有 coordinator，而是有多个相互重叠的写者：

- OutboundStationRuntime 同时维护 active visit、slot owner、envelope owner、service owner、active transition、drain epoch。
- station kernel 又维护 demand token、queue lease、FIFO head 和 throat grant。
- agentGoalNodeId() / dispatch fallback 再独立决定车辆目标。
- deadlock recovery 直接覆盖车辆 route、state、wait 字段。
- 所谓 station-pair coordinator 目前只是 mode: `shadow` 的诊断汇总，并不做实际仲裁。

这导致三个核心问题：

- 路线不是许可。A* 算出一条路、或者 recovery 写入一条 route，并不代表车辆获得了 throat 的使用权。
- exclusive 和 drain 同时存在。当前 active pass 被诊断为 exclusive，但 movement blocker 又允许若干 foreign vehicle 以特殊条件在 active envelope 内 drain。正确的模型应当是：先进入 DRAINING，foreign incumbents 全部排空；之后才原子地进入 ACTIVE_PASS。不能一边 active exclusive，一边给 foreign drainer 开后门。
- 一次 tick 内存在多个决策边界。runtime 被反复 reconcile，movement 后 recovery 又产生新的移动意图。于是同一车辆可以在一个公开 state snapshot 中处于“逻辑上 moving，物理上尚未开始且没有 hold”的非法中间态。

两个被拒绝的实验没有否定 authoritative coordinator；它们证明的是：只让 outbound 一侧 authoritative，但不同时拥有 inbound approach、bottom slots 和 drain，是错误的边界。

## 2. 最小可行重构

不要重写物理仿真，也不要把车辆从入口直接跳到 station。保留现有 0.2 秒级物理 tick、edge movement、加减速、转向切换、lift/lower、碰撞与 3D 坐标。

只新增一个 station-pair control plane：

```text
Task / demand scheduler --visit request--> StationPairCoordinator
Pathfinder --------------route proposal--> StationPairCoordinator
                                           |
                                           +-- lease + motion directive
                                                        |
                                                        v
                                             Physical tick mover
```

关键原则是：

- 单写者，但不是单一大锁。
- Coordinator 是 station pair 相关 ownership 和 directive 的唯一写者，但资源仍按细粒度冲突集合并发，不要把整个 lift pair 锁成一个 mutex。

建议最小 API：

```ts
type PairDirective =
  | {
      kind: 'move';
      pairId: string;
      visitId: string;
      leaseId: string;
      revision: number;
      routePrefix: string[];
      clearThroughNodeId: string;
    }
  | {
      kind: 'hold';
      pairId: string;
      visitId: string | null;
      reason: string;
      blockingLeaseId: string | null;
    }
  | {
      kind: 'service';
      pairId: string;
      visitId: string;
      leaseId: string;
      stationId: string;
    };
```

每个 tick 改为：

```text
generate / assign tasks
observe physical occupancy and prior progress
pair coordinator reconciles and issues directives   <- 唯一 grant 时点
apply route intents
advance physical vehicles
observe arrivals / progress / service completion
deadlock detector may enqueue recovery request      <- 不得直接改 route
audit invariants
```

post-movement 阶段可以关闭 lease、记录 progress、提交下一 tick 的 recovery request，但不得再安装可移动 route。

路径规划的职责收缩为：

- station pair 外：继续负责完整路线。
- pair 内：生成候选 route。
- coordinator：决定候选 route 的哪一段被 lease、何时可以执行。

现有文档此前已经得出了同样的方向：planned route 不应成为全局硬锁，正确做法是特定资源上的 bounded、FIFO、TTL lease。

## 3. Station-pair ownership 定义

建议把“业务生命周期”和“物理 ownership”分开：

| 概念 | 是否拥有物理资源 | 规则 |
| --- | --- | --- |
| Queued demand | 否 | 只是待服务的 load/task。可以没有 vehicle。不得拥有 node、route 或 throat。 |
| Requested visit | 否 | 已绑定 vehicle/task，拥有 FIFO sequence 和 aging，但没有物理通行权。 |
| Bottom-a / bottom-b slot lease | 是 | 每个具体 slot 一个 lease、一个 owner。planned route 不等于 slot lease。 |
| Inbound approach lease | 是 | 覆盖从 entry fence 到第一个合法 stop/service point 的连续 route prefix，并预留 clear-through。 |
| Outbound pass lease | 是 | 覆盖 entry edge、共享 throat、service envelope 和服务后的 clear-through；phase 为 entering/servicing/clearing。 |
| Temporary clearance lease | 是 | 只授予已经在 conflict set 内的 incumbent/blocker，路线必须单调离开 conflict set；优先级高于 pending visit。 |
| Active service | 是 | 是某个 visit 的 servicing phase，不是另一个独立 owner。任务完成后 visit 仍可处于 clearing。 |

### Outbound active pass

同一个 `visitId` 应贯穿：

```text
requested -> slot-leased -> entering -> servicing -> clearing -> released
```

不要再独立写入 `slotOwnerRequestId`、`envelopeOwnerRequestId`、`serviceOwnerRequestId`。它们都应从 lease table 派生。

硬 invariant：

```text
active outbound pass
  => drain epoch 不存在
  => conflict resources 内没有 foreign occupant
  => 没有新的 inbound approach grant
```

如果 grant 前发现 foreign occupant：

- selected outbound visit 保持 requested/head
- pair 进入 DRAINING
- 给 incumbent 发 clearance lease
- 全部排空后才 grant outbound pass

### Inbound approach

Inbound approach 必须由同一个 pair coordinator 仲裁。不能因为它属于 inbound station，就绕过 outbound station 的 throat envelope。

它只 lease 真实需要的 route prefix，不持有整条未来路线。多个 inbound queue occupants 可以停在互不冲突的 slot，但穿越共享 throat 的 approach transition 必须串行或按资源冲突矩阵批准。

### Bottom-a / bottom-b slots

每个 slot 同时记录：

```ts
{
  physicalOccupantVehicleId: string | null; // 事实
  leaseOwnerVehicleId: string | null;       // 权限
  visitId: string | null;
  phase: 'reserved' | 'approaching' | 'occupied' | 'releasing';
}
```

如果 physical occupant 与 lease owner 不一致，不应把 slot 给新车，也不应悄悄改 owner。该 occupant 成为 incumbent，只能取得 egress/clearance lease。

### Temporary clearance

Clearance 不是 `localRouteReason` 字符串，也不是 deadlock helper 的 side effect。它应是 first-class lease，包含：

- `leaseId`、`revision`
- 精确 route prefix
- `clearThroughNodeId`
- `issuedAtSec`
- `lastProgressAtSec`
- `nextProgressDeadlineSec`
- `hardExpiresAtSec`

Clearance 只能减少以下至少一个量：

- 车辆占据的 protected resource 数量
- 到 clear-through 的剩余 hop 数
- 当前 conflict set 内的 foreign occupant 数量

若一个 clearance move 只是从 throat 的一个冲突节点移到另一个等价冲突节点，应拒绝，除非它是已验证的连续排空路线的一部分。

## 4. 防止 loaded-moving 但无 edge/no wait/no progress 的 invariants

### A. 立即结构 invariant

```text
state == loaded-moving
  => currentEdgeId != null
  => legRemainingM > epsilon
  => targetNodeId != null
```

唯一例外是明确的 direction-switch phase。安装 route 但尚未启动 edge 时，车辆应继续处于 assigned/route-ready；loaded 已经由独立 boolean 表达，不需要提前写成 loaded-moving。

实际上应规定：

> 只有 beginAgentSimpleLeg() 可以写入 moving state。所有 route installer 只能写入 route intent。

### B. Route consistency

车辆不在 edge 上时：

```text
routeNodeIds[routeIndex] == currentNodeId
targetNodeId == routeNodeIds[routeIndex + 1] || targetNodeId == null
targetNodeId != null => graph 中存在 current -> target edge
```

Station-controlled route 还必须带有有效的 `leaseId + revision`。

### C. Stop-state completeness

任何有 task 或 loaded、尚未到 service point、也没有物理移动/handling phase 的车辆，必须满足二选一：

- 有可在本 tick/下一 tick 启动的 executable route intent
- 或 `state == waiting-blocked && waitReason != null && waitingSinceSec != null`

不能存在第三种“既不动，也不等”。

### D. One-tick route-start invariant

新 route intent 允许最多停留一个 tick：

```text
routeInstalledAtTick < currentTick
&& currentEdgeId == null
&& waitReason == null
=> critical: route-intent-not-executed
```

### E. Protected occupancy invariant

每台处于 pair protected resource 内的 AMR，必须是以下之一：

- active pass owner
- active service/clearing owner
- valid clearance lease owner
- 当前正在完成已进入的 edge，并已被 coordinator 识别

否则立即产生 critical evidence。

### F. Pass/drain mutual exclusion

```text
activePass != null => drainLeases.length == 0 && foreignOccupants.length == 0
drainLeases.length > 0 => activePass == null
```

### G. Progress invariant

不能因为重复 reconcile、重复安装 route 或更新 wait reason 就刷新 timeout。只有以下事实算 progress：

- edge progress 增加
- node transition
- route prefix index 增加
- service phase 完成
- foreign occupant 数下降
- 到 clear-through 的距离下降

超时后应停止并保存 checkpoint，不要再调用另一个 helper 覆盖现场。

### H. Task/visit invariant

Outbound lower 完成后，task 可以完成，但车辆在离开 throat 前仍必须保留 `visit.phase='clearing'` 和 clearance/pass lease。此时不得给它分配一个会把它重新带回 throat 的新任务。

另外，当前 core 会仅凭 `state==='loaded-moving'` 把时间计为 moving，即使没有 edge；这项统计应改成只按真实 speed/edge/leg 计量。

## 5. 哪些逻辑保留，哪些停止打补丁

| 保留 | 处理方式 |
| --- | --- |
| Physical tick mover、edge travel、加减速、方向切换、lift/lower | 不改模型，只让它执行 coordinator directive。 |
| A*/shortest path | 保留为 route proposal，不能再隐含资源许可。 |
| Collision、node occupancy、reservation、physical violation | 保留为最终物理安全层。 |
| Outbound station plan、service envelope、route adjacency、travel estimate | 作为 pair topology 和 lease deadline 输入。 |
| station demand/FIFO 数据 | 保留调度顺序，但不得直接写物理 ownership。 |
| shadow ledger、station critical diagnostics、10 分钟/小时 audit | 保留并升级为 enforcement evidence。 |
| c01/c02 conflict-session 修复和相关测试 | 保留在非 station-pair 一般交通恢复中。 |

优先隔离或停用：

- `tryClearOutboundStationAwaitTransitionBottomLaneBlockers`
- `installOutboundStationAwaitTransitionBottomLaneClearance`
- `outboundStationAwaitTransitionBypassForLocalClearance`
- 任何允许 foreign vehicle 在已经 active 的 “exclusive envelope” 内继续取得新准入权的 helper
- station-specific recovery 在 `updateDeadlockSmokeCounters()` 中直接写 vehicle route/state
- `holdOutboundStationAwaitTransition()` 无差别清除别的 subsystem 安装的 route
- 多个独立 owner 字段以及依次 fallback 的 outbound goal chain
- 所有不经过 `beginAgentSimpleLeg()` 就设置 `loaded-moving` 的 helper

不是立刻删除所有 helper。正确迁移方式是：

```text
旧 helper 计算 candidate clearance route
        |
        v
向 pair coordinator 提交 clearance request
        |
        v
coordinator 检查 ownership/conflicts 并签发 lease
        |
        v
统一 directive adapter 安装 route
```

当 pair coordinator 开启 enforcing mode 后，凡是 route 涉及 pair protected resource 的 generic recovery，都只能提交 request，不能直接改车。

`deadlockCandidateHasActiveRecovery()` 也应调整语义：仅有未过期 session 不足以无限视为 recovery；对于 station pair，必须有近期真实物理 progress。

## 6. 最小安全实施顺序

### P0：先补观测，不改调度

加入：

- `routeInstalledAtTick`
- `lastKinematicProgressAtSec`
- `stationDirectiveId/revision`
- `moving-state-without-kinematics`
- `route-intent-not-executed`
- sampled station critical counters

同时建立一个可在几分钟模拟时间内重现以下状态的 fixture：

- outbound owner 等待 pass
- foreign incumbent 位于 envelope
- inbound approach 正在请求共享 throat
- bottom-a/b 至少两个 occupied/targeted slots

### P1：统一 route-intent 写入口

新增一个 `installRouteIntent()`：

- 验证 adjacent edges
- 验证 directive/lease
- 不设置 moving state
- 不静默清空另一个 revision 的 route
- 失败时必须设置 explicit wait

所有 station/recovery route installer 先迁移到这个入口。

### P2：实现 pair coordinator 的最小 enforcing slice

最初只接管：

- shared throat entry
- outbound active pass
- inbound approach
- bottom-a/b concrete slots
- clearance/drain

Task generation、storage routing、一般网络 deadlock recovery 都不动。

### P3：把 drain 变成正常状态，而不是 recovery

实现：

```text
OPEN -> DRAINING -> PASS_ACTIVE -> SERVICING -> CLEARING -> OPEN
```

其中 DRAINING 和 PASS_ACTIVE 严格互斥。

完成此步后，才关闭现有 outbound-await-transition clearance helper。

### P4：收敛 visit/owner 字段

将现有 request、pass、drain epoch 映射到：

- Demand
- Visit
- Lease

删除独立可写的 slot/envelope/service owner 字段，并去掉 outbound goal 的多层 station fallback/bypass。

不要先做大规模文件拆分。可以只新增一个纯函数式 `station-pair-coordinator.ts`，由 `index.ts` 提供 topology 和 physical observations。等 24h gate 通过后再拆 43k 行主文件。

## 7. 可执行验证阶梯

### 先修 audit 的两个盲点

当前脚本已经有 hourly PPH、10 分钟 AMR 窗口、critical anomaly 早停和 checkpoint。

但必须先改：

- `--stop-on-critical` 在循环中只检查 anomalies；station contract critical count 是运行结束后才计算，因此 station critical 本身不能可靠地立即早停。
- `assignedWithoutRouteIssue()` 在 vehicle 有 target 或 route length > 1 时直接放行，所以抓不到 SH-05 这种“有一跳 route，但长期没启动 edge”的情况。

新增输出字段：

```text
stationContractCriticalMax
stationContractCriticalSampleCount
stationContractCriticalFirstSec
stationContractCriticalByCode
motionContractCriticalCount
maxMotionIntentWithoutExecutionSec
perAmrMaxConsecutiveActiveZeroTaskWindows
```

### 短 gate

12,000 秒已经被证明不足以跨过已知的 16,200 秒失败点。因此在快速 fixture 之外，最短可信的 full-flow gate 应跑到至少 16,500 秒。

```bash
corepack pnpm run typecheck

./node_modules/.bin/vitest run packages/shuttle-sim-core/src/index.test.ts \
  -t "(station pair|station contract|outbound station|motion contract|deadlock recovery)" \
  --maxWorkers=1

SHUTTLE_COMMIT_SHA="$(git rev-parse HEAD)" \
./node_modules/.bin/tsx scripts/run-physical-24h-amr-audit.ts \
  --duration-sec 16500 \
  --regions 2 \
  --shuttles 8 \
  --inbound-pph 3600 \
  --outbound-pph 3600 \
  --outbound-full-columns 4 \
  --initial-fill-policy zone-balanced-50 \
  --storage-selection-policy sequential \
  --collision-avoidance on \
  --audit-every-sec 1 \
  --ten-minute-sec 600 \
  --hourly-sec 3600 \
  --stop-on-critical \
  --out output/review/station-pair-short-16500.json \
  --checkpoint-dir output/review/station-pair-short-16500-checkpoints \
  --change-note "station-pair-coordinator-short-gate"
```

硬通过条件：

- 完整到达 16,500 秒
- physical/deadlock/livelock 全部为 0
- sampled station contract critical 为 0
- motion contract critical 为 0
- 没有 active pass 与 foreign occupant 同时存在
- 没有 lease progress timeout
- 没有 stationary-active-window
- event log 中没有同一 vehicle/revision 反复出现 clearance install -> await-transition hold 而没有 node/edge progress

短 gate 先不设绝对 PPH 淘汰线，但要与当前同 seed baseline 比较并保留 hourly rows。

### 6h gate

```bash
SHUTTLE_COMMIT_SHA="$(git rev-parse HEAD)" \
./node_modules/.bin/tsx scripts/run-physical-24h-amr-audit.ts \
  --hours 6 \
  --regions 2 \
  --shuttles 8 \
  --inbound-pph 3600 \
  --outbound-pph 3600 \
  --outbound-full-columns 4 \
  --initial-fill-policy zone-balanced-50 \
  --storage-selection-policy sequential \
  --collision-avoidance on \
  --audit-every-sec 5 \
  --ten-minute-sec 600 \
  --hourly-sec 3600 \
  --stop-on-critical \
  --out output/review/station-pair-6h.json \
  --checkpoint-dir output/review/station-pair-6h-checkpoints \
  --change-note "station-pair-coordinator-6h-gate"
```

硬通过条件：

- `finalSimTimeSec == 21600`
- 6 条 hourly PPH
- `8 × 36 = 288` 条完整的 10 分钟 AMR rows
- physical/deadlock/livelock/critical AMR/sampled station critical 全部为 0
- 不允许：
  - assigned-without-route
  - moving-state-without-kinematics
  - route-intent-not-executed
  - stationary-active-window
  - long-wait-no-task-window
  - zero-task-moving-window
- 任一 AMR 最多允许一个孤立的 active zero-task 10 分钟窗口；两个连续窗口直接失败
- 所有 station pass/clearance 均在动态 deadline 内完成
- 结束时无 orphan visit、orphan lease、drain epoch

吞吐初始门槛以当前同配置健康 6h baseline 为准：

- total PPH 不低于 `441.333 × 95% ≈ 419.3`
- inbound 不低于约 `201.9`
- outbound 不低于约 `195.3`
- 每小时与冻结 baseline 的对应小时比较：不能低于 85%；不能连续两小时低于 90%

PPH 不是安全豁免。当前失败 run 的 total PPH 仍有 `422.889`，但必须因 contract critical 而失败。

### 24h gate

```bash
SHUTTLE_COMMIT_SHA="$(git rev-parse HEAD)" \
./node_modules/.bin/tsx scripts/run-physical-24h-amr-audit.ts \
  --hours 24 \
  --regions 2 \
  --shuttles 8 \
  --inbound-pph 3600 \
  --outbound-pph 3600 \
  --outbound-full-columns 4 \
  --initial-fill-policy zone-balanced-50 \
  --storage-selection-policy sequential \
  --collision-avoidance on \
  --audit-every-sec 5 \
  --ten-minute-sec 600 \
  --hourly-sec 3600 \
  --stop-on-critical \
  --out output/review/station-pair-24h.json \
  --checkpoint-dir output/review/station-pair-24h-checkpoints \
  --change-note "station-pair-coordinator-24h-evidence"
```

除 6h 的全部硬条件外，还要求：

- 24 条 hourly PPH
- `8 × 144 = 1,152` 条 10 分钟 AMR rows
- 任一 AMR 均无连续两个 active zero-task 窗口
- 无超过 30 分钟的 confined/stuck run
- 最后 6h total PPH 不低于最初 6h 的 90%
- 24h aggregate total PPH 不低于冻结基线的 95%
- active visits、leases、drain requests 的数量没有随运行时间单调增长
- 每个 pair 在结束时要么完全 idle/open，要么有一个可解释、正在真实 progress 的 visit；不得只有逻辑 owner 而没有执行者

最终优先级应是：先建立 motion contract，再让 station pair 成为共享 throat 的唯一授权者，随后把 clearance 从 deadlock patch 升格成正常 lease 生命周期。不要继续向 `agentGoalNodeId()` 或 bottom-lane recovery 增加例外分支。

