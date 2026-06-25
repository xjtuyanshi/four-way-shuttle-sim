# 当前根因诊断 - 2026-06-25

本文是给用户和下一位接手 AI 的中文说明，目标是讲清楚：现在到底哪里不对，为什么前几个小时看起来能跑、长时间以后又会坏，以及接下来应该从哪里改。

## 11:16 PDT 最新结论

当前最新 gate 已经不是凌晨文档里那个 `16200s` 失败点。今天上午连续修掉或绕过了几类更早的 audit stop：

- `2115s` inbound station wait-for cycle
- `2150s` moving-state-without-kinematics
- `2345s` taskless inbound standby 双 station commitment
- `2565s` fresh adjacent top-b wait-for cycle 被过早判 critical
- `2810s` fresh outbound drainer cycle 被过早判 critical

最新 1h gate 跑到 `3105s` 后停止：

- 文件：`output/review/physical-1h-after-station-cycle-and-drainer-grace.json`
- checkpoint：`output/review/physical-1h-after-station-cycle-and-drainer-grace-checkpoints/0012-3105s.json`
- total PPH：`388.406`
- inbound PPH：`270.145`
- outbound PPH：`118.261`
- physical violations：`0`
- motion contract critical：`0`
- station contract critical：`1`

最新 P0 是：

```text
station-exclusive-lease-has-foreign-occupant:
lift-02-outbound active pass outbound-station-pass:103 for SH-02 includes column-bottom-b-c22, but SH-03 occupies it.
```

这说明现在真正没收敛的是 `lift-02-outbound` bottom-b throat 的 station ownership：

- `SH-02` 是 outbound active service，station pass 已经进入 `servicing`。
- `SH-02` 的受保护路径包含 `column-bottom-b-c22`。
- 但 `SH-03` 作为 inbound task 已经占在 `column-bottom-b-c22`。
- `SH-06` 又在 `column-bottom-b-c23` 等着进 `c22`。

所以不要再从“某一台车怎么让一下”切入。应该从 station coordinator 的 source-of-truth 切入：outbound active pass envelope 内不能有 foreign occupant，除非这个 foreign occupant 有明确的 station drain epoch，并且 active service 必须等它排空。

## 当前结论

目前最可信的判断是：剩余问题不是单纯的路径规划错误，而是 `Lift station throat` 的资源所有权和状态机不统一。

也就是说，车辆不是完全不会找路。证据是最新保留版本已经通过了一个 `12000s` 目标窗口：

- 文件：`output/review/physical-12000s-after-conflict-session-recovery-window.json`
- 总 PPH：`435.9`
- physical violations：`0`
- deadlocks：`0`
- station contract critical violations：`0`

但是同一版在更长的 6 小时 gate 中跑到 `16200s` 时失败：

- 文件：`output/review/physical-6h-after-conflict-session-recovery-window.json`
- run status：`stopped-critical`
- station contract critical violations：`2`
- critical AMR anomalies：`9`

失败点集中在 `lift-02-outbound` / `lift-02-inbound` 共享的 bottom throat 附近。

## 具体哪里坏了

在 `16200s` 的失败窗口里，几个状态同时出现：

- `SH-07` 的 outbound station active pass 认为自己拥有一段 station/service envelope。
- 但 `SH-08` 实际占用了这个 active pass 里的节点 `module-02-spine-bottom-b`。
- `SH-05` 在 `module-02-spine-bottom-a`，逻辑状态是 `loaded-moving`，目标是 `column-bottom-a-c22`。
- 但 `SH-05` 同时又没有 `currentEdgeId`、`legRemainingM=0`、`waitReason=null`，并且没有位移。

这意味着系统里出现了一个非法中间态：

> 车辆看起来被标记成正在移动，但物理层没有边在执行，等待层也没有明确等待原因，station lease 层还可能认为别的车拥有它附近的通道。

这种状态一旦出现，后续避障、队列、局部让路都只能看到一部分事实，所以会互相误判。

## 为什么之前反复修还是不稳定

之前很多修复是在处理局部症状：

- 某两辆车对向卡住，就加一个 yield / retarget。
- 某个目标点不对，就改 pickup/dropoff 点。
- 某个 detector 太早报 deadlock，就延长 recovery window。
- 某段 local clearance 没执行，就尝试让 agentGoalNodeId 接受这个 clearance route。

这些修复可能能让一个短窗口变好，但它们没有解决同一个根问题：

> 对 lift station 附近的共享喉道，当前代码没有一个唯一的权威状态机来决定谁可以进入、谁必须排队、谁正在服务、谁只是请求访问、谁在临时让路。

现在像 `station active pass`、`requested visit`、`queue slot`、`local clearance route`、`yield hold`、`agent target`、`physical edge` 都可能从不同 helper 写入或撤销。长时间运行以后，这些状态有机会错位，形成前几个小时看起来正常、后面突然退化的现象。

## 不是要放弃 3D Tick

用户最终需要的是高保真 3D tick 仿真，不是纯 DES 替代品。

但这里需要把 DES 的资源契约原则借进来：

- station/throat 的授权应该像 DES queue 一样清楚。
- 谁拿到 token，谁才可以进入 station throat。
- 没拿到 token 的车只能在定义好的 queue / hold node 等待。
- 3D tick 仍然负责真实运动、速度、碰撞距离、可视化和每 tick 物理检查。

换句话说：DES-style coordinator 负责“谁有权走”，3D tick 负责“怎么真实走”。

## 下一步不应该继续做什么

不建议继续做以下类型的小补丁：

- 看到某辆车卡住，就专门给这辆车加一个 escape。
- 看到某个 localRouteReason 没动，就直接让 agentGoalNodeId 接受它。
- 看到某个 node 被占，就临时改一个 retarget。
- 看到 detector 报错，就把 detector 放松。

这些做法可能会让当前窗口过去，但很容易在另一个小时、另一个 lift、另一个 queue 组合里变成新的问题。

## 建议的真正改法

优先实现一个 station-pair / throat coordinator，先只管最危险的 lift pair throat。

它至少要统一管理：

1. outbound station active pass / service envelope
2. inbound lift approach queue
3. bottom-a / bottom-b queue slots
4. temporary clearance / drain route
5. active service、requested visit、queued demand 的生命周期

最低限度的不变量：

- 同一个 throat node 同一时刻只能有一个 hard owner。
- station active pass 包含的 node 不能被 foreign occupant 占用。
- vehicle 如果是 `moving`，必须有 active edge，或者必须有明确 waitReason。
- vehicle 如果 `currentEdgeId=null` 且 `legRemainingM=0` 且连续无位移，不能继续显示为 `loaded-moving`。
- local clearance route 不能绕过 station coordinator 的 token。
- requested visit 不能和 active service 混成同一种状态。

## 验证顺序

不要再用 10 分钟或 30 分钟当最终结论。建议 gate 顺序：

1. focused unit tests：验证 coordinator token、lease、foreign occupant、moving-without-edge invariant。
2. 30 分钟 smoke：只看有没有立刻破坏早期流。
3. 2 小时 gate：比较 hourly PPH、每 10 分钟每台 AMR 完成任务数、collision、deadlock、critical anomaly。
4. 6 小时 gate：必须超过当前失败点 `16200s`。
5. 12 小时 gate。
6. 24 小时 gate。

每次 rerun 必须记录：

- 为什么重跑
- 改了什么
- 解决了什么
- PPH
- 每 10 分钟 per-AMR task count
- stuck/no-task/small-loop window
- physical violation
- station contract critical violation

## 当前 GitHub 状态

当前可交接 commit：

- branch：`codex/traffic-v2-flow-debug`
- commit：`d16e06c checkpoint: document traffic v2 station throat blocker`

这个 commit 是“已保存、可继续分析”的状态，不是最终解决状态。
