# 统一 Data Model 兼容性分析报告

> **日期**: 2026-02-13
> **验证方式**: 直接查询本机 Cursor SQLite 数据库
> **数据源**: `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`
> **样本量**: 4,592 条 bubble / 264 个 session / 29 个 workspace

---

## 1. 原始兼容性矩阵回顾

以下为原始分析中提出的字段矩阵，本报告逐项验证其准确性。

---

## 2. Message 级别字段验证

### 2.1 通过验证的字段（原标注准确）

| 字段 | Claude Code | Codex | Cursor | 验证状态 |
|------|:-----------:|:-----:|:------:|:--------:|
| id | ✓ uuid | ✓ 生成 | ✓ bubbleId | ✅ 准确 |
| sessionId | ✓ | ✓ | ✓ | ✅ 准确 |
| role | ✓ | ✓ | ✓ | ✅ 准确 |
| content | ✓ | ✓ | ✓ | ✅ 准确 |
| parentMessageId | ✓ parentUuid | undefined | undefined | ✅ 准确 |
| isSidechain | ✓ | undefined | undefined | ✅ 准确 |
| toolCalls | ✓ | ✓ | ✓ | ✅ 准确 |

**验证细节**:

- **id**: 每条 bubble 均有 `bubbleId` (UUID 格式)，key 结构为 `bubbleId:<composerId>:<bubbleId>`
- **role**: `type: 1` = user, `type: 2` = assistant，cursor-history 正确映射
- **content**: 从 `text`、`toolFormerData`、`codeBlocks`、`thinking` 等多字段提取
- **toolCalls**: 通过 `toolFormerData.{name, params, result, status}` 完整支持

### 2.2 需修正的字段

#### timestamp — 原标注 ⚠️「session 级别」→ 修正为 ⚠️「版本相关，per-message 部分可用」

**原始判断**: Cursor 仅有 session 级别时间戳，per-message 时间戳退化。

**实测结果**: 不准确。Cursor 有两个独立的 per-message 时间戳来源。

##### 全量统计（4,592 条 bubble）

| 时间戳来源 | 可用量 | 覆盖率 | 格式 | 说明 |
|-----------|-------:|-------:|------|------|
| `bubble.createdAt` | 2,835 | 61.7% | ISO 字符串 | 新版 Cursor (≥2025-09) |
| `timingInfo.clientRpcSendTime` | 763 | 16.6% | Unix 毫秒 | 旧版 Cursor，仅 assistant |
| **任一来源可用** | **3,355** | **73.1%** | — | 合并两个来源 |
| 无任何时间戳 | 1,237 | 26.9% | — | 旧 session 的 user 消息为主 |

##### 按消息类型

| 消息类型 | 有时间戳 | 总数 | 覆盖率 |
|---------|--------:|-----:|-------:|
| type=1 (user) | 187 | 306 | 61.1% |
| type=2 (assistant) | 3,168 | 4,286 | 73.9% |

##### 按 Cursor 版本（时间线）

| Session 创建时间 | `bubble.createdAt` | `timingInfo.clientRpcSendTime` | 说明 |
|:----------------:|:------------------:|:------------------------------:|------|
| 2025-08 及之前 | ❌ 不存在 | ✓ 仅 assistant | 旧版格式 |
| 2025-09 ~ 至今 | ✓ 全部消息 | ❌ 不存在 | 新版格式 |

##### 实测示例

**新版 session (2026-01-29) — 有 `createdAt`**:
```
bubble[0] type=1 createdAt=2026-01-29T12:58:03.575Z
bubble[1] type=2 createdAt=2026-01-29T12:58:05.071Z
bubble[2] type=2 createdAt=2026-01-29T12:58:36.979Z
bubble[3] type=2 createdAt=2026-01-29T12:58:39.313Z
```

**旧版 session (2025-08-26) — 仅 `timingInfo`**:
```
bubble[0] type=1 createdAt=None  timingInfo.rpc=None        ← user 消息无时间戳
bubble[1] type=2 createdAt=None  timingInfo.rpc=2025-08-26 17:51:27
bubble[2] type=2 createdAt=None  timingInfo.rpc=2025-08-26 17:51:40
bubble[3] type=2 createdAt=None  timingInfo.rpc=2025-08-26 17:51:42
```

##### 结论

原始标注「session 级别」**不准确**。正确描述应为：

> Cursor 的 per-message 时间戳**版本相关**：新版 (≥2025-09) 每条消息有 `createdAt`；旧版仅 assistant 消息有 `timingInfo.clientRpcSendTime`，user 消息无时间戳。总体 73.1% 的消息可获取 per-message 时间戳。

---

#### tokenUsage — 原标注 ⚠️「部分」→ 修正为 ❌「per-message 几乎不可用」

**原始判断**: Cursor 有 `tokenCount`，部分可用。

**实测结果**: per-message 级别**几乎完全不可用**，仅 session 级别有用。

##### 全量统计（4,592 条 bubble）

| Token 来源 | 可用量 | 覆盖率 | 说明 |
|-----------|-------:|-------:|------|
| `tokenCount` (非零 input/output) | 5 | 0.1% | 几乎无用 |
| `usage` (snake_case) | 0 | 0% | 未见任何实例 |
| `contextWindowStatusAtCreation` | 极低 | — | 偶见于 user 消息 |
| `promptDryRunInfo` | 存在但异常 | — | 数字 key 而非对象字段，结构不稳定 |

##### Session 级别 token 数据

| 字段 | 可用性 | 说明 |
|------|:------:|------|
| `composerData.contextTokensUsed` | 部分 session ✓ | 当前会话消耗的 context token |
| `composerData.contextTokenLimit` | 部分 session ✓ | 模型 context window 上限 |
| `composerData.contextUsagePercent` | 部分 session ✓ | 使用百分比 |

##### 实测示例

**Per-message tokenCount（典型值）**:
```json
{"inputTokens": 0, "outputTokens": 0}
```
> 4,587/4,592 条 bubble 的 tokenCount 为全零

**极少数非零实例（5/4,592）**:
```json
{"inputTokens": 17945, "outputTokens": 1079}
```

**Session 级别（可用）**:
```json
{
  "contextTokensUsed": 46427,
  "contextTokenLimit": 272000,
  "contextUsagePercent": 18
}
```

##### 结论

原始标注「部分」**低估了问题的严重性**。正确描述应为：

> Cursor per-message token 数据**几乎不可用**（0.1%），`tokenCount` 字段存在但值几乎全为零。仅 session 级别的 `contextTokensUsed/Limit` 有实际意义。与 Claude Code / Codex 的完整 per-message token 计数差距极大。

---

### 2.3 补充发现：model 字段

原始矩阵未列出 model 字段，但 cursor-history 已实现提取。

##### 实测结果

| 字段 | 可用量 | 说明 |
|------|-------:|------|
| bubble 级 `model` / `modelType` / `selectedModel` | 0 | 不存在 |
| session 级 `composerData` 内 model 信息 | — | 未直接存储 |
| `promptDryRunInfo` 内 model | — | 结构不稳定 |

然而 cursor-history 的 JSON 输出中第一条消息显示了 `model: "gpt-5.2-codex-xhigh"`，这来自 `extractModelInfo()` 的多源提取逻辑，具体来源待进一步确认。

---

## 3. Session 级别字段验证

### 3.1 通过验证的字段

| 字段 | Claude Code | Codex | Cursor | 验证状态 |
|------|:-----------:|:-----:|:------:|:--------:|
| id | ✓ | ✓ | ✓ composerId | ✅ 准确 |
| title | ✓ summary | ✓ 提取 | ✓ name | ✅ 准确 |
| createdAt | ✓ | ✓ | ✓ | ✅ 准确 |
| updatedAt | ✓ | ✓ | ✓ | ✅ 准确 |
| leafMessageId | ✓ leafUuid | undefined | undefined | ✅ 准确 |
| agentSessionIds | ✓ agentIds | undefined | undefined | ✅ 准确 |
| parentSessionId | undefined | ✓ UUID 检测 | undefined | ✅ 准确 |

**验证细节**:

- **id**: `composerData.composerId`，UUID 格式，始终存在
- **title**: `composerData.name`，可能为 null（无标题 session）
- **createdAt**: `composerData.createdAt`，Unix 毫秒，始终存在
- **updatedAt**: `composerData.lastUpdatedAt`，Unix 毫秒，始终存在

### 3.2 需修正的字段

#### projectPath — 原标注 ⚠️「需解析」→ 修正为 ✓「可靠获取」

**原始判断**: Cursor 需从 workspaceStorage 路径推断，标记为 ⚠️。

**实测结果**: 解析逻辑成熟可靠，100% 覆盖。

##### 全量统计

| 指标 | 值 |
|------|---:|
| 总 workspace 目录数 | 29 |
| 包含 workspace.json 的目录 | **29** |
| **覆盖率** | **100%** |

##### 解析方式

```
workspaceStorage/<hash>/workspace.json
  └─ { "folder": "file:///Users/borui/Devs/project-name" }
       ↓ strip file:// → URL decode %20
     /Users/borui/Devs/project-name
```

##### 实测示例

| Workspace Hash | 解析出的项目路径 |
|----------------|-----------------|
| `007ef8f4...` | `file:///Users/borui/Devs/open-source-general-agents/wormhole` |
| `023dc4e9...` | `file:///Users/borui/Devs/mcptest` |
| `034070be...` | `file:///Users/borui/Devs/scripts/travel_poi` |
| `253a176e...` | `file:///Users/borui/Knowledges/blog-me/myblogpostsnew2024` |
| `1915b884...` | `vscode-remote://dev-container+...` (Dev Container) |

##### cursor-history 输出验证

```
#1 msgs=  9 created=2026-01-29 workspace=~/Knowledges/blog-me/myblogpostsnew2024  ✓
#2 msgs=  2 created=2026-01-26 workspace=~/Devs/open-source-general-agents/wormhole  ✓
#4 msgs=  4 created=2026-01-24 workspace=~/Devs/vibe-coding-history/vibe-history  ✓
```

##### 特殊情况

- Dev Container workspace 包含 `vscode-remote://` 协议 URI，cursor-history 也能处理
- `%20` 空格编码会被正确解码
- workspace.json 不在 SQLite 数据库内，存在于文件系统上

##### 结论

原始标注 ⚠️ **过于保守**。正确描述应为：

> Cursor 的 projectPath 通过 `workspace.json` 获取，覆盖率 100%，解析逻辑成熟。虽然存储位置不在 SQLite 内（在文件系统上），但这不影响可靠性。应标记为 ✓ 而非 ⚠️。

---

## 4. 修正后的兼容性矩阵

### Message 级别

| 字段 | Claude Code | Codex | Cursor | 修正说明 |
|------|:-----------:|:-----:|:------:|----------|
| id | ✓ uuid | ✓ 生成 | ✓ bubbleId | 公用 |
| sessionId | ✓ | ✓ | ✓ | 公用 |
| role | ✓ | ✓ | ✓ | 公用 |
| content | ✓ | ✓ | ✓ | 公用 |
| timestamp | ✓ per-message | ✓ per-message | ⚠️ 版本相关 | **修正**: 非 session 级别退化。新版 per-message 可用，旧版仅 assistant 有 |
| parentMessageId | ✓ parentUuid | — | — | Claude 专用 |
| isSidechain | ✓ | — | — | Claude 专用 |
| toolCalls | ✓ | ✓ | ✓ | 公用 |
| tokenUsage | ✓ | ✓ | ❌ 几乎不可用 | **修正**: 从 ⚠️ 降级为 ❌。per-message 0.1%，仅 session 级 context 可用 |

### Session 级别

| 字段 | Claude Code | Codex | Cursor | 修正说明 |
|------|:-----------:|:-----:|:------:|----------|
| id | ✓ | ✓ | ✓ composerId | 公用 |
| title | ✓ summary | ✓ 提取 | ✓ name | 公用 |
| createdAt | ✓ | ✓ | ✓ | 公用 |
| updatedAt | ✓ | ✓ | ✓ | 公用 |
| projectPath | ✓ | ✓ cwd | ✓ workspace.json | **修正**: 从 ⚠️ 升级为 ✓。100% 可靠获取 |
| leafMessageId | ✓ leafUuid | — | — | Claude 专用 |
| agentSessionIds | ✓ agentIds | — | — | Claude 专用 |
| parentSessionId | — | ✓ UUID 检测 | — | Codex 专用 |

### 修正变更总结

| 字段 | 原标注 | 修正后 | 变更方向 |
|------|:------:|:------:|:--------:|
| timestamp | ⚠️ session 级别 | ⚠️ 版本相关 per-message | 描述更精确 |
| tokenUsage | ⚠️ 部分 | ❌ 几乎不可用 | ↓ 降级 |
| projectPath | ⚠️ 需解析 | ✓ 可靠获取 | ↑ 升级 |

---

## 5. Cursor 数据结构参考

### Bubble 完整字段（实测）

```typescript
interface CursorBubble {
  // === 始终存在 ===
  type: 1 | 2;                            // 1=user, 2=assistant
  bubbleId: string;                        // UUID
  _v: number;                              // 数据版本号

  // === 时间戳（版本相关）===
  createdAt?: string;                      // ISO 字符串，新版(≥2025-09)才有
  timingInfo?: {                           // 旧版才有
    clientStartTime?: number;              // 相对时间（非 Unix，不可用作时间戳）
    clientRpcSendTime?: number;            // Unix 毫秒 ✓（可用作时间戳）
    clientSettleTime?: number;             // Unix 毫秒（响应完成时间）
    clientEndTime?: number;                // Unix 毫秒（结束时间）
  };

  // === 内容 ===
  text?: string;                           // 主文本
  richText?: string;                       // JSON 格式富文本
  codeBlocks?: Array<{
    content: string;
    languageId: string;
    uri?: { path: string; _formatted: string; _fsPath: string };
  }>;
  thinking?: { text?: string };            // AI 思考过程

  // === 工具调用 ===
  toolFormerData?: {
    name?: string;                         // 工具名 (read_file, write, grep, ...)
    params?: string;                       // JSON 字符串
    rawArgs?: string;                      // 替代 params
    result?: string;                       // JSON 字符串（含 diff）
    status?: string;                       // completed | cancelled | error
    additionalData?: { status?: string };
  };

  // === Token（几乎不可用）===
  tokenCount?: {                           // 99.9% 为 {0, 0}
    inputTokens: number;
    outputTokens: number;
  };

  // === 其他 ===
  isAgentic?: boolean;
  unifiedMode?: string;
  checkpointId?: string;                   // 文件状态快照 ID
  requestId?: string;                      // API 请求 ID
  serverBubbleId?: string;                 // 服务端 ID（1:1 映射）
  promptDryRunInfo?: unknown;              // 结构不稳定
  supportedTools?: number[];               // 支持的工具 ID 列表
  context?: unknown;                       // 上下文数据
  images?: unknown[];                      // 附加图片
  attachedCodeChunks?: unknown[];          // 附加代码片段
}
```

### Session 完整字段（实测）

```typescript
interface CursorSession {
  // === 始终存在 ===
  composerId: string;                      // UUID
  createdAt: number;                       // Unix 毫秒
  _v: number;                              // 数据版本号
  fullConversationHeadersOnly: Array<{     // bubble 引用列表（线性，非树）
    bubbleId: string;
    type: 1 | 2;
    serverBubbleId?: string;
  }>;

  // === 通常存在 ===
  name?: string;                           // session 标题
  lastUpdatedAt?: number;                  // Unix 毫秒

  // === Session 级别 Token（部分可用）===
  contextTokensUsed?: number;              // 已使用 context token
  contextTokenLimit?: number;              // context window 上限
  contextUsagePercent?: number;            // 使用百分比

  // === 其他 ===
  unifiedMode?: string;                    // 'agent' 等
  isAgentic?: boolean;
}
```

### 存储架构

```
~/Library/Application Support/Cursor/User/
├── globalStorage/
│   └── state.vscdb                        # cursorDiskKV 表
│       ├── composerData:<sessionId>       # session 元数据
│       ├── bubbleId:<sessionId>:<id>      # 完整 bubble 数据
│       └── checkpointId:<sessionId>:<id>  # 文件状态快照
│
└── workspaceStorage/
    └── <hash>/
        ├── workspace.json                 # { "folder": "file:///..." }
        └── state.vscdb                    # ItemTable
            └── composer.composerData      # 该 workspace 所有 session 元数据列表
```

---

## 6. cursor-history 代码中发现的问题

### Bug: 时间戳 fallback 使用 `new Date()`

**位置**: `src/core/storage.ts:499`, `src/core/storage.ts:779`

```typescript
timestamp: data.createdAt ? new Date(data.createdAt) : new Date(),
//                                                     ^^^^^^^^^^
//  对无 createdAt 的旧 bubble，返回**当前时间**而非真实时间
```

**影响范围**: 2025-09 之前的 session 中，所有无 `createdAt` 的 bubble（约 26.9%）显示的时间戳为**查询时刻**而非实际发送时间。

**推荐修复**:

```typescript
function extractTimestamp(data: RawBubbleData, sessionCreatedAt?: Date): Date {
  // 1. 首选 bubble.createdAt (新版 Cursor)
  if (data.createdAt) return new Date(data.createdAt);

  // 2. 次选 timingInfo.clientRpcSendTime (旧版 Cursor, assistant only)
  const rpc = data.timingInfo?.clientRpcSendTime;
  if (typeof rpc === 'number' && rpc > 1_000_000_000_000) return new Date(rpc);

  // 3. 备选 timingInfo.clientSettleTime / clientEndTime
  const settle = data.timingInfo?.clientSettleTime;
  if (typeof settle === 'number' && settle > 1_000_000_000_000) return new Date(settle);

  // 4. 兜底: session 创建时间（近似）
  return sessionCreatedAt ?? new Date();
}
```

### 潜在改进: tokenCount 提取投入产出比低

`extractTokenUsage()` 实现了多源 fallback（`tokenCount` → `usage` → `contextWindowStatusAtCreation` → `promptDryRunInfo`），但 Cursor 实际数据中 per-message token 几乎全为零（0.1%）。该功能的实际效果有限，仅 session 级别的 `contextTokensUsed/Limit` 有实用价值。

---

## 7. 统一 Data Model 设计建议

### 针对 Cursor 端的映射策略

| 统一字段 | Cursor 映射 | 质量标注 |
|----------|------------|:--------:|
| message.id | `bubbleId` | ✓ 高质量 |
| message.sessionId | `composerId` (from key) | ✓ 高质量 |
| message.role | `type: 1→user, 2→assistant` | ✓ 高质量 |
| message.content | 多源提取 (text + toolFormerData + codeBlocks + thinking) | ✓ 高质量 |
| message.timestamp | `createdAt` → `timingInfo.clientRpcSendTime` → session.createdAt | ⚠️ 版本相关 |
| message.parentMessageId | `undefined` | — 不适用 |
| message.isSidechain | `undefined` | — 不适用 |
| message.toolCalls | `toolFormerData` | ✓ 高质量 |
| message.tokenUsage | `null` (per-message 不可用) | ❌ 不可用 |
| session.id | `composerId` | ✓ 高质量 |
| session.title | `name` | ✓ 高质量 |
| session.createdAt | `createdAt` | ✓ 高质量 |
| session.updatedAt | `lastUpdatedAt` | ✓ 高质量 |
| session.projectPath | `workspace.json → folder` | ✓ 高质量 |
| session.contextUsage | `contextTokensUsed / contextTokenLimit` | ⚠️ 部分 session |
| session.leafMessageId | `undefined` | — 不适用 |
| session.agentSessionIds | `undefined` | — 不适用 |
| session.parentSessionId | `undefined` | — 不适用 |

### 建议的统一模型补充字段

```typescript
interface UnifiedMessage {
  // ... 公共字段 ...

  // 元数据质量标注
  timestampSource?: 'native' | 'timing_info' | 'session_fallback' | 'unknown';
  tokenUsageSource?: 'native' | 'session_level' | 'unavailable';
}
```

---

*报告基于对本机真实 Cursor 数据的直接 SQL 查询和 cursor-history CLI 输出验证。不同 Cursor 版本的数据结构可能有所差异。*
