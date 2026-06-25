# ChatGPT Pro Review Response - Round 8 - 2026-06-24

Source: ChatGPT Pro Extended in Chrome, same shuttle review thread.
Prompt handoff: docs/chatgpt-pro-review-handoff-2026-06-24-round8.md
Repo branch at handoff: codex/traffic-v2-flow-debug
Last pushed commit at handoff: c8ccb431ed749c6c6dcb6cf8624b19775bc71ed0
Local diff status: dirty, intentionally not committed because the current 10m WIP gate completed but regressed badly.

---

According to a document from 2026-06-24，Round 8 当前状态是明确的 No-Go：不要提交为 passing version，也不要继续跑 30m/2h。第一轮在 480s 形成 approach wait chain；扩大保护区后，第二轮虽然跑满 600s，却把总 PPH 压到 132，并造成 5 辆车约 400–442s 的持续等待。这个结果已经足以判定：activeVisit 被赋予物理排他权的时间过早、范围过大。

Pasted markdown

审查边界也要明确：GitHub pushed commit 是 c8ccb431...；其中 runtime 仍主要由 request、slot owner、envelope owner、service owner 和 active transition 组成，并没有 Round 8 handoff 所述的 activeVisitRequestId / mode / drainEpoch 完整本地语义。远端 station kernel 仍声明为 shadow，outboundVisits 也是 shadow DTO。因此下面对 Round 8 的判断以 pasted handoff 为主，不是对未提交源码逐行批准。

总体决策
项目	结论
activeVisit 作为逻辑 aggregate root	保留
activeVisit 一创建就保护 approach/envelope	撤回
slot0、显式 approach/envelope topology	保留
pre-service drain 思路	保留，但拆成两个 scope
“nearest outside feasible node” egress	撤回
当前整条 approach chain 长时间独占	撤回
重新回到纯 slot0 + local blocker	不建议
下一刀	显式 approachLease 激活边界
现在跑 30m/2h	不允许
1. 最可能的根因
一级根因：逻辑 admission 与物理 ownership 被混成同一件事

activeVisit 在 outbound work admission 时就产生，这是合理的：它表示 depth=1 下该 station 已经接收了一个工作。

但它只能拥有：

station logical capacity

不能因此自动拥有：

approach slots
pass / slot0
service envelope
相邻 storage exit

Round 8 的 WIP 把 activeVisit 投影成 slot owner，并由该 visit 推导完整 approach/service protected nodes。这实际上建立了错误等式：

activeVisit exists
    == slot0 reserved
    == approach reserved
    == service envelope reserved

正确关系应该是：

activeVisit exists
    != any physical lease exists

只有显式签发 approachLease、slot0Lease 或 envelopeLease 后，对应物理区域才具有排他性。

600s 现场正好证明了这一点：

lift-01-outbound owner SH-05 还在 column-bottom-a-c10，目标甚至是 column-bottom-b-c10；

lift-02-outbound owner SH-06 还在 module-02-spine-bottom-a；

但 c08、c09、c21 附近的普通 storage/column 流量已经因 outbound-station-visit-owned 被封锁超过 400s。

Pasted markdown

这不是正常 draining，而是远程 visit 对尚未到达的物理区域进行了长期预占。

二级根因：保护范围一次扩到了 approach + service

Round 7 需要的是：

slot0 occupant
  -> service envelope drain
  -> service grant

Round 8 却扩展成：

activeVisit admitted
  -> protect entire approach
  -> protect entire service envelope
  -> force all foreign traffic leave

于是一个尚未到达 pre-entry 的 owner，可以冻结三个 approach slots、storage exits 和 station envelope。这把一个局部 station handoff 变成了整个 bottom-column 区域的长期 corridor lock。

三级根因：egress 是几何启发式，不是资源契约

“最近的外部可行节点”不应作为 station egress 规则。它可能：

把车辆送入另一个 storage exit；

穿过 owner 的 ingress 路径；

导致反复重新规划；

把堵塞转移到相邻列或 module spine；

让 drain occupant 集合持续变化。

Station 必须定义有方向的、确定性的 egress graph，而不是每 tick 搜索最近外部节点。

四级根因：诊断状态暴露了 source-of-truth 不一致

当前 active visit 显示 slot-reserved，但 owner 尚未接近 slot0；同时 service transition 是 waiting-for-head-reservation，head supply 仍是 unknown。这说明逻辑 visit、物理 lease 和 shadow transition 没有同一套状态语义。

Pasted markdown

slot-reserved 必须意味着实际存在 slot lease，不能只是“该 visit 未来可能去 slot0”。

2. WIP 应该保留、撤回和重做什么
保留

activeVisitRequestId 作为 depth=1 station logical-capacity owner。

at-slot0 和 draining 这些状态概念。

显式 station topology：

approach slots；

admission edge；

pass/slot0；

service entry edge；

service envelope；

clear-through。

slot0 使用 slotIndex: 0 的 schema 修正。

同一个 controller tick phase 内集中推进状态。

read/query path 不再调用 mutating reconcile。

foreign occupant 只能按明确方向离开、不能逆向进入 service node 的原则。

Round 7 与 Round 8 的失败 regression fixtures。

撤回

从 activeVisit 自动投影 slotOwnerRequestId。

active visit 一产生就把 approach slots 加入 protected nodes。

owner 未 loaded-ready、未到 pre-entry 时保护 station 区域。

service envelope 在 owner 到 slot0 之前就被保护。

“nearest outside feasible node” egress。

仅因为车辆位于相邻 storage cell，就把它当成 station protected-region occupant。

outbound-station-visit-owned 作为没有具体 lease resource key 的通用 blocker。

重做

物理所有权必须重新拆为：

activeVisit       逻辑容量
approachLease     进入并穿越 approach chain 的短期权利
slot0Lease        pass 点唯一占用
drainEpoch        在签发下一物理 lease 前清空一个有界区域
envelopeLease     service envelope 排他占用

mode 不应成为第六个独立 source of truth。最好由资源状态派生：

no drain / no lease     -> shared
drainEpoch != null      -> draining
approachLease != null   -> approach-exclusive
envelopeLease != null   -> service-exclusive

若确实保存 mode 字段，也必须在同一个原子 transition 中修改，并有硬 invariant 验证它与 lease 组合完全一致。

3. 最小状态机
核心原则

activeVisit 可以在 task admission 时创建，但直到显式 physical lease 发出之前，它不得阻塞任何物理节点或边。

推荐状态机
Visit 状态	有效资源	可做什么	禁止什么
admitted	activeVisit	执行 outbound pickup	保护 approach/envelope
loaded-ready	activeVisit	正常路由到 station pre-entry 附近	自动占用 slot0
waiting-approach	activeVisit	在 station 外合法 hold point 等待	在 approach 内 self-goal
approach-draining	activeVisit + approach drainEpoch	冻结新 ingress；现有 occupant 按确定 egress 离开	owner 进入未清空区域
approaching-slot0	activeVisit + approachLease	owner 沿固定 bounded route 前进	foreign 进入 approach
at-slot0	activeVisit + slot0Lease	检查 service envelope	直接让 foreign 进入 slot0
service-draining	activeVisit + slot0Lease + service drainEpoch	清空 service envelope	owner 提前进入 envelope
service-granted	activeVisit + slot0Lease + envelopeLease	安装固定 service route	重新选择 owner
entering	activeVisit + envelopeLease	进入 service node	foreign ingress
servicing	activeVisit + envelopeLease	handling/dropoff	释放 envelope
clearing	activeVisit + envelopeLease	沿 clear-through 路径离开	新 visit 取得物理 lease
completed	无	释放全部资源	残留 lease
cancelled-clearing	取决于物理位置	若已进入则安全清场	在 envelope 内直接删除 visit
approachLease 何时签发

不是 task admission，也不是单纯 loaded-complete，更不应采用通用的“距离 N 个节点”。

使用明确 topology 边界：

visit.state == loaded-ready
vehicle.loaded == true
vehicle 位于 station-defined preEntryNode
下一条 route edge == station admissionEdge
存在 bounded route: preEntry -> tail -> ... -> slot0
没有其他 physical station lease

例如既有 topology 中：

lift-01: column-bottom-a-c10 -> column-bottom-a-c09
lift-02: column-bottom-a-c18 -> column-bottom-a-c19

当 loaded owner 真正准备跨越该 admission edge 时，controller 才开始 approach handoff。

若 owner 还在 storage 内、module spine 或执行 pickup：

approachLease = null
slot0Lease = null
envelopeLease = null
protectedNodes = []
approach 与 service 是否共用 drainEpoch

共用同一个数据结构，但必须是两个不同 scope 和两个不同阶段。

TypeScript
type DrainEpoch = {
  id: string;
  ownerVisitId: string;
  scope: 'approach' | 'service';
  protectedNodeIds: string[];
  ingressEdges: EdgeKey[];
  foreignVehicleIds: string[];
  egressRouteByVehicleId: Map<string, string[]>;
  startedAtSec: number;
  deadlineSec: number;
  lastProgressAtSec: number;
};
Approach drain

触发：loaded owner 已到 pre-entry，准备跨 admission edge。

保护：

精确的 approach chain；

进入该 chain 的 admission/side ingress edges；

不包括相邻 storage cells；

不包括 service envelope。

existing occupants 可以按 station-defined egress 离开；新 entrant 被禁止。occupant 集合在 epoch 创建时冻结，已经有 in-flight ingress reservation 的车辆必须一并纳入。

清空后签发 approachLease。

Service drain

触发：owner 已经物理到达 slot0。

保护：

service-entry edge；

service envelope；

不再保护 upstream approach slots。

清空后在同一个 controller cycle 内签发 envelopeLease 并进入 service-granted。

最小物理保护集
Owner 尚未到 pre-entry
空集
Approach drain / lease

对于 depth=1，第一版可以保护完整、显式且很短的 approach chain，而不是动态 N-node route：

lift-01: c09, c08, c07
lift-02: c19, c20, c21

关键不是进一步缩成一两个节点，而是只在 owner 已到 admission edge 时激活，并有严格 TTL。这样实现简单，也不会形成几百秒预占。

owner 到 slot0 后：

release c09/c08 或 c19/c20
retain slot0 only
Service drain / lease

仅 service envelope 和 service-entry edge。

4. Foreign vehicles 如何退出而不冻结整个 module

不要使用 nearest outside feasible node。

每个 station topology 应提供：

TypeScript
approachDrainExitRoutesByNode
serviceDrainExitRoutesByNode
preEntryHoldNodeId

规则：

drain epoch 创建时，冻结当前 foreign occupant 集合。

每个 occupant 获得一条预先验证的、单调离开 protected region 的 route。

route 不得穿越：

owner 的 admission edge；

slot0；

service node；

owner 的 pre-entry hold node。

occupant 离开后不得重新进入，直至 epoch 完成。

位于相邻 storage cell 但尚未进入 approach node 的车辆，不是 occupant；它只是在 lease 期间不能进入该 approach node。

owner 应停在 protected region 和 foreign egress path 之外。若 topology 没有安全 hold 点，就不能启动 drain，直到 owner 可以在 region 清空后立即跨越 admission edge。

这可避免：

owner 在入口挡住 egress
foreign occupant 等 owner
owner 又等 foreign occupant
5. 下一步 focused red tests

先全部做成确定性 unit/integration test，再跑 10m。

Test 1：activeVisit 没有 physical lease 时绝不阻塞普通交通

复现 Round 8 600s 的核心模式：

SH-05 拥有 lift-01-outbound activeVisit；

SH-05 尚未 loaded-ready 或还在 c10/storage route；

SH-01 从 storage-r14-c08 请求 c08；

SH-03 从 storage-r14-c09 请求 c09。

断言：

approachLease == null
slot0Lease == null
drainEpoch == null
protectedNodes == []
SH-01/SH-03 不出现 outbound-station-visit-owned

这是下一刀最重要的红测试。

Test 2：只有跨 admission edge 时才启动 approach drain

loaded owner 位于 c10，next edge 是 c10 -> c09；

foreign occupant 位于 c08；

另一个 foreign vehicle 在 region 外准备进入 c09。

断言：

创建 drainEpoch(scope=approach)；

occupant 集合只包含已经在内或已经获得 in-flight ingress grant 的车辆；

外部车辆被禁止新进入；

owner 留在 pre-entry；

service envelope 仍是 shared；

occupant 按固定 egress 路径离开；

region 清空后签发 approachLease。

Test 3：owner 到 slot0 后释放 upstream approach

owner 依次到达 c09、c08、c07；

达到 c07 后：

approachLease released/narrowed
slot0Lease owner == activeVisit
c08/c09 恢复普通流量

普通车辆应能再次使用 c08/c09，而不能进入 c07。

Test 4：service drain 与 approach drain 分离

owner 已在 slot0；

service envelope 内有 foreign vehicle；

approach upstream 有另一辆普通车。

断言：

创建 drainEpoch(scope=service)；

upstream approach 不被 service drain 封锁；

envelope occupant 获得确定 egress；

清空后的同一 controller cycle 签发 envelopeLease；

owner 开始 entering。

若 envelope 起始为空，必须同 tick 直接 service-granted，不得多等待一个通用 timeout。

Test 5：snapshot/cancel 生命周期

分别在以下状态 snapshot/restore：

approach-draining；

approaching-slot0；

service-draining；

entering。

恢复后：

occupant 集合、owner、deadline、lease resource key 不变；

下一 transition 与不中断运行一致；

cancel/reset 后没有 orphan activeVisit、drainEpoch 或 lease。

6. Hard invariants

以下必须每 tick 检查，不是每 5s/30s 采样。

activeVisitCountPerStation <= 1
approachLease.visitId
slot0Lease.visitId
drainEpoch.ownerVisitId
envelopeLease.visitId
全部为空或等于 activeVisit.id
activeVisit 存在但无 physical lease/drainEpoch
=> protectedNodeCount == 0
approachLease != null
=> owner loaded
=> owner 位于 approach region 或 admission edge
=> owner route 是 station bounded route
slot0Lease != null
=> owner 在 slot0 或正在进入 slot0 的最后一条 edge
service drainEpoch != null
=> slot0Lease != null
=> owner 当前在 slot0
envelopeLease != null
=> service envelope 无 foreign occupant
=> envelope owner == slot0 owner == activeVisit
gap == unknown under active outbound visit
=> hard failure
waitReason == outbound-station-visit-owned
=> 必须带 concrete resourceKey、ownerVisitId、lease/drainEpoch id
没有 physical lease/drainEpoch
=> outbound-station-visit-owned wait 必须为 0
drainEpoch foreignVehicleIds 只能减少，不能持续增加
7. 下一轮 gates

建议使用相同 seed、arrival trace、初始库存与此前 reference 做严格 A/B。

10m gate

必须：

跑满 600s；

physical violations 0；

deadlock/livelock 0/0；

anomaly/critical 0/0；

long-wait window 0；

gap=unknown = 0；

activeVisit-without-lease-block = 0；

orphan visit/lease 0；

approach/service drain timeout 0；

任一 outbound-station-visit-owned 连续等待不得超过对应 drain deadline。

性能建议以此前 slot0-egress 10m 的 552 total / 168 outbound 为 reference：

total PPH >= 524
outbound PPH >= 160

也就是不超过 5% 回退。至少不能接受当前 132 / 60 这种数量级。

30m gate

必须满足全部 10m 条件，另加：

跑满 1800s；

每个 station 至少完成多个完整：
approachDrain -> approachLease -> slot0 -> serviceDrain -> envelopeLease -> clear；

所有 drain epoch 都结束；

所有 physical lease 的 lastProgressAtSec 持续前进；

所有 AMR 10m window：

stationary-active 0；

long-wait 0；

zero-task-moving 0；

无车辆在相同 station protected region 反复进出；

visit phase dwell p95/max 写入审计。

相对 30m reference 484 total / 134 outbound：

total PPH >= 460
outbound PPH >= 127
2h gate

必须：

跑满 7200s，不得 early stop；

safety、deadlock、livelock、critical、AMR risk 全部为零；

每个 10m AMR window 无 long-wait/stationary-active；

gap=unknown = 0；

activeVisit 无 physical lease 时的 station blocker 次数 0；

drain no-progress episode 0；

physical lease owner mismatch 0；

foreign re-entry violation 0；

slot0 到 service grant 超时 0；

max station physical wait 小于计算出的 TTL。

TTL 不要使用通用 300s，按 topology 计算：

T_approach =
  3 × freeFlow(preEntry -> slot0)
  + 2 × directionSwitchSec
  + 5s

T_drain =
  3 × longestForeignEgressFreeFlow
  + 2 × directionSwitchSec
  + 5s

相对 Round 6 完整 2h reference 356 total / 151.5 outbound：

total PPH >= 338.2
outbound PPH >= 143.9

2h 正常结束后停止生成新任务，再做最多 300s quiescence drain：

activeVisit == 0
approachLease == 0
slot0Lease == 0
drainEpoch == 0
envelopeLease == 0
station mode == shared

通过一个 reference seed 后，再补两个不同 seed 的 2h，才允许进入 6h/24h。

明确停止的局部补丁

不要再做：

为 c08、c09、c20、c21 分别增加特殊 blocker。

把 adjacent storage nodes 继续加入 protected set。

把整个 owner plannedRouteNodeIds 视为 station hard ownership。

用 “距 station N 个节点”代替显式 admission edge。

用最近外部节点做 egress。

提高 long-wait/deadlock timeout 来让报告变绿。

因 activeVisit 存在而取消、抢占或重派普通 inbound/storage 任务。

给 owner 增加超高 route priority，强行挤开其他车辆。

让 generic deadlock breaker承担正常 station queue 协调。

在当前 depth=1 未稳定前启用 depth=2。

让 query/diagnostic/dispatch-goal getter 修改 controller 状态。

再增加一个与 activeVisit / leases / drainEpoch 平行的 owner table。

最终结论

当前 WIP 可保留骨架，但必须撤回“activeVisit 立即物理独占”的语义。

最小正确下一刀是：

activeVisit 只拥有逻辑 station capacity
        |
loaded owner 到达显式 pre-entry
        |
approach drainEpoch
        |
approachLease
        |
slot0Lease
        |
service drainEpoch
        |
envelopeLease
        |
service / clear / release

核心验收句应是：

没有显式 physical lease 或 drainEpoch，就没有任何 station-owned physical blocker。

只要这条没有成为每 tick 硬 invariant，继续扩展 protected nodes 只会把死锁换成更大范围、更长时间的流量冻结。
