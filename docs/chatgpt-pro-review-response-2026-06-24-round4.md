# ChatGPT Pro Review Response - Round 4

- Captured: 2026-06-24
- ChatGPT conversation: https://chatgpt.com/c/6a3b76e8-3bd0-83ea-bc1a-6e13f3432d12
- Source handoff: docs/chatgpt-pro-review-handoff-2026-06-24-round4.md

---

审查结论

是。这次复现出的卡死、lift 附近反复蹭、outbound 长期归零，主因就是 outbound station / lift queue / resource ownership 的系统性契约缺陷。

明确决策：

保留 R3.2。

回退 R3.3 的运行时行为。

R3.3 中 dropoff → task-specific pass node 的映射思想可以保留，但它必须成为内层 pass 点，不能继续充当整个 station 的外层 boundary。

1. Root cause：不是一个坐标算错，而是同一资源存在多个“真相”

当前 outbound 流程至少有四套独立判断：

dispatch/routing 根据 task、早先任务和 meter 节点推断目标；

station runtime 根据另一套 boundary 判断是否 grant pass；

move blocker 根据当前节点、候选 route 和 dock corridor 推断能否前进；

dropoff 完成后，任务先完成并解绑，另一套 clearance route 再负责驶离。

基准代码也体现了这种分散：outbound meter/FIFO、dispatch goal、dock corridor blocker 分别由不同函数推断，而不是读取同一个 station-owned visit/lease。

与此同时，现有 station kernel 的 lease 收集逻辑跳过 loaded vehicle，主要建模 inbound service 和 taskless inbound standby；它还没有成为 outbound ownership 的唯一来源。

因此：

R3.2 修的是一个真实但独立的 inbound lease lifecycle bug：taskless reserve 不应继续占着 active service 所需的 slot。

R3.3 修错了抽象层：它把 task-specific pass node 当成 station 外层 boundary。move blocker 又通过 route/lookahead 提前实施这个 gate，于是车辆不是停在 c07/c21，而是提前停在 c04/c18。

这不是 collision avoidance “太保守”。collision avoidance 只是把上层授权矛盾显性化。关闭它只会把卡死变成穿模。

对历史上所有穿模现象，不能仅凭这些运行断言全部由同一问题造成；但本轮已复现的 outbound 卡死和长期 PPH 退化，证据足以认定为 station contract 问题。

另一个关键断点是：outbound lowering 完成时，代码先将 task 标记 completed、清除 vehicle.taskId，之后才安装 outbound clearance route。也就是说，clear-through ownership 天然不能只挂在 task 上，必须有一个能够跨越 task completion 的 station visit。

2. 最小架构改动：一个连续 visit，两类 lease，四个阶段

推荐的最小结构不是重写调度器，而是增加一个很小的 outbound station kernel：

普通黄色路网
   │
   │ approach admission
   ▼
有序 approach / meter slots
   │
   │ 到达 task-specific pass node
   │ service pass
   ▼
service envelope
   │ dropoff / lowering
   ▼
clear-through
   │ 车体完全离开 envelope
   ▼
release
两类资源
资源	容量	作用
approach/meter	由真实物理 slot 数决定，通常 >1	让多个 loaded outbound 按 FIFO 接近 pass 点
service envelope	1，或共享物理冲突组容量 1	从 pass crossing 开始，一直占有到 clear-through 完成

不要把整个 approach corridor 建成一个 capacity=1 的大 mutex。 那会再次过早串行化，产生与 R3.3 类似的吞吐崩溃。approach 应是若干有序、单槽容量的 meter slots，车辆只能向 pass 方向压缩，不能超车。

一个连续的 station visit

建议增加：

TypeScript
OutboundStationVisit {
  id;
  requestSeq;
  fifoSeq;                 // 到达 approach admission 时确定
  taskId;
  vehicleId;
  stationId;
  dropoffNodeId;

  approachEntryEdge;
  approachNodeIds;
  assignedApproachSlot;
  passNodeId;

  serviceEntryEdge;
  serviceEnvelopeId;
  serviceEnvelopeNodeIds;
  clearThroughNodeId;

  phase:
    | "requested"
    | "approach-waiting"
    | "approach-admitted"
    | "at-pass"
    | "service-granted"
    | "servicing"
    | "clearing"
    | "released";

  issuedAtSec;
  lastProgressAtSec;
}

这个 visit 在车辆 loaded-ready 时创建并绑定 task-specific 几何计划；在车辆实际到达 approach admission 时进入 station FIFO。这样：

远在仓储区、尚未到站的早期 task 不会形成 phantom head-of-line blocking；

几何计划不会每 tick 重新推断；

task completed 后 visit 仍处于 clearing，直到车体完全离开。

Pass 是“跨边授权”，不是“节点锁”

这是本轮最关键的修正：

拥有 passNode 本身 ≠ 必须已经有 service pass
从 passNode 跨入 serviceEnvelope 的那条 edge 才需要 service pass

即：

TypeScript
requiresServicePass(fromNodeId, toNodeId, visit)

只能检查当前 move 是否跨越 approach → service boundary，不能因为候选 route 后面包含 service node，就在 c04/c18 提前阻断。

短视窗 clear-through safety 可以继续做 bounded lookahead，但它只能判断“现在是否安全进入”，不能改变 gate 所在位置，更不能把未来 route 节点变成全局 hard claim。项目此前的实验也已证明，全局 planned-route hard lock 会过度串行化；正确方向是 FIFO/TTL 的 bounded resource lease。

Pass node 如何从 task/dropoff 决定

不要只做欧氏最近点，也不要把列号偏移散落在 blocker 中。应由纯 topology contract 计算：

根据 task.dropoffNodeId 确定 station 和 service envelope；

在合法 loaded route 上，找到进入 service envelope 的第一条 edge；

该 edge 的 fromNodeId 即 passNodeId；

校验 pass node：

是黄色可行网格节点；

允许停车；

与 service entry 有合法有向 edge；

唯一对应这一 station/dropoff；

从 service 至 clear-through 存在合法路径。

对 handoff 中两个任务：

column-bottom-b-c08 → pass column-bottom-a-c07

column-bottom-b-c22 → pass column-bottom-a-c21

这两个映射应作为新 topology contract 的测试样例保留。

c04/c18 只证明现有 blocker 提前实施了 lookahead gate，不能据此把它们硬编码为新的 approach boundary。

3. 具体 invariants
节点与授权规则
所在区域	loaded outbound 是否可进入	需要什么
普通黄色路网	可以	普通 route/reservation/collision 规则
对应 station 的 approach admission	可以	matching visit + approach capacity
已分配的 approach/meter 节点	可以	matching approach lease，不需要 service pass
passNodeId 本身	可以停留	matching approach lease，不需要 service pass
passNodeId → serviceEntry crossing edge	只有队首可以	matching active service pass
service envelope 内所有节点/edge	仅当前 owner	同一个 service pass
dropoff/lowering	仅当前 owner	同一个 service pass
clear-through 路线	仅当前 owner	同一个 service pass，直到车体完全离开
其他 station 的专属 approach/service 节点	不允许	不得借用错误 station 的 visit

若某些黄色节点同时也是公共 through-lane，不应仅凭 node membership 全局禁止其他车辆；应按 station-directed edge/slot ownership 判定。这避免把共享通道错误变成 station 私有大锁。

必须成立的 ownership invariants

每台 loaded outbound 最多一个 active outbound visit。

每个 active outbound task 最多一个 visit。

每个 approach slot 最多一个 owner。

每个 serviceEnvelopeId 最多一个 owner。

phase 只能单调前进，不能从 servicing/clearing 回退到 approach-waiting。

service pass 必须绑定 visitId + vehicleId + stationId + task/dropoff plan，不能转让。

只有当前物理队首、且已到 pass 点的 visit 能拿 service pass。

task completion 不释放 service pass。

collision blocker 暂时阻止 movement 时，不释放、不重发、不闪烁 pass。

route replan 不得改变 visit 的 station、dropoff、pass node 或 envelope。

ownership 不能再从 plannedGoalNodeId、整条 route 或 wait reason 反向推断；这些只能作为诊断信息。

gate authorization 只针对当前 crossing edge，不能因为未来 route 含有 envelope node 而提前拒绝。

已经在 approach corridor 的车辆

不能把它们退回外层 boundary，也不能 reset route 后重新排队。

应执行一次 station reconciliation：

matching task/visit 且位于 approach：

原地 adopt 为 approach-admitted；

根据到 pass 的图距离建立实际物理顺序；

只允许继续向前压缩；

已在 passNodeId：

置为 at-pass；

没有 service pass 就在此等待；

已经在 service envelope：

原地 adopt 为唯一 service owner；

根据 loaded/lowering/task-completed 状态恢复为 servicing 或 clearing；

禁止给第二台车发 pass；

单个 orphan interior vehicle：

合成一个 adopted-interior-owner visit，让它安全 clear-through；

多台车同时位于同一 service envelope：

这是 hard invariant failure；

停止新 admission，记录故障，不用 generic deadlock breaker 掩盖。

approach lease 可以有 TTL，但车辆一旦物理进入 approach，不能因 TTL 到期被“逻辑驱逐”。service pass 在 interior 绝不能自动到期；超时只触发 watchdog 和诊断。

4. 实施顺序
第一步：恢复可信基线

保留 R3.2。

完整回退 R3.3 的 controlling behavior。

把 R3.2 当前状态做独立 commit/tag，并记录 rolling log。

R3.3 的 dropoff/pass 映射只提取成纯函数和测试，不保留其 move-blocker 改动。

第二步：先建立纯 topology contract

建立类似：

TypeScript
outboundStationPlanForDropoff(dropoffNodeId)

输出 approach entry、ordered approach nodes、pass edge、service envelope 和 clear-through node。

这一阶段不改变行为，只增加 fail-fast assertions 和全 topology tests。

第三步：增加 outbound visit 状态

在现有 station kernel 下增加一个小的 outboundStationVisits 集合，不建议把 loaded outbound 硬塞进名称和语义都偏 inbound 的 stationQueueLeases。

同时覆盖：

snapshot/restore；

deterministic hash；

event log；

diagnostics；

rolling log summary。

第四步：让 station kernel 成为唯一授权源

loaded-ready 创建 visit；

到达 approach admission 后进入 station FIFO；

分配 approach slot；

物理队首到 pass 后 grant service pass；

任务完成后进入 clearing；

footprint 完全离开后 release。

第五步：增加一个中央 movement authorization

不要继续向十几个 blocker 中分散 patch。增加单一入口：

TypeScript
authorizeStationMove(vehicle, fromNodeId, toNodeId)

执行顺序应是：

route edge valid
→ station/resource authorization
→ ordinary reservation
→ collision and swept-footprint safety
→ tick movement

station authorization 永远不能绕过 collision avoidance。

第六步：把旧逻辑降级为 diagnostic

旧的：

task-order inferred FIFO；

route-lookahead station boundary；

independently inferred envelope pass；

clearance owner inference；

不能和新 kernel 同时 controlling。短期可以保留为 shadow comparison，发现不一致时报警，但只能有一个真正授权源。

暂时不要改

不改 collision avoidance；

不改 footprint、clearance、速度、加速度、dt；

不改 task arrival rate 和 storage selection；

不加 generic priority/deadlock breaker；

不扩大 planned-route hard claims；

不借机重写整个 dispatcher；

不以提高 PPH 为由缩短 clear-through；

不把 approach corridor 设成一个 capacity=1 大锁。

5. Focused tests

建议按四组增加。

A. Topology contract

c08 → pass c07、c22 → pass c21。

所有 outbound dropoff 都有唯一 station plan。

pass node 是黄色网格、可停、与 service entry 有合法 edge。

approach entry、pass、service entry、clear node 顺序正确。

approach 与 service envelope 不重叠，pass node 属于 approach 而非 service。

B. R3.3 精确回归

loaded outbound 从 c04 一类上游节点出发，没有 service pass 时仍可沿 approach 前进到 c07。

它只能在 c07 → service crossing 上被拒绝，不能在 c04/c18 提前等待。

等待原因必须是 outbound-station-await-pass，当前位置必须等于该 task 的 passNodeId。

grant pass 后无需 route reset 即可继续 service。

C. FIFO 和 lifecycle

同 station 两台车：只有物理队首拿 pass，后车不超车。

不同 station 可并行，各自 envelope 独立；几何冲突时使用共享 envelope resource key。

approach 满载时只拒绝新 entrant，不冻结已经在 corridor 内的车辆。

lowering 完成、task completed、vehicle.taskId=null 后，visit 仍为 clearing。

只有到达 clear node且 footprint 离开 envelope 后才 release。

collision 暂时挡住 service owner 时，pass owner 不改变。

pre-entry cancellation 释放 request/approach lease；interior cancellation 必须先 clear。

snapshot/restore 后 visit、FIFO、owner、phase 完全一致。

D. Recovery、安全与现有回归

已在 approach 的车辆能够原地 adopt，不返回 outer gate。

已在 pass 的车辆等待后正常获 grant。

单个 orphan interior vehicle 被 adopt 并 clear；期间不能发第二个 pass。

每个 station transition edge 做 swept-footprint 检查，逻辑和 3D projected footprint 都无重叠。

保留 R3.2 两个 stale inbound reserve focused tests。

增加一个 300–600 秒 deterministic integration test，要求至少完成 outbound，且 pass 不闪烁、无 orphan、无 phase regression。

对 station plan build 次数做断言：一个 visit 只计算一次，不允许每 tick shortest-path 重算，避免 R3.3 那种 wall-clock 暴涨。

6. Validation gates

所有运行必须使用相同 seed、相同流量、相同车辆数，并保持 collision avoidance 开启。任何 hard safety/contract failure 都不能被平均 PPH 掩盖。

10 分钟 gate

以 R3.2 为直接基线：

total：468 PPH

outbound：150 PPH

最低接受条件：

类别	Gate
吞吐	total ≥ 421 PPH；outbound ≥ 135 PPH
基本功能	outbound completed > 0
安全	physical violation = 0；3D projected-footprint overlap = 0
契约	duplicate service owner、orphan owner、pass mismatch、phase regression 全部为 0
活性	station head 无进展不得超过 120 秒
位置	所有 await-pass 必须发生在对应 task 的 exact pass node
上游阻断	c04/c18 一类 approach 上游不得因缺少 service pass 被阻断
性能	同机器 wall clock 不得超过 R3.2 的 1.25 倍

因此 R3.3 的 90 total / 0 outbound / 172.8s 必须直接判 fail，不进入 30 分钟。

30 分钟 gate

R3.2 的总体结果是 408 total / 110 outbound，但末尾 outbound 已归零。因此需要同时检查总体值和尾部稳定性：

类别	Gate
总体吞吐	total ≥ 367 PPH；outbound ≥ 99 PPH
10 分钟窗口	每个 10 分钟窗口 outbound > 0
5 分钟窗口	有 loaded outbound backlog 时，不允许任何连续 5 分钟 outbound=0
尾部退化	最后 10 分钟 total ≥ 首个 10 分钟的 75%；outbound ≥ 首个 10 分钟的 60%
station head	相同 head/phase/node 无进展不得超过 120 秒
loaded AMR	连续等待不得超过 300 秒
契约及安全	所有 sample 的 invariant count 都为 0，而不只是 final snapshot 为 0
性能	wall clock 相对同基线不得恶化超过 25%

按这套 gate，R3.2 会因末尾 outbound 停止而失败，这正是合理结果。

24 小时 gate

24 小时只在 30 分钟完全通过后启动。定义：

S30 = 通过的 30 分钟运行中，第 10–30 分钟的平均 PPH
Hourly PPH

必须输出 24 行 hourly 数据，包含 total/inbound/outbound、backlog、waiting、blocked、resource violations。

硬条件：

24h 平均 total ≥ 0.90 × S30.total

24h 平均 outbound ≥ 0.90 × S30.outbound

有 outbound backlog 时，不允许任何小时 outbound=0

hourly total 和 outbound 的 p05 ≥ 各自 hourly median 的 70%

最后 6 小时 median total/outbound ≥ 前 6 小时 median 的 90%

任意 3 小时 rolling PPH 不得持续低于 24h median 的 75%

这能捕获“总体平均还可以，但后半程逐渐死掉”的情况。

每台 AMR、每 10 分钟

8 台 AMR 应各有 144 行记录。至少输出：

completed tasks / inbound / outbound；

moving、loaded、blocked、idle seconds；

path length、net displacement、bbox；

unique nodes、node transitions；

current wait reason；

approach/service visit phase；

station lease/pass ownership；

loopiness、confinement、ping-pong flags。

现有审计脚本已经具备大部分这些字段，并已有 stationary、small-loop、ping-pong、long-wait、zero-task-moving 等指标。

硬条件：

zeroTaskMovingWindows = 0

criticalWindows = 0

smallAreaLoop = 0

nodePingPong = 0

任何 AMR 不得连续两个 active 10 分钟窗口完成任务数为 0

单个窗口 completedTasks=0 只有在以下全部满足时才可接受：

moving < 300 秒；

loadedSec = 0；

不持有 approach/service lease；

不在 active task 上

每台 AMR 的 24h completed-task 总数不得低于 fleet median 的 70%，避免个别车辆长期饿死

卡死和小范围打转

直接沿用并强化现有指标：

loaded 或 station-owner 连续 wait > 300 秒：fail

station head phase/node/edge 120 秒无进展：fail

service pass 120 秒无任何 phase 或几何进展：fail

10 分钟窗口内：

bbox ≤ 3m，

path ≥ 8m，

loopiness ≥ 6
判为 small-area loop，任何一次都 fail

≤3 个 unique nodes 且 ≥6 次 transition：判为 ping-pong，任何一次都 fail

confined run > 600 秒：fail

穿模与逻辑安全

必须同时检查：

logical node/edge occupancy violation = 0；

swept-footprint collision = 0；

3D projected-footprint overlap = 0；

同一 service envelope 同时出现两台 AMR = 0；

pass owner 与实际 interior occupant 不一致 = 0。

不能只看当前的 physicalViolationCount，因为两个逻辑节点可能投影到 3D 中非常接近或重叠。

长运行性能

24h 最后四分之一的 simulated-sec / wall-sec 不得低于第一四分之一的 80%；

active visits、leases、event buffers 必须有稳定上界；

不得出现随着时间增长的 station-plan 重算或 route-replan 频率上升。

每次 10m、30m、24h 运行都继续写 rolling log，记录原因、改动、runtime、PPH、窗口退化和具体失败 invariant。

7. 对 R3.2 / R3.3 的明确决定
R3.2：保留

理由：

它修复的是明确的 lease lifecycle 错误；

修改范围窄；

focused tests 覆盖了“应释放”和“不应释放”两侧；

没有削弱 collision avoidance；

10m 仍有正常 inbound/outbound；

30m 暴露的是另一个 outbound contract 问题，不是否定 R3.2。

R3.3：回退

理由：

10m gate 已明确失败；

outbound=0；

vehicle 在真正 pass 点之前被阻断；

wall-clock 显著恶化；

focused tests 通过只说明测试验证了当前实现，并不说明契约正确。

应从 R3.3 只保留这一条知识：

task.dropoffNodeId 应确定 task-specific passNodeId。

但应删除这一条错误实现：

task-specific passNodeId 等同于 station 外层 boundary，并允许 move blocker 根据未来 route 提前执行 gate。

最终正确形态是：

一个连续 stationVisitId，一个多槽 approach lease，一个 task-specific inner pass，以及一个持续到 clear-through 完成的 service-envelope owner。
