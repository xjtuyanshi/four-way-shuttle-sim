# 审查结论

**要求修改（Request changes）。当前 WIP 不应作为已验证修复提交。**

我直接核查了指定 HEAD 的核心调度、站点 shadow kernel、冲突会话、deadlock 统计和审计脚本。未提交 WIP 不在 GitHub 快照中，因此对两个最新 top-a helper 的判断依据 handoff 中的描述和现有通用实现，而不是逐行 dirty diff。

系统现在不是缺少另一个 top-a 路径补丁，而是有三个边界没有立住：

1. **任务分配结果不是原子的**：`assigned` 可以与“无路线、无等待契约”同时出现。
2. **station shadow 与控制权混在一起**：由车辆物理状态推导出的 lease，又反过来控制车辆。
3. **deadlock 检测器同时修改交通状态并记账**：恢复成功与 deadlock 已确认没有清晰分界。

---

## 一个必须先纠正的验证问题

现有两个 4570 秒结果不是干净的 A/B：

* 基线使用 `--audit-every-sec 1`
* top-a WIP 后使用 `--audit-every-sec 5`

而 `assigned-without-route` 只在审计采样时检查；5 秒采样完全可能漏掉持续一个或几个 tick 的非法状态。因此“5 秒审计中 critical=0”不能证明 1678 秒问题已消失。审计循环只在到达 `nextAuditSec` 时执行车辆状态检查。

更严重的是，`getState()` 目前会先调用 `reconcileStationKernelShadowState()`，而这个 reconcile 会重建和替换 demand tokens、queue leases。也就是说，读取诊断状态不是严格只读。由于这些 lease 又被部分控制逻辑读取，审计频率至少存在影响模拟状态的风险。

**第一项验证闸门应当是：同一代码、同一 seed 分别以 1 秒和 5 秒审计运行，最终 state hash、event hash、任务完成数必须完全一致。否则任何长跑 A/B 都不可信。**

---

# 1. `assigned-without-route` 的最可能 root cause

## 结论

这不是以 route planner 为主的故障。

最可能的主因是：

> **queue hold 被表达成 `goal=currentNode`，随后任务转移或分配把车辆设为 `assigned`，但没有在同一个原子操作中把它转换为明确的 hold 状态。**

代码允许 `taskAssignmentRoute()` 在当前位置等于 dispatch goal 时返回单节点路线 `[currentNode]`。`assignTaskToVehicle()` 随后仍会设置：

* `vehicle.taskId`
* `vehicle.state = assigned`
* `waitReason = null`
* `targetNodeId = route[1] ?? null`

因此单节点路线天然能够产生“assigned、target=null、waitReason=null”。

而 inbound dispatch goal 确实可能故意返回当前 queue node：车辆应继续排队但不能向更深 slot 压缩时，`inboundCurrentQueueHoldOrDeeperGoalNodeId()` 直接返回 `vehicle.currentNodeId`。

正常情况下，后续 movement pass 会识别 `goal === currentNode`，再调用 `holdAtTopLiftQueueNode()` 写入明确 wait reason。问题在于 `tryAdoptInboundQueueTaskAtCurrentSlot()` 可以在车辆遍历期间转移任务；成功后外层循环立即 `continue`，该车辆当 tick 不再执行 hold/route 状态收敛。这是一个非常具体的、能产生 1678 秒快照的执行路径。

审计器捕获的也不是宽松条件：它要求任务存在、没有 target、没有 edge、没有 phase、没有 wait reason、路线长度不超过 1，而且车辆不在服务节点。这是一个真实的 tick-boundary contract gap。

### Root cause 排序

1. **任务分配／任务 adoption 的原子性与状态表示**
2. **queue reservation、service grant 与导航 intent 没有明确区分**
3. reconciliation 顺序
4. route planner 本身

建议先查 1678 秒之前最后一次与 `task-0243` 有关的事件。重点找：

* `task-reassigned`
* reason=`inbound-queue-reserve-adopted-task`
* `task-assigned`
* station lease transition

若非法状态下一 tick 自动恢复，它仍然是原子性 bug，不应降级为“无害瞬态”。

---

# 2. SH-06 / SH-08 的恢复应该放在哪里

## 正确归属

**主责任：conflict session manager / traffic arbitration。**

各层职责应是：

| 层                        | 职责                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------- |
| Station coordinator      | 提供语义优先级和资源约束，例如“loaded exit 优先于 empty service entrant”，以及 service grant 是否临时 suspended |
| Conflict session manager | 识别 reciprocal swap、选 winner/yielder、管理恢复生命周期                                           |
| Route planner            | 在给定保护节点和 envelope 下计算一条有界 retreat/yield route                                          |
| Deadlock observer        | 只观察、分类和计数，不改路线                                                                         |
| Invariant repair         | 只处理不可能状态，不处理正常交通冲突                                                                     |

对该具体场景，**SH-08 loaded inbound 应获胜，SH-06 empty entrant 应让行**。但这应该是局部冲突政策，不是全局“所有 loaded 永远优先”。

SH-06 的 station ownership 不应因让路而丢失。推荐将其 service grant 标为：

```text
activeInboundService
  -> suspended-for-conflict
  -> conflict recovery route
  -> resume/replan from yielded node
```

FIFO 顺序和 demand ownership 保留，只临时替换物理导航控制权。

## 为什么不能放在 smoke counter

`updateDeadlockSmokeCounters()` 当前先后调用大量带副作用的 recovery helpers，然后才构建 wait-for cycle；超过阈值后又执行一轮 recovery，最后才增加 `deadlockCount`。这使“检测器”同时承担恢复策略、状态变更和统计语义。

此外，它的 cycle signature 只是排序后的 vehicle ID：

```text
SH-06,SH-08
```

没有包含：

* `SH-06 -> SH-08`
* `SH-08 -> SH-06`
* 等待资源
* target node
* wait reason
* conflict session ID

所以同一对车辆的 wait edge 已改变时，仍可能被视为同一个持续 cycle。当前 cycle 发现算法还会把通向 cycle 的 tail vehicle 一并加入，而不是计算精确 SCC。

现有 `deadlockCandidateHasActiveRecovery()` 主要检查车辆是否在移动、是否有 local yield route 或 hold，并不直接检查 conflict session 的生命周期。这又会造成“已经有恢复会话，但尚未产生物理位移”时仍被计为 deadlock。

代码中已经存在通用 adjacent-node-swap resolver，而且在 loaded/empty 不同时倾向选择 empty 作为 yielder。最新 top-a helper 与它高度重叠。

### 建议的新统计语义

分成三个事件：

```text
wait-cycle-observed
recovery-issued
deadlock-confirmed
```

只有满足以下条件才增加 `deadlockCount`：

* 同一个有向 SCC 持续存在；
* 没有 active recovery，或 recovery 已超过自己的 timeout；
* `lastProgressAtSec` 未变化；
* blocker/resource edge 仍相同。

4561 秒事件更适合先记为 `cycle-recovered` 或 `recovery-issued`。5 秒后 candidates 已为空，说明当前 `deadlockCount` 至少混入了成功恢复的 cycle。

---

# 3. 当前 station architecture 是否违反 resource contract

**是。**

当前实现存在明显的反向所有权：

```text
vehicle route/current/target
        ↓ 推导
station lease
        ↓ 又用于
dispatch / throat gating
```

这不是 shadow，也不是 authoritative coordinator，而是 observer-derived control loop。

虽然代码有显式 `issueStationKernelQueueAdmissionLease()`，但 `reconcileStationKernelShadowState()` 随后会用 `collectStationKernelQueueLeases()` 重建并整体替换 lease 数组。新 lease 的 target、phase 和 bounded route 又从车辆当前路线、target 和 planned goal 推导出来。

对于 inbound，只要车辆有 active inbound task，就可能生成 `service-granted` lease；即使 target 实际还是 queue slot，也会被归类为 service grant。这正是在概念上把 `queueReservation` 与 `activeInboundService` 合并了。

与此同时，至少 outbound throat grant 已经直接读取这些 reconstructed leases 来决定：

* 是否有 lease
* 谁是 head
* 是否允许进入 throat

因此“shadow”已经进入控制路径。

## 必须明确区分两种模式

### `observe`

* 可以从物理状态推导 diagnostics
* 不得参与 movement、dispatch、priority 或 throat gating
* `getState()` 必须只读

### `enforce`

* lease/grant 只能由 station runtime 显式签发和释放
* physical occupancy 只是事实确认
* route 不得反向创建 lease
* occupancy 与 lease 不符时记 invariant violation，而不是重新解释 ownership

不能继续保留现在的 hybrid 模式。

---

# 4. 最小架构修正

不需要改写 3D tick simulation，也不需要纯 DES。

最小修正是增加一个很窄的 **control-contract boundary**。

## A. 原子化车辆 intent

不要再用 `route=[currentNode]` 暗示 hold：

```ts
type VehicleIntent =
  | {
      kind: 'move';
      owner: 'task' | 'station' | 'conflict';
      goalNodeId: string;
      routeNodeIds: string[];
      grantId?: string;
    }
  | {
      kind: 'hold';
      owner: 'station' | 'traffic' | 'task';
      reason: string;
      resourceId: string;
      blockingVehicleId?: string;
    }
  | {
      kind: 'service';
      owner: 'station';
      stationId: string;
      grantId: string;
      serviceNodeId: string;
      boundedRouteNodeIds: string[];
    };
```

所有 assignment、adoption、reassignment 都必须通过一个 `applyVehicleIntent()` 原子完成：

```text
bind task
+ install move/hold/service intent
+ clear incompatible claims
+ validate postcondition
```

函数返回以后，不允许存在“task 已 assigned，但 intent 尚未补上”的中间状态。

## B. 小型、持久化的 StationContractRuntime

每个 station 只持有：

```text
InboundDemand[]
QueueReservation[]
SlotOccupancy[]          // 观察事实，不是 lease
ActiveInboundService?   // 最多一个
TransitionGrant?        // 有界 route + envelope + generation
```

生命周期：

```text
demand ready
→ issue queueReservation
→ physical occupancy acknowledges reservation
→ FIFO head gets service grant
→ queueReservation explicitly released/promoted
→ service
→ clear-through
→ explicit release
```

每个 grant 应有：

* `grantId`
* `generation`
* `issuedAtSec`
* `lastProgressAtSec`
* `expiresAtSec`
* `boundedRouteNodeIds`
* `envelopeNodeIds`

reconcile 只能检查一致性，不能重新创造 ownership。

## C. ConflictRecoveryGrant

冲突会话临时成为车辆的 control owner：

```text
station service intent
→ suspended
→ conflict recovery intent
→ conflict cleared
→ station service intent resumed/replanned
```

这样无需扩大全局 blocker，也不必让 station coordinator 自己做路径搜索。

---

# 5. 必须增加的 tick-boundary invariants

这些检查应在模拟内部每个 tick 执行，不能只依赖 1 秒或 5 秒外部采样。

### 1. Task–vehicle 双向一致

```text
task.vehicleId == vehicle.id
iff
vehicle.taskId == task.id
```

一个 active task 只能有一个 vehicle；一个 vehicle 只能有一个 active task。

### 2. Intent totality

每个 assigned/in-progress vehicle，在非 lift timed phase 下，必须恰好有一个有效控制 intent：

* move
* explicit hold
* station service
* conflict recovery

不能为零，也不能同时由 station route 和 conflict route 双重控制。

### 3. Move route 完整性

对 move intent：

* `route[0] === currentNodeId`
* `route.length >= 2`
* `targetNodeId === route[1]`
* 每条 edge 存在
* terminal 与 intent goal 一致
* grant-bound route 不越出 envelope

### 4. Hold 必须可解释

hold 必须包含：

* 非空 reason
* station/resource/session owner
* blocker 或等待资源
* `sinceSec`
* progress/expiry policy

`goal=currentNode + waitReason=null` 永远非法。

### 5. Station 资源互斥

每个 station：

* 一个 vehicle 最多一个 queue reservation
* 一个 slot 最多一个 reservation owner
* 一个 slot 最多一个 physical occupant
* occupancy 不得自动创建 reservation
* 最多一个 `activeInboundService`
* service vehicle 必须是合法 FIFO head
* queue reservation 与 active service 必须通过显式 promotion 转换

### 6. Service grant 完整性

`service-granted` 必须有：

* 明确 service node
* 非空 bounded route，或车辆已经位于 service boundary
* grant ID
* station ID
* demand/task ID

不能把“停在 queue slot”直接解释成 service granted。

### 7. Reciprocal swap

发现：

```text
A.target == B.current
B.target == A.current
```

后一个 tick 内必须满足：

* 存在唯一 conflict session
* winner/yielder 唯一
* recovery route 已签发，或明确记录没有安全 yield pocket
* station ownership 的保留／暂停状态明确

### 8. Deadlock confirmation

只有精确 wait-for SCC 在 recovery timeout 后仍无进展，才能计入 deadlock。

### 9. Observer purity

连续调用任意次数：

```text
getState()
createDiagnostics()
renderAuditSnapshot()
```

不得改变：

* state hash
* FIFO seq
* lease seq
* route
* reservation
* event log
* 后续模拟结果

---

# 6. 最新 WIP 的保留、回滚与替换

| WIP                                                  | 决定                         | 处理方式                                                                        |
| ---------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------- |
| `tryYieldEmptyTopASpineAwayFromLoadedInboundFaceoff` | **部分保留**                   | 保留其安全 yield route 选择思路，改成无副作用的 `RecoveryPlan` 生成器                           |
| `tryBreakAgentRefreshTopANodeSwap`                   | **替换**                     | 合并到现有通用 reciprocal/adjacent swap conflict resolver                          |
| 从 `updateDeadlockSmokeCounters()` 提前调用新 helper       | **回滚**                     | detector 不得修改车辆路线                                                           |
| focused top-a tests                                  | **保留并重写断言**                | 断言 session、winner/yielder、lease suspend/resume、N tick 内进展、deadlockCount 不增加 |
| schema 中 demand／queue／service 的区分                    | **保留**                     | 补 `grantId`、`generation`、`owner`、`lastProgressAtSec`                        |
| route lease 由 route state 推导                         | **替换**                     | shadow 中仅作 observation；enforce 中只能显式签发                                      |
| audit script 的异常捕获与 checkpoint                       | **保留**                     | 增加持续时长、首次 tick、恢复 tick、session ID                                           |
| 649 行 core WIP                                       | **不要整体提交**                 | 拆成 observer purity、atomic intent、conflict resolver、station shadow 四个独立提交    |
| 681 行测试 WIP                                          | **保留行为 fixture，删除实现耦合重复项** | 重点覆盖系统不变量而非 helper 名称                                                       |
| handoff 文档                                           | **单独 docs commit**         | 不与功能修复混在同一个提交                                                               |

---

# 7. 下一步实施和验证顺序

## Step 0：先恢复可信实验条件

不改业务策略，先完成：

1. 让 `getState()` 和 diagnostics 严格只读。
2. 同一代码分别跑 audit 1 秒与 5 秒。
3. 比较 state hash、event hash、任务完成数和所有 KPI。
4. 用 1 秒 cadence 重新跑当前 top-a WIP 的 4570 秒结果。

**停止条件：** 1 秒与 5 秒运行不完全等价，则暂停所有流量策略修改。

---

## Step 1：修正 control-contract boundary

这是下一次最小架构切口：

1. 新增 `VehicleIntent`。
2. 所有 assignment/adoption/reassignment 原子安装 intent。
3. 禁止 self-goal 代表隐式 hold。
4. 增加 `finalizeTickAndAssertContracts()`。
5. 把 deadlock observer 中的 recovery helper 移出。
6. 将 reciprocal swap 交给 conflict session resolver。
7. top-a 路线逻辑作为 resolver 的一个 topology strategy。

不需要同时完成完整 station source-of-truth。

### Step 1 验证

按相同 seed、相同 timestep、相同 1 秒审计顺序运行：

* focused tests
* 10 分钟 A/B
* 30 分钟 A/B
* 4570 秒精确复现

4570 秒需要特别证明：

* 1678 秒附近没有任何 tick-boundary intent gap
* 4561 秒附近若出现 swap，先有 recovery session，后有物理进展
* `deadlockCount` 不因成功 recovery 增加

---

## Step 2：建立真正的 station shadow runtime

先只做 `observe`：

* persistent demand IDs
* persistent queue reservations
* occupancy comparison
* proposed service grants
* legacy decision 与 proposed decision diff

此阶段 shadow 不能参与移动控制。

验证 10 分钟、30 分钟后，要求：

* derived occupancy 与 issued reservation 的 mismatch 可解释
* 不出现 duplicate slot owner
* proposed service head 稳定
* proposed bounded route 始终有效

---

## Step 3：单站 source-of-truth A/B

只选一个 inbound station 或一个 station pair：

* station runtime 签发 queue reservation
* head-only service grant
* conflict 时 suspend/resume
* 其他 station 继续 legacy

不要同时切全部站点。

---

## Step 4：长跑闸门

建议按：

```text
10m → 30m → 4570s → 2h soak → 24h
```

每一级必须满足：

* physical violations = 0
* confirmed deadlocks = 0
* persistent intent/contract violations = 0
* 没有 assigned-without-route
* 没有连续 long-stuck window
* 没有连续 small-loop / ping-pong window
* inbound、outbound 均未出现整段 10 分钟零产出
* total PPH 无未解释回退

4570 秒 A/B 应以 handoff 中的 `388.359 total / 241.05 inbound / 147.309 outbound` 为基准，但通过标准不应只是 PPH 相同；必须同时通过 contract、recovery 和 3D 行为检查。

24 小时最终报告应包含：

* 每小时 inbound/outbound/total PPH
* 每 10 分钟、每 AMR 完成任务矩阵
* 每 AMR 最大连续 blocked time
* small-loop、ping-pong、zero-task-moving
* station reservation/service grant churn
* conflict sessions：opened/recovered/timed-out
* p95/p99 queue wait、service wait
* 1678/4561 同类事件计数
* 关键 checkpoint 的 3D 回放

---

## 最终判断

* **1678 秒：** 主因是任务 intent 非原子化，以及用 self-goal 表示 queue hold；route planner 不是首要嫌疑。
* **4561 秒：** 是真实 reciprocal traffic conflict，但 `deadlockCount` 又混入了恢复时序和观测语义问题。
* **station architecture：** 当前确实处于危险的 hybrid 状态，shadow-derived lease 已经进入控制路径。
* **最小修正：** 不是增加 blocker，而是建立 `VehicleIntent`、持久 station contract 和独立 conflict recovery ownership。
* **最新 top-a WIP：** 保留测试场景和安全 retreat 算法，回滚 smoke-counter hook，合并进通用 conflict session resolver。
* **当前工作树：** 不应整体提交；应按 observer purity、atomic intent、conflict resolution、station shadow 分拆。
