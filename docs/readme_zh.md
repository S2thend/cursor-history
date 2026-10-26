# Cursor History

<p align="center">
  <img src="readme-banner.png" alt="cursor-history：所有 Cursor 历史的统一入口。Composer、Agent transcripts 和 Store / ACP 汇入统一的 CLI 与 Node.js API。" width="960">
</p>

[![npm version](https://img.shields.io/npm/v/cursor-history.svg)](https://www.npmjs.com/package/cursor-history)
[![npm downloads](https://img.shields.io/npm/dm/cursor-history.svg)](https://www.npmjs.com/package/cursor-history)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-20%2C%2022--26-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0%2B-blue.svg)](https://www.typescriptlang.org/)

🇺🇸 [English](../README.md) | 🇨🇳 [中文](./readme_zh.md) | 🇫🇷 [Français](./readme_fr.md) | 🇪🇸 [Español](./readme_es.md) | 🇯🇵 [日本語](./readme_ja.md) | 🇰🇷 [한국어](./readme_ko.md) | 🇺🇦 [Українська](./readme_uk.md)

**所有 Cursor 历史，一个统一入口。**

Cursor 对话可能分散在不同工作区、IDE 数据库、Agent transcript，以及较新的 CLI / ACP 会话存储中。`cursor-history` 自动发现受支持的本地来源，通过同一套 CLI 和 Node.js 库提供访问。

跨工作区搜索对话正文，查看消息及来源中可用的工具活动，导出为 Markdown 或 JSON。备份和恢复 Composer 历史，或在项目移动时迁移受支持的 Composer 会话。

**把 Cursor 编程历史转化为可复用的训练数据。** 支持 messages、ShareGPT 和 TRL 导出，保留结构化工具调用，提供默认凭据脱敏、按会话划分的训练/验证集，以及可运行的 Hugging Face SFT 示例。[训练数据指南](./training.md)。

**已经积累了几个月的 Cursor 历史？无需提前采集，也无需预先建立索引。** 搜索在本地运行，不需要嵌入模型或 API key。

**希望通过 MCP 接入？** 使用 [cursor-history-mcp](https://github.com/S2thend/cursor-history-mcp#quick-start) 将历史能力暴露为 MCP 工具。Agent 也可以直接调用本项目的 CLI 或 Node.js API，按工作流选择合适的接口即可。两个包独立发布，请查看 [MCP 存储兼容范围与发布说明](https://github.com/S2thend/cursor-history-mcp#compatibility)。

## 快速上手

```bash
npm install -g cursor-history

cursor-history list --all
cursor-history search "authentication"
cursor-history show 1
cursor-history export 1
cursor-history backup
```

需要 Node.js 20.x 或 22.x–26.x，以及已有的本地 Cursor 历史。不想全局安装，可以运行 `npx cursor-history list --all`。

`show` 和 `export` 中的数字对应同一数据源、同一工作区作用域下的会话列表；保存命令供以后使用时，请使用会话 UUID。`backup` 归档的是 Composer 数据库，不包含 Store 数据库或 transcript。

[工具对比](#comparison) · [安装](#安装) · [使用方法](#使用方法) · [输出示例](../README.md#example-output) · [库 API](#库-api) · [路线图](#路线图) · [兼容性与安全升级](#兼容性与安全升级)

<a id="comparison"></a>

## 为什么选择 cursor-history？

如果你希望通过同一套 CLI 和 Node.js API 查找、查看、保存和复用 Cursor 历史，`cursor-history` 提供了完整的使用流程。

- **多种 Cursor 来源，一个接口** — 读取受支持的 Composer、Agent transcript、Store / CLI 和 ACP 数据。
- **从搜索到保存** — 跨工作区搜索会话正文，查看可用的 diff 和工具活动，导出 Markdown 或 JSON；备份恢复 Composer 数据，并用 `--dry-run` 预览符合条件的 Composer 会话迁移。
- **复用真实编程对话进行微调** — messages、ShareGPT 与 TRL 共用会话提取和脱敏逻辑；TRL 模式将工具参数输出为对象，并校验工具定义及调用/结果关联。[导出与训练示例](./training.md)。
- **融入现有工作流** — 在自己的工具中使用 Node.js API，连接独立的 [MCP 配套项目](https://github.com/S2thend/cursor-history-mcp#compatibility)，或按 [WSL 配置](#cursor-数据存储位置)读取 Windows 侧或 WSL 内的 Store 数据。

| 维度 | **cursor-history（本项目）** | [deja-vu](https://github.com/vshulcz/deja-vu) | [cursaves](https://github.com/Callum-Ward/cursaves) | [johnlindquist/cursor-history](https://github.com/johnlindquist/cursor-history) |
|---|---|---|---|---|
| 定位 | Cursor 历史查询与管理；CLI + Node.js API | 跨 Agent 记忆 | Git / S3 同步 | 浏览、导出、剪贴板 |
| 文档列出的 Cursor 来源 | Composer、Agent transcripts、Store / CLI、ACP | IDE SQLite、CLI transcripts¹ | 工作区及全局 SQLite | 文档未说明 |
| 搜索 | 跨工作区搜索会话正文 | 跨 Agent 索引搜索 | 文档未说明 | 标题模糊搜索 |
| 保存与转移历史 | Composer 备份恢复；符合条件的 Composer 迁移 | 记忆同步与交接 | 快照恢复；工作区复制 | 文档未说明 |

文档核对日期：**2026-09-09**。依据为表头链接中的项目 README 及 ¹ [deja-vu 的 Cursor 格式说明](https://github.com/vshulcz/deja-vu/blob/main/docs/registry/cursor.md)，未进行各工具的运行对比测试。“文档未说明”表示所查来源未描述该能力，不代表确认不支持。

本项目的备份与恢复仅覆盖 Composer 数据库；迁移仅支持符合条件的 Composer 会话，不包括 Store-only 或合并来源会话。可读取的 Store / ACP 会话和 transcript 可导出，但导出文件不是可恢复的备份归档。详见[兼容性约定](./compatibility.md)。

## 为什么需要这个工具

你可能记得曾用 Cursor 解决过某个问题，却不记得当时在哪个项目、哪个会话或哪个 Cursor 界面中操作。搜索本地历史里的关键词，就有机会重新找到那段对话。

Cursor 的 [Agent CLI](https://cursor.com/docs/cli/reference/parameters) 提供 `agent ls`、`agent resume` 和 `agent --resume=<id>`，用于查找或继续 CLI 会话。`cursor-history` 则提供跨工作区、跨存储格式读取和管理受支持本地历史的工作流。

| 你想做什么 | 从哪里开始 |
|---|---|
| 在 Cursor Agent CLI 中继续对话 | Cursor 的 `agent ls` 或 `agent --resume=<id>` |
| 跨工作区搜索对话正文中的短语 | `cursor-history search "connection pool"` |
| 查看或导出发现的本地会话 | `cursor-history show 1` 或 `cursor-history export 1` |
| 备份或恢复 Composer 历史 | `cursor-history backup` / `cursor-history restore`（[用法](#备份与恢复)） |
| 将受支持的 Composer 会话移动到另一工作区 | `cursor-history migrate-session`（[用法](#迁移会话)） |
| 在自己的应用中使用历史记录 | [Node.js API](#库-api) |

## 导出训练数据

```bash
# 通用 messages 格式（默认）；保留 ShareGPT 兼容选项
cursor-history export-training -o dataset.jsonl
cursor-history export-training --schema sharegpt -o sharegpt.jsonl

# 纯对话 TRL 数据，无需工具定义
cursor-history export-training --schema trl --no-tools --no-reasoning -o sft.jsonl

# 工具调用训练：提供实际使用的函数 JSON Schema
cursor-history export-training --schema trl --tools-file tools.json \
  --no-reasoning --valid-ratio 0.05 -o agent.jsonl
```

`messages` 的工具参数是 JSON 字符串，`trl` 则是 JSON 对象，并附带 `tools` 定义。
ShareGPT 保留 `conversations/from/value`，其 `[tool_call]` 等文本标记属于本项目扩展。
工具定义不会从历史调用中猜测；如果缺失，请提供 `--tools-file` 或使用 `--no-tools`。

配套 [Python 示例](../examples/training/train.py) 先逐条应用目标模型的聊天模板，再构建
训练数据集，避免不同工具参数被 Arrow 改写或因类型不一致而加载失败。支持 `--check`
仅验证加载和分词。模板必须支持你保留的工具调用和 reasoning 字段；格式兼容不保证训练质量。
完整环境配置与运行方式见[训练数据指南](./training.md)。

交互终端会在 stderr 显示扫描、已处理会话、记录数及跳过数量；`--progress` 可用于日志和
`--json` 模式，`--no-progress` 可关闭。`--report quality.json` 保存来源完整性、工具失败或
缺少结果、截断和丢弃分段等计数。所有输出先写入临时文件，成功后再替换；处理或写入失败
会保留已有文件，空验证集也会写成空文件，避免误用上次的数据。

TRL 的自动验证只加入现有的 **publish 工作流**，推送 `v*` 标签时运行并阻止验证失败的发布；
不新增 PR 或普通分支 push 检查。

## 支持多代 Cursor 存储和不同使用界面

不同版本与使用界面可能在同一台机器上留下不同的本地数据表示。`cursor-history` 会发现以下受支持的来源：

| 来源 | 本地文件 | 用途 |
|---|---|---|
| 旧版 / Composer | Cursor 用户数据目录下的 `workspaceStorage/*/state.vscdb` 和 `globalStorage/state.vscdb` | 工作区记录和全局对话数据 |
| Agent transcripts | `~/.cursor/projects/**/agent-transcripts/**/*.jsonl` | transcript 中保留的对话正文和工具调用 |
| Store / CLI | `~/.cursor/chats/**/store.db` | 每个会话的 Store 对话数据 |
| ACP 会话 | `~/.cursor/acp-sessions/**/store.db` | ACP 根目录下发现的会话 Store 数据 |

各平台路径、自定义根目录和 WSL 配置见 [Cursor 数据存储位置](#cursor-数据存储位置)。

这些格式包含的字段并不总是相同。transcript 可能缺少时间戳或工具结果。在作用域内同时存在可用 Store 数据库和 transcript 时，以数据库作为 Store 对话来源，transcript 保留为来源记录。来源详情和时间戳来源标记可以区分直接存储的信息、推断值和不完整视图。

读取支持不等于备份或迁移支持：当前备份归档仅包含 Composer 数据，Store-only 或合并来源会话暂不能迁移。扩大覆盖范围已列入[路线图](#路线图)，完整边界见[兼容性与数据完整性规范](./compatibility.md)。

## 用历史记录做三件事

### 找到它

```bash
cursor-history list --all
cursor-history search "connection pool"
cursor-history show 1
```

找到那段已经解决过问题的对话，即使它属于另一个工作区。安装工具之前已有的、受支持的本地历史也可以搜索。

### 保存它

```bash
cursor-history export 1
cursor-history backup
cursor-history migrate-session 1 /path/to/new/workspace --dry-run
```

将可读取的会话导出为 Markdown 或 JSON。备份 Composer 历史，并在移动受支持的 Composer 会话之前预览迁移操作。

### 再次利用它

直接使用 [Node.js 库](#库-api)，或连接独立的 [cursor-history-mcp](https://github.com/S2thend/cursor-history-mcp) 服务，让支持 MCP 的助手搜索已有开发历史。

几个月的决策、修复、提示词和工具活动可能已经保存在磁盘上。下次需要时，让这些上下文更容易被找到。

## 功能特性

- **双接口** - 可作为 CLI 工具使用，也可作为库导入到 Node.js 项目中
- **会话列表** - 查看所有工作区的聊天会话
- **查看对话** - 查看各来源中可用的内容，包括：
  - AI 回复和自然语言解释
  - **文件编辑的完整 diff 显示**，带语法高亮
  - **详细的工具调用**，显示所有参数（文件路径、搜索模式、命令等）
  - AI 推理和思考过程
  - 带明确来源标记的消息时间戳（直接存储或推断）
- **搜索** - 跨工作区搜索对话正文中的关键词，带高亮匹配
- **导出** - 将会话保存为 Markdown 或 JSON 文件
- **迁移** - 在工作区之间移动或复制受支持的 Composer 会话（例如重命名项目时）
- **备份与恢复** - 备份 Composer 数据库，并在需要时恢复
- **跨平台与 WSL 支持** - 支持 macOS、Windows、Linux 和 WSL。在 WSL 中，可配置数据路径，读取存储在 Windows 侧或 WSL 内的 Cursor Store 会话。详见 [WSL 配置](#cursor-数据存储位置)。

## 安装

### 从 NPM 安装（推荐）

```bash
# 全局安装
npm install -g cursor-history

# 使用 CLI
cursor-history list
```

### 从源码安装

```bash
# 克隆并构建
git clone https://github.com/S2thend/cursor_chat_history.git
cd cursor_chat_history
npm install
npm run build

# 直接运行
node dist/cli/index.js list

# 或全局链接
npm link
cursor-history list
```

## 系统要求

- Node.js 20.x 或 22.x–26.x（不支持 Node 21；推荐 Node.js 22.5+ 以获得内置 SQLite 支持）
- Cursor IDE 或 Agent CLI 已有受支持格式的本地历史

## SQLite 驱动配置

cursor-history 支持两种 SQLite 驱动，以获得最大兼容性：

| 驱动 | 描述 | Node.js 能力边界 |
|------|------|------------------|
| `node:sqlite` | 内置模块；仅在具备当前操作所需全部 API 时选择 | 22.5 起可读取；22.16.0 和 23.8.0 起支持在线备份 |
| `better-sqlite3` | 原生绑定；具备能力时作为自动回退 | 支持主版本 20 和 22–26 |

### 自动驱动选择

cursor-history 按操作检查实际能力，而不是只检查模块能否导入：

1. 当前操作所需 API 齐全时优先使用 **node:sqlite**；
2. 否则回退到已安装且具备能力的 **better-sqlite3**。

强制指定的驱动不会自动回退；缺少能力时会返回带修复建议的类型化错误。

### 手动驱动选择

您可以使用环境变量强制指定驱动：

```bash
# 强制使用 better-sqlite3
CURSOR_HISTORY_SQLITE_DRIVER=better-sqlite3 cursor-history list

# 强制使用 node:sqlite（必须具备当前操作所需的全部 API）
CURSOR_HISTORY_SQLITE_DRIVER=node:sqlite cursor-history list
```

### 调试驱动选择

查看正在使用哪个驱动：

```bash
DEBUG=cursor-history:* cursor-history list
```

### 库 API 驱动控制

在将 cursor-history 作为库使用时，您可以通过编程方式控制驱动：

```typescript
import { setDriver, getActiveDriver, listSessions } from 'cursor-history';

// 在任何操作之前强制指定驱动
setDriver('better-sqlite3');

// 检查当前活动的驱动
const driver = getActiveDriver();
console.log(`使用驱动: ${driver}`);

// 或通过 LibraryConfig 配置
const result = await listSessions({
  sqliteDriver: 'node:sqlite'  // 为此调用强制使用 node:sqlite
});
```

## 使用方法

### 列出会话

```bash
# 列出最近的会话（默认：20 个）
cursor-history list

# 列出所有会话
cursor-history list --all

# 列出带有 composer ID 的会话（用于外部工具）
cursor-history list --ids

# 限制结果数量
cursor-history list -n 10

# 仅列出工作区
cursor-history list --workspaces
```

### 查看会话

```bash
# 按索引号显示会话
cursor-history show 1

# 显示截断的消息（快速概览）
cursor-history show 1 --short

# 显示完整的 AI 思考/推理文本
cursor-history show 1 --think

# 显示完整的工具调用详情（命令、内容和结果）
cursor-history show 1 --tool

# 显示完整的错误消息（不截断为 300 字符）
cursor-history show 1 --error

# 按消息类型过滤（user, assistant, tool, thinking, error）
cursor-history show 1 --only user
cursor-history show 1 --only user,assistant
cursor-history show 1 --only tool,error

# 组合选项
cursor-history show 1 --short --think --tool --error
cursor-history show 1 --only user,assistant --short

# 输出为 JSON
cursor-history show 1 --json
```

### 搜索

```bash
# 搜索关键词
cursor-history search "react hooks"

# 限制结果数量
cursor-history search "api" -n 5

# 调整匹配周围的上下文
cursor-history search "error" --context 100
```

### 导出

```bash
# 导出单个会话为 Markdown
cursor-history export 1

# 导出到指定文件
cursor-history export 1 -o ./my-chat.md

# 导出为 JSON
cursor-history export 1 --format json

# 导出所有会话到目录
cursor-history export --all -o ./exports/

# 覆盖现有文件
cursor-history export 1 --force
```

### 迁移会话

迁移支持符合条件的 Composer 会话。Store-only、合并来源或存在歧义的会话会被拒绝；使用 `--dry-run` 预览迁移。

```bash
# 将单个会话移动到另一个工作区
cursor-history migrate-session 1 /path/to/new/project

# 移动多个会话（逗号分隔的索引或 ID）
cursor-history migrate-session 1,3,5 /path/to/project

# 复制而非移动（保留原件）
cursor-history migrate-session --copy 1 /path/to/project

# 预览将发生的操作而不实际更改
cursor-history migrate-session --dry-run 1 /path/to/project

# 将一个工作区的所有会话移动到另一个
cursor-history migrate /old/project /new/project

# 复制所有会话（备份）
cursor-history migrate --copy /project /backup/project

# 强制与目标现有会话合并
cursor-history migrate --force /old/project /existing/project
```

### 备份与恢复

备份归档包含 Composer `state.vscdb` 数据，不包含 Store 数据库、Agent transcript 或 ACP 会话存储。需要便携副本时，可将这些来源中可读取的会话导出为 Markdown 或 JSON；导出文件不是可恢复的备份归档。

```bash
# 创建 Composer 聊天历史的备份
cursor-history backup

# 创建备份到指定文件
cursor-history backup -o ~/my-backup.zip

# 覆盖现有备份
cursor-history backup --force

# 列出可用备份
cursor-history list-backups

# 列出指定目录中的备份
cursor-history list-backups -d /path/to/backups

# 从备份恢复
cursor-history restore ~/cursor-history-backups/backup.zip

# 恢复到自定义位置
cursor-history restore backup.zip --target /custom/cursor/data

# 强制覆盖现有数据
cursor-history restore backup.zip --force

# 查看备份中的会话而不恢复
cursor-history list --backup ~/backup.zip
cursor-history show 1 --backup ~/backup.zip
cursor-history search "query" --backup ~/backup.zip
cursor-history export 1 --backup ~/backup.zip
```

### 全局选项

```bash
# 输出为 JSON（适用于所有命令）
cursor-history --json list

# 使用自定义 Cursor 数据路径
cursor-history --data-path ~/.cursor-alt list

# 按工作区过滤
cursor-history --workspace /path/to/project list
```

## 可查看的内容

浏览聊天历史时，您将看到：

- **完整对话** - 与 Cursor AI 交换的所有消息
- **逐条渲染消息** - 每条解析出的消息按顺序单独显示一次，连续重复不再折叠，因此不同的工具调用、来源与 token 数据不会被隐藏
- **时间戳** - 消息有直接存储时间时显示（HH:MM:SS 格式）；没有直接时间的消息不显示时间，而不是用兜底时间填充
- **跨栈解析会话** - 当同一 UUID 同时存在于 Composer 与 Store 时，cursor-history 保留兼容的 Composer 身份并输出带明确来源的解析视图。读取内容前先应用工作区范围：已知但越界的来源不会被打开，并会使结果明确标为 partial；允许范围内的来源遵循规范的骨干与增强规则，而不是盲目逐字段合并。
- **AI 工具操作** - 详细查看 Cursor AI 执行的操作：
  - **文件编辑/写入** - 带语法高亮的完整 diff 显示，准确展示更改内容
  - **文件读取** - 文件路径和内容预览（使用 `--tool` 查看完整内容）
  - **搜索操作** - 使用的模式、路径和搜索查询
  - **终端命令** - 完整的命令文本
  - **目录列表** - 探索的路径
  - **工具错误** - 失败/取消的操作显示 ❌ 状态指示器和参数
  - **用户决策** - 显示您是否接受 (✓)、拒绝 (✗) 或待定 (⏳) 工具操作
  - **错误** - 带有 ❌ 表情符号高亮的错误消息（从 `toolFormerData.additionalData.status` 提取）
- **AI 推理** - 查看 AI 决策背后的思考过程（使用 `--think` 查看完整文本）
- **代码制品** - Mermaid 图表、代码块，带语法高亮
- **自然语言解释** - AI 解释与代码相结合，提供完整上下文

### 显示选项

- **默认视图** - 完整消息，截断的思考（200 字符）、文件读取（100 字符）和错误（300 字符）
- **`--short` 模式** - 将用户和助手消息截断为 300 字符，便于快速浏览
- **`--think` 标志** - 显示完整的 AI 推理/思考文本（不截断）
- **`--tool` 标志** - 显示完整的工具调用详情，包括命令、内容和结果
- **`--error` 标志** - 显示完整的错误消息而非 300 字符预览
- **`--only <types>` 标志** - 按类型过滤消息：`user`、`assistant`、`tool`、`thinking`、`error`（逗号分隔）

## Cursor 数据存储位置

| 平台 | Composer 存储 | Store 存储 |
|---|---|---|
| macOS | `~/Library/Application Support/Cursor/User/` | `~/.cursor/` |
| Windows | `%APPDATA%/Cursor/User/` | `%USERPROFILE%\.cursor\` |
| Linux / WSL | `~/.config/Cursor/User/` | `~/.cursor/` |

工具会自动发现并读取两类存储。每个会话的 `store.db` 是主要 Store 消息来源。在驱动具备所需能力且快照读取环境正常的前提下，数据库缺失、没有可用消息或存在源数据损坏/读取故障时，可以回退到 transcript。驱动能力和快照基础设施故障会直接报错，不会转为 transcript 回退。可用数据库始终是 Store 对话的主来源；共存的 transcript 仅保留为被取代的来源记录。

使用 `--data-path <path>` 或 `CURSOR_DATA_PATH` 指定自定义 Cursor 数据目录。通过 `CURSOR_STORE_ROOT` 独立配置 Store 根目录，也可以传入其 `chats`、`projects` 或 `acp-sessions` 子目录，工具会归一化到同一根目录。

WSL 中的 Windows 侧 Store 数据通常挂载在 `/mnt/c/Users/<windows-user>/.cursor`。例如：`CURSOR_STORE_ROOT=/mnt/c/Users/<windows-user>/.cursor cursor-history list --all`。如果会话由 WSL 内运行的 Cursor agent 创建，则使用 WSL 侧的 `~/.cursor`。

在 WSL 中对 Windows 挂载项目运行 CLI 时，不要复用 Windows 安装的原生 `node_modules`。原生依赖与平台相关；请使用 Linux Node.js 在独立的 WSL 依赖目录中安装后再运行 Linux 侧测试或构建。`cursor-history` 不会自动安装或删除依赖。

## 库 API

除了 CLI，您还可以在 Node.js 项目中将 cursor-history 作为库使用：

```typescript
import {
  listSessions,
  getSession,
  searchSessions,
  exportSessionToMarkdown
} from 'cursor-history';

// 列出所有会话并分页
const result = await listSessions({ limit: 10 });
console.log(`找到 ${result.pagination.total} 个会话`);

for (const session of result.data) {
  console.log(`${session.id}: ${session.messageCount} 条消息`);
}

// 获取特定会话（从零开始的索引）
const session = await getSession(0);
console.log(session.messages);

// 在所有会话中搜索
const results = await searchSessions('authentication', { context: 2 });
for (const match of results) {
  // 完整消息数组索引、完整内容中的 UTF-16 偏移量以及完整源代码行。
  console.log(match.messageIndex, match.offset, match.match);
}

// 导出为 Markdown
const markdown = await exportSessionToMarkdown(0);
```

### 迁移 API

```typescript
import { migrateSession, migrateWorkspace } from 'cursor-history';

// 将会话移动到另一个工作区
const moveResults = await migrateSession({
  sessions: 3,  // 索引或 ID
  destination: '/path/to/new/project'
});
console.log(moveResults);

// 复制多个会话（保留原件）
const copyResults = await migrateSession({
  sessions: [1, 3, 5],
  destination: '/path/to/project',
  mode: 'copy'
});
console.log(copyResults);

// 在工作区之间迁移所有会话
const workspaceResult = await migrateWorkspace({
  source: '/old/project',
  destination: '/new/project'
});
console.log(`迁移了 ${workspaceResult.successCount} 个会话`);
```

### 备份 API

```typescript
import {
  createBackup,
  restoreBackup,
  validateBackup,
  listBackups,
  getDefaultBackupDir,
  listSessions
} from 'cursor-history';

// 创建备份
const result = await createBackup({
  outputPath: '~/my-backup.zip',
  force: true,
  onProgress: (progress) => {
    console.log(`${progress.phase}: ${progress.filesCompleted}/${progress.totalFiles}`);
  }
});
console.log(`备份已创建: ${result.backupPath}`);
console.log(`会话数: ${result.manifest.stats.sessionCount}`);

// 验证备份
const validation = await validateBackup('~/backup.zip');
if (validation.status === 'valid') {
  console.log('备份有效');
} else if (validation.status === 'warnings') {
  console.log('备份有警告:', validation.corruptedFiles);
}

// 从备份恢复
const restoreResult = await restoreBackup({
  backupPath: '~/backup.zip',
  force: true
});
console.log(`恢复了 ${restoreResult.filesRestored} 个文件`);
// 检查 restoreResult.warnings：损坏的条目会被跳过，绝不会恢复。

// 列出可用备份
const backups = await listBackups();  // 扫描 ~/cursor-history-backups/
for (const backup of backups) {
  console.log(`${backup.filename}: ${backup.manifest?.stats.sessionCount} 个会话`);
}

// 从备份读取会话而不恢复
const sessions = await listSessions({ backupPath: '~/backup.zip' });
```

### 可用函数

| 函数 | 描述 |
|------|------|
| `listSessions(config?)` | 列出会话并分页 |
| `getSession(index, config?)` | 按索引获取完整会话 |
| `searchSessions(query, config?)` | 在会话中搜索 |
| `exportSessionToJson(index, config?)` | 将会话导出为 JSON |
| `exportSessionToMarkdown(index, config?)` | 将会话导出为 Markdown |
| `exportAllSessionsToJson(config?)` | 将所有会话导出为 JSON |
| `exportAllSessionsToMarkdown(config?)` | 将所有会话导出为 Markdown |
| `migrateSession(config)` | 将会话移动/复制到另一个工作区 |
| `migrateWorkspace(config)` | 在工作区之间移动/复制所有会话 |
| `createBackup(config?)` | 备份 Composer 聊天历史 |
| `restoreBackup(config)` | 从备份恢复聊天历史 |
| `validateBackup(path)` | 验证备份完整性 |
| `listBackups(directory?)` | 列出可用的备份文件 |
| `getDefaultBackupDir()` | 获取默认备份目录路径 |
| `getDefaultDataPath()` | 获取特定平台的 Cursor 数据路径 |
| `setDriver(name)` | 设置 SQLite 驱动 ('better-sqlite3' 或 'node:sqlite') |
| `getActiveDriver()` | 获取当前活动的 SQLite 驱动名称 |

### 配置选项

```typescript
import type { MessageType } from 'cursor-history';

interface LibraryConfig {
  dataPath?: string;       // 自定义 Cursor 数据路径
  workspace?: string;      // 按工作区路径过滤
  limit?: number;          // 分页限制
  offset?: number;         // 分页偏移
  context?: number;        // 搜索上下文行数
  backupPath?: string;     // 从备份文件读取而非实时数据
  sqliteDriver?: 'better-sqlite3' | 'node:sqlite';  // 强制指定 SQLite 驱动
  messageFilter?: MessageType[];  // 按类型过滤消息 (user, assistant, tool, thinking, error)
}
```

### 错误处理

```typescript
import {
  listSessions,
  createBackup,
  restoreBackup,
  isDatabaseLockedError,
  isDatabaseNotFoundError,
  isSessionNotFoundError,
  isWorkspaceNotFoundError,
  isBackupError,
  isBackupPublishedPermissionError,
  isRestoreRollbackError,
  isRestoreError,
  isInvalidBackupError,
  validateMessageTypes
} from 'cursor-history';

try {
  const result = await listSessions();
} catch (err) {
  if (isDatabaseLockedError(err)) {
    console.error('数据库已锁定 - 关闭 Cursor 后重试');
  } else if (isDatabaseNotFoundError(err)) {
    console.error('未找到 Cursor 数据');
  } else if (isSessionNotFoundError(err)) {
    console.error('未找到会话');
  } else if (isWorkspaceNotFoundError(err)) {
    console.error('未找到工作区 - 请先在 Cursor 中打开项目');
  }
}

try {
  await createBackup({ outputPath: '/private/backups/cursor.zip' });
} catch (err) {
  if (isBackupPublishedPermissionError(err)) {
    if (err.details.pathIdentityVerified) {
      console.error('已验证发布备份需要修正文件模式:', err.details.outputPath);
    } else {
      // 已越过提交点，但此路径不可信。不要在这里更改其文件模式。
      console.error('发布备份路径需要身份恢复:', err.details.outputPath);
    }
  }
}

// 将无类型过滤值传给读取操作前先进行验证
const invalidTypes = validateMessageTypes(['invalid']);
if (invalidTypes.length > 0) {
  console.error('无效的过滤类型:', invalidTypes);
}

// 备份特定错误
try {
  await createBackup();
} catch (err) {
  if (isBackupError(err)) {
    console.error('备份失败:', err.message);
  } else if (isInvalidBackupError(err)) {
    console.error('无效的备份文件');
  } else if (isRestoreError(err)) {
    console.error('恢复失败:', err.message);
  }
}

try {
  await restoreBackup({ backupPath: '/private/backups/cursor.zip', force: true });
} catch (err) {
  if (isRestoreRollbackError(err)) {
    // 这些是清单相对路径，绝不是私有物理定位符。
    console.error('以下项目需要手动恢复:', err.details.residualFiles);
  }
}
```

## 兼容性与安全升级

> **兼容性契约：**英文版
> [Compatibility and Data-Integrity Contract](./compatibility.md) 是规范来源，定义稳定 ID、
> 索引基数与作用域、工作区 I/O 边界、完整性/来源、推断时间、读取上限、备份权限，以及经过
> 验证的 CLI/库示例。如其他说明与其不一致，以该契约为准。
>
> 增量存储库输出的使用方应固定在 v0.16，直到能够验证 v0.18.0 后再从 v0.17 升级。无需修改
> 消费方的升级保证仅覆盖 v0.16 Composer-only 档案；它不承诺保留 v0.17 不稳定的 Store
> 合成 ID。
>
> v0.18.0 直接修正 v0.16/v0.17 的公共搜索坐标，并以新增元数据形式在 JSON 导出中加入
> 从零开始的索引。规范兼容性文档还定义了备份发布提交点，以及备份已发布后权限失败的
> 权限或清理失败的类型化错误语义；不得盲目删除身份未经验证的残留路径。恢复时会跳过损坏条目，
> 并在写入前拒绝非法路径、重复目标或不安全链接；`--force` 不会绕过这些完整性与路径限制检查。
> 任一文件发布后的失败都不会尝试自动回滚，而会保留所有当前目标并返回
> `RESTORE_ROLLBACK_INCOMPLETE`；请停止 Cursor 并从可信备份恢复。

### v0.18 兼容性说明

- 所有 Session ID（包括标准 UUID）均保留 v0.16 的逐字节、区分大小写语义；查询、逻辑分组和
  跨源关联都必须复用 Cursor 返回的精确拼写。仅大小写不同的值属于不同 ID。
- 使用 `--workspace` 的迁移只允许读取作用域外的必要元数据，绑定精确物理键，并在首次写入前
  准备完整批次。任一目标歧义、变化或不符合条件时，整个批次保持零修改。
- Composer/Store 合并后，活动分支开头、中间和结尾的 Store-only 消息各出现一次；Store
  侧分支不会混入，既有 Composer ID 不变。
- `createdAt` 相同的 Composer 记录在同一受支持运行时/区域环境下继续使用 v0.16 的
  `String.localeCompare()` 发现顺序。
- 备份外层版本保持 `manifest.version: "1.0.0"`，可选库存成员独立使用
  `schemaVersion: 1`。完整规范请参阅 [compatibility.md](compatibility.md)。

## 路线图

将备份恢复和迁移能力扩展到已经支持读取的新来源。以下是计划方向，暂未承诺发布版本或日期。

- [ ] **Store / ACP 备份与恢复**：将 Store 数据库、Agent transcript 和关联元数据纳入可恢复的归档，保留来源关系，并验证备份与恢复往返的一致性。
- [ ] **Store-only 会话迁移**：在工作区之间移动或复制 Store-only 会话，更新工作区绑定和路径引用，并验证 Cursor 能否发现迁移后的会话。
- [ ] **合并来源会话迁移**：移动或复制同时存在于 Composer 和 Store 中的会话，保留原生标识，并保持各来源一致。

在这些功能实现之前，[备份与恢复](#备份与恢复)仅覆盖 Composer 数据，[迁移](#迁移会话)仅支持符合条件的 Composer 会话。可读取的 Store / ACP 会话仍可导出为 Markdown 或 JSON，但导出文件不是可恢复的备份归档。

欢迎通过 [GitHub Issues](https://github.com/S2thend/cursor-history/issues) 提供使用场景和可复现的存储示例，帮助确定优先级。

## 开发

### 从源码构建

```bash
npm install
npm run build
```

### 运行测试

```bash
npm test              # 运行所有测试
npm run test:watch    # 监视模式
```

### 发布到 npm

本项目通过 GitHub Actions 使用 npm trusted publishing，不使用 `NPM_TOKEN` 仓库 secret。
首次发布前：

1. 在 npm 中把此包的 trusted publisher 精确绑定到本 GitHub 仓库；workflow filename
   填写 `npm-publish.yml`（文件位于 `.github/workflows/npm-publish.yml`），environment
   填写 `npm-release-verification`，并允许 `npm publish` action。
2. 在 GitHub 创建 `npm-release-verification` environment，设置指定维护者为 required
   reviewers，并按仓库保护策略禁止未经审核的绕过。

每次发布时：

1. 更新并验证所有带版本的包元数据和 release notes，完成文档规定的门禁，然后冻结一个
   干净 revision。
2. 确认版本 tag 尚不存在，并且只推送该 tag（例如 `git push origin v0.18.0`）。revision
   冻结前不要推送或移动 release tag。
3. 工作流会验证源码和全部受支持运行时，仅打包一次，并把候选包绑定到 revision 和
   SHA-256。上述门禁通过后，真正的 `publish` job 会在受保护的
   `npm-release-verification` environment 处暂停，批准前不能请求 OIDC token。
4. 下载这个由校验和寻址的候选包，按 [release-verification.md](release-verification.md)
   完成针对同一制品的私有验证；只有全部通过后才批准 environment。
5. 批准后以 npm provenance 发布原样保留的同一组字节，不重新构建或打包。

源码、运行时、制品或私有验证中的任何失败都会阻止发布。绝不能悄悄强制移动 release
tag；尚未发布的失败候选必须显式处置，只要已有字节发布就必须使用新版本。

## 贡献

我们欢迎社区贡献！以下是您可以参与的方式：

### 报告问题

- **Bug 报告**：[创建 issue](https://github.com/S2thend/cursor_chat_history/issues/new)，包含重现步骤、预期与实际行为，以及您的环境（操作系统、Node.js 版本）
- **功能请求**：[创建 issue](https://github.com/S2thend/cursor_chat_history/issues/new)，描述功能及其使用场景

### 提交 Pull Request

1. Fork 仓库
2. 创建功能分支 (`git checkout -b feature/my-feature`)
3. 进行更改
4. 运行测试和代码检查 (`npm test && npm run lint`)
5. 提交更改 (`git commit -m 'Add my feature'`)
6. 推送到您的 fork (`git push origin feature/my-feature`)
7. [创建 Pull Request](https://github.com/S2thend/cursor_chat_history/pulls)

### 开发环境设置

```bash
git clone https://github.com/S2thend/cursor_chat_history.git
cd cursor_chat_history
npm install
npm run build
npm test
```

## 许可证

MIT
