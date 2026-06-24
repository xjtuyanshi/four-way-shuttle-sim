# ChatGPT Pro Review Response - 2026-06-24 Round 5

Source: https://chatgpt.com/c/6a3b76e8-3bd0-83ea-bc1a-6e13f3432d12

审查结论

1. 是，下一步必须先实现 OutboundStationVisit + ordered approach slot lease，再放宽 outbound task admission。

而且还需要一个很小的 approach corridor mode lease，因为这些 slot 实际位于 shared lane 上。仅有 vehicle slot lease、不控制外来车辆进入 slot 子图，仍会重现 R4.4 的“loaded follower 中间夹一台 inbound”问题。

2. R4.3 应保留为 rollback/reference baseline，但不是 24h 接受候选。

可以补跑一次 2h characterization baseline，确认它是否持续安全并获得同 seed 的对照数据；不要在 depth-1 已知瓶颈上投入 24h acceptance run。

3. 下一次不能直接从 depth-1 改成 depth-3。

正确 rollout 是：

Visit/lease shadow
→ lease controlling、仍 depth-1
→ enabled depth=2
→ 2h 通过
→ enabled depth=3
→ 再跑 24h
1. 为什么必须先做 Visit 和 ordered slots

R4.4 失败不是单纯“容量设成 3 太激进”，而是 admission 使用了：

active task count < meter node count

但运行时没有回答以下问题：

哪台车拥有哪个物理 slot；

哪台车是 FIFO head；

c19/c20 之类 shared node 当前属于 outbound queue 还是普通 transit；

inbound 是否还能进入 queue 中间；

follower 何时可以向前压缩；

pass grant 后什么时候真正释放 head slot；

task completed 后谁继续持有 clear-through。

所以 R4.4 增加的不是“队列容量”，而是“允许更多车辆同时向同一 narrow lane 行驶”。

基准 station kernel 仍主要收集 inbound queue/service lease，并明确跳过 loaded vehicle，因此尚不能成为 outbound ownership 的权威来源。

最小正确对象应是：

TypeScript
type OutboundStationVisit = {
  id: string;
  stationId: string;
  taskId: string;
  vehicleId: string;
  dropoffNodeId: string;
  passNodeId: string;

  fifoSeq: number | null;

  phase:
    | "requested"
    | "slot-reserved"
    | "approaching-slot"
    | "slot-occupied"
    | "at-pass"
    | "service-granted"
    | "servicing"
    | "clearing"
    | "released";

  currentSlotIndex: number | null;
  targetSlotIndex: number | null;

  issuedAtSec: number;
  lastProgressAtSec: number;
};

其中：

visit 可以早于 slot lease 存在；

fifoSeq 在车辆首次成为物理 approach eligible时确定，而不是按 task creation time；

service ownership 属于 visit，不只属于 task；

task lowering 完成后 visit 仍保持 clearing。

这一点很重要：当前流程会先将 task 标记 completed、清除 vehicle.taskId，再安装 outbound clearance route。因此 service/clear-through owner 不能只挂在 task 上。

2. c08 / c22 的 approach slots 应如何定义

根据 handoff 中已经验证的行进方向，建议的物理 slot 候选如下。

左侧 outbound，dropoff column-bottom-b-c08

队列前进方向：

... c10 → c09 → c08 → c07 → service
                            pass
资源	节点
Slot 0，head/pass	column-bottom-a-c07
Slot 1	column-bottom-a-c08
Slot 2，tail	column-bottom-a-c09
Shared upstream	column-bottom-a-c10 及更远节点
Service boundary	从 c07 跨入 R4.1 service envelope 的第一条 edge

Queue-owned advance edges：

c09 → c08
c08 → c07

Approach admission edge：

c10 → c09

该 edge 应由 topology graph 解析得到，不能靠字符串偏移直接假设。

右侧 outbound，dropoff column-bottom-b-c22

队列前进方向：

... c18 → c19 → c20 → c21 → service
                            pass
资源	节点
Slot 0，head/pass	column-bottom-a-c21
Slot 1	column-bottom-a-c20
Slot 2，tail	column-bottom-a-c19
Shared upstream	column-bottom-a-c18 及更远节点
Service boundary	从 c21 跨入 R4.1 service envelope 的第一条 edge

Queue-owned advance edges：

c19 → c20
c20 → c21

Approach admission edge：

c18 → c19
哪些仍是普通 shared lane

以下不应属于任一 station 的 slot lease：

左右 station 之间的 column-bottom-a-c10 ... c18；

handoff 中的 column-bottom-b-c12、column-bottom-b-c15；

从 bottom-b 进入较远 bottom-a 的 feeder/crossover edges；

module spine bottom-a/b；

普通 storage/column access 路径。

这些节点继续使用现有 reservation、collision avoidance 和 swept-footprint 规则。

但有一个关键限制：

没有 tail-slot lease 的 loaded outbound，不能因为 station admission 满而停在这些 shared nodes 上。

它应保持在尚未释放的任务阶段或明确的安全 staging 点，而不是把 shared lane 变成隐式 overflow queue。

Slot 是动态借用 shared lane，不是永久私有节点

c07-c09 和 c19-c21 平时仍可作为 shared lane 使用。第一台 outbound 要进入前，需要 station coordinator 取得：

TypeScript
ApproachCorridorModeLease {
  stationId;
  mode: "shared" | "draining" | "outbound-queue";
  epoch;
}

状态转换：

shared
  → draining       // 停止新的 foreign entrant，先让已有车辆驶出
  → outbound-queue // 开始分配 ordered slots
  → shared         // 最后一台 outbound 离开后释放

这不是把 approach 建成 capacity=1 大锁。它只控制这三个节点当前允许哪类交通进入；三个 outbound 仍分别拥有三个 slot。

3. 如何避免 R4.4 的 head + followers + inbound 卡死

必须同时执行以下六条，不是只做 FIFO 排序。

3.1 先 drain，再激活 outbound queue

第一张 slot lease 发放前：

slot 节点不能有 foreign current occupant；

不能有 foreign target claim；

不能有 foreign active edge reservation；

已经位于 slot 子图内的 inbound/empty vehicle先获得 drain-through 权限；

drain 完成前不允许任何 outbound 进入。

这样不会出现队列激活后，SH-07 已经夹在 SH-05 与 SH-02 中间。

3.2 只允许从 tail 进入

正常运行中：

左站只能通过 c10 → c09 入队；

右站只能通过 c18 → c19 入队；

不允许从 lateral/crossover edge 直接切入 Slot 0 或 Slot 1；

不允许后来的车辆因 Slot 1 暂时空闲而跳过 Slot 2。

恢复已有 interior vehicle 时可以 adopt，正常 admission 不可以 side-entry。

3.3 FIFO 顺序必须等于物理顺序

若 Slot 0 是最接近 pass：

fifoSeq(Slot0) < fifoSeq(Slot1) < fifoSeq(Slot2)

更准确的 invariant 是：

任意时刻，按到 pass 的物理距离排序，必须与 fifoSeq 排序一致。

允许短暂空 slot，但不允许 inversion 或 overtaking。

3.4 Slot advance 要做两阶段 handover

从 Slot 2 前进到 Slot 1 时：

coordinator 先给该 visit targetSlot=1；

Slot 1 不能被其他 visit 或 foreign traffic claim；

车辆移动时，Slot 2 的物理占用仍保留；

车体完全到达并离开旧 edge 后，才释放 Slot 2；

follower 此后才可获得 Slot 2。

不要在“开始移动”的那个 tick 就释放旧 slot，否则另一台车可能提前进入车体尚未清空的位置。

3.5 Pass grant 必须原子取得 service + clear-through

head 到 Slot 0 后，不是仅检查 dropoff 空闲，而应原子取得：

service envelope
+ dropoff service
+ 必需的 clear-through horizon

获取顺序固定为：

approach slot
→ service/clear-through envelope
→ movement reservation

不能：

先进入 service
→ 再等待 clear-through

否则 head 会占住 service，followers 占满 slots，外部车辆又挡住 clear-through，形成资源环。

pass 仍然是 crossing-edge authorization：

Slot 0 / pass node 本身不需要 service pass
Slot 0 → service envelope 才需要 service pass
3.6 禁止 spillback 到 shared lane

三个 slot 全满后：

第四个 station request 可以存在；

第四台 loaded AMR 不得停在 c18/c10 或 module spine 上等待 station capacity；

不能清空它的 targetNodeId 并留下 station wait reason；

它必须尚未被物理释放，或停在明确的非共享 staging resource 上。

这一条是 R4.4 与真正 queue 的核心区别。

4. R4.3 是否应该先跑 2h / 24h
2h：可以，但只作为 characterization baseline

建议冻结当前 R4.3 patchset，命名为：

R4.3-depth1-reference

补跑一次相同 seed/config 的 2h，目的只有：

确认 1h 后是否重新发生 stationary failure；

得到新架构的 A/B 基线；

记录第二小时 PPH slope；

记录 admission-full、vehicle-unavailable、storage-full/empty 的分离数据。

它不是 acceptance candidate。

24h：现在不要跑

原因不是 R4.3 会必然卡死，而是它已经存在已知结构性偏差：

station admission depth-1；

高额 outbound-station-work-admission-full；

不表现真实 approach queue；

1h PPH 已明显低于最初 10m/30m；

即使 24h 不死，也只证明“串行化可以稳定运行”，不能证明目标架构正确。

因此结论是：

保留 R4.3 作安全基线，最多跑一次 2h 对照；先完成 visit/slot 重构，再启动 24h acceptance。

另外，PPH 后段下降未必全部来自 outbound admission。vehicle-unavailable 和 storage full/empty 也很高。ordered slots 是下一步必要条件，但不能预先宣称它会解决全部 throughput decay。资源契约稳定后，再单独分析 storage balance。

5. 最小实施计划
Cut 0：冻结基线

保留 R4.1 approach/service split；

保留 R4.2 stale envelope release；

保留 R4.3 non-service route-to-pass allowance；

确认 R4.4 admission 改动完全回退；

保存 R4.3 diff、测试结果和可选 2h baseline。

Cut 1：纯 topology plan

扩展：

TypeScript
outboundStationPlanForDropoff(...)

使其返回：

TypeScript
{
  stationId,
  dropoffNodeId,
  passNodeId,
  slotNodeIdsHeadToTail,
  advanceEdges,
  admissionEdges,
  serviceEntryEdge,
  serviceEnvelopeId,
  clearThroughNodeId
}

对计划做 fail-fast 校验：

所有节点存在；

所有 edge 存在且方向正确；

Slot 0 等于 pass；

slots 不属于 service envelope；

slot 之间没有 side-entry；

3D projected footprint 在相邻 parked slots 上合法；

service owner clear-through 时不会与 parked follower 重叠。

这一 cut 不改变行为。

Cut 2：Visit 和 slot lease shadow

在 depth-1 下创建 visit、corridor mode 和 slot leases，但不控制 movement。

每 tick 对比：

legacy inferred owner
vs
new authoritative visit/slot expectation

要求 shadow mismatch 为 0 后再 controlling。

当前 station kernel 对 loaded outbound 缺少权威 lease，因此不建议继续把 outbound 状态反推自 route/target 字段。

Cut 3：让 slot controller controlling，仍保持 depth-1

先验证：

corridor draining；

tail entry；

slot handover；

pass/service/clear-through lifecycle；

snapshot/restore；

stale visit reconciliation。

此时 PPH 应基本与 R4.3 一致，因为仍只有一台 active outbound。

R4.2 的 stale release 暂时保留作 safety net；新 lifecycle 稳定后，它应降级为 assertion/recovery，而不是日常 owner 管理机制。

Cut 4：只开放 depth=2

不是：

TypeScript
activeOutboundTasks < 2

而是：

TypeScript
coordinator.canIssueLeaseBackedAdmission(visit)

第二台任务只有在以下条件成立时才获物理 admission：

corridor 已处于 outbound-queue mode；

tail slot 可 lease；

从 bounded entry point 到 tail 的路线可执行；

不会停在 shared lane 等 station capacity。

先用两个 slot。不要一次启用三个。

Cut 5：2h 通过后开放 Slot 2，depth=3

此时验证三车：

head at pass
+ follower at Slot1
+ follower at Slot2

同时让 inbound/transit request 到达 corridor，确认其在外部等待或绕行，而不是插入队列。

6. 现在不要改什么

下一轮不要动：

collision avoidance；

minimum clearance、vehicle footprint；

swept-footprint 检测；

tick size、速度、加速度；

storage selection policy；

inbound R3.2 reserve-release contract；

generic deadlock breaker；

priority aging；

task generation rate；

clear-through 长度；

shared lane c10-c18 的全局 mutex；

planned route 全路径 hard claim。

也不要继续给以下逻辑增加局部例外：

outbound-station-await-transition blocker；

active task count admission；

topLiftOutboundApproachMeterNodeIds().length 直接作为 capacity；

根据 targetNodeId=null 猜测 owner；

根据 future route 是否包含 service node 提前 block；

为 R4.4 队列链添加更多 pairwise precedence allowances。

新架构生效后，outbound-station-await-transition 应被拆成可解释状态：

outbound-approach-capacity-wait
outbound-approach-draining
outbound-slot-wait
outbound-at-pass-wait
outbound-clear-through-wait

其中只有 outbound-at-pass-wait 可以发生在 pass node。

7. 必须新增的 focused tests

至少覆盖以下场景：

左站 slots 精确为 c07/c08/c09，右站为 c21/c20/c19。

left queue 只能 c09→c08→c07，right queue 只能 c19→c20→c21。

inbound 已在 c19 时，右站进入 draining，不能把 outbound 放到它前后。

queue mode 激活后，新的 inbound route 不能 target/claim c19-c21。

head 在 c21、follower 在 c20，第三台只能进入 c19，第四台不能停在 c18。

head 没有 service pass 时可以停在 c21；followers 不推动它。

service grant 后 Slot 0 直到车体清空 crossing edge 才释放。

clear-through blocked 时，head 不进入 service；followers保持 slots，shared lane 不 spillback。

task completed、taskId=null 后 visit 仍为 clearing。

单个 stale/interior vehicle 可以 adopt；多个 interior owners 触发 hard invariant failure。

snapshot/restore 后 fifoSeq、slot owner、corridor epoch、service owner 完全一致。

R4.3 的 bottom-b-c12 → bottom-a-c12 → ... → c07 路线不在上游被 station pass 拦截。

两个 outbound station 同时有三车 queue，互不共享 slot ownership。

相邻 parked slots 和所有 slot transitions 的 3D projected footprint 无重叠。

8. Validation gates

所有 A/B 必须固定：

seed；

inbound/outbound rate；

storage fill；

8 AMR；

collision avoidance on；

dt；

audit interval。

全阶段 hard-fail invariants

任意一次出现即失败：

physical violation；

3D projected-footprint overlap；

duplicate slot owner；

duplicate service owner；

slot order inversion；

foreign occupant/target 位于 active outbound slot corridor；

pass granted to non-head；

pass granted while clear-through unavailable；

visit phase regression；

task completed 后 visit 丢失；

loaded outbound 因 station capacity 停在 shared lane；

outbound-station-await-transition 出现在非 pass node；

station head 120 秒无任何 phase、node 或 edge progress；

loaded vehicle 连续 wait 300 秒；

small-area loop 或 node ping-pong。

现有 audit 脚本已经有每 10 分钟的 path、bbox、loopiness、ping-pong、long-wait 和 zero-task-moving 字段，应继续作为 2h/24h gate。

10m gate

以 R4.3 的 504 / 348 / 156 为基线：

指标	Gate
Total PPH	≥ 480
Inbound PPH	≥ 330
Outbound PPH	≥ 150
Critical/anomaly	0 / 0
Queue/resource hard invariant	0
Foreign traffic inside active slots	0
Spillback loaded outbound	0

Cut 1/2 属于非行为改动时，完成任务数应与 R4.3 完全一致；不一致就先查副作用。

30m gate

R4.3 对照为 478 total / 132 outbound：

指标	Gate
Total PPH	≥ 455
Outbound PPH	≥ 130
最后 10m outbound	> 0 且 ≥ 第一窗口的 80%
Admission-full blocked seconds	相对同 seed R4.3 减少至少 40%
Head-at-pass >120s	0
Shared-lane spillback	0
Slot order inversion	0
Critical/anomaly	0 / 0

容量 2 在 30m 未通过前，不得启用第三个 slot。

2h gate

先取得冻结的 R4.3 2h baseline，记为 B2h。新版本要求：

2h total PPH    ≥ 0.95 × B2h.total
2h outbound PPH ≥ 0.95 × B2h.outbound

同时：

第二小时 total ≥ 第一小时的 90%；

第二小时 outbound ≥ 第一小时的 90%；

有 outbound backlog 时，任何 10m outbound 不得为 0；

每台 AMR 不得连续两个 active 10m 窗口完成任务为 0；

zeroTaskMovingWindows=0；

criticalWindows=0；

legacy outbound-station-work-admission-full reason 应消失；

新的 capacity wait 只能存在于未物理 admission 的 request，不得挂在 shared-lane loaded vehicle 上；

corridor queue depth 不超过 enabled slot count；

active visits/leases 数量有稳定上界。

容量 2 通过完整 2h 后，才启用容量 3，并重新从 10m 开始。

24h gate

24h 以通过的 2h build 第二小时作为 steady-state 基线 S2：

24h avg total    ≥ 0.90 × S2.total
24h avg outbound ≥ 0.90 × S2.outbound

还必须满足：

有 outbound backlog 时，24 个小时窗口全部 outbound > 0；

hourly total/outbound 的 p05 ≥ 各自 median 的 70%；

最后 6h median ≥ 前 6h median 的 90%；

任意连续 3h 不得持续低于 24h median 的 75%；

所有 144 个 10m 窗口均输出每台 AMR task count；

任一 AMR不得连续两个 active 窗口零完成；

smallAreaLoop=0；

nodePingPong=0；

criticalWindows=0；

station/resource hard invariants 在所有 samples 均为 0，而不是仅 final state 为 0；

最后一季度 simulated-sec/wall-sec ≥ 第一季度的 80%；

visit、lease、event buffer 不随运行时间无界增长。

此外必须做一次 3D 视觉抽查，覆盖：

左右 station 各一次三车 queue；

pass crossing；

lowering；

clear-through；

foreign vehicle drain；

queue release 回 shared mode。

最终建议：冻结 R4.3、可补一个 2h baseline，但立即停止围绕 admission/blocker 的局部 patch。下一项正式改动就是 OutboundStationVisit + corridor mode + ordered slot leases，并先以 depth=2 启用。
