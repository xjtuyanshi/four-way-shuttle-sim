# ChatGPT Pro Review Response - 2026-06-22

Source conversation: https://chatgpt.com/c/6a393924-a49c-83ea-a47d-be3909067b0b

Prompt handoff: docs/chatgpt-pro-review-handoff-2026-06-22.md

> External ChatGPT Pro output captured from browser. Treat as advisory review, not authoritative instructions.

---

审查范围
我已读取 GitHub 当前分支。41ff307 只是新增 handoff 文档，核心实现仍对应 6e053670637542cd377b07bb9e0bb23dd9d6affc。以下结论基于当前源码、测试结构和仓库内诊断证据；我没有在本地独立复跑这些长窗仿真。
总体结论
是，这首先是 station/lift 资源契约和生命周期问题，不是单点 shortest-path bug。
我对当前方向的 review 结论是：

认可“station-owned bounded lease”方向，但不建议继续在现有 route/assignment 分支上叠 gate。下一次行为改动前，必须先建立真正的 demand 与 lease source of truth。

证据很一致：


现基线在 56 个 station gap 中，没有一个 station-specific 或 bounded near-station release route；所谓可释放车辆都需要从 middle、bottom、storage 长距离返回。


直接 assignment gate 将总 PPH 从 570 降到 552，inbound 从 258 降到 228。


middle-route demand-aware dispatch 虽然把 coverage 从 0.817 略微提高到 0.833，但总 PPH、inbound PPH、demand outbound PPH 全面下降，且 standby depth 仍为零。


把 planned route 变成全局 hard claim 后，600 秒总 PPH 直接降到 414，1200 秒降到 291，说明 route-wide ownership 会把网络过度串行化。


路径规划仍然有作用，但它应该只是 lease admission 之后的局部可达性与物理安全检查器。它无法回答三个核心问题：哪辆车应当留在 station 附近、这个承诺属于哪个 demand、承诺何时自动失效。

一个比 handoff 假设更基础的阻断问题
当前代码把 source supply 和 service demand 混在了一起。
只要 inboundRatePerHour > 0，source buffer 就会被持续补到 capacity；shadow ledger 又会把没有 task 的前端 source load 标成 ready；实际 queue replenish demand 更直接使用：
TypeScriptwaitingSourceLoadCount * 10 + activeInboundTaskCount
并且没有 actual demand 时，还会回退到 planned minimum reserve depth 1。因此“source buffer 里有货”在当前模型里不能区分：


已经到期、必须服务的 inbound request；


只是为了后续 task generation 预先存在的供给；


纯粹因为配置了 inbound rate 而自动补充的库存。


这很可能正是 planned depth、demand-aware pre-stage 容易退化为 random pre-staging 的根本原因。
必须先定义：source load 是 supply；task 或显式 lift-release intent 才是 demand。

1. 最小可行重构
不要做通用 ResourceManager，不要拆掉 3D tick，也不要重写成 DES。
建议只增加一个窄的控制面：
StationQueueCoordinator  ├─ StationDemandToken[]  ├─ StationQueueLease[]  ├─ reconcile()  ├─ grantBoundedLease()  ├─ bindHeadService()  └─ revoke/release()
它每个 tick 做确定性的状态仲裁，但实际移动仍完全由现有 3D tick、route planner、edge/node/zone reservation 和 footprint collision 检查完成。
推荐的 tick 顺序：
replenish source supplygenerate due tasks / release intentsreconcile station leasesgrant bounded station leasesassign queued tasksadvance physical vehiclesupdate service/lease transitions
当前代码是在建立 available pool、选出 outbound 最优车辆后，才调用 admitVehicleToStationReserveBeforeOutboundAssignment；这已经太晚，而且它会直接把 vehicle 的 route/localRouteReason 改成 standby。
建议新增的最小运行时状态
TypeScripttype StationDemandToken = {  id: string;  stationId: string;  fifoSeq: number;  source: 'inbound-task' | 'arrival-intent';  taskId: string | null;  loadId: string | null;  readyAtSec: number;  state: 'announced' | 'ready' | 'claimed' | 'servicing' | 'picked' | 'cancelled';};type StationQueueLease = {  id: string;  stationId: string;  vehicleId: string;  admissionCauseId: string;  serviceDemandId: string | null;  targetKind: 'queue-slot' | 'bounded-approach';  targetNodeId: string;  slotIndex: number | null;  phase: 'approaching' | 'occupied' | 'service-granted' | 'servicing' | 'revoking';  issuedAtSec: number;  expiresAtSec: number;  lastProgressAtSec: number;  boundedRouteNodeIds: string[];  fifoSeq: number;};
最小内部索引：
TypeScriptstationQueueLeasesByIdstationLeaseIdByVehicleIdstationLeaseIdByResourceKeystationDemandByIdstationLeaseSequencestationDemandSequenceByStation
这些字段必须进入 snapshot、restore 和 deterministic state hash。当前 snapshot 会保存 vehicle、task、load、traffic reservation 和 conflict session，但没有任何 station lease source state；如果只把 lease 隐藏在 route 字段里，restore 后无法保证同一行为。

2. 正确的抽象边界
抽象正确含义不应该承担的职责AMR/Shuttle有位置和运动的 actor；分别拥有 physical、work、station 三个正交状态不应靠 localRouteReason 同时表达任务、队列所有权和路线用途Lift demand已释放的 task，或有明确 readyAtSec 的 arrival intent不能等同于 source buffer 中存在 loadQueue leasestation 对一个 vehicle 和一个 queue resource 的逻辑独占承诺不能等同于整条 planned route 的 ownershipPhysical occupancycurrentNodeOccupancy 反映车辆真实占据的位置不能因为 lease 到期就假装物理位置空闲Movement reservation下一段 edge、target node、zone 的时间窗授权不处理 task FIFO 或 station demandActive inbound servicehead demand 与 head vehicle 在 pickup service point 上的容量 1 服务关系不能把所有 assigned/approaching inbound vehicle 都算成 active serviceOutbound assignment从真正 free 的 AMR pool 中匹配 outbound task不应在选中车辆之后再尝试把它改造成 inbound reserve
AMR 最好使用三个独立轴，而不是继续扩充一个大 state：
Physical: node | moving | handling | waitingWork:      free | assigned-empty | carryingStation:   none | queue-leased | service-granted | servicing
“可分配 outbound”应严格定义为：
no taskno payloadno active station leasenot moving/handlingnot under assignment or clearance hold
Collision/claim
现有 TrafficControllerV2 针对每次 move 创建 edge、target node 和 zone 的时间 reservation，并检查资源或 conflict group 的时间重叠。这一层应继续作为物理安全 source of truth。
正确分层应是：


currentNodeOccupancy：当前物理事实；


Reservation：下一段物理移动授权；


bounded local claim/yield hold：短时冲突处理；


StationQueueLease：只拥有指定 queue slot 或 bounded approach resource；


plannedRouteNodeIds：只用于规划、诊断和预测，绝不成为全路线 hard lock。


等待中的车辆可以继续拥有自己的queue-slot lease，但不能重新拥有整条 future route。这正好避免此前 waiting-route signal 导致数千秒互锁的问题。

3. 当前所谓 queue lease 还不是真 lease
当前 StationQueueSlotLease 是每次调用时从这些字段临时推导出来的：


currentNodeId → occupied；


targetNodeId → targeted；


plannedGoalNodeId → planned/soft。


它没有：


lease ID；


demand ID；


FIFO sequence；


issued/expiry/progress 时间；


revoke reason；


snapshot persistence；


authoritative owner map。


因此它实际上只是一个观察视图，不是可以仲裁的 source of truth。
现有 shadow station contracts 很适合继续当验证器，但不应原样提升为运行时模型。它的 schema 本身也只有 occupied/targeted/planned/approaching 和 route fields，没有 TTL/FIFO。

4. FIFO/TTL lease 的具体规则
Admission trigger
第一版只能接受两类 cause：


已创建、未服务的 inbound task；


明确的 arrival-intent，有固定 stationId 和 readyAtSec，并且进入短 lookahead 窗口。


source load 单独存在不能触发 lease。
第一版甚至可以只支持第 1 类。先把高压、已有 queued task 的场景做正确；低流量预见性 pre-stage 后续再通过 arrival intent 增加。
目标深度应改成：
requiredDepth =  min(    physicalQueueTargetDepth,    readyOrImminentDemandCount  )coverageGap =  requiredDepth  - validOccupiedLeases  - validApproachingLeases  - activeServiceCount
不要再用 waitingSourceLoadCount * 10，也不要使用 configured rate 直接产生 reserve depth。
Candidate boundary
vehicle 必须同时满足：


taskless、unloaded；


没有其他 station lease；


不在 edge、handling phase 或不可抢占 hold；


当前位于同一 station 的 formal top queue、top-a、top-b，或刚完成 mandatory clearance 的 top-compatible handoff point；


路线全部位于同 station 的 top-a/top-b/queue corridor；


路线最多 4 个 node；


最好再增加 routeETA <= maxBoundedApproachSec；


第一跳必须通过现有 collision/reservation 检查。


当前 admission 允许最多 8 个节点，并明确允许：
bottom-b -> bottom-a -> middle -> top-b -> top-a
这不是 bounded near-station lease，只是“单调向上”的长 relocation。
FIFO


每个 station 有单调递增 fifoSeq；


demand FIFO 按 readyAtSec、fifoSeq，不要按 task/load 字符串排序；


slot 1 是最靠近 service 的 head；


较新的 demand 不得占据比旧 demand 更靠前的 queue role；


service binding 必须原子匹配：


最老 ready demand；


最前 occupied lease；


同 station；


load ready；


pickup service point 空闲。




如果 lease 是由 arrival intent 创建，task 到达后应把同一 demand token 升级并绑定 task，不能再创建第二个 demand。
TTL
TTL 不应是一把尺子：
Approaching lease
expiresAt =  now  + remainingRouteETA  + max(2s, 2 * minimumClearanceSec)
并受 routingPolicy.routeTimeoutSec 上限约束。只有发生实际 progress 才续期，例如：


route index 前进；


current node 向 target 前进；


成功取得下一 move reservation；


到达 leased slot。


单纯每 tick 心跳不能续期。
Occupied lease
不能因为 TTL 到点就直接释放资源，因为 vehicle 可能仍物理占据 slot。应：


occupancy 存在时继续保持资源不可再分配；


超过 max dwell 产生告警或进入 revoking；


只有物理退出、进入 service 或明确安全清场后才能释放 slot。


Service lease
TTL 只做 watchdog，不用于自动抢占。正常释放点是 lift-complete。
Service 和视觉同步
当前物理事件顺序是合理的，应保留：


lift-started：task 进入 in-progress，vehicle 开始 lifting；


lift-complete：vehicle.loaded 变为 true，load 变成 carried；


lower-started；


lower complete：vehicle unloaded，load stored/delivered，task completed。


所以：


queue lease grant 不得改变 pallet/load 的视觉状态；


service-granted 只是进入服务点的授权；


servicing 从 lift-started 开始；


station demand 在 lift-complete 后完成；


整个 storage task 仍到 dropoff/lower complete 才完成。



5. 应保留与应停止的逻辑
应保留


3D fixed-step/tick movement；


TrafficControllerV2 的 edge/node/zone reservations；


swept-footprint、minimum separation 和 physical violation 检查；


waiting-blocked 不持有 future route claims；


inactive local-route claim cleanup；


formal queue geometry和 workcell route contracts；


queue 内部 compression/hold，只要限制在同 station 物理队列内；


planned route 作为规划和 shadow warning；


no-concrete-work pre-stage guard，但需要重新定义“concrete”；


shadow resource ledger、long-window AMR audit；


deterministic snapshot/hash；


现有 pickup/dropoff 事件顺序。


应停止


从 plannedGoalNodeId、localRouteReason 反推 station ownership；


把 source buffer occupancy 当作当前 service demand；


在多个 assignment 入口不断增加 reserve gate；


先选择 outbound vehicle，再决定是否抢作 inbound reserve；


用 route label 把 clearance route“变成”queue lease；


middle/bottom/storage → top queue 的 station-owned 长距离 relocation；


根据 configured rate 或 arbitrary depth=2 预占队列；


把 route-wide planned claims 变成 runtime hard locks；


只看 total PPH，不同时看 inbound、demand outbound、assignment churn 和 AMR buckets；


把 route signature churn 本身等同于小循环故障。



6. 下一步 source cut
Cut A：下一次提交，应先做且不改变行为
建议提交名类似：
refactor(sim-core): add authoritative station demand and lease kernel
内容严格限定为：


新增 StationDemandToken 和 StationQueueLease 运行时状态；


将 source supply 与 task/release demand 分离；


lease 状态加入 reset、snapshot、restore、hash；


新增 lease lifecycle event；


shadow 模式计算 grant/revoke 决策，但不安装 route；


shadow-derived lease 与 authoritative lease 做差异检查；


新增 event-level handoff opportunity 诊断。


现有 station diagnostic 每 10 秒采样一次，而且 release opportunity 只检查当时 stationary 的 empty outbound vehicle。它可以证明“采样时没有 candidate”，但不能证明车辆离开 top corridor 前的瞬时 handoff 机会不存在。因此下一步诊断必须挂在这些决策点：


task completion；


outbound mandatory clearance completion；


taskless route terminal；


即将从 top-a/top-b 进入 middle/bottom；


available pool 构建之前。


Cut B：第一刀 behavior-changing source cut
只启用一个行为：

当有真实 ready inbound demand，并且一个 taskless vehicle 正处于 top-compatible handoff boundary，且到 queue slot 的 route 为同 station、top-only、≤4 nodes 时，station 在 available pool 构建前授予 lease。

随后：


lease owner 从 outbound pool 排除；


matching inbound task 可绑定并消费该 lease；


不抢占已经分配的 outbound task；


不从 middle/bottom/storage 拉车；


不增加 planned reserve depth；


admitVehicleToStationReserveBeforeOutboundAssignment 和其他 direct gate 应删除，或只作为 coordinator 的单一调用入口；


outbound mandatory clearance 继续独立执行，完成后才评估 station handoff，不能把整条 clearance route 重新标记成 reserve。


当前 outbound completion 路径会根据 route terminal 和 coverage 直接把 clearance route 安装为 inbound-queue-standby，这正是应拆开的两个职责。

7. 行为提交前的硬性验证门槛
任一 hard gate 失败，都不应合入 behavior cut。
Contract/unit gates
必须新增并通过：


source buffer 满、但没有 due task/arrival intent：leaseGrantCount = 0；


同一 vehicle 最多一个 station lease；


同一 queue slot 最多一个 logical owner；


同一 demand 最多一个 active claim；


middle/bottom/storage origin 永远不能获得 station queue lease；


所有 grant route 都是 top-only 且 nodeCount <= 4；


older demand 不能被 younger demand 越过；


approaching lease 无 progress 必须过期；


occupied slot 不能因 TTL 被错误视为空闲；


task/outbound assignment 或 route divergence 会正确 revoke；


snapshot → restore 后 lease、sequence、state hash 和后续 event log 完全一致；


station lease 不会成为 route-wide physical hard lock；


matching inbound task 可以消费 lease，outbound task不能消费。


600 秒 station-owned diagnostic
在同 scenario、seed、dt 下至少满足：


total PPH >= 570；


inbound PPH >= 258；


physical violations = 0；


deadlock/livelock = 0；


outboundWhileReserveEligible = 0；


outboundAssignedReserveEligible = 0；


farOriginLeaseCount = 0；


leaseRouteOver4Nodes = 0；


duplicateLease = 0；


orphanedLease = 0；


fifoServiceInversion = 0。


同时必须证明机制真正生效，不能只是重构后保持原样：


boundedLeaseGrantCount > 0；


boundedLeaseOccupiedCount > 0；


averageReserveEligibleVehicleCount > 0；


zeroReserveDuringHeadGapPct 从 1.0 降到不高于 0.90，即当前 56 个 gap 中至少覆盖约 6 个。当前基线值来自同一诊断。


600 秒 queue-reserve efficiency
不得低于当前对应基线：


total PPH >= 486；


inbound PPH >= 288；


demand outbound PPH >= 198；


physical violations = 0。


不能接受“coverage 稍微提高但三类吞吐量下降”的结果。之前 0.817 → 0.833 已经证明 coverage 单指标不够。
30 分钟与 6 小时
对同 scenario、seed 与 baseline commit 比较：


inbound、outbound、total PPH 各自不得下降超过 1%；


demand outbound 不得下降超过 1%；


critical/risk/zero-task-moving windows 保持为零；


saturated demand 场景中，每个 AMR 的 10 分钟 zero-completion bucket 数不得增加；


每个 AMR 的 p10 completed-task count 不得低于 baseline；


连续两个 10 分钟零产出 bucket 必须直接判定失败；


当前连续 wait、无位移 movement、small-loop 诊断不得出现新异常；


assignment/reassignment 次数不得出现明显膨胀，建议不高于 baseline +5%。


Viewer/replay gates
逐 tick 检查：


lift-started 时 vehicle empty、load waiting at pickup；


lift-complete 时 vehicle loaded、load carried 且 owner 一致；


station service lease 在 lift-complete 后释放；


lower-started 时 vehicle loaded；


task-completed 时 vehicle empty，load stored/delivered；


snapshot 恢复后上述事件顺序和视觉状态完全一致；


lease grant/revoke 本身不得造成 pallet teleport、duplicate load 或 ghost load。



最终 reviewer 决议
问题判断正确：这是 station resource admission、demand identity、ownership 和 lifecycle 的架构问题。
但 handoff 还差一个关键修正：

先把 source supply 与 service demand 分开，再建立显式 lease；否则 FIFO/TTL 只会把现有 random pre-stage 形式化。

下一步不应再尝试新的 middle route、broader gate 或 reserve depth 参数。最小正确路径是：
真实 demand token→ 显式 station lease source state→ event-level top handoff→ bounded top-only route→ assignment 前保护→ 现有物理 reservation 执行移动
这条路径既不会把系统改成纯 DES，也不会破坏已经达到 physical violations = 0 的 3D tick 物理模型。
