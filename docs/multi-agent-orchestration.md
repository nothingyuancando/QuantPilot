# Multi-Agent Mission DAG

QuantPilot 可以在现有 Workspace Writer 之前，按固定、可信的金融研究 DAG 运行多个专业 Agent。该功能默认关闭：

```bash
QUANTPILOT_MULTI_AGENT_ENABLED=1
```

启用前必须应用 Prisma migration，并为项目选择的模型配置凭据。已经创建的 Mission 使用冻结的 specification，不会原地升级。

## 可信拓扑

```text
planning -> data_prefetch
                    |-> fundamental_research -|
                    |-> technical_analysis   |-> risk_crosscheck -> synthesis
                    |-> risk_precheck -------|
                                                        |
                                                        v
                                              workspace_generation
                                                        |
                                                        v
                                      validation -> preview -> evidence verification
```

扇出专家不能修改规范工作区，每个专家只能在 `.data-agent/multi-agent/` 下写一个经过 Schema 校验的产物。`workspace_generation` 仍是唯一可以取得工作区 mutation lease 的节点。

拓扑、Profile、工具、预算和输出路径全部来自可信 Finance Mission Definition。浏览器请求和模型输出不能增加节点或扩大权限。

## 持久执行

`AgentMissionNodeAttempt` 保存每次物理执行。`AgentNodeJob` 与 `AgentNodeOutboxEvent` 提供 PostgreSQL durable dispatch 和幂等生命周期投影。Claim、heartbeat 与完成提交都必须匹配数据库时钟下仍有效的 lease owner 和单调递增 fencing token。

Agent 之间通过 `AgentNodeArtifact` 交接，而不是重放完整对话。交接记录 Schema、源 AgentRun、受限路径、字节数与 SHA-256；下游会重新读取文件并拒绝哈希漂移。

每个专家都有独立 AgentRun，用于模型、Token、耗时和失败归因。节点产物不保存 hidden reasoning、Provider 私有会话或无限制工具输出。

Worker 领取节点后使用 10 分钟 lease，并每分钟续租。模型供应商暂时不可用等可恢复错误按节点预算创建新的 Attempt 后重新领取；路径越界、文件缺失、哈希漂移和风险阻断等完整性错误不重试。旧 Worker 即使晚到，也会因为 fencing token 失效而无法覆盖新 Attempt。

## Evidence Retrieval 与引用约束

首轮 Fundamental、Technical 和 Risk Precheck 不再把全部冻结数据直接塞进上下文。平台先在可信侧对 JSON/text artifact 做有界词法检索，再将 Top-K evidence passage 交给专家：

- 每段证据包含稳定的 `evidence:*` ID、源 artifact、JSON path 和原文片段。
- 模型产出的每条研究 claim 必须引用检索结果中的 ID；未知 ID 或无证据 claim 会在产物落盘前被拒绝。
- Risk Cross-check 和 Synthesis 继续通过 immutable artifact manifest、路径与 SHA-256 绑定上游产物。
- 检索深度、段落数量和单段大小均有上限，避免无限上下文和不受控 RAG。

这是一版可复现的本地检索 MVP，适合当前冻结金融数据；后续可以在不改变 Agent contract 的情况下替换为 hybrid retrieval 或向量索引。

## 可观测性

生成页会轮询 Mission 状态并显示 DAG 波次、节点状态、依赖、Attempt、模型、耗时、Token、最新 artifact 和错误。状态来自持久化 Mission/Node/Attempt/AgentRun 投影，不依赖进程内事件，因此刷新页面或 Worker 重启后仍可恢复。

```text
Fundamental ─┐
Technical ───┼─> Risk Cross-check ─> Synthesis ─> Writer
Risk Precheck┘
```

API 通过 generation status 返回 `multiAgent` 投影；未启用多 Agent 或旧 Mission 返回空投影，保持前端兼容。

## 单 Agent / 多 Agent 对照评测

Eval Platform 的 E2E evaluator 提供“单 / 多 Agent 对照”入口。一次操作会用完全相同的 case selection、模型和 evaluator 配置排入两个独立队列项：

- `single_agent`：关闭 `QUANTPILOT_MULTI_AGENT_ENABLED`。
- `multi_agent`：开启固定 Finance DAG。

队列所有权和报告 metadata 都绑定 `orchestrationMode`，避免旧报告或另一模式的报告被错误认领。Overview 仅对配置相同且已完成的 pair 计算通过率、平均分、耗时和总 Token 差值。该字段由 `20261029000100_add_eval_orchestration_mode` migration 提供。

## 安全性质

- Mission 最多 32 个节点、深度最多 12，并执行环检测。
- 每个输出 artifact 只有一个生产者。
- 编译器最多接受一个 `single_writer` 节点。
- 专家输入必须是受限大小的普通文件，拒绝 symlink 和越界 realpath。
- Risk cross-check 可以在平台层阻断 Writer。
- Node、Attempt、Job 与 Outbox 在事务中一起推进。
- 丢失 fencing token 的旧 Worker 无法 heartbeat 或完成提交。
- 最终完成仍必须由现有 Evidence Verifier 写入 accepted receipt。

## 灰度顺序

1. 保持开关关闭，依次部署 `20261028000100_add_multi_agent_dag_runtime` 与 `20261029000100_add_eval_orchestration_mode`。
2. 执行单元、Prisma、PostgreSQL runtime 和 task E2E 检查。
3. 仅对内部环境启用开关，观察模型凭据、结构配额和产物质量。
4. 对比单 Agent 基线的耗时、Token、验证通过率、风险阻断率和 lease takeover。
5. 关闭开关只会停止创建新的多 Agent Mission；已有 Mission 应完成或显式取消。

首版有意采用固定 DAG，不允许模型动态创建子 Agent。
