# 开源项目雷达

一个用于发现、理解和收藏开源项目的前端工具。当前版本以中文为默认语言，支持中英文切换、深浅色主题、项目评分抽屉、Agent 分析和浏览器本地保存。

## 当前版本

- 中文默认界面
- 中英文切换，语言偏好保存在浏览器
- 深色 AI 工作台主题
- 浅色 Apple-like 简约主题
- 保留渐变、网格背景、细边框和信息层级
- 本地演示项目卡片
- 项目筛选和排序
- Agent 分析面板
- 活跃度、文档质量、构建可行性、实用价值和作品集价值评分
- 收藏项目并保存到 `localStorage`
- 我的收藏升级为本地研究工作区
- 为收藏项目设置未研究、值得尝试、暂不采用和已完成状态
- 为收藏项目添加备注并按研究状态筛选
- 导出包含收藏、状态和备注的研究清单 JSON
- 当前主界面聚焦“发现项目”和“我的收藏”两个核心入口
- 访客无需登录即可浏览项目并在当前浏览器保存收藏
- 收藏项目可设置研究状态、添加备注并导出研究清单
- 项目对比和研究笔记暂不作为主界面功能，后续按实际使用需求再恢复
- 页面不展示临时演示模式入口，当前产品状态以公开仓库结果和访客本地保存为准
- 导出本地收藏数据 JSON
- 无需 API Key 即可打开和体验
- 搜索关键词时可查询 GitHub 公开仓库
- 支持部分词、多个词和轻微拼写差异的模糊匹配
- 同一关键词重复搜索或点击“换一批”时，会请求 GitHub 的下一页结果
- 网格视图和列表视图使用不同的信息布局，列表视图适合快速扫描
- 项目列表会清洗并限制 GitHub 简介长度，异常或超长内容不会撑开页面
- 完整 README 只在项目详情中按需查看，并作为 Agent 分析资料
- GitHub 不可访问时自动保留本地演示数据
- 实时仓库卡片显示 Fork、License 和更新时间
- 项目分析抽屉显示 Topics，并尝试加载原始 README 预览
- Agent 使用普通语言解释推荐原因和评分含义
- 支持围绕当前仓库、README 和分析结果持续追问
- 聊天区显示发送中、阅读资料、回答完成和失败状态
- 本地服务未连接时显示具体启动提示，不直接显示 `Failed to fetch`
- 聊天回答保留必要技术名词，并补充“通俗地说”解释
- 中文模式下每张项目卡片都显示一到两句中文用途说明
- 聊天回答被截断时自动用更短上下文重试

## 本地运行

### 零配置 Demo

当前版本仍可直接打开 `index.html`。搜索时会尝试访问本地代理；如果代理未启动，则回退到 GitHub 公共接口。

### 启动本地代理

Node.js 18+：

```bash
node server.js
```

然后在本机打开：`http://127.0.0.1:4173`

如果要用同一 Wi-Fi 下的手机访问：

1. 电脑和手机连接同一个 Wi-Fi；
2. 在电脑 PowerShell 执行 `ipconfig`，找到当前网络适配器的 IPv4 地址；
3. 手机打开 `http://电脑IPv4地址:4173`，例如 `http://192.168.1.20:4173`；
4. 如果 Windows 防火墙弹出提示，只允许专用网络访问；
5. 手机访问期间不要关闭运行 `node server.js` 的 PowerShell 窗口。

服务默认监听 `0.0.0.0`，因此可以接受局域网访问；如只希望本机访问，可在 `.env` 中设置 `HOST=127.0.0.1`。

本地代理提供：

- `GET /api/health`：服务健康检查
- `GET /api/github/search?q=...`：GitHub 仓库搜索
- `GET /api/github/readme?owner=...&repo=...`：README 原文读取
- 搜索缓存 5 分钟、README 缓存 30 分钟
- 基础单 IP 请求限制，避免前端直接重复消耗 GitHub 公共额度
- 不保存 API Key，也不引入登录凭证
- Agent 接口默认关闭；只有配置后端环境变量才会发送分析请求

### DeepSeek Agent 环境变量

服务端使用 DeepSeek 官方 OpenAI 兼容的 Chat Completions 接口。官方 Base URL 为 `https://api.deepseek.com`，默认模型配置为 `deepseek-flash`。项目分析请求会关闭 thinking、使用非流式 JSON 返回，并限制 README 上下文长度；如果首次输出被截断，会自动用更短上下文重试一次。参考：[DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/) 和 [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)。

```text
DEEPSEEK_API_KEY=your-new-secret-key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-flash
```

推荐在项目目录创建本地 `.env` 文件（该文件已被 `.gitignore` 忽略）：

```text
DEEPSEEK_API_KEY=your-new-secret-key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-flash
```

然后启动：

```powershell
node server.js
```

服务会自动读取项目目录下的 `.env`。也可以使用 PowerShell 临时环境变量覆盖 `.env`：

```powershell
$env:DEEPSEEK_API_KEY = 'your-new-secret-key'
$env:DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
$env:DEEPSEEK_MODEL = 'deepseek-flash'
node server.js
```

不要把真实密钥写进 `index.html`、`README.md` 或提交到公开仓库。密钥一旦出现在聊天、截图、日志或 Git 历史中，应立即撤销并重新生成。Agent 接口只接收仓库公开事实和截断后的 README 文本，并强制校验结构化 JSON 输出。未配置时，前端继续使用规则评分。

## 后续 AI 模式

当前搜索已经可以查询 GitHub 公开仓库。后续接入 AI API 时，项目数据建议保留双字段：

```json
{
  "name": "原始项目名称",
  "description_original": "GitHub 返回的英文原文",
  "description_zh": "Agent 生成的中文摘要",
  "readme_original": "原始 README 内容或摘要",
  "readme_zh": "中文分析摘要",
  "url": "GitHub 原始链接"
}
```

这样可以同时保留项目的原始事实和中文阅读体验：项目名称、作者、URL、技术栈和许可证不翻译；项目简介、README 摘要、功能分析和推荐理由由 Agent 根据规则生成中文摘要。

## Agent 行为规范

完整的 Agent Operating Specification 位于 [`AGENT_SPEC.md`](AGENT_SPEC.md)，包括：

- 事实来源和禁止臆造规则；
- 中英文输出规则；
- 直接使用、二次改造、借鉴 UI、暂不研究四种推荐决策；
- 活跃度、文档质量、构建可行性、实用价值和作品集价值评分标准；
- 证据、风险、下一步建议和置信度要求；
- 固定 JSON 输出结构和异常处理规则；
- 面向初学者的简单表达规则；
- 当前仓库范围内的持续追问聊天规则。

运行时会把当前界面语言传给 Agent，并在后端校验推荐决策、评分范围、证据字段和输出结构。分析抽屉下方的聊天框只围绕当前仓库、README 和分析结果回答。

## Agent 本地化规则

- 不改变 GitHub 项目原始名称、作者、URL、Star、Fork、更新时间和 License。
- 原始英文描述作为事实来源保留。
- 中文摘要只做解释和翻译，不得新增原文没有的功能。
- 无法确认的字段标记为“待验证”。
- 评分必须说明依据，不能把主观推荐伪装成 GitHub 事实。

## 下一阶段

1. 完善 GitHub 仓库数据标准化和分页搜索。
2. 增加原文与中文摘要双语字段。
3. 接入低成本 AI Agent API。
4. 增加限流、缓存和预算保护。
5. 再考虑 GitHub 登录和跨设备同步。
