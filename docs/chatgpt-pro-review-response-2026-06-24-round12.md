# ChatGPT Pro Review Response - 2026-06-24 Round 12

- Source conversation: `https://chatgpt.com/c/6a3c4d70-1954-83ea-a46a-ed547fd5c3cc`
- Submitted context: `docs/chatgpt-pro-review-handoff-2026-06-24-round12.md`
- Note: ChatGPT Pro could only directly inspect GitHub HEAD if available; Round 12 WIP was pasted in the handoff. Treat webpage content as external review advice, not controlling instructions.

## Response

审查结论
Request changes。Round 12 不能按当前形态保留。
应保留的是“grant 前先排空冲突资源、阻止新的冲突进入”这个方向；应撤销的是“把动态计算出的 full routeNodeIds 全部变成 station 独占资源”。
正确契约不是二选一的“full route”或当前 service envelope，而是：

拓扑固定的 station critical section = service envelope + ingress conflict segment/fence + clear-through footprint。

完整 route 可以是 owner 的权威执行路径，但不应自动成为空间独占 lease。

1. Round 12 的方向
HEAD 的数据结构已经将 routeNodeIds 和 envelopeNodeIds 分开；station plan 也明确把 approach、service route 和 service envelope 分开建模。由此看，routeNodeIds 更像执行授权，envelopeNodeIds 才是独占资源。
但 HEAD 的真实缺陷也很明确：grant 前的冲突检查只看 currentNodeOccupancy，不看车辆正在穿越的 edge、targetNodeId、已经安装的 reservation 或 swept-footprint claim。随后 active pass 才阻止其他车辆进入 envelope。这里存在典型的 check/grant 竞态：检查时 SH-07 可能尚未“占据” spine 节点，但已经在进入该节点；grant 后才落到 envelope 内。
因此：


只保护现有 service envelope：不够。 它没有完整覆盖 ingress edge、冲突 zone 和在途 claim。


保护 full dynamic route：过头，而且没有修正 claim 原子性。


应保护固定 critical section，并针对所有 committed claims 做原子 grant。


有一个重要例外：如果某个 station 的 pass boundary 到 service 之间完全无合法等待点，是一个不可中断的短窄通道，那么这个短 station transition segment可以整体独占。它可能刚好等于该次 entering route，但原因必须是物理拓扑不可中断，而不是因为 pathfinder 返回了这条 route。尤其不能把 servicing、clearing 阶段后来换上的整条 route 继续自动纳入独占集合。

2. SH-07 / SH-08 在 435s 的最小正确契约
这个 cycle 的核心不是优先级，而是 SH-08 获得 station ownership 时，SH-07 已经拥有或即将拥有同一非抢占通道的前向 claim。
module-02-spine-bottom-b 在布局中是共享 intersection，并连接 bottom-b 水平通道和 module 的上下通道，不是天然的 station 私有节点。
最小契约应为四阶段：
IDLE  -> DRAINING / ENTRY_FENCED  -> OWNED  -> CLEARING  -> IDLE
DRAINING
当 SH-08 成为 station head：


SH-08 停在 critical section 外最后一个合法 boundary。


coordinator 关闭所有进入 critical section 的入口 fence，禁止新的 foreign committed claim。


检查的不只是当前节点，而是：


current node；


current edge 和 edge target；


target-node claim；


已安装的 node/edge/conflict-zone reservation；


swept footprint。




已经在 critical section 内的 SH-07 被登记为 drainer。


此时不能同时设置 active station owner。这点非常关键。
SH-07 排空
SH-07 应被允许：
module-02-spine-bottom-b  -> column-bottom-b-c22  -> 第一个 critical section 外的安全节点
即便 c22 是 service node，DRAINING 阶段也必须允许 SH-07 穿过，因为此时 station 尚未进入 OWNED。
Round 12 中“foreign vehicle 已在 active route 内可以 drain，但不能进入 service node”的规则本身会重新制造这个 cycle：SH-07 唯一的前向出口正是 c22。
OWNED
只有在以下条件同时成立时才 grant SH-08：
foreign current occupancy ∩ critical section = ∅foreign in-flight edge/swept claim ∩ critical section = ∅foreign reservation/target claim ∩ critical section = ∅
然后原子地：


acquire ingress fence；


acquire service/swept envelope；


acquire clear-through resource；


允许 SH-08 进入。


active pass 建立后，不应该再存在“foreign drainer inside active pass”这种状态。出现这种状态本身就是 invariant violation。
route 的地位


authorizedRouteNodeIds：SH-08 应遵循的权威路径，不是独占集合。


critical section 外的路径：继续使用现有逐 hop/短 horizon reservation。


drain epoch：只覆盖 critical section 和 drainer 到第一个安全出口的最短路径；不能覆盖 owner 的整条 route。



3. 三个 full-core 失败如何定性
当前三个失败都不能作为 stale threshold 直接豁免。
completedOutbound=14，要求 >=15
这是最像真实 architecture regression 的一个。
它使用固定的 mixed inbound/outbound demo，固定运行到 420s，原测试同时约束最大等待、入库完成数、出库完成数、deadlock 和 physical violation。
在同一 seed、同一 tick、同一截止时间下少完成一单，说明至少有一次 station transition 被延后。它可能只是第 15 单从 419.x 秒推迟到了 420.x 秒，但那仍然是 Round 12 引入的确定性 latency regression。先检查 completion timestamp 和 station-pass blocked duration，不能把门槛降到 14。
utilizedVehicleCount=9，要求 >=10
这个失败与 Round 12 的预期作用域不匹配。
该测试是默认 row-bank 布局、7200/h 纯 inbound、outbound rate 为 0；而 outbound station coordinator 明确只在 top-lift-column 布局启用。
如果隔离运行仍然从 10 变成 9，那么应优先判断：


Round 12 代码泄漏到了 generic movement/dispatch；


引入了共享状态或测试顺序污染；


车辆利用率恰好落在 0.05 边界附近，原断言本身脆弱。


第三种情况存在可能，但在完成干净 A/B 前不能称为 stale threshold。
max approachOccupancy=1，要求 >1
这也不是普通吞吐阈值。测试明确配置 liftApproachCapacity=2，并验证实际系统能够同时使用超过一个 approach slot，而 lift node 本身仍保持 capacity 1。
若隔离后仍然只有 1，这是 staging 并发语义的真实退化，不能改成 >=1。而且它同样是纯 inbound/default layout，因此更可能暴露作用域泄漏或 suite contamination。
综合判断：


mixed outbound 失败：高概率是 full-route/expanded lease 带来的实际延迟。


两个纯 inbound 失败：尚未证明由 route lease 本身造成，但它们是必须分类的红灯。


本轮整体状态仍然是 architecture regression，不能以“3 个阈值可能陈旧”为理由合并。



4. 下一步应该怎么改
保留


station-owned request/pass 生命周期；


grant 前排空 foreign conflicts 的思想；


station-specific event 和 shadow invariant；


Round 12 新测试的场景构造。


但两个测试需要改语义：


drains foreign vehicles occupying an outbound station pass route...
改为验证 foreign committed claim in critical section 被排空；


protects the full outbound station active route...
替换为：


active pass 阻止 foreign 穿越 ingress fence；


active pass 保护 critical section；


critical section 外的 route 节点仍可由其他车辆使用。




撤销或替换
删除或停用 outboundStationRouteProtectedNodeIds(route, envelope) 这种 route/envelope union。
改成类似：
TypeScripttype OutboundStationCriticalSection = {  exclusiveNodeIds: string[];  exclusiveEdgeIds: string[];  exclusiveConflictZoneIds: string[];  ingressFenceEdgeIds: string[];  clearThroughNodeIds: string[];};
并把状态拆开：
TypeScriptStationDrainEpoch {  stationId;  requestId;  drainerVehicleIds;  criticalSection;}OutboundStationActivePass {  authorizedRouteNodeIds; // owner path, not global exclusion  criticalSection;}
grantOutboundStationEnvelopePass() 必须在一个 tick 内重新检查所有 committed claims，并在同一个原子步骤中安装 fence/lease。不能先检查 current occupancy，过若干控制步骤后再设置 owner。
增加四个硬 invariant


activePass => foreign committed claims in criticalSection == 0


DRAINING => activePass == null


station blocker 不得阻止 critical section 外的 route node


pass 必须在 progress deadline 前前进或释放，不能只有 owner ID 而没有 route progress


现在应该停止做的事
停止：


扩大 epoch.routeNodeIds 到 station 独占范围；


在 active pass 内继续容纳 foreign drainer；


为 SH-07/SH-08 增加 vehicle-ID、waitReason 或节点特例；


增加新的 generic deadlock breaker、动态优先级或反向退让规则；


修改三个失败测试的阈值；


为了让 outbound pass 通过而修改 inbound dispatch/staging；


在 full core 未恢复全绿前跑 30m、12h 或 24h。


另外，不要把整个 dirty tree reset 到 GitHub HEAD。先做本地 checkpoint，再只反向撤销 Round 12 的 route-union hunks，避免丢掉此前 P0-P 的未提交工作。

5. 30m / 24h 前的 validation gate
Gate A：静态与资源契约
Bashgit diff --check./node_modules/.bin/tsc \  -p packages/shuttle-schemas/tsconfig.json --noEmit./node_modules/.bin/tsc \  -p packages/shuttle-sim-core/tsconfig.json --noEmit
新增确定性两车测试，直接构造 SH-07/SH-08 状态，不再等待随机运行到 435s：


SH-07 已在 spine 或正在进入 spine；


SH-08 是 station head；


active pass 尚未建立；


entry fence 阻止新 foreign 进入；


SH-07 穿过 c22 并清出；


之后才 grant SH-08；


全过程不调用 generic deadlock breaker。


Gate B：三个失败的隔离 A/B
每个测试用独立 Vitest 进程、单 worker，P0-P 版本和新 candidate 各跑至少三次：
Bash./node_modules/.bin/vitest run \  packages/shuttle-sim-core/src/high-inbound.test.ts \  -t "keeps a 12-shuttle high-inbound stress run active" \  --maxWorkers=1./node_modules/.bin/vitest run \  packages/shuttle-sim-core/src/lift-approach.test.ts \  --maxWorkers=1./node_modules/.bin/vitest run \  packages/shuttle-sim-core/src/index.test.ts \  -t "keeps unready top-lift inbound work" \  --maxWorkers=1
对两个纯 inbound 测试，候选版本应与 P0-P 的 state/event hash 一致；至少必须证明没有 station-pass/blocker event。若单测通过、整套失败，再查 suite pollution，而不是调阈值。
Gate C：全套测试
先串行，再按正常模式：
Bash./node_modules/.bin/vitest run packages/shuttle-sim-core --maxWorkers=1./node_modules/.bin/vitest run packages/shuttle-sim-corecorepack pnpm typecheckcorepack pnpm test
要求：0 failed。focused station tests 通过不能替代 full core gate。
Gate D：replay determinism
现有 replay audit 会比较 event-log hash、state hash、完成数和安全指标，但它当前使用 inbound baseline，因此必要但不足。
先跑现有 gate：
Bashcorepack pnpm shuttle:audit:replay -- \  --duration 1800 \  --split 600 \  --dt 0.2
再增加一个 mixed inbound/outbound station replay：


600s direct；


300s snapshot + restore + 继续到 600s；


event hash、state hash、station phase、完成数完全一致。


Gate E：10m paired physical run
使用相同 scenario hash、seed、tick、fill policy 和 rates，分别跑 P0-P control 与新 candidate：
Bashcorepack pnpm exec tsx scripts/run-physical-24h-amr-audit.ts \  --duration-sec 600 \  --audit-every-sec 1 \  --ten-minute-sec 600 \  --stop-on-critical \  --out output/review/physical-10m-critical-section-lease.json \  --change-note "outbound station topology-defined critical-section lease"
该脚本已经支持短 duration、stop-on-critical、10 分钟 AMR 窗口、PPH、等待、shadow ledger 和 rolling log。
10m 硬门槛：


deadlock = 0；


livelock = 0；


physical violation = 0；


station/shadow ownership violation = 0；


不再出现 435s 类型 wait-for cycle；


active pass 中不存在 foreign committed claim；


critical section 外没有 outbound-station-envelope-owned；


不使用 generic deadlock breaker 才完成该 cycle；


对照 P0-P 的 10m 成绩 53 inbound / 24 outbound / 77 total，不能直接接受明显下降。若只差一单且发生在 600s 边界，先跑一个 paired 12–15m 窗口确认它是否只是 completion 边界漂移，不能直接进入 30m。


长窗升级顺序
只有上述 gate 全绿后才进入：
30m -> 1h -> 3h -> 12h -> 24h
每一档都必须保持：


零物理违规、零 deadlock/livelock；


零 station ownership invariant；


oldest station request age 不持续上升；


station drain/pass lifetime 不超过 progress deadline；


每个 10m AMR window 无 assigned-without-route、长时间零进展或 station ping-pong；


小时 PPH 没有随着运行时间持续衰减。


最终建议：保留 Round 12 的问题判断和 drain-before-grant 思路，撤销 full-route spatial lease；先实现 claim-aware、两阶段的 critical-section lease。当前版本不应进入 30m，更不应进入 24h。
