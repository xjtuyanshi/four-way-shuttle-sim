# Review 结论：**REQUEST CHANGES，当前 WIP 不应提交，也不应开始 24h 验证**

这不是又一个局部路径规划 bug，而是**控制权、资源所有权和观察状态没有形成单一事实源**。2100s gate 清零有价值，但它主要证明了诊断口径和生命周期清理改善；PPH 始终不变，而完整测试仍有 42 个失败和 worker timeout，因此不能把“shadow violations=0”解释为控制系统已经正确。

远端 HEAD 也直接支持这个判断：

* `taskAssignmentRoute()`允许返回 `[currentNode]`，随后 `assignTaskToVehicle()`仍无条件把 vehicle 和 task 设为 `assigned` 并清空 wait 状态。这正是 Round 9 指出的非原子 assignment。
* 项目已经有 `OutboundStationRequest/Pass/Runtime`，所以问题不是“少一个新类型”；问题是这些状态仍通过 task、vehicle、loaded、route 状态周期性反推，尚未真正成为权威控制状态。
* HEAD 中 `getState()`和 `createSnapshot()`都会先执行有写操作的 station reconcile。WIP 去掉 `getState()`中的写操作是正确的，但还必须覆盖 `createSnapshot()`及所有报告入口。
* deadlock 流程在构造纯 wait-cycle observation 之前就执行大量 recovery，并在成功后清空 candidate，因此短周期可能被修复但从未被正确记录。

## 优先级决定

### P0：立即停止以下工作

停止继续增加：

* station queue、dock、buffer、follower 的特殊 route patch；
* 新的 `waitReason` 来填补所有权空洞；
* 新的 side-yield 候选规则或 pocket 特例；
* 为了让 42 个测试通过而批量修改 expected route/goal；
* 2h、8h、24h 长跑；
* 以“5 秒采样下 shadow=0”作为正确性结论。

当前需要先保存 dirty patch，然后拆分 WIP，而不是继续在同一个脏工作树上追加逻辑。

### P1：拆分并保留安全修改

建议将当前 WIP 分成四个独立变化集：

| 变化集                                        | 处理意见                                            |
| ------------------------------------------ | ----------------------------------------------- |
| Observer purity、只读测试                       | **保留并优先落地**，但扩展到 `createSnapshot()`及全部 observer |
| Deadlock accounting 分类                     | **保留方向，但尚未完成**；必须先观察、再恢复、最后确认                   |
| FIFO audit eligibility、hard/soft lease 分类  | **保留为诊断语义修改**，不得悄悄改变控制                          |
| inbound self-route hold、conflict lifecycle | **作为临时行为适配器单独隔离**，在新边界完成前不要视为最终方案               |

不要整体 revert，但也不要把这些内容混成一个“已验证修复”提交。

### P2：实施最小控制边界

下一步不是大改 physics，也不是重写 planner。最小动作是增加一个**原子 ControlDecision / VehicleIntent 提交点**，把现有 route planner 包在后面。

建议最小模型：

```ts
type VehicleIntent =
  | { kind: 'move'; intentId: string; owner: IntentOwner; taskId: string | null;
      routeNodeIds: string[]; leaseIds: string[] }
  | { kind: 'hold'; intentId: string; owner: IntentOwner; taskId: string | null;
      reason: string; resourceKey: string | null }
  | { kind: 'service'; intentId: string; owner: 'station'; taskId: string;
      stationId: string; grantId: string; phase: ServicePhase }
  | { kind: 'idle'; intentId: string; owner: 'dispatcher' };

type ControlDecision = {
  vehicleId: string;
  taskTransition?: { taskId: string; from: 'queued'; to: 'assigned' };
  intent: VehicleIntent;
  acquireLeaseIds: string[];
  releaseLeaseIds: string[];
};
```

核心不变量必须是：

1. `task.state='assigned'`只能与有效 intent 在**同一事务**提交。
2. `[currentNode]`不是 move intent。它必须显式转换成 `hold`、`service`或 `idle`。
3. 若 route、lease 或 grant 验证失败，task 和 vehicle 均不得发生部分修改。
4. station protected node 只能由持有对应 `StationLease`或 `ServiceGrant`的 intent 进入。
5. `routeNodeIds`只是执行投影，不再被用于推断谁拥有 station slot、throat 或 service envelope。
6. 所有 route、target、wait、local route、task assignment 写操作逐步集中到一个 commit 函数中。

这一步完成后，现有 `installAssignedInboundQueueHoldIfNeeded()`应退化为通用 intent 验证的一部分，而不是长期保留的 inbound 特例。

## Station ownership 应如何切断旧事实源

`StationRuntimeState`必须成为权威状态，状态转换只能由明确事件触发：

```text
work-admitted
→ queue-slot-granted
→ queue-slot-occupied
→ service-granted
→ service-started
→ service-completed
→ clear-through
→ released
```

禁止由周期性扫描重新创建或升级控制状态，例如：

* 因为 `vehicle.loaded === true`就把 request 推导为 `loaded-ready`；
* 因为 planned route 经过 slot 就创建 lease；
* 因为 vehicle 到了某个 node 就反推它拥有 service grant；
* observer reconcile 发现不一致后直接“修正”runtime。

reconcile 可以作为只读 assertion，输出 mismatch；不能修复控制状态。

## 对 `conflictSessionYielderHasActiveYieldIntent()` 的判断

**方向正确，但当前判定依据仍然不够安全。**

以下修改可以保留：

* yielder 已经在离开 pocket 的 edge 上时，不应继续保持 `holding-pocket`；
* 已恢复主路线、没有 yield 行为的 session 应关闭；
* 使用 `yield-intent-ended`作为 close reason 是合理的。

风险在于：仅凭“当前 route 与 session clearance route 仍匹配”可能把普通主路线误认成仍在执行 yield，也可能掩盖 yield 根本没有成功安装。

正确契约应该是：

```text
session.state ∈ {yielding, holding-pocket}
⇒ session.yieldIntentId != null
⇒ vehicle.activeIntentId == session.yieldIntentId
⇒ activeIntent.owner == conflict-session
```

route suffix 对齐只应作为辅助诊断，不能作为控制身份。

当 intent 丢失时应同时执行两件事：

1. 关闭 session，reason=`yield-intent-lost`或 `yield-intent-ended`；
2. 记录单独的 invariant/event，不能仅通过关闭 session 让 shadow gate 变绿。

## 对 hard lease duplicate-owner 语义的判断

**只用 hard lease 判定 exclusive duplicate owner 是正确的。**

但“hard”必须由**可执行授权**定义，而不是字段名称：

* current occupancy：hard；
* 有效 reservation：hard；
* station queue/service lease：hard；
* conflict yield pocket grant：hard；
* 有 reservation/grant 支撑的 next-node target：hard；
* 普通 `plannedRouteNodeIds`：soft；
* 未获 reservation 的 `targetNodeId`：也不应自动视为 hard。

建议拆成三个指标：

| 指标                             | 严重度                  |
| ------------------------------ | -------------------- |
| `hard-resource-owner-conflict` | critical，必须为 0       |
| `hard-soft-route-contention`   | watch，用于预测即将发生的争用    |
| `soft-route-overlap`           | info，统计规划拥堵，不阻止 gate |

因此当前 hard-only 修改可以保留，但 2100s 报告仍应显示 soft overlaps。不能把它们从 duplicate owner 中移除后完全不报告。

## Observer 与 control 的强制隔离

每个 tick 应固定为：

```text
1. 读取 tick-start control state
2. dispatcher / station / conflict controller 生成候选 decision
3. arbiter 解决资源冲突
4. 原子提交 accepted decisions
5. physics 执行 vehicle intents
6. 根据真实 movement/service event 更新 control runtime
7. 从只读 snapshot 计算 diagnostics
```

具体要求：

* `getState()`、`getEventLog()`、`getDebugState()`、`createSnapshot()`不得写任何字段。
* `calculateTrafficDiagnostics()`和 rolling audit 只能接收只读快照。
* 控制模块不得接收 `Shadow*Diagnostics`类型。
* `diagnosticReadOnlyDepth`这类运行时护栏不能作为最终设计；它最多用于临时检测。
* hard invariant 必须每 tick 检查，不能依赖每 5 秒 observer sampling。
* 加入 observer-frequency determinism 测试：相同 seed 下，“不读取状态”“每 tick 读取”“每 5 秒读取”的最终 core state hash、事件序列和 KPI 必须完全相同。

## 42 个失败测试怎么处理

不要将它们统称为 stale tests。先分四类：

1. **Safety / ownership tests**
   例如 protected node、duplicate owner、station single owner。不得降低断言。

2. **State / snapshot / determinism tests**
   例如 station demand token snapshot restore、observer purity、timeout。全部是 release blocker。

3. **Legacy implementation-shape tests**
   例如必须走某个旧 dock/buffer goal。新 contract 完成后可以改成断言 intent、lease 和最终物理结果。

4. **Behavioral scenario tests**
   side-yield、queue successor、prefetch、clearance。不能只修改期望路线；应改成断言：

   * 谁获得 grant；
   * 谁持有 hold；
   * 谁最终前进；
   * 是否释放资源；
   * 是否有 starvation 或物理违规。

完整 suite 在任何长跑前必须达到 **532/532、0 timeout、0 unhandled error**。

# 24h 前的强制验证 ladder

## Gate 0：源码与可复现性

每次输出记录：

* commit SHA；
* dirty patch hash；
* scenario hash；
* seed；
* timestep；
* observer/audit interval；
* intent/resource schema version。

未记录这些信息的 run 不作为验证证据。

## Gate 1：静态与契约测试

必须全部通过：

* schemas、sim-core、audit script typecheck；
* observer purity；
* snapshot mid-transition restore determinism；
* atomic assignment；
* station lease acquire/occupy/release；
* conflict intent identity；
* deadlock observed/recovery/confirmed 分类；
* 完整 core suite 532/532。

## Gate 2：微场景

至少覆盖：

* self-route assignment 转 explicit hold；
* inbound queue FIFO；
* station capacity full；
* lease 在 route reset 时释放；
* outbound service 与 clear-through；
* side-yield install、hold、resume；
* yield intent 丢失；
* wait-cycle 被观察、恢复和确认；
* service 或 yield 中途 snapshot/restore。

每个场景逐 tick 检查 hard invariants。

## Gate 3：2100s nominal gate

固定 reference seed 加至少两个额外 seed。

要求：

* physical violation = 0；
* swept overlap/pass-through = 0；
* hard resource owner conflict = 0；
* station/intent invariant = 0；
* confirmed deadlock = 0；
* nominal recovery-issued = 0；
* livelock、ping-pong、long-wait anomaly = 0；
* final stuck vehicles = 0；
* min separation ≥ scenario 配置值减数值容差；
* soft overlap 可以非零，但必须报告；
* 有 assignable backlog 时，同一 AMR 连续两个 10 分钟窗口完成 0 task，判为 starvation failure。

当前 456 PPH只能作为对比，不应成为迫使控制逻辑保持旧行为的硬目标。新 contract 第一次完整通过后，再锁定新的 `PPH_ref`。

## Gate 4：2h gate

要求：

* 同一 seed 下 audit off / 每 tick / 每 5 秒三组运行的 core state hash 完全相同；
* 至少三个 seed；
* 所有 2100s hard 条件继续满足；
* warm-up 后每小时 PPH 不低于 `0.90 × PPH_ref`；
* queue/backlog 无持续增长；
* 不出现符合 backlog 条件的连续两个 0-task 窗口。

## Gate 5：8h degradation gate

至少 nominal seed 和 stress seed 各一组。

要求：

* hard violation、confirmed deadlock、livelock 均为 0；
* nominal recovery-issued 为 0；
* 最后 2h 平均 PPH ≥ 前 2h 平均 PPH 的 95%；
* 不允许连续三小时每小时下降超过 5%；
* queue、reservation、session、event-log 等 runtime 集合保持有界；
* 每个 10 分钟×AMR 零任务单元均有原因分类。

## Gate 6：24h acceptance

输出至少包括：

* 24 个 hourly total/inbound/outbound PPH；
* **144×8** 的 10 分钟×AMR 完成任务矩阵；
* 每个零任务单元的原因；
* 每台 AMR 最大连续零任务窗口；
* 最大 wait、最大 loopiness、最大 queue age；
* observed cycle、recovery issued、confirmed deadlock 三类独立计数；
* 所有 hard invariant 汇总；
* rolling log 中的 rerun 原因、问题、修复/验证、PPH、异常和输出路径。

接受标准：

* hard/physical violation = 0；
* confirmed deadlock = 0；
* nominal recovery-issued = 0；
* 平均 PPH ≥ `0.95 × 2h reference`；
* warm-up 后无单小时低于 `0.85 × reference`，除非明确证明是 demand-limited；
* 最后 4h 平均 PPH ≥ 前 4h 平均 PPH 的 95%；
* 无未解释的 AMR starvation；
* 结束时无 station resource 泄漏、无活动 conflict session、无 stuck vehicle。

## 明确不要继续做什么

不要再：

1. 用更多 route 条件弥补 assignment/lease 缺失。
2. 让 planned route 或 observer shadow 成为 station 控制输入。
3. 通过关闭 session 或降低 violation 分类来制造 clean gate。
4. 只看 `deadlockCount=0`，忽略 recovery 次数和短 wait-cycle。
5. 按旧路线形状批量更新测试。
6. 在完整测试仍有失败和 timeout 时做 24h。
7. 让 `getState()`、`createSnapshot()`或 audit 调用改变仿真轨迹。
8. 把此次工作扩大成 physics 或 planner 全面重写。

最小正确路径是：**先拆 WIP，随后实现一个统一的原子 VehicleIntent/StationLease 提交边界，再迁移测试和运行验证 ladder。**
