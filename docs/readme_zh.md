# Cursor History

<p align="center">
  <img src="logo.png" alt="cursor-history logo" width="200">
</p>

[![npm version](https://img.shields.io/npm/v/cursor-history.svg)](https://www.npmjs.com/package/cursor-history)
[![npm downloads](https://img.shields.io/npm/dm/cursor-history.svg)](https://www.npmjs.com/package/cursor-history)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0%2B-blue.svg)](https://www.typescriptlang.org/)

**终极开源工具，用于浏览、搜索、导出和备份您的 Cursor AI 聊天历史。**

遵循 Unix 哲学的 POSIX 风格 CLI 工具：专注于一件事并做到极致——访问您的 Cursor AI 聊天历史。简单、可组合、专注。

```bash
# 管道友好：可与其他工具组合使用
cursor-history list --json | jq '.[] | select(.messageCount > 10)'
cursor-history export 1 | grep -i "api" | head -20
cursor-history search "bug" --json | jq -r '.[].sessionId' | xargs -I {} cursor-history export {}
```

再也不会丢失任何对话。无论您需要查找上周的完美代码片段、将历史记录迁移到新机器，还是为所有 AI 辅助开发会话创建可靠备份——cursor-history 都能满足您的需求。免费、开源，由社区为社区打造。

## 功能特性

- **双接口** - 可作为 CLI 工具使用，也可作为库导入到 Node.js 项目中
- **会话列表** - 查看所有工作区的聊天会话
- **完整对话** - 查看包含以下内容的完整聊天历史：
  - AI 回复和自然语言解释
  - **文件编辑的完整 diff 显示**，带语法高亮
  - **详细的工具调用**，显示所有参数（文件路径、搜索模式、命令等）
  - AI 推理和思考过程
  - 消息时间戳（所有会话均准确，包括 2025 年 9 月之前的会话）
- **搜索** - 按关键词查找对话，带高亮匹配
- **导出** - 将会话保存为 Markdown 或 JSON 文件
- **迁移** - 在工作区之间移动或复制会话（例如重命名项目时）
- **备份与恢复** - 创建所有聊天历史的完整备份，并在需要时恢复
- **跨平台** - 支持 macOS、Windows 和 Linux

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

- Node.js 20+（推荐 Node.js 22.5+ 以获得内置 SQLite 支持）
- Cursor IDE（已有聊天历史）

## SQLite 驱动配置

cursor-history 支持两种 SQLite 驱动，以获得最大兼容性：

| 驱动 | 描述 | Node.js 版本 |
|------|------|--------------|
| `node:sqlite` | Node.js 内置 SQLite 模块（无需原生绑定） | 22.5+ |
| `better-sqlite3` | 通过 better-sqlite3 的原生绑定 | 20+ |

### 自动驱动选择

默认情况下，cursor-history 会自动选择最佳可用驱动：

1. **node:sqlite**（首选）- 适用于 Node.js 22.5+，无需原生编译
2. **better-sqlite3**（备选）- 适用于较旧的 Node.js 版本

### 手动驱动选择

您可以使用环境变量强制指定驱动：

```bash
# 强制使用 better-sqlite3
CURSOR_HISTORY_SQLITE_DRIVER=better-sqlite3 cursor-history list

# 强制使用 node:sqlite（需要 Node.js 22.5+）
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

# 显示完整的文件读取内容（不截断）
cursor-history show 1 --fullread

# 显示完整的错误消息（不截断为 300 字符）
cursor-history show 1 --error

# 按消息类型过滤（user, assistant, tool, thinking, error）
cursor-history show 1 --only user
cursor-history show 1 --only user,assistant
cursor-history show 1 --only tool,error

# 组合选项
cursor-history show 1 --short --think --fullread --error
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

```bash
# 创建所有聊天历史的备份
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
- **跨栈合并会话** - 当同一会话同时存在于 Composer（vscdb）与 Store（~/.cursor）两个栈时，两侧表示会按字段合并（任一侧都不丢弃），骨干来源按平台选择（WSL 偏好 Store；Windows/macOS/原生 Linux 偏好 Composer）
- **AI 工具操作** - 详细查看 Cursor AI 执行的操作：
  - **文件编辑/写入** - 带语法高亮的完整 diff 显示，准确展示更改内容
  - **文件读取** - 文件路径和内容预览（使用 `--fullread` 查看完整内容）
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
- **`--fullread` 标志** - 显示完整的文件读取内容而非预览
- **`--error` 标志** - 显示完整的错误消息而非 300 字符预览
- **`--only <types>` 标志** - 按类型过滤消息：`user`、`assistant`、`tool`、`thinking`、`error`（逗号分隔）

## Cursor 数据存储位置

| 平台 | 路径 |
|------|------|
| macOS | `~/Library/Application Support/Cursor/User/` |
| Windows | `%APPDATA%/Cursor/User/` |
| Linux | `~/.config/Cursor/User/` |

该工具会自动从这些位置查找并读取您的 Cursor 聊天历史。

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
const result = listSessions({ limit: 10 });
console.log(`找到 ${result.pagination.total} 个会话`);

for (const session of result.data) {
  console.log(`${session.id}: ${session.messageCount} 条消息`);
}

// 获取特定会话（从零开始的索引）
const session = getSession(0);
console.log(session.messages);

// 在所有会话中搜索
const results = searchSessions('authentication', { context: 2 });
for (const match of results) {
  console.log(match.match);
}

// 导出为 Markdown
const markdown = exportSessionToMarkdown(0);
```

### 迁移 API

```typescript
import { migrateSession, migrateWorkspace } from 'cursor-history';

// 将会话移动到另一个工作区
const results = migrateSession({
  sessions: 3,  // 索引或 ID
  destination: '/path/to/new/project'
});

// 复制多个会话（保留原件）
const results = migrateSession({
  sessions: [1, 3, 5],
  destination: '/path/to/project',
  mode: 'copy'
});

// 在工作区之间迁移所有会话
const result = migrateWorkspace({
  source: '/old/project',
  destination: '/new/project'
});
console.log(`迁移了 ${result.successCount} 个会话`);
```

### 备份 API

```typescript
import {
  createBackup,
  restoreBackup,
  validateBackup,
  listBackups,
  getDefaultBackupDir
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
const validation = validateBackup('~/backup.zip');
if (validation.status === 'valid') {
  console.log('备份有效');
} else if (validation.status === 'warnings') {
  console.log('备份有警告:', validation.corruptedFiles);
}

// 从备份恢复
const restoreResult = restoreBackup({
  backupPath: '~/backup.zip',
  force: true
});
console.log(`恢复了 ${restoreResult.filesRestored} 个文件`);

// 列出可用备份
const backups = listBackups();  // 扫描 ~/cursor-history-backups/
for (const backup of backups) {
  console.log(`${backup.filename}: ${backup.manifest?.stats.sessionCount} 个会话`);
}

// 从备份读取会话而不恢复
const sessions = listSessions({ backupPath: '~/backup.zip' });
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
| `createBackup(config?)` | 创建所有聊天历史的完整备份 |
| `restoreBackup(config)` | 从备份恢复聊天历史 |
| `validateBackup(path)` | 验证备份完整性 |
| `listBackups(directory?)` | 列出可用的备份文件 |
| `getDefaultBackupDir()` | 获取默认备份目录路径 |
| `getDefaultDataPath()` | 获取特定平台的 Cursor 数据路径 |
| `setDriver(name)` | 设置 SQLite 驱动 ('better-sqlite3' 或 'node:sqlite') |
| `getActiveDriver()` | 获取当前活动的 SQLite 驱动名称 |

### 配置选项

```typescript
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
  getSession,
  createBackup,
  isDatabaseLockedError,
  isDatabaseNotFoundError,
  isSessionNotFoundError,
  isWorkspaceNotFoundError,
  isInvalidFilterError,
  isBackupError,
  isRestoreError,
  isInvalidBackupError
} from 'cursor-history';

try {
  const result = listSessions();
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

// 过滤错误处理
try {
  const session = getSession(0, { messageFilter: ['invalid'] });
} catch (err) {
  if (isInvalidFilterError(err)) {
    console.error('无效的过滤类型:', err.invalidTypes);
    console.error('有效类型:', err.validTypes);
  }
}

// 备份特定错误
try {
  const result = await createBackup();
} catch (err) {
  if (isBackupError(err)) {
    console.error('备份失败:', err.message);
  } else if (isInvalidBackupError(err)) {
    console.error('无效的备份文件');
  } else if (isRestoreError(err)) {
    console.error('恢复失败:', err.message);
  }
}
```

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

### 发布到 NPM

本项目使用 GitHub Actions 进行自动 NPM 发布。要发布新版本：

1. 更新 `package.json` 中的版本：
   ```bash
   npm version patch  # 用于 bug 修复 (0.1.0 -> 0.1.1)
   npm version minor  # 用于新功能 (0.1.0 -> 0.2.0)
   npm version major  # 用于破坏性更改 (0.1.0 -> 1.0.0)
   ```

2. 推送版本标签以触发自动发布：
   ```bash
   git push origin main --tags
   ```

3. GitHub 工作流将自动：
   - 运行类型检查、代码检查和测试
   - 构建项目
   - 发布到 NPM 并带有来源证明

**首次设置**：将您的 NPM 访问令牌添加为名为 `NPM_TOKEN` 的 GitHub secret：
1. 在 https://www.npmjs.com/settings/YOUR_USERNAME/tokens 创建 NPM 访问令牌
2. 转到您的 GitHub 仓库设置 → Secrets and variables → Actions
3. 添加名为 `NPM_TOKEN` 的新仓库 secret，值为您的 NPM 令牌

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
