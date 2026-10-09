# dsh-longhorizon

**为 DeepSeek Harness 的长程任务提供「已验证进度账本」。**

长任务有一种特定的失败方式：agent 报告了它证明不了的进度，这份报告进了对话记录，下一轮就在一个从未被核实的claim 上继续往下建。下游没有任何东西能区分「已核实的步骤」和「乐观的步骤」，于是错误不断累积，直到最后给出一个自信但错误的答案。

本插件补上缺失的那道核对。当 agent 声称某步做完时，一个**带全新上下文的独立验证者**去检查真实工作区，返回结构化裁决，只有通过裁决的步骤才会进入持久账本。被否的步骤留在账本里作为**证据**——它永远不会被提升为进度。

```
声明 ──▶ 独立验证 ──▶ 裁决
                       │
        complete + clean + aligned ──▶ 账本（进度）
                       │
                   其它任何结果 ──▶ 账本（仅证据）
```

## 它做什么

**1. 用独立验证替代自述。** 验证者是一个不继承任何对话上下文的独立子代理。它读文件、跑能跑检查、然后用三行控制行作答：

```
Status: complete | incomplete | blocked
Integrity: clean | suspect | violation
Contract audit: aligned | unknown | needs_revision | invalid
```

**2. 硬降级不变量。** 只要审计是脏的，声明就不可能是 `complete`：

```
integrity === "violation" || contract !== "aligned"  ⟹  status !== "complete"
```

这条不变量是**代码强制的，不是在提示词里请求的**。少写一行控制行的验证者会向保守方向降级——未声明的 integrity 读作 `suspect`，绝不读作 `clean`——因为占位值绝不能成为背书工作的那一环。

**3. 持久化已验证进度账本。** 通过的步骤追加写入 `ledger.jsonl`（一行一个 JSON 对象，每次追加都 fsync），并在 `state.json` 里维护 last-wins 投影。崩过的进程、被压缩过的上下文、或一个全新会话，都能重新打开这次运行并回答：什么已被验证、什么被否以及为什么、还剩什么。

**变异护栏。** 验证者只应观察、不应写入。工作区会在每次验证前后各做一次指纹（所有文件记 size+mtime，限额内的文件另记 SHA-256）。只要有东西变了，这次审计自己的结论即作废，该轮记为 `blocked` / `violation`。

## 工具

| 工具 | 用途 |
|---|---|
| `longhorizon_verify` | 用一个声明的步骤去核对工作区，并把裁决写入账本。 |
| `longhorizon_ledger` | 读回已验证进度、被否的声明、以及剩余项。 |
| `longhorizon_state` | 当前状态：已验证轮次、待证声明、未完成项。 |

## 安装

```sh
dsh plugin --profile web add dsh-longhorizon
```

然后重启 harness。无需构建：包内直接是 ESM 源码，且没有运行时依赖。

## 存储位置

一切都在 harness 的状态目录下，**不在你的项目里**：

```
<state>/longhorizon/runs/<runId>/ledger.jsonl
<state>/longhorizon/runs/<runId>/state.json
```

`<runId>` 优先由会话 id 派生，没有会话 id 时用工目录的哈希，所以重开同一个会话就是重开同一次运行。

## 设计边界——请读这几条

- **验证者是独立 agent，不是独立进程。** 它看不到执行者的对话，这是它「独立」的来源；但它运行在同一个 harness 内，受同样的权限约束。
- **变异护栏是正确性工具，不是安全边界。** 它比对文件指纹，不防御本地攻击者，也不是沙箱。
- **超出哈希上限的大文件会被如实报为「证据缺口」。** 这类文件只比 size+mtime，快照会明确说出来，而不是假装做过它没做的比对。
- **验证是有成本的。** 每个被验证的步骤都会多一次验证者回合。你换来的是账本；如果任务只是一轮短对话，你不需要这个插件。

## 为什么会有这个项目

循环设计移植自 [LongHorizon-Harness](https://github.com/AMAP-ML/LongHorizon-Harness)（AMAP-ML，MIT）——manager/executor/auditor 轮次、持久轮账本、以及一个无法为脏结果背书的 auditor。

那个项目是一个包裹 agent CLI 的 Python 编排器，**在 Windows 上跑不起来**：它的持久化层要求 `os.O_NOFOLLOW`、`os.O_DIRECTORY` 与 `supports_dir_fd`（win32 上全部缺失），并且用 POSIX 的 `VAR=value cmd` 模板起子进程。它还按设计为每个角色回合驱动一次 agent CLI——所以接 DeepSeek Harness 时它只能读到每次 `dsh --profile headless` 的最终答复，拿不到中间的工具事件。

本插件把真正承载价值的部分——独立验证、降级不变量、已验证状态账本、变异护栏——拿出来，在 harness 内部原生实现：那里事件可得，也不需要任何 POSIX-only 原语。

## 许可证

MIT
