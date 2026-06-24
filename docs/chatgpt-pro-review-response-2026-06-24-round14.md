# ChatGPT Pro Review Response - Round 14

- Date: 2026-06-24
- Reviewer surface: ChatGPT Pro Extended
- Repo: xjtuyanshi/four-way-shuttle-sim
- Branch: codex/traffic-v2-flow-debug
- Commit reviewed: 95d63f9
- Handoff sent: docs/chatgpt-pro-review-handoff-2026-06-24-round14.md

## Response

Reviewer decision：Request changes

当前分支不能接受为 24h/customer-review 候选，但不需要推倒重写。

30m 和短 3D smoke 证明物理运动、安全距离和基础吞吐并没有整体崩坏；40m 稳定等待闭环则证明 station/dock corridor 的活性与资源所有权契约仍不正确。

我没有在 GitHub ref 中读取到所列失败 JSON、checkpoint 和 rolling log 文件，因此具体 2400s 状态以已提交 handoff 为事实源；代码结构判断基于 95d63f9 当前源文件。

核心判断

这不是一个真正的“三车环”，而是：

SH-01 -> 等待 SH-02 的 dock protection
SH-02 -> 等待 SH-01 占据的 c18
SH-07 -> 等待 SH-01 占据的 c18

其中真正的强连通等待环是：

SH-01 <-> SH-02

SH-07 是被这个二车环吸住的第三个受害者。

根本错误是：

系统让 SH-02 获得了足以阻止 SH-01 离开的 station/dock 优先权，但 SH-02 自己又需要 SH-01 当前占据的物理节点。

这违反了非抢占物理资源最基本的规则：

尚未进入 exclusive 状态的未来 owner，不能阻止现有 occupant 释放它所占的资源。

“envelope owner precedence”只能在完整 drain 已完成、exclusive lease 已合法生效之后成立。在 shared/draining 阶段，必须是 incumbent/drainer precedence。

1. 当前 station/dock/lane arbitration 是否已经过度碎片化？

是，证据已经足够，不应再增加局部 precedence/yield 例外。

当前实现实际上有两套控制面：

Schema 中的 StationKernel、station coordinator 和 service transition 都明确是 mode: "shadow"，即诊断模型，不是实际 movement authority。

实际 outbound runtime 同时维护：

activeVisitRequestId

mode

envelopeOwnerRequestId

slotOwnerRequestId

serviceOwnerRequestId

activeTransition

drainEpoch

这些都是可能独立变化的 mutable ownership indicators。

这使系统可能同时表达：

逻辑上 SH-02 是 active station visit
物理上 SH-01 仍占据 corridor
dock policy 保护 SH-02
node occupancy 保护 SH-01
drain 规则又只覆盖部分 envelope

这就是 Round 14 的稳定闭环。

另外，2400s 时 shadow ledger 仍为零违规，而当前 station invariant 只检查 demand coverage、重复 commitment、route/kernel lease 配对等，没有检查 foreign occupant、wait-for cycle 或 no-stop entry。

最小可行重构

不要重写 task、routing、physics 或 dashboard。只重构 station 周边一个小型 topology-defined conflict region 的 movement arbitration。

建议引入一个 authoritative：

TypeScript
StationConflictRegionKernel

它只负责：

进入共享 dock/throat region
region 内通行
进入 service envelope
clear-through
普通非 station 车辆的 transit

保留现有：

task assignment；

station FIFO request；

shortest path；

generic occupancy；

collision/swept-footprint；

3D physical tick。

逻辑 FIFO 与物理 lease 必须分开：

Station FIFO token:
  表示 SH-02 是下一个 station head

Station movement lease:
  表示 SH-02 此刻真的可以进入共享物理区域

SH-02 可以长期保持 FIFO head，但在 SH-01 排空之前不能拥有会阻止 SH-01 出口的 spatial lease。

2. bottom-a 混合交通应该怎样运行？

首先，c18 不能同时充当：

普通车辆等待点；

outbound station approach；

lane crossing；

station protection boundary；

多方向车辆的 immediate target。

它应被建模为 no-hold conflict cell。车辆可以穿过，但不能在没有下游保证的情况下进入并停住。

在当前三车状态下，正确顺序如下。

第一步：SH-01 是 incumbent drainer

SH-01 已经物理占据 column-bottom-a-c18。无论它是不是 station 车辆，它都先于后来的 exclusive station grant。

应当发生：

station mode = draining
active exclusive station lease = null
SH-01 registered as drainer
new entries to c18 closed

如果 column-bottom-b-c18 以及到第一个安全停止点的路径可用，给 SH-01 一个 bounded drain lease：

c18 -> bottom-b-c18 -> first safe egress

此时 outbound-lift-dock-protected 不得阻止它。

第二步：SH-02 保留 FIFO head，但不拥有 corridor

SH-02 可以保留：

outbound station request
FIFO sequence
queue/meter slot lease

但不能保留：

dock corridor ownership
service envelope ownership
阻止 SH-01 排空的 movement priority

换句话说：

SH-02 是下一个，不等于 SH-02 现在拥有 c18。

plannedGoal=column-bottom-a-c21 只是 intent，不是空间 lease。

第三步：SH-07 在 region 外等待

SH-07 不是 station queue follower，而是普通 inbound transit requester。

它应在 c19 或更上游的合法 hold 点等待；在没有 transit lease 时，不得继续把 c18 保持为可执行 immediate target。

第四步：SH-01 排空后，才授予 SH-02 station transition

当且仅当：

region 中没有 foreign occupant
没有 foreign active edge 正在进入
没有 foreign immediate committed target
service + clear-through bounded segment 可用

才原子授予 SH-02：

approach -> service -> clear-through

此时关闭 SH-07 所在入口，SH-07 等 SH-02 release 后再获得 transit lease。

一个重要的反向检查

如果 SH-01 到达 c18 后发现 bottom-b-c18 无法使用，那么真正的错误发生得更早：

SH-01 不应该在没有 egress lease 的情况下进入 c18。

因此正常契约应是：

reserve safe egress
-> reserve conflict cell/edges
-> enter
-> release behind

而不是：

先进入 c18
-> 再等待下游和 station policy

如果 c17/c19 也属于 no-stop 节点，它们同样不能被当作长期物理队列；station logical queue 应放在真正合法的 meter/pocket，或把 physical station WIP 暂时限制为 1。

3. 是否应该由一个 station kernel 统一授权？

是，但要统一的是“策略授权”，不是取代底层物理 occupancy。

正确分层应是：

Station queue kernel
  维护 demand/FIFO/head

Station conflict-region kernel
  维护 transit/drain/station-entry/service/clear lease

Generic traffic/physics
  最终执行节点占用、边运动、swept footprint 和碰撞检查

可以在代码上属于同一个 StationKernel，但内部必须保持这两个 ledger 分离。

当前 schema 已经具备接近正确的词汇：

queue-slot
bounded-approach
service-envelope
clear-through

问题是它们目前仍然只存在于 shadow diagnostics。

建议的 authoritative lease
TypeScript
type StationMovementLease = {
  id: string;
  stationId: string;
  vehicleId: string;
  requestId: string | null;

  kind:
    | 'transit'
    | 'drain'
    | 'station-enter'
    | 'station-service'
    | 'station-clear';

  phase: 'granted' | 'entered' | 'clearing';

  entryGateId: string;
  exitNodeId: string;

  protectedNodeIds: string[];
  protectedEdgeIds: string[];

  issuedAtSec: number;
  lastProgressAtSec: number;
  deadlineSec: number;
};

region runtime 应改成 discriminated union，使非法组合不能表达：

TypeScript
type StationRegionState =
  | {
      mode: 'shared';
      activeLease: null;
      drainEpoch: null;
    }
  | {
      mode: 'draining';
      activeLease: null;
      drainEpoch: DrainEpoch;
    }
  | {
      mode: 'exclusive';
      activeLease: StationMovementLease;
      drainEpoch: null;
    }
  | {
      mode: 'clearing';
      activeLease: StationMovementLease;
      drainEpoch: null;
    };

然后：

envelopeOwnerRequestId

serviceOwnerRequestId

dock owner

active transition owner

全部从 activeLease 派生，不再分别写入。

slotOwnerRequestId 可以继续存在，但只能表示 region 外部的 queue slot，不得自动赋予 corridor 权限。

单一调用点

所有进入或在 station region 内移动的车辆都调用：

TypeScript
authorizeStationRegionMove(
  vehicle,
  fromNodeId,
  toNodeId,
  boundedRoutePrefix
)

返回：

TypeScript
allow
hold(reason, blockerVehicleId, leaseId)
grant(lease)

旧的：

outbound-lift-dock-protected
envelope-owned
envelope-yielding exception
foreign-forward-clearing exception

不能继续作为独立 policy blockers。它们应被 region kernel 的一个决策取代。

node-occupied 仍应保留，因为它是物理事实；但 kernel 不得生成一个会与该物理事实形成反向等待的 lease。

4. 应添加什么 invariant 和 regression test？
最重要的 invariant
在 station conflict region 内，不允许存在 vehicle/resource wait-for cycle。

具体到本次：

SH-01 waits for station lease owned by SH-02
SH-02 waits for node occupied by SH-01

应在第一次形成时立即报错，不应等到 300–600 秒后才被 long-wait detector 发现。

当前 audit 默认 longWaitSec=300、stationaryActiveSec=540，对于资源闭环检测过晚。

建议新增四个硬 invariant
A. Exclusive lease 不得包含 foreign occupant
TypeScript
state.mode === 'exclusive'
  => occupants(region).every(v => v.id === activeLease.vehicleId)
B. Foreign occupant 存在时必须处于 draining
TypeScript
foreignOccupants(region).length > 0
  => state.mode === 'draining'
  && activeLease === null
  && every foreign occupant is a registered drainer
C. No-hold cell 进入必须带 egress lease
TypeScript
move enters conflict/no-stop node
  => lease.routePrefix ends at service slot or safe node outside region
D. Lease 必须有 bounded progress
TypeScript
active lease:
  current time - lastProgressAtSec <= expected transition deadline

不能只依赖最终 deadlock count。

精确的 SH-01/SH-02/SH-07 regression test

构造：

SH-01: c18, wants bottom-b-c18, ordinary inbound transit
SH-02: c17, station FIFO head, loaded outbound
SH-07: c19, ordinary loaded inbound transit

必须依次断言：

SH-02 保持 FIFO head；

SH-02 尚未获得 exclusive spatial lease；

region 进入 draining；

SH-01 获得 drain lease；

SH-07 不得再进入/target c18；

SH-01 先离开 region；

之后才 grant SH-02；

SH-02 完成 service/clear-through；

最后 SH-07 获得 transit；

全程：

无 wait-for SCC；

无 generic deadlock breaker；

无 reverse ping-pong；

无 physical violation。

再加两个单点测试：

does not grant station-exclusive lease while a foreign vehicle occupies the region

does not admit a transit vehicle into a no-hold conflict cell without reserving its safe egress
Shadow ledger 也必须扩展

至少新增：

stationWaitForCycle
exclusiveLeaseHasForeignOccupant
drainerBlockedByPendingOwner
noStopEntryWithoutEgressLease
stationLeaseProgressTimeout

否则仍会出现“shadow 0 violation，但三台车静止 600s”的 false green。

5. 下一步最小安全实施计划
P0：先做一次纯诊断复现，不改行为

不要先写第五个 clearing exception。

在 1500–2400s 范围记录：

每个 station region 的 mode
active request / active lease
current occupants
entry gate claims
每次 allow/deny decision
deny reason 与 blocker
SH-01 进入 c18 的时刻
SH-02 被标成 owner/head/active visit 的时刻
第一次形成 SH-01 <-> SH-02 wait-for cycle 的时刻

关键要回答：

SH-01 是先进入 c18，之后 SH-02 才获得保护？
还是 SH-02 已有合法 exclusive lease，SH-01 仍被错误放入 c18？

这决定 bug 位于：

grant-before-drain

还是：

entry-gate bypass

但两者都由同一个 region contract 修复。

建议把 wait-for SCC 检测加入诊断，第一次形成循环时立刻保存 checkpoint，而不是等 600s 窗口结束。

P1：建立 topology-defined region

在 scenario 初始化时构造并缓存：

TypeScript
type StationConflictRegionPlan = {
  id: string;
  stationId: string;

  interiorNodeIds: string[];
  interiorEdgeIds: string[];

  entryGateEdges: string[];
  safeExitNodeIds: string[];

  queueSlotNodeIds: string[];
  serviceNodeId: string;
  clearThroughNodeIds: string[];
};

不要每 tick 从完整动态 route 推导 region，也不要把整条 bottom-a lane 变成 exclusive。

第一版可以每个 region 同时只允许一个 bounded movement lease；只要 region 足够小，这比扩大全 route lease安全得多。正确性稳定后再增加 compatibility matrix。

P2：把现有 runtime 收敛到一个 authority

保留现有 request/FIFO。

替换：

多个 owner ID
独立 dock blocker
独立 envelope blocker
独立 yielding precedence

为：

一个 StationRegionState
一个 activeLease
一个 authorizeStationRegionMove()

drainEpoch 和 activeLease 必须互斥。

在迁移期间可以保留旧函数做 assertion：

TypeScript
if (legacyDecision !== kernelDecision) {
  emit critical diagnostic;
}

但只能有 kernel 的结果实际控制 movement，不能两个 controller 同时投票。

P3：focused 和 full-core gate

先跑新回归：

Bash
./node_modules/.bin/vitest run \
  packages/shuttle-sim-core/src/index.test.ts \
  -t "station conflict region|drains incumbent before outbound station lease|no-hold conflict cell" \
  --maxWorkers=1

再跑当前 15 个相关测试：

Bash
./node_modules/.bin/vitest run \
  packages/shuttle-sim-core/src/high-inbound.test.ts \
  packages/shuttle-sim-core/src/lift-approach.test.ts \
  packages/shuttle-sim-core/src/index.test.ts \
  -t "keeps a 12-shuttle high-inbound stress run active|uses configured lift approach staging capacity|keeps unready top-lift inbound work|outbound station|envelope-yielding candidate" \
  --maxWorkers=1

然后：

Bash
./node_modules/.bin/vitest run packages/shuttle-sim-core --maxWorkers=1
./node_modules/.bin/vitest run packages/shuttle-sim-core

要求 0 failed。

P4：确定性 replay

加入一个 pre-knot snapshot regression：

从 cycle 出现前的 snapshot 恢复
运行至少 120s
与 direct run 比较 event/state hash

并断言：

stationWaitForCycle = 0
exclusiveLeaseHasForeignOccupant = 0
leaseProgressTimeout = 0
P5：physical ladder

先不要再次直接跑 24h。

顺序建议：

45–60m exact scenario
2h
6h
24h

修复后的首轮不要只跑到 2400s，应至少越过原失败点 10–20 分钟。

首个 gate 可用原配置，但加强观测：

Bash
./node_modules/.bin/tsx scripts/run-physical-24h-amr-audit.ts \
  --duration-sec 3600 \
  --audit-every-sec 1 \
  --ten-minute-sec 600 \
  --hourly-sec 3600 \
  --shuttles 8 \
  --regions 2 \
  --inbound-pph 3600 \
  --outbound-pph 3600 \
  --initial-fill-policy zone-balanced-50 \
  --storage-selection-policy sequential \
  --collision-avoidance on \
  --long-wait-sec 60 \
  --stationary-active-sec 120 \
  --stop-on-critical \
  --out output/review/physical-60m-after-station-region-kernel.json

降低这些检测阈值只是为了更早失败，不能作为行为修复。

每一级要求：

physicalViolations = 0
deadlocks = 0
livelocks = 0
stationWaitForCycle = 0
exclusiveLeaseHasForeignOccupant = 0
noStopEntryWithoutEgressLease = 0
stationLeaseProgressTimeout = 0

并且：

active AMR 不得整整一个 10m 窗口 0 tasks + 0m path + blocked；

更强的实时 gate：active AMR 不得无进展超过 120s；

每个 10m throughput 不得相对前三个稳定窗口中位数突然下降超过约 25–30%；

outbound 不能连续窗口塌缩；

snapshot/restore deterministic hash 一致；

35–50m 时间段应做一次 3D replay/visual smoke，而不只是重新看前 7 分钟。

明确停止修改的内容

本轮应停止：

再加 foreign vehicle may clear if... 特例；

再加一层 envelope owner/yielder precedence；

用 loaded/outbound 全局优先级解决；

改 shortest-path heuristic；

扩大 lease 到完整 route 或整条 bottom-a；

把 c18 capacity 改成 2；

放松 collision/occupancy；

让 SH-01 通过车辆 ID 或固定节点特例倒车；

降低 PPH、等待或 anomaly 通过阈值；

依赖 generic deadlock breaker 在运行后修复这个环。

最小安全动作

下一步只做两件事：

加入第一次形成 SH-01 <-> SH-02 wait-for cycle 时的诊断 checkpoint 和确定性三车 regression；

把 bottom-a station conflict region 的 movement authorization 收敛到一个 authoritative bounded lease，确保 drainEpoch 与 exclusive lease 互斥。

不要在完成这两件事之前继续跑 2h/6h/24h。
