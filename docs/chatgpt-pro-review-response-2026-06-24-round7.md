# ChatGPT Pro Review Response - Round 7 - 2026-06-24

Source: ChatGPT Pro Extended in Chrome, same thread as Round 6 shuttle review.
Prompt handoff: docs/chatgpt-pro-review-handoff-2026-06-24-round7.md
Repo branch at handoff: codex/traffic-v2-flow-debug
Last pushed commit at handoff: c8ccb431ed749c6c6dcb6cf8624b19775bc71ed0
Local diff status: dirty, intentionally not committed because the 2h gate failed.

---

Review 结论

当前 slot0 + egress 工作树不应作为通过版本提交，2h gate 是明确 No-Go。
但也不建议整体回滚：slot0、visit、显式 envelope topology 和 foreign egress 的方向都对。应保留这些资产，替换目前错误的所有权协调核心。

本次判断以 pushed commit c8ccb431... 和你提供的本地 diff/6600s checkpoint 为依据。

Pasted markdown

核心判断是：

6600s 不是新的局部 pathfinding 故障，而是一个典型的 split-brain station ownership：
SH-05 同时是 visit head、slot0 owner 和 pass occupant，但这些事实没有原子地转化为 controller 的 head reservation；而 service envelope 内又有 SH-02，现有 egress 权限只有在 activeTransition 已创建后才生效，形成先有 grant 还是先 drain 的循环依赖。

因此，仅把 SH-05 “立即 promote 成 service owner”仍不够。正确的最小修正是：

slot0 owner 立即成为唯一 head visit；

若 envelope 已清空，同一 controller cycle 内发出 service grant；

若 envelope 未清空，进入 station-owned draining 状态；

draining 在 service grant 之前就阻止新 foreign ingress，并驱逐现有 foreign occupant；

envelope 清空后再原子获得 service/envelope lease。

1. SH-05 长期等待的根本原因
判断：你的假设基本正确，但还少了一半

“controller 没把 slot0/pass occupant 当成 head reservation”确实存在，而且从 schema 就能看到不一致：

ShadowOutboundStationVisit 已允许 currentSlotIndex=0，并有 at-pass、service-granted 等 phase；

当前本地 diff 也把 route lease 的 slotIndex 改成了 nonnegative；

但 serviceTransition.headReservationSlot 和 headReservationSupply.physicalHeadReservationSlot 仍是 positive，无法表示 outbound slot 0；

vehicle commitment 的 queue slot 字段同样仍是 positive。

所以 waiting-for-head-reservation 和 headReservationSupply.gap=unknown 至少部分是模型本身无法表达 slot0 head reservation，不是现场真的没有 head。

更严重的是，内部 controlling state 和 shadow visit state不是同一个状态机：

内部 request states 是 admitted / loaded-ready / waiting-at-gate / pass-granted / entering / servicing / clearing...；

内部没有 authoritative at-pass，也没有 draining；

shadow visit 却有 slot-occupied / at-pass / service-granted；

runtime 还分别保存 slotOwnerRequestId、envelopeOwnerRequestId、serviceOwnerRequestId 和 activeTransition。

这意味着 at-pass 只是从车辆位置推导出来的诊断结果，不是驱动 controller transition 的 source of truth。

6600s 的实际 wait-for graph

现场不只是 SH-05 没被 promote：

SH-05
  位于 pass/slot0 c07
  等待 service transition
  下一步需要进入 bottom-b-c07

SH-02
  已占据 bottom-b-c07
  却以 pass c07 为 target
  等待 SH-05 让出 pass

SH-03
  位于 c06
  同样 target pass c07
  等待 SH-05

所以至少存在：

SH-05 waits for bottom-b-c07 / envelope availability
SH-02 waits for SH-05 to vacate pass

而当前 foreign-egress 补丁只有存在 activePass 时才允许 foreign vehicle drain。现在 activePass 又因为 envelope 未清空而无法建立，于是产生循环：

需要 activePass 才能 drain
需要 drain 完成才能 grant activePass

这才是 6600s 的完整根因。

另一个必须修的设计问题

当前 diff 让下面两个本应纯读取的函数调用 mutating reconciliation：

outboundStationWorkAdmissionBlockReason()

outboundDropoffDispatchGoalNodeId()

它们调用 reconcileOutboundStationSlotOwner()，意味着仅仅查询 block reason 或 dispatch goal 就可能改变 owner。任务遍历顺序、查询次数甚至 diagnostics 调用顺序都可能改变 controller 状态。

必须改成：

controller 在固定 tick phase 中统一推进一次；所有 admission、routing、blocker、diagnostics 只读取不可变的本 tick controller snapshot。

2. 最小系统性修正

不要再增加 SH-02 或 c07 专用 blocker。最小 contract 是让 OutboundStationVisit 成为 aggregate root：

TypeScript
type OutboundStationRuntime = {
  stationId: string;

  // Depth=1 station work capacity
  activeVisitId: string | null;

  mode: 'shared' | 'draining' | 'exclusive';

  // Physical child leases; never independently elect owners
  slot0Lease: {
    visitId: string;
    vehicleId: string;
    nodeId: string;
    issuedAtSec: number;
    lastProgressAtSec: number;
  } | null;

  envelopeLease: {
    visitId: string;
    vehicleId: string;
    issuedAtSec: number;
    lastProgressAtSec: number;
  } | null;

  drainEpoch: {
    visitId: string;
    foreignVehicleIds: string[];
    startedAtSec: number;
  } | null;
};
最重要的语义分离

当前 diff 把 slotOwnerRequestId 同时当成：

station work admission capacity；

queue head；

physical pass lease；

service grant 前置条件。

这是错误的。

应拆为：

activeVisitId
表示 depth=1 station 已经接受一个 outbound work。它从 task admission 开始存在，即使车辆尚未完成 pickup。

slot0Lease
是真正的物理 pass slot lease。只在车辆 loaded-ready、接近 station 且 controller 准备接管该区域时签发。

envelopeLease
只在 drain 完成并发出 service grant 时签发。

因此：

work admission 应检查 activeVisitId，不应检查 slotOwnerRequestId；

head reservation 不再是另一个独立 owner election，它就是 slot0Lease.ownerVisitId；

serviceTransition 是 visit 状态转换事件，不是另一张 owner 表；

slotOwnerRequestId、serviceOwnerRequestId 等字段可以暂时保留作兼容 projection，但不能继续分别 reconcile。

服务授权规则
visit at slot0/pass
        |
        +-- envelope clear
        |      -> same controller cycle: service-granted
        |      -> acquire envelope lease
        |
        +-- envelope contains foreign vehicle
               -> mode=draining
               -> freeze new foreign ingress
               -> issue explicit egress plan
               -> once empty, service-granted

不应直接在 envelope 未清空时 promote 为 entering/service owner。
可以立即认定它是 head reservation owner，但 envelope/service ownership必须等 drain 完成。

3. Depth=1 正确状态机

建议只保留一套 authoritative visit state；shadow output 直接投影它。

Visit 状态	拥有资源	允许动作	退出条件
admitted	station capacity	车辆执行 outbound pickup；无 pass/envelope 权限	load 已上车
loaded-ready	station capacity	controller 选择安全 pre-admission hold；检查 station 区域	可开始 drain/获取 slot0
waiting-for-slot0	station capacity	在 station 区域之外等待；不得 target pass	pass 可获取且 drain 已建立
approaching-slot0	station capacity + slot0 lease	只有 owner 可沿 bounded approach route target pass	车辆到达 pass
at-slot0	station capacity + slot0 lease	不得自行进入 envelope；controller 检查 foreign occupancy	clear → service grant；occupied → draining
service-granted	station capacity + slot0 + envelope lease	安装固定 service transition route	下一 movement cycle 开始进入
entering	station capacity + envelope lease	只有 owner 可沿 service route 前进	到达 service node
servicing	station capacity + envelope lease	执行 dropoff/handling	handling 完成
clearing	station capacity + envelope lease	沿指定 clear-through route 离开	完全离开 envelope
completed	无	删除 visit，station 回到 shared	terminal
cancelled	取决于物理位置	未进入 envelope 可直接释放；已经进入则转 abort-clearing	物理清场完成
Station mode 是正交状态
shared
  没有 station exclusivity；普通交通可使用共享节点

draining
  active head visit 正在等待 service
  禁止新 foreign ingress
  现有 foreign occupants 只能沿 egress graph 离开

exclusive
  service/envelope grant 已发出
  仅 active visit 可进入和占有 envelope

depth=1 暂时不需要完整的 outbound-queue batch mode。这里需要的是一个小而明确的 pre-service draining phase。它是当前故障所必需的，不是提前跳到 depth=2。

防止 700s at-pass 的硬不变量
if visit.state == 'at-slot0' and envelopeForeignOccupants.length == 0:
    visit must become 'service-granted' in the same controller cycle

若 envelope 非空：

station.mode == 'draining'
drainEpoch.visitId == activeVisit.id
every foreign occupant has an explicit egress successor/route
no foreign vehicle targets slot0 or service envelope

不允许出现：

state = at-slot0
waitReason = outbound-station-await-transition
mode = shared
grantBlockReason = unknown/null

等待超时也不能继续使用 300 秒通用 AMR threshold。建议按物理路径计算：

T_drain_max =
  max(
    20s,
    3 × longestFreeFlowEgressSec
      + 2 × switchDirectionSec
      + 2 × reservationClearanceSec
  )

对当前几节点 envelope，预计应明显小于 60 秒。超过即 hard failure，而不是等到 10 分钟窗口。

4. Inbound/unloaded 车辆能否 target outbound pass？

不能，只要 slot0 lease、drain epoch 或 envelope lease 任一存在。

这条规则应由 station resource provider 同时提供给：

route planning；

dispatch goal selection；

movement authorization；

shadow invariant audit。

不能只放在最后一级 move blocker，否则 planner 会持续把 c07 当目标，车辆会在 c06/c07 周围堆积和重规划。

分三种情况

Foreign vehicle 尚未进入 protected region

不得规划或 target：

outbound pass node；

service envelope nodes；

protected ingress edges。

它应停在 station topology 中明确配置的 foreignHoldNodeId，而不是随便选择当前节点 self-goal。

Foreign vehicle 已经在 envelope 内

不得原地等，也不得向 pass 回退。controller 必须为它提供显式 directed egress：

bottom-b station node
  -> module spine bottom-b
  -> module spine bottom-a / station外 hold node

现有 egress regression 所验证的方向是合理的，但实现不应依赖：

TypeScript
activePass.routeNodeIds.indexOf(...)

应改成 station topology 自己的：

TypeScript
foreignDrainSuccessors: Map<NodeId, NodeId[]>
foreignEgressNodeIds: NodeId[]

这样 draining 在 activePass 尚未存在时也能工作。

Foreign vehicle 已经完全离开

在 station 回到 shared 之前不得重新进入。

对于 6600s：

SH-02 应从 column-bottom-b-c07 向 station 外 egress，绝不能再 target column-bottom-a-c07；

SH-03 应清除 c07 target，并在 protected region 外 hold/reroute；

SH-05 保持 slot0 head；

SH-02 清出后，下一个 controller cycle 即发出 SH-05 service grant。

5. 下一轮实现与测试顺序
P0：先冻结一个确定性红测试

不要先重跑 2h。

建立一个接近 6600s 的三车 fixture：

SH-05:
  loaded outbound
  activeVisit/head/slot0 owner
  current = pass c07

SH-02:
  foreign unloaded inbound
  current = first envelope node bottom-b-c07
  target = pass c07

SH-03:
  foreign vehicle outside envelope
  target = pass c07

旧实现应稳定复现 no-progress。新实现必须证明：

controller 进入 draining；

SH-02 target 被改为 explicit egress；

SH-03 不再 target c07；

SH-02 清场后一个 controller cycle 内 SH-05 获得 service grant；

SH-05 在 T_drain_max 内进入 service；

三车无 deadlock、无 physical violation。

P1：统一 index 和 diagnostics

至少统一这些字段对 slot0 的表达：

route lease slot；

outbound visit slot；

service transition head slot；

head reservation supply physical slot；

vehicle commitment queue slot。

更稳妥的做法是 controller 不依赖 numeric slot，而依赖：

resourceKey = station:<stationId>:outbound-slot:0
ownerVisitId

数字只用于展示。

同时删除 active outbound visit 下的 gap='unknown'。允许的 block reason 必须封闭：

visit-not-loaded
waiting-for-slot0
draining-foreign-occupants
service-node-occupied
service-route-unavailable
grant-issued
P2：分离 admission capacity 与 slot lease

新增或明确 activeVisitId；

outboundStationWorkAdmissionBlockReason()只读 activeVisitId；

删除它对 reconcileOutboundStationSlotOwner()的调用；

outboundDropoffDispatchGoalNodeId()同样只读，不得修改 controller；

删除“任何 active outbound task 都自动 retains slot”的语义。

当前 outboundStationRequestRetainsSlot() 应被替换，而不是继续加条件。它只要 task 仍 active 就无限保留 slot，正好允许 724 秒的 slot hold。

P3：加入 pre-grant draining

draining 必须在 activeTransition 创建前存在；

egress 权限基于 drain epoch/topology，而不是 active pass route；

新 foreign ingress 被冻结；

清空后原子设置：

visit → service-granted

envelope lease owner

fixed service route

transition deadline。

P4：snapshot/restore

我核对的 pushed ShuttleEngineSnapshotV1 字段中没有看到 outbound station runtime、visit sequence、owner 或 mode。authoritative controller 若不能进入 snapshot，就会在 replay/restore 后重新从 task 推导 owner，重新引入双重 source of truth。

需要覆盖每个中间状态：

loaded-ready；

approaching-slot0；

at-slot0；

draining；

entering；

servicing；

clearing。

restore 后要求下一步 transition、event log hash 和最终结果一致。

明确 Pass/Fail gates
Focused unit gate

必须全部通过：

slot0 能成为 head reservation；

active visit 与 slot0 lease 分离；

at-slot0 + clear envelope 同 tick grant；

at-slot0 + foreign occupant 进入 draining；

foreign inside 只能 egress；

foreign outside不能 target/进入；

drain 后自动 grant；

cancellation/reset 无 orphan lease；

snapshot/restore 每个 state 一致；

sibling station 同时工作互不污染。

10m gate

physical violation 0

deadlock/livelock 0/0

critical 0

outbound completed >0

unknown transition gap 0

foreign target protected node 0

owner mismatch 0

at-slot0-with-clear-envelope 最大持续 <=1 controller cycle

station continuous wait <60s

30m gate

除上述条件外：

所有 admitted visits 最终 completed、clearing 或有明确正常进行中的 phase；

orphan visits/leases 0

draining timeout 0

outbound-station-await-transition > T_drain_max 为 0

10m stationary-active/long-wait windows 0

相同 seed/arrival trace 下 total 与 outbound PPH 不得比 pushed reference 回退超过 5%。

2h gate

必须完整到 7200s，不能 stop early：

critical/anomaly 0/0

physical violations 0

deadlock/livelock 0/0

每辆车所有 10m window 无 stationary-active、long-wait、zero-task-moving；

station wait 最大值 <60s；

draining episode 全部完成；

active visit 下 gap=unknown 次数 0；

slot0、envelope、service owner 始终属于同一 visit；

非 owner target/occupy protected resource 次数 0；

结束后停止任务生成并做 300s quiescence drain：

active visits 0

slot/envelope leases 0

station mode 全部 shared。

上一轮完整 Cut3 2h reference 是 total 356、outbound 151.5。同一 workload 下建议最低性能门槛：

total PPH >=338.2

outbound PPH >=143.9

也就是最多接受 5% 回退。

Pasted markdown

鉴于故障先后出现在约 4685s 和 6600s，正式 24h 前建议至少：

reference seed 2h；

另外两个 seed 各 2h；

一个 6h soak；

然后才允许 24h。

6. 当前 diff 保留还是回滚？
保留

outbound pass/approach/service envelope 显式 topology；

outbound slot0 概念和 resource key；

slot0 owner 才能获得 envelope pass 的检查；

depth=1 station admission；

route lease diagnostics；

foreign vehicle “只向外 drain、不得后退、不得进入 service node、不得重新进入”的测试意图；

schema 支持 outbound slot0；

4685s 和 6600s 两组 regression fixtures。

替换
当前代码	处理
admission 使用 slotOwnerRequestId	改为 activeVisitId
outboundStationRequestRetainsSlot()	删除并换成显式 state/lease lifecycle
reconcileOutboundStationSlotOwner()按 active task 选 owner	改为 loaded-ready 后由 controller 原子签发
query 函数内部调用 reconcile	移除，所有 query 必须纯读取
foreign egress 依赖 activePass.routeNodeIds	改为 drain epoch + station egress topology
slot/envelope/service 三套独立 owner	统一归属 active visit，其他为 derived child leases
inbound-style head reservation diagnostics	改为能表示 outbound slot0，或使用 resource key
unknown gap	对 active outbound visit 禁止出现
不建议恢复的旧逻辑

不要回到：

active outbound task count == station capacity

也不要回到没有 slot0 owner 的 legacy admission。那只会重新引入 Round 6 的 corridor ownership 问题。

最终决策

保留当前 dirty diff 作为 WIP 基础，但不要原样 commit。

最应该回滚/删除的是：

slotOwnerRequestId 兼任 work admission capacity；

“active task 自动永久 retains slot”的 reconciliation；

read/query path 中的 mutating reconcile；

只有 activePass 存在才生效的 egress 机制。

最应该保留的是：

slot0 resource；

owner-only grant；

foreign forward-drain 行为；

所有失败 regression tests。

下一刀不是给 at-pass 多加一个 if。下一刀应当是：

authoritative activeVisit depth=1 + 真实 slot0 lease + pre-service draining epoch。

做到这一步后，SH-05 在 pass 点只有两种合法状态：立即 service-granted，或有明确 foreign occupants、egress plan 和 deadline 的 draining。绝不能再出现第三种持续 700 秒的 outbound-station-await-transition。
