# Feishu-Didi Onboarding Hub

新员工入职自动化系统 —— 自动为待入职员工开通飞书工作邮箱和企业滴滴账号。

**主要交互方式：飞书机器人卡片**（一键开通，无需打开网页）
辅助方式：Web Dashboard、MCP Server（Cursor AI 集成）

## Quick Start

```bash
# 安装依赖
npm install

# 配置环境变量
cp .env.example .env
# 编辑 .env 填写飞书凭证和机器人 Chat ID

# 启动服务（Web + 机器人自动启动）
npm start

# 或单独启动 MCP Server（供 Cursor 调用）
npm run mcp
```

## Configuration

```env
# 飞书应用凭证（必填）
FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# 滴滴企业凭证（开通滴滴功能时填写）
DIDI_CLIENT_ID=
DIDI_CLIENT_SECRET=
DIDI_ACCESS_TOKEN=

# 服务配置
PORT=3000
BASE_URL=http://localhost:3000

# 飞书机器人（推荐配置，核心功能）
FEISHU_BOT_CHAT_ID=oc_xxxxxxxx    # IT 群 Chat ID
BOT_CHECK_INTERVAL=1800000         # 检查间隔（默认 30 分钟）
```

## 飞书机器人功能（核心）

### 自动通知
- **定时检查**：每 30 分钟自动检查新的待入职人员
- **智能去重**：只通知新增人员，不重复推送
- **每日汇总**：每天早上 9:00 自动发送汇总卡片
- **入职倒计时**：按紧急程度标记（🔴今天 🟠明天 🟡本周 🟢稍后）
- **僵尸过滤**：自动过滤 90 天前的过期数据

### 卡片交互
- **一键开通**：每人旁边有独立的"开通"按钮，点击直接开通邮箱
- **批量开通**：底部"一键全部开通"按钮，带二次确认
- **刷新列表**：点击"刷新"按钮获取最新数据
- **结果通知**：开通后自动发送结果卡片（成功/失败详情）

### 操作审计
- 所有开通操作都记录审计日志（操作人、时间、结果）
- 通过 `GET /api/bot/audit` 查看

## 飞书机器人配置步骤

1. 在 [飞书开放平台](https://open.feishu.cn) 创建应用，启用"机器人"能力
2. 申请权限：`im:chat:readonly`、`im:message:send_as_bot`、`corehr:pre_hire:read` 等
3. 发布应用版本
4. 把应用机器人拉入 IT 群
5. 启动服务后调用 `GET /api/bot/chats` 获取群 Chat ID
6. 填入 `.env` 的 `FEISHU_BOT_CHAT_ID`
7. 重启服务，机器人自动开始工作
8. （可选）在飞书开放平台配置卡片回调地址：`{BASE_URL}/api/bot/callback`

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/hires` | GET | 获取待入职人员列表（本地拼音生成邮箱，速度快） |
| `/api/provision/email` | POST | 开通单人邮箱（自动去重+重试） |
| `/api/provision/email/batch` | POST | 批量开通邮箱 |
| `/api/provision/didi` | POST | 开通单人滴滴 |
| `/api/provision/didi/batch` | POST | 批量开通滴滴 |
| `/api/didi/rules` | GET | 获取滴滴用车规则 |
| `/api/bot/check` | POST | 手动触发机器人检查 |
| `/api/bot/summary` | POST | 手动触发每日汇总 |
| `/api/bot/chats` | GET | 获取机器人所在群聊列表 |
| `/api/bot/config` | POST | 动态配置 Chat ID |
| `/api/bot/callback` | POST | 飞书卡片回调 |
| `/api/bot/audit` | GET | 操作审计日志 |
| `/api/logs/stream` | GET | SSE 实时日志 |
| `/api/health` | GET | 健康检查 |

## MCP Server（Cursor 集成）

在 Cursor 中使用 AI 操作入职系统。配置文件已生成在 `.cursor/mcp.json`。

### 可用工具

| 工具 | 说明 |
|------|------|
| `list_hires` | 列出待入职人员，支持按城市/日期/状态过滤 |
| `provision_email` | 为单人开通邮箱（自动去重） |
| `provision_email_batch` | 批量开通邮箱 |
| `provision_didi` | 为单人开通滴滴 |
| `get_didi_rules` | 获取滴滴规则列表 |
| `send_bot_notification` | 触发机器人通知（check/summary） |
| `get_audit_log` | 查看操作审计日志 |

### 使用示例

在 Cursor 中对 AI 说：
- "查看有哪些人需要开通邮箱"
- "帮我给张三开通工作邮箱"
- "批量开通所有待入职人员的邮箱"
- "发一个机器人通知到群里"

## Architecture

```
src/
├── services/         # 业务逻辑
│   ├── feishu.js     # 飞书 API（CoreHR V2 + IM，带自动重试）
│   ├── didi.js       # 滴滴企业 API（带签名）
│   ├── email.js      # 邮箱生成（本地拼音 + API 去重重试）
│   ├── matcher.js    # 城市→滴滴规则匹配
│   ├── bot.js        # 飞书机器人（定时检查+卡片交互+审计日志）
│   └── logger.js     # 日志服务（SSE 推送）
├── api/
│   └── routes.js     # Express REST API
├── mcp/
│   ├── server.js     # MCP Server（Cursor 集成）
│   └── tools.js      # MCP 工具定义（7 个工具）
└── index.js          # 主入口

public/
└── index.html        # Web Dashboard（辅助）
```

## 核心特性

- **飞书机器人优先**：卡片交互 > 网页操作，IT 在群里点按钮即可完成
- **智能邮箱生成**：中文名→拼音，重名自动加数字后缀（跳过 2 和 4）
- **两阶段去重**：先查在职通讯录，再尝试写入处理离职回收站占用
- **同批去重**：同批次两个"张伟"自动分配不同邮箱
- **并发优化**：飞书 API 分批并发查询（3 路并发 + 限流保护）
- **自动重试**：API 请求失败自动重试（指数退避，最多 3 次）
- **优雅降级**：单人失败不影响批量操作，逐行反馈结果
