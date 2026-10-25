# BOSS Greeting Skill

让支持本地工具的 AI 助手安装并启动求职招呼语助手。浏览器读取你当前打开的岗位详情，结合你自己的经历生成草稿，由你核对、复制和发送。

## 1.2 功能

- 四档语气：严肃专业、亲和活泼、热情夸张、灵动巧思。可在岗位浮窗快速切换，或在设置页保存默认值。表达规则区分客观陈述、自然口语、强烈热情和单句巧思；事实与能力不因语气夸大。
- 文件导入：PDF、PNG/JPG/JPEG/BMP、UTF-8 TXT/MD。图片与PDF在本机使用Windows文字识别，先预览并编辑，再确认加入个人资料；不会自动覆盖已保存资料。每个文件25MiB，PDF最多40页。
- 网页岗位适配：BOSS直聘、猎聘、智联招聘。只处理当前前台的详情正文，不读取职位列表、聊天或未展开的受限内容。

| 平台 | 支持的网页详情 |
| --- | --- |
| BOSS直聘 | `www.zhipin.com/job_detail/…`，以及搜索页已打开的详情浮层 |
| 猎聘 | `www.liepin.com/job/…shtml`、`www.liepin.com/a/…shtml` |
| 智联招聘 | `www.zhaopin.com/jobdetail/…htm`，及旧版 `jobs.zhaopin.com/…htm` |

平台改版可能影响选择器。页面要求登录或展开完整描述时，请正常操作后再检测；该适配针对网页版。

支持 Windows 10/11、Chrome/Edge、Node.js 22+。使用 `npx skills` 安装时，按其当前要求准备 Node.js 22.20+。本仓库包含完整程序，安装 skill 时会一并复制浏览器扩展、本地服务和安装脚本。[Skills CLI 官方安装说明](https://github.com/vercel-labs/skills/blob/main/docs/commands.md)

## 对 AI 说什么

把这段话交给支持本地文件和命令执行的 AI 助手：

> 帮我安装 https://github.com/nnnnompipo-glitch/job-greeting-builder- 上的 boss-greeting skill。先读 SKILL.md，检测本机环境，优先接入我明确允许复用的模型环境配置或已启动的本地模型。完成配置和启动，并告诉我还需要完成的浏览器扩展加载步骤。不要读取聊天软件登录凭证，不要替我向招聘者发送消息。

这段话是安装请求，不代表每个聊天软件都具备执行能力。普通聊天窗口如果没有本地工具，只能提供安装指导；客户端的聊天登录也不一定提供其他程序可用的模型接口。

## 安装

可让 AI 使用它所在客户端的 skill 安装机制。支持 Skills CLI 的环境也可运行：

```powershell
npx skills add https://github.com/nnnnompipo-glitch/job-greeting-builder- --skill boss-greeting
```

按提示选择实际使用的 AI 客户端。安装到全局可加 `-g`；例如已安装 Codex 的环境可以选择 `-a codex`。安装命令需要仓库内已有完整的 `skills/boss-greeting` 目录；仅有空仓库时还不能安装。

装好后，AI 应阅读安装目录中的 `SKILL.md`，按照其中的流程运行 `assets/app/scripts/install.mjs`，而不是只复制一段提示词。不同客户端的 skill 目录不同，应以安装工具返回的真实路径为准。安装器将程序部署到稳定的本机目录，默认是 `%LOCALAPPDATA%/BOSS-Greeting-Helper`；重新安装 skill 时保留其中的个人资料、模型设置与配对信息。

## 怎样接入模型

| 已具备的条件 | 可以怎样使用 |
| --- | --- |
| 已安装并登录可调用的 Codex 命令行 | 选择 Codex 生成通道 |
| 当前 AI 助手获得明确授权、可传给子进程的模型地址及 API Key 环境变量 | 检查后复用到助手的模型配置，不回显密钥 |
| 正在运行的 Ollama 或 LM Studio 服务 | 连接本机接口，并选择实际已安装/已加载的模型 |
| 豆包、DeepSeek 等模型服务的 API Key | 在“模型与个人资料设置”中填写对应接口、模型 ID 和密钥 |
| 只有普通聊天软件登录 | 需要该客户端另外提供的开放接口、本地执行能力或可调用命令；不提取其登录凭证 |

自动配置只使用明确传入的环境变量和本机模型服务。不会遍历电脑上的软件配置、浏览器 Cookie、聊天记录或登录令牌。找不到可调用的接口时，会说明缺少什么，保留手动配置入口。

豆包模型 API 通过火山方舟提供；DeepSeek API 也使用单独的 API Key。使用本地模型时，需要先准备对应模型文件并启动本地服务。助手不会在本地模型失败时自动切换到云端。[火山方舟接口](https://console.volcengine.com/ark/region%3Acn-beijing/docs/compatible-with-openai-sdk)、[DeepSeek API](https://api-docs.deepseek.com/)、[Ollama 兼容接口](https://docs.ollama.com/api/openai-compatibility)、[LM Studio 接口](https://lmstudio.ai/docs/developer/openai-compat/chat-completions)

## 首次使用还需完成什么

1. 按安装脚本输出的路径，在 `chrome://extensions` 或 `edge://extensions` 加载 `extension` 文件夹。普通用户安装的未上架扩展需要这一次浏览器操作。
2. 在扩展弹窗填入本机 `private/pairing.txt` 的配对码，打开“模型与个人资料设置”。
3. 填写自己的专业、求职城市、真实经历和作品集依据；也可导入图片或PDF，核对识别结果后确认加入资料。选择语气，完成模型测试并保存。
4. 开启前台岗位检测，刷新支持的平台岗位详情页。核对生成的草稿，再自行复制和发送。

升级后在扩展管理页重新加载扩展并刷新岗位页，使新语气控件与站点权限生效。已保存的模型、个人资料、配对码和语气位于独立程序目录，会在升级时保留。

模型 API Key 与个人资料保存在安装器输出的 `appRoot/private/`，默认位于 `%LOCALAPPDATA%/BOSS-Greeting-Helper/private/`；该目录不会随源码分发。浏览器扩展应加载安装器输出的 `extensionPath`，不要猜测 skill 目录中的旧副本。连接测试使用模拟文字，实际生成才使用岗位和个人资料。

## 仓库布局

```text
README.md
.github/workflows/ci.yml
skills/boss-greeting/
  SKILL.md
  agents/openai.yaml
  references/install.md
  assets/app/
    scripts/install.mjs
    scripts/configure-host.mjs
    server/
    extension/
    templates/
    tests/
```

`SKILL.md` 与程序放在同一个 skill 内，避免安装后缺少依赖文件。源码仓库不包含 Node 二进制、模型权重、真实简历、API Key 或运行日志。

## 发布与维护

开发目录可运行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/export-github.ps1`，生成干净的仓库目录与 `dist/BOSS-Greeting-Skill-GitHub.zip`。上传生成目录中的内容到目标 GitHub 仓库；迁移仓库时同步更新本 README 的安装地址。仓库根目录应直接显示 `README.md` 和 `skills/`；仅上传 ZIP 文件本身不会让技能安装器发现技能。导出工具不会创建仓库或推送 GitHub。

导出后的仓库在 `skills/boss-greeting/assets/app` 内运行：

```powershell
node --test tests/*.test.mjs extension/tests/*.test.cjs
```

独立浏览器界面测试使用隔离 Chrome 和模拟网页，不使用日常浏览器资料；脚本位于 `extension/tests/browser-qa.cjs` 和 `extension/tests/settings-qa.cjs`。GitHub Actions 在 Windows、Node.js 24 环境运行自动测试。
