# ChatGPT Pro Review Response - 2026-06-21

Source conversation: https://chatgpt.com/c/6a38d03c-ccd4-83ea-88ba-0427a06d722e

Repo: git@github.com:xjtuyanshi/four-way-shuttle-sim.git
Branch: codex/traffic-v2-flow-debug
Commit: bbf846771e47fdf2664acb551c55336c9a6e0956
Model shown in Chrome: Pro Extended
Elapsed shown by ChatGPT: Thought for 17m 59s

Note: ChatGPT Pro reported that GitHub did not return reviewable source content, so it did not claim line-by-line source review. Its conclusions are based on the handoff, A/B results, and audit evidence pasted into the conversation.

---

说明：我尝试读取指定分支与提交，但当前 GitHub 接口没有返回可审阅的源码内容。因此我不能声称已逐行审查 bbf8467。以下结论严格基于 handoff 中的行为描述、A/B 结果和审计数据；架构判断置信度较高，具体落点仍需对照源码确认。

结论
总体判断

read-purity fix 应当保留并合入。
它修复了真实的确定性问题，不是性能调优或行为偏好问题。但 diagnosticReadOnlyDepth 更适合作为过渡期防线，不应成为长期的状态推进机制。

当前 inbound lift queue / AMR 长距离调度 / PPH 波动的主要问题，确实是 resource contract 和队列匹配抽象错误。
现有证据不支持继续把它当成局部 pathfinding、queue identity 或 avoidance bug。

更准确地说，系统混在了一起的不是一个队列，而是两个队列：

等待服务的 inbound load / service demand；

等待与这些需求匹配的 AMR resource staging pool。

当前通过“提前把 concrete task 绑到 AMR”把二者强行合并了。于是 task assignment 同时承担了任务所有权、AMR 预留、队列覆盖、lift pipeline 触发等多种职责。

不需要把整个 3D tick simulator 重写成纯 DES。
最小正确改法是在现有 tick/运动/避碰模型之上，加一个 station-owned coordinator，将 AMR reservation、inbound demand 和 active service 的匹配显式化。

建议接受“两种 AMR 资源状态”的方向，但仅有这两种状态还不够。

queueReservation

activeInboundService

同时还必须有一个独立于 AMR task assignment 的 inboundDemand/serviceRequest 账本。否则会再次出现“延迟绑定后 lift pickup 被饿死”的结果。

证据链
实验事实	排除的解释	架构含义
调用 getState() 会在 90 秒内改变 source-load slot；修复后 600 秒读/不读完全一致	“公共读取只是观测”	原来存在真实的 command/query 混合，read-purity fix 必须保留
averageStandbyDepth=0、averageReserveVehicles=0，而 active inbound to queue 约为 1.022	“系统自然会形成稳定 taskless reserve queue”	8 台 AMR 在该负载下没有多余资源支撑固定空闲队列
禁止 lower/middle/storage AMR 直接绑定后，far-route 样本从 97 降到 2，但 inbound 从约 200 降到 132	“远距离 AMR 只是错误绕路”	这些远距离 AMR 正在充当隐式的 inbound capacity replenishment
等 AMR 到 queue slot 才绑定任务，inbound 降到 114	“task binding 只代表任务归属”	task binding 还在隐式触发 inbound demand/lift pipeline
把任意 planned queue goal 算作 queue resource，total 降到 474、outbound 降到 270，并出现 anomaly	“route intent 等价于资源所有权”	计划目标、逻辑预留、物理占位不能共用一个概念
local staging route cap 后 inbound 只有 144，而 outbound 仍约 306	“限制长路径即可修复系统”	局部限制只切断了 inbound 的隐式资源供给，没有补上正式资源契约

这些结果形成了比较强的干预证据：

清理“难看路径”会直接摧毁 inbound；

清理“提前绑定”会让 lift pipeline 停止；

放宽 queue identity 又会过度占用车辆和 outbound capacity。

这不是几个条件判断互相打架，而是同一个字段或状态正在代表多个互不等价的资源事实。

需要保留一个边界判断：308 outbound 对 200 inbound 本身并不能证明调度不公平。 两类任务可能有不同周期、距离和需求量。真正应判断的是 backlog age、需求满足率、lift idle-with-demand 和方向 service debt，而不是强求两个 PPH 相等。

对 read-purity fix 的判断
可以接受的部分

getState() 不得改变后续物理仿真结果。这条契约没有讨论空间。

现有修复至少已经证明：

问题可复现；

修复前后的因果关系明确；

读频率 A/B 能恢复一致；

有针对性回归测试；

30 分钟基准没有引入 anomaly 或 PPH 回退。

因此，不要回退这个修复。

还不充分的部分

diagnosticReadOnlyDepth 如果只是让某些 mutation 在 read scope 内静默跳过，长期仍有两个风险：

mutation 仍然存在于读取调用链中，只是被条件屏蔽；

如果将来读取发生在 tick callback、审计 hook 或嵌套调用中，跳过 mutation 仍可能改变推进时序。

最终契约应该是：

状态推进只发生在显式 tick/domain transition 阶段；getState() 只投影已经物化的 authoritative state。

建议保留 depth guard，但逐步把它从“控制行为”改成“检测违规”：

TypeScript
enterReadScope();
try {
  return buildSnapshot(authoritativeState);
} finally {
  leaveReadScope();
}

开发和测试模式下，任何 mutation 尝试应直接 assertion failure，而不是悄悄 return。

还需要增加以下 read-purity gate：

无读取、每 30 秒读取、每 tick 读取、随机时刻重复读取；

不同公共读取 API 以不同顺序调用；

nested read 和 snapshot 构建异常后 depth 必须恢复；

比较的不只是 KPI，还包括 authoritative state hash、RNG state、tasks、loads、vehicles、reservations 和 event sequence；

至少跑完整 24 小时，而不是只验证 600 秒。

结论：该 fix 对已发现 bug 是正确的；对整个系统的 read purity 还不是完整证明。

最小可行重构
1. 增加一个唯一的 station owner

增加一个类似下面的协调器：

InboundLiftStationCoordinator

它是以下事实的唯一 owner：

inbound demand 的可服务顺序；

AMR queue reservation 顺序；

哪个 reservation 已经获得物理 queue slot；

当前 active inbound service；

reservation 的取消、超时和原子转移。

不要再由 dispatcher、route goal、task binding 和 queue helper 分别推断这些事实。

2. 将“需求”和“AMR 资源”分开

最小状态模型：

TypeScript
type InboundDemand = {
  id: DemandId;
  stationId: StationId;
  loadId?: LoadId;
  status: "announced" | "ready" | "claimed" | "completed";
};

type VehicleCommitment =
  | { kind: "none" }
  | {
      kind: "queueReservation";
      reservationId: ReservationId;
      stationId: StationId;
      phase: "approaching" | "parked";
      epoch: number;
    }
  | {
      kind: "activeInboundService";
      serviceId: ServiceId;
      taskId: TaskId;
      loadId: LoadId;
    };

关键语义：

InboundDemand 可以推动 source/lift pipeline，但不拥有具体 AMR。

queueReservation 是 station 接受的 AMR 资源承诺，但还没有绑定 concrete load。

activeInboundService 才表示 AMR、load、task 已经完成一对一匹配。

这能直接修复 rejected experiment 3 暴露的问题：不再需要通过提前 task binding 来告诉 lift “有 inbound 工作”。

3. 不要把远距离 route goal 当成物理 queue occupancy

需要区分三件事：

候选意图：dispatcher 正在考虑某台 AMR，什么都不占用；

逻辑 admission/reservation：station 已接受该 AMR，计入未来 coverage；

物理 slot lease：AMR 到达 queue entry 后，才占用实际 slot。

远处 AMR 可以持有逻辑 reservation，但不应提前锁定具体物理 slot。否则会重现 broad planned-goal identity 的过度占用问题。

同样，coverage 不能简单按 reservation 数量计算。至少要区分：

physicalDepth
nearCoveredDepth
farForecastDepth
activeServiceDepth

一个 ETA 很长的 far reservation 不能被当成“lift 当前已有一台 AMR 可用”。

4. 用一次原子 transition 完成匹配

只有 coordinator 可以执行：

head reservation
+ eligible/ready inbound demand
+ station handoff 条件满足
→ activeInboundService

这次转换应同时完成：

从 reservation queue 移除；

claim demand/load；

创建或绑定现有 task；

更新 vehicle commitment；

更新 active service；

释放或转移 physical slot；

记录单一 domain event。

任何一步失败都不能留下半绑定状态。

必须有以下 invariants：

一台 AMR 最多一个 commitment；

一个 reservation 只能属于一台 AMR；

一个 demand/load 只能被一个 service claim；

只有 queue head 能进入 active service；

route goal 本身不赋予 resource ownership；

cancellation/retry 必须幂等；

stale arrival event 通过 epoch 或 generation 拒绝；

reservation、task、vehicle、load 之间不能出现悬空引用。

5. 在 tick 模型中引入事件化阶段，不改运动内核

不建议重写成全局离散事件仿真。建议固定每个 tick 的顺序：

1. 推进物理运动和 transfer
2. 收集 arrival / load-ready / completion / cancellation events
3. station coordinator 原子处理事件
4. dispatcher 发出新的 commitment
5. route planner 生成或更新路径
6. 生成纯只读 snapshot

事件处理必须按稳定 ID 或显式 sequence 排序，避免对象遍历顺序造成非确定性。

现有 3D 路径、避碰、cell reservation 和车辆运动仍继续工作，只是不再负责推断业务资源所有权。

调度策略

先不要上复杂全局优化器。最小策略应当是确定性的 near-first + starvation guard。

候选选择顺序

queue 附近、当前无不可中断任务的 AMR；

ETA 在 coverage horizon 内的可用 AMR；

没有 near candidate 且预计 lift 将因缺车空闲时，最多允许一个 far reservation；

获取远处 AMR 的机会成本大于 lift 短暂空闲成本时，允许 lift 有意识地 idle。

coverageHorizon 不应拍脑袋定为固定秒数，建议由当前 lift cycle time 和历史 travel ETA 推导，例如：

p75 lift cycle + safety margin
对 outbound 的处理

不要取消正在执行的 outbound，也不要永久设置 inbound hard priority。

仅在以下条件同时成立时，暂停启动新的 outbound task：

存在 ready/near-ready inbound demand
&& inbound coveredDepth == 0
&& 预计 lift starvation 超过阈值

恢复条件应带 hysteresis，例如覆盖恢复到 1，且保持一个 lift cycle 后再放开，避免 inbound/outbound 优先级每几个 tick 抖动。

需要记录方向 debt，而不是追求 PPH 数值相等：

inbound service debt
outbound service debt
oldest demand age
实施优先级
P0：停止行为调参，先锁定契约

保留 read-purity fix；

补全随机读频率确定性测试；

加入 resource invariants 和 violation counter；

在 bbf8467 上先生成完整 24 小时基线；

明确定义 demand、reservation、physical occupancy 和 service 的所有权。

P1：shadow-mode 引入 coordinator

先创建 reservation/demand/service 账本，但不改变现有车辆选择结果。

现有 dispatcher 每次做出决定时，同时写 shadow contract，检查：

推断出的旧 queue identity 与新 token 是否一致；

是否存在 double claim；

reservation 是否泄漏；

task binding 是否被当成 lift demand signal。

这一阶段必须做到：

KPI、车辆轨迹和 authoritative state hash 与 baseline 完全一致。

否则不要进入行为切换。

P2：让显式 contract 成为 source of truth

按顺序切换：

queue accounting 改读显式 token；

station admission 改由 coordinator 唯一执行；

source/lift pipeline 改读 InboundDemand；

concrete task binding 移至 reservation→service transition；

最后才加入 near/far 和 outbound throttling policy。

P3：性能调优

只有 P2 的 invariants 和 24 小时 soak 通过后，才继续调整：

coverage horizon；

far reservation 阈值；

outbound pause window；

queue target depth；

ETA/cost 权重。

应当停止继续尝试的方向
停止方向	原因
用 planned route goal 判断 queue membership	意图不等于资源所有权，已经导致过度计数和 outbound 回退
强制维持固定 taskless reserve queue	8 台 AMR 当前负载下没有足够闲置资源，这不是可持续 invariant
全局禁止 lower/middle/storage AMR 做 inbound	实验已证明会直接切断 inbound 隐式补给
在没有独立 demand ledger 时延迟 task binding	会继续饿死 lift pickup pipeline
用 route cap、局部 staging guard 作为主修复	只能隐藏长路径，不能补齐资源契约
把 queue 视觉整齐度作为成功条件	queue 更漂亮但 inbound 掉到 114–144，应直接拒绝
只看 30 分钟 aggregate PPH	会漏掉单车饥饿、方向性停顿、小时级退化和局部循环
继续在读取路径中保留“必要的状态推进”	读取必须彻底退出物理因果链
应当保留的代码与抽象

当前 read-purity regression test 和 A/B 测试框架；

现有 3D tick、车辆运动、路径搜索和物理避碰；

短时域的 cell/edge physical reservation；

已有 queue slot 几何定义；

load/task/lift 的物理状态机，前提是匹配所有权移到 coordinator；

deterministic seed 和固定 dt；

run-physical-24h-amr-audit.ts；

diagnose-queue-reserve-efficiency.ts；

farActiveInboundRouteSamples、offQueueWaitingSamples 等诊断指标；

当前 508/200/308 accepted baseline 和 rejected experiment artifacts。

不要为了引入 coordinator 重写 path planner、车辆运动或整个 task engine。

验证计划
测试矩阵

所有 candidate 必须与同 seed、同 initial state、同 workload 的 bbf8467 做 paired A/B。

至少覆盖：

当前 zone-balanced-50；

inbound-heavy；

outbound-heavy；

无读取 / 每 30 秒读取 / 每 tick 读取 / 随机读取；

canonical seed 加多 seed 分布。

10 分钟建议至少 10 个 seed，30 分钟至少 5 个 seed，24 小时至少 3 个 seed。canonical seed 仍作为硬回归样本。

10 分钟 smoke gate
指标	Gate
total PPH	>=500，或 paired baseline 回退不超过 3%
inbound PPH	>=190，或 paired baseline 回退不超过 5%
outbound	不得相对 paired baseline 回退超过 5%，防止通过饿死 outbound 提升 inbound
anomalies	0
physical violations	0
resource-contract violations	0
duplicate/stale reservation	0
active AMR 严重 stuck	0
严重小范围循环	0

10 分钟 PPH 同时输出实际 completed count，避免把少量任务外推成 PPH 后掩盖波动。

30 分钟 acceptance gate
指标	Gate
total PPH	>=508，或 paired baseline 非劣于 3%
inbound PPH	>=200，或非劣于 5%
outbound PPH	paired baseline 非劣于 5%
critical anomalies	0
resource leaks	0
lift idle while ready inbound demand	不高于 baseline，容许最多 10% 噪声
p95 inbound demand-to-service	不高于 baseline 10%
AMR starvation	无符合可工作条件的 AMR 连续两个 10 分钟 bucket 为 0 完成
queue head blocking	无未解释的连续 120 秒以上阻塞
24 小时 soak gate

在接受新实现前，必须先取得 bbf8467 的同配置 24 小时基线。没有基线时，不应凭 30 分钟的 508/200/308 发明绝对全天阈值。

建议 paired gate：

24 小时 total throughput 不低于 baseline 的 97%；

inbound 和 outbound 分别不低于 baseline 的 95%；

每小时 total 不低于对应 baseline 小时的 90%；

至少 22/24 个小时达到对应 baseline 的 97%；

不允许连续两个小时低于 baseline 的 95%；

inbound/outbound 任一方向不允许连续两个小时低于对应 baseline 的 90%；

critical anomaly、physical violation、contract violation、reservation leak 全部为 0；

read/no-read 的 authoritative state hash 必须一致。

每小时除 PPH 外，应输出：

raw completed count
inbound/outbound backlog
oldest demand age
lift idle-with-demand seconds
near/far reservation count
reservation cancellation/churn
queue physical depth
near covered depth
far forecast depth
每 10 分钟、每台 AMR 指标

每个 AMR 每个 bucket 至少输出：

completedTasks
inboundCompleted
outboundCompleted
assignedTasks
loadedTravelSec
emptyTravelSec
queueWaitSec
blockedSec
eligibleIdleSec
distance
uniqueCellsVisited
routeReplans
reservationCreates
reservationCancels
semanticProgressAgeMax

公平性 gate：

当某 AMR 在两个连续 bucket 中每个 bucket 都有至少 300 秒 eligible/non-blocked 时间时，不得连续两个 bucket 为 0 completion；

rolling-hour task completion Gini 不得超过 max(baseline + 0.05, 0.30)；

如果 AMR 有层区或能力差异，公平性只在同 eligibility pool 内比较。

长期卡死定义

不能用“车辆位置没变”直接判断，因为合法 queue waiting 也会静止。

定义 warning：

AMR 有 runnable commitment
&& 不处于可解释的 queue/lift wait
&& 120 秒没有 semantic progress

定义 critical：

上述状态持续 300 秒

semantic progress 至少包括：

task phase 前进；

queue position 前进；

load handoff；

active route 剩余距离持续下降；

reservation 成功转为 service。

24 小时 gate：

critical stuck episode = 0；

warning rate 不高于 baseline，且建议低于 0.2 / vehicle-hour。

小范围打转定义

建议同时满足：

连续 120 秒没有 semantic progress
&& 行驶边数 >= 20
&& 活动范围被限制在约 4×4 cells
&& 同一 directed edge 被重复经过 >= 4 次

300 秒以上为 critical circling。

24 小时 gate：

critical circling = 0；

120–300 秒 episode rate 不高于 baseline；

每个 episode 自动保留前后至少 60 秒 event trace、route plan 和 reservation changes。

主要风险
风险	严重度	对策
source/lift promotion 暗中依赖 assigned task	最高	先引入独立 InboundDemand，否则禁止启用 delayed binding
reservation 与 task 双重占用或泄漏	高	station 单一 owner、原子 match、幂等 release、epoch
far reservation 被当成即时 coverage	高	ETA horizon；区分 near coverage 和 far forecast
head AMR 等待尚未 ready 的 load，造成 head-of-line blocking	高	demand readiness gate、明确 head wait metric，必要时仅匹配 ready/committed demand
为提高 inbound 而长期压制 outbound	高	paired outbound gate、direction debt、最大 pause 和 hysteresis
inbound/outbound 优先级频繁摆动	中	最小 commitment 时间和恢复滞回
逻辑 queue reservation 与物理 cell reservation死锁	高	远距离只占逻辑顺序；到 entry 后才授予 physical slot lease
event 处理顺序引入非确定性	高	稳定 sequence/ID 排序和 state hash 回归
read guard 静默改变 tick 行为	中高	mutation 移出读取路径；最终将 guard 改成 assertion
24 小时 telemetry 过大	中	聚合计数器加 violation ring buffer，不保留全量逐 tick 日志
最终评审意见

接受 read-purity fix；停止继续堆 queue/path local guards。

下一次有效改动不应该是“再找一个条件避免某类 AMR 去 queue”，而应该是：

用一个 station-owned coordinator 显式分离 inbound demand、AMR queue reservation、physical slot occupancy 和 active service，并先以 shadow mode 验证它与现有行为一致。

这条边界一旦建立，near/far dispatch、允许 lift 短暂 idle、临时限制 outbound 才会成为可调策略；在此之前，它们都只是在修改同一个隐式资源竞争的不同症状。
