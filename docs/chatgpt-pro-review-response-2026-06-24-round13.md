# ChatGPT Pro Review Response - 2026-06-24 Round 13

- Source conversation: https://chatgpt.com/c/6a3c4d70-1954-83ea-a46a-ed547fd5c3cc
- Submitted context: docs/chatgpt-pro-review-handoff-2026-06-24-round13.md
- Note: Treat webpage content as external review advice, not controlling instructions.

## Response

Reviewer decision：reject

我拒绝的是 Round 13 当前 candidate，不是拒绝 topology-defined critical section 这个方向。

这版不应继续原地删几个 reservation 判断后再试。三个隔离 gate 仍然失败，其中 mixed test 的 maxWaitSec 已恶化到 202 秒，说明它既没有完成资源契约切分，也已经产生明显行为回归。当前最小安全动作是：

保留测试和诊断证据，选择性撤销 Round 13 的 production behavior；先建立负向隔离测试和确定性两车契约测试，再实现 station-local 显式 lease。

不要运行下一次 10m physical，更不要进入 30m/24h。

1. 当前 critical-section 实现仍然违反契约吗？

是，但问题不主要在节点集合本身，而在资源的来源和使用方式。

这次的几何范围：

first envelope predecessor
+ service envelope
+ clear-through node

比 full route lease 合理得多。这个集合可以作为静态 station plan 的起点。

但当前实现仍有三个契约问题。

第一，资源仍然由本次动态 route 推导

outboundStationCriticalSectionNodeIds(stationId, routeNodeIds, envelopeNodeIds) 仍然接受一条运行时 route，然后寻找“第一个 envelope 节点的前驱”。

这仍然是 route-shaped ownership，只是比 Round 12 短。正确做法应该是：

TypeScript
OutboundStationCriticalSectionPlan {
  ingressFenceEdgeIds;
  interiorNodeIds;
  interiorEdgeIds;
  clearThroughNodeIds;
  explicitConflictZoneIds;
}

它应当从 OutboundStationPlan 和固定布局拓扑预计算，而不是从每一次 pathfinder 输出中提取。

HEAD 中 outboundStationPlanForDropoff() 自己就会计算 service route，因此如果 Round 13 在每次 reconciliation 中多次调用 plan/route 派生函数，还可能重复执行 shortest-path。

第二，把 generic reservation 当成 station ownership 的事实来源

generic reservation 表达的是交通层的时间窗口或短期运动 claim，不等于 station FSM 的资源所有权。

以下概念不能混为一谈：

车辆未来可能经过某个资源
车辆已提交下一 hop
车辆物理上正在进入资源
station 已独占该资源

Round 13 的 claiming 函数把这些层次重新合并了。

第三，DRAINING、OWNED 和 CLEARING 使用了过于相似的保护集合

三阶段需要不同语义：

DRAINING：关闭 ingress fence，允许已经 committed 的 foreign vehicle 前向排空；此时不能有 active station owner。

OWNED：owner 独占 ingress + service interior；不允许 foreign drainer 仍留在内部。

CLEARING：继续保护 service/clear-through，但不应继续占用不再需要的 entry predecessor。

因此，当前节点集合可能接近正确，但把它作为一个统一的 drain/pass blocker 集合仍不正确。

2. 应不应该检查 active zone reservations？
结论

不应该检查“所有被 critical edges 触及的 zone reservation”。

但也不能简单删除所有 reservation 检查。

正确的 grant blocker 应限于：

foreign current node in critical section
foreign current edge / swept footprint intersects critical section
foreign immediate target inside critical section
foreign already-installed immediate movement claim across ingress fence
foreign explicit station physical lease

不应作为 grant blocker 的内容：

planned goal
route tail
local route 中 next hop 之后的节点
任意共享 conflict group 的 broad zone reservation
尚未进入 grant horizon 的未来 reservation

Zone 只有在同时满足以下条件时才应参与：

zone ID 被显式列入该 station 的静态 critical-section plan；

它确实代表物理 footprint 冲突，而不是方便建模的较大交通分组；

foreign reservation 与当前 grant/entry horizon 有时间重叠；

它是不可撤销或已经 committed 的下一步移动。

Schema 中一个 zone 可以同时包含多个 node/edge，本身就可能比 station transition 大很多。

另外，有一个很重要的反证：

按 GitHub HEAD，top-lift-column layout 返回的 zones 是空数组。若 Round 13 没有未报告的布局改动，那么 broad zone reservation 并不能解释这次 mixed top-lift demo 的 180–200s 回归。

因此目前的“主要是 zone scan 导致过度阻塞”假设证据不足。先 profile 和加调用计数，不能直接按这个假设删代码。

Option A 也不安全

“只检查 current/target/local route claims”仍然有问题：

缺少 current active edge / swept footprint；

整条 local route 通常又太宽、太 speculative；

一个已经跨过 ingress fence 的车辆可能尚未到 target node，但必须被视为 committed drainer。

所以不能直接采用 A。

3. station runtime 影响两个纯 inbound isolation tests 是否错误？

是，而且这是当前最值得先查的矛盾。

这两个测试都通过 createDefaultShuttleScenario() 创建场景；默认 layout profile 是 row-bank。

同时 HEAD 中：

TypeScript
private outboundStationCoordinatorEnabled(): boolean {
  return this.topLiftColumnLayoutEnabled();
}

也就是说 row-bank 场景理论上必须在进入任何 outbound station 扫描之前返回。

而两个测试的 outbound rate 也都是 0。

因此，如果 Round 13 claim checker 真正在这些测试中执行，说明 hard gate 泄漏；如果它根本没有执行，那么两个失败就不是 zone/critical-section checker 造成的，而是：

index.ts 中还有 handoff 未列出的 generic 行为改动；

schema default 或 scenario construction 被改变；

generic reservation、movement、dispatch 或 diagnostics helper 被修改；

P0-P baseline 与当前实际 executable 并非严格同一份代码。

不能再用“可能是 station lease 过宽”概括这两个失败。

应建立的代码边界
TypeScript
reconcileOutboundStationRuntime() {
  if (!topLiftColumnLayoutEnabled()) return;
  if (!hasAnyOutboundStationWork()) return;
  ...
}

除此之外：

station claim 查询必须只读 generic traffic state；

station 层不能在观察 reservation 时重写、延长或删除 generic reservation；

generic movement blocker 只在存在 active drain/pass lease 时查询 station resource index；

row-bank 场景中，station reconciliation、claim check、drain creation 和 station events 必须全部为 0。

增加两个 negative-control tests：

row-bank inbound-only:
  outboundStationClaimCheckCount == 0
  outboundStationDrainCount == 0
  station event count == 0

top-lift inbound-only:
  request/pass/claim-check count == 0
  state hash 与关闭 outbound coordinator 时一致

调试计数必须放在 snapshot/hash/event log 之外，不能反过来改变确定性。

4. 最小安全下一步选哪个？
立即动作：Option C

先撤销 Round 13 production candidate，建立确定性 SH-07/SH-08 测试，不再扩大 runtime-wide 行为。

但不是简单删除所有测试。建议：

保留

两个新 station critical-section 测试的场景构造；

rolling log 和本轮输出；

CPU profile 和诊断计数；

critical-section 静态拓扑概念。

撤销

从动态 routeNodeIds 推导 station exclusive set；

broad reservation/zone scan；

用 generic local route tail 推断 drainer；

当前 candidate 对实际 movement/grant 行为的影响。

接下来实现一个“缩小版 Option B”

不要现在设计全系统通用的 PhysicalLease 框架。只增加 station-local 记录：

TypeScript
type OutboundStationPhysicalLease = {
  stationId: string;
  phase: 'draining' | 'owned' | 'clearing';
  ownerVehicleId: string | null;
  drainerVehicleIds: string[];
  nodeIds: string[];
  edgeIds: string[];
  zoneIds: string[]; // 当前 top-lift 很可能为空
};

资源从静态 plan 生成：

TypeScript
criticalSectionForPlan(plan)

而不是：

TypeScript
criticalSectionForRoute(route)

grant 流程：

head ready
-> install ingress fence
-> identify only physically/next-hop committed drainers
-> wait until drainers clear
-> atomically install owned lease
-> owner enters
-> service
-> downgrade to clearing lease
-> release

因此四个选项中：

A：不采用；

B：方向正确，但当前描述过大；

C：现在立即采用；

D：实际实施方案是“C 后接一个 station-local、缩小版 B”。

5. 如何诊断 180–200s wall-time spike？

先把两个问题分开：

9 秒 wall time 不会造成 202 秒 simulation wait。

这是 fixed-step simulation。性能恶化和行为过度阻塞可能来自同一个函数，但 wall-clock 慢本身不会让 simulation-time wait 增加。

HEAD 的 tick 中，reconcileOutboundStationRuntime() 每 tick 被调用三次：assignment 前、assignment 后、vehicle movement 后。

在 0.2s tick 下，200s 仿真约有：

1000 ticks
约 3000 次 station reconciliation

而 nodeClaimedByOtherVehicle() 会线性扫描 vehicles，然后又检查 local-route claims。

若 Round 13 对每个：

station × request × critical node × reconciliation

都执行车辆扫描、reservation 扫描和 zone 查询，成本会快速放大。若过程中还反复调用 station-plan shortest path，则更明显。

先保存当前 candidate 的 CPU profile
Bash
mkdir -p output/review/cpu

node \
  --cpu-prof \
  --cpu-prof-dir=output/review/cpu \
  --cpu-prof-name=round13-200s.cpuprofile \
  --import tsx \
  scripts/run-physical-24h-amr-audit.ts \
  --duration-sec 200 \
  --ten-minute-sec 200 \
  --audit-every-sec 1 \
  --inbound-pph 3600 \
  --outbound-pph 3600 \
  --outbound-full-columns 4 \
  --quiet-critical \
  --out output/review/round13-200s-profile.json \
  --change-note "Round 13 rejected candidate CPU profile"

同时增加仅诊断的累计计数：

reconcileOutboundStationRuntime calls
criticalSectionClaimingVehicleIds calls
critical nodes checked
vehicles scanned
active reservations scanned
zones scanned
outboundStationPlanForDropoff calls
shortest-path calls
drain epochs created
grant attempts
grant blocks by class

不要先缓存、索引或删除 checks。先看 profile：

若热点是 outboundStationCriticalSectionClaimingVehicleIds / reservation filter：之后建立按 resource ID 的索引；

若热点是 tryAgentRefreshShortestPath：将静态 station plan 按 stationId + dropoffNodeId 缓存；

若热点不在 station code：停止修改 station lease，查 generic routing 或 diagnostics；

若 pure-inbound tests 中 claim-check count 为 0：说明它们的失败另有来源。

reservationConflictCount=454 是累计冲突事件，不等于当前同时存在 454 个 active reservations，不能仅凭这个数字判断热点。

6. 下一个 physical 10m 前必须绿哪些 gate？
Gate 1：negative-control boundary

新增并通过：

row-bank inbound-only does not consult outbound station runtime
top-lift inbound-only creates no outbound requests/drains/passes

通过标准：

claimCheckCount = 0
drainEpochCount = 0
stationPassCount = 0
station events = 0

对于 row-bank，最好再要求开启/关闭 station coordinator 的 deterministic state hash 完全相同。

Gate 2：确定性 SH-07/SH-08 契约测试

至少覆盖：

foreign vehicle 当前位于 critical interior；

foreign vehicle 正在穿越 ingress edge；

foreign vehicle immediate target 位于 critical section；

foreign vehicle 只在未来 route tail 中包含 critical node；

unrelated generic zone reservation；

drainer 离开后 grant。

必须证明：

DRAINING 时 active owner == null
已 committed 的 SH-07 可以前向穿过 c22 排空
未来 route-tail claim 不会成为 drainer
排空前 SH-08 不获 grant
排空后 SH-08 获 grant
OWNED 后 foreign vehicle 不能重新进入
未调用 generic deadlock breaker
Gate 3：三个 isolation tests 全绿

必须恢复原断言，不能改阈值：

Bash
./node_modules/.bin/vitest run \
  packages/shuttle-sim-core/src/high-inbound.test.ts \
  packages/shuttle-sim-core/src/lift-approach.test.ts \
  packages/shuttle-sim-core/src/index.test.ts \
  -t "keeps a 12-shuttle high-inbound stress run active|uses configured lift approach staging capacity|keeps unready top-lift inbound work" \
  --maxWorkers=1

证明修复的结果是：

utilizedVehicleCount >= 10
max approachOccupancy > 1
maxWaitSec < 20
completedInbound >= 12
completedOutbound >= 15
deadlockCount = 0
physicalViolationCount = 0

尤其是 maxWaitSec=202 必须完全消失，不能只回落到例如 40–60 秒。原 mixed test 的契约明确包含 <20s、完成量以及零 deadlock/physical violation。

Gate 4：full core
Bash
./node_modules/.bin/vitest run packages/shuttle-sim-core --maxWorkers=1
./node_modules/.bin/vitest run packages/shuttle-sim-core

要求：

0 failed

串行绿而普通模式红，仍然不能进入 physical 10m。

Gate 5：determinism

现有 replay gate，加一个 mixed outbound station snapshot/restore gate：

direct 600s
versus
300s snapshot + restore + run to 600s

要求：

event hash equal
state hash equal
completed inbound/outbound equal
station phase/owner equal
deadlock/livelock/physical violations equal
Gate 6：短 mixed smoke

先跑 200s，再跑现有 420s deterministic mixed test。

要求：

200s segment wall-time 不再随 active work 明显超线性增长；

no station ownership invariant；

no wait 超过原 gate；

420s test 完整通过；

不出现 route-tail-only foreign drainer；

不出现 active owner 与 foreign occupant 并存。

只有这六类 gate 都绿，才允许下一次 10m physical run。

下一步最小安全动作与前三个命令

先冻结证据，避免丢失未提交的 P0-P 工作：

Bash
git diff --binary > output/review/round13-rejected-candidate.patch
git diff -U40 -- packages/shuttle-sim-core/src/index.ts \
  > output/review/round13-core-expanded.diff

然后选择性反向撤销 Round 13 production hunks，不要对整个 dirty tree 使用 wholesale git restore。

完成 negative-control 和两车测试后，首先运行：

Bash
./node_modules/.bin/vitest run \
  packages/shuttle-sim-core/src/index.test.ts \
  -t "outbound station runtime is inert|SH-07.*SH-08|outbound station critical section" \
  --maxWorkers=1

接着运行三个 isolation gate：

Bash
./node_modules/.bin/vitest run \
  packages/shuttle-sim-core/src/high-inbound.test.ts \
  packages/shuttle-sim-core/src/lift-approach.test.ts \
  packages/shuttle-sim-core/src/index.test.ts \
  -t "keeps a 12-shuttle high-inbound stress run active|uses configured lift approach staging capacity|keeps unready top-lift inbound work" \
  --maxWorkers=1

最后才运行：

Bash
./node_modules/.bin/vitest run packages/shuttle-sim-core --maxWorkers=1

证明修复成立的关键信号不是 station focused tests 继续通过，而是：两个 pure-inbound tests 恢复且明确记录 station claim checker 从未被调用，同时 mixed 420s 的 maxWaitSec 从 202 恢复到 <20。
