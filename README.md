# 求职招呼语助手 · Codex 登录版

[更新日志](CHANGELOG.md) · [发布与版本归档](RELEASING.md)

浏览器读取你当前打开的岗位详情，结合简历和作品集生成招呼语，由你核对、复制和发送。支持 Windows 10/11、Chrome/Edge、Node.js 22+。

**当前版本为 1.4.1，统一使用 Codex CLI 的 ChatGPT 账号登录方式。无需填写模型地址、模型 ID 或 API Key。** 豆包等具备本地工具的 AI 可以协助安装；实际生成由本机 Codex 完成，不会复用豆包聊天登录，也不要求申请其他模型的 API Key。只有文字聊天能力的客户端可以提供指导，不能据此完成本机安装。

## 对 AI 说什么

> 帮我安装 https://github.com/nnnnompipo-glitch/job-greeting-builder- 上的 boss-greeting skill。先读 SKILL.md，检测 Node.js 和 Codex CLI，缺少 Codex 时按官方方式安装，并指导我用自己的 ChatGPT 账号完成 codex login。检查登录状态后启动助手，保留现有个人资料和配对信息。不要索取 API Key，不要读取任何客户端的登录凭证，不要替我向招聘者发送消息。

安装 skill 和运行生成程序是两个步骤。支持 Agent Skills 的安装器可取得完整的 `skills/boss-greeting` 目录；安装后应继续执行其中的安装流程。

```powershell
npx skills add https://github.com/nnnnompipo-glitch/job-greeting-builder- --skill boss-greeting
```

安装器所需的 Node.js 版本以 [Skills CLI 文档](https://github.com/vercel-labs/skills/blob/main/docs/commands.md) 为准。也可使用当前 AI 客户端已有的 skill 安装机制。

## 安装与登录

1. 先运行技能目录中的 `node assets/app/scripts/install.mjs --diagnose`，只读检查运行环境、Codex 路径和 ChatGPT 登录状态。已安装的 Codex 桌面应用可能自带可用命令行，先检测再安装。
2. 缺少 Codex 时使用 [官方 Codex 安装说明](https://learn.chatgpt.com/docs/codex/cli)。已具备 npm 的环境可运行：

   ```powershell
   npm install -g @openai/codex@latest
   ```

   Windows 也有独立的 PowerShell 安装器，见 [官方 Windows 部署说明](https://learn.chatgpt.com/docs/enterprise/windows-deployment)。Node 便携运行环境本身不一定包含 npm；不要把 Node 已存在当成 npm 已存在。

3. 在终端运行以下命令，使用自己的 ChatGPT 账号完成浏览器登录：

   ```powershell
   codex login
   codex login status
   ```

   `login status` 会报告当前认证方式；退出码为 0 只说明有凭证，还要确认使用的是 ChatGPT。账号是否具有可用的 Codex 权限和额度，以实际账号状态为准，不承诺免费或无限使用。[官方认证说明](https://learn.chatgpt.com/docs/auth)

4. 回到技能目录启动助手：

   ```powershell
   node assets/app/scripts/install.mjs --start
   ```

   Windows 未将 Node 放入 PATH 时，可运行 `powershell -NoProfile -ExecutionPolicy Bypass -File assets/app/scripts/bootstrap.ps1 -Start`。安装输出实际 `appRoot`、`extensionPath` 和 `pairingFile`。默认程序目录为 `%LOCALAPPDATA%/BOSS-Greeting-Helper`。

## 浏览器与资料

1. 在 `chrome://extensions` 或 `edge://extensions` 加载安装器输出的 `extensionPath`，按浏览器正常界面完成开发者模式和权限设置。
2. 将本机 `pairingFile` 中的配对码填入扩展，点击“保存设置”，再点“测试连接”。配对信息保存在此浏览器，关闭弹窗后仍会保留。打开设置，检查 Codex 登录，填写专业、目标城市、真实经历及作品依据。
3. 也可导入 PDF、PNG/JPG/JPEG/BMP、UTF-8 TXT/MD。图片和 PDF 使用 Windows 本机文字识别；先预览、修改，确认加入并保存后才用于生成。每个文件最多 25 MiB，PDF 最多识别前 40 页。
4. 开启前台岗位检测，刷新岗位详情。核对草稿和匹配依据，再自行复制、发送。登录检查通过后，还需一次实际岗位生成才能验证生成通道。

## 保留的功能

| 功能 | 范围 |
| --- | --- |
| 四档语气 | 严肃专业：正式客观；亲和活泼：自然口语；热情夸张：加强主观热情；灵动巧思：一句贴合岗位的巧思。所有档位都以真实经历为准。 |
| 生成进度 | 暗色终端浮窗与绿色进度条，背景代码雨随阶段渐密，落地产生溅射和涟漪；完成后粒子消失。生成期间不显示未经模型提供的百分比。 |
| 文件导入 | PDF、图片、TXT、Markdown；本机识字，核对后加入资料。 |
| 招聘网页版 | BOSS直聘、猎聘、智联招聘；仅检测当前前台、已打开且可正常查看的岗位详情。 |

页面要求登录或展开完整正文时，由用户正常完成；适配不涵盖手机 App。平台改版可能需要调整提取规则。程序不会点击打招呼、投递或发送，不读取聊天、联系人，不批量抓取。

支持从网站首页等入口站内切换到岗位，无需每次刷新。导航等待脚本在三个平台的页面中检查地址与可见状态；仅在允许的岗位路由创建浮窗和读取当前详情，其他页面不读取正文或请求后台。浮窗被网页重绘移除时会自动恢复。

## 升级与数据

1.3.0 升级会保留个人资料、配对信息和语气。旧版其他模型配置会先备份到本机 `private/`，再迁移为 Codex；不会继续调用旧接口，不会将旧密钥上传到仓库。ChatGPT 登录由 Codex 自己管理，本助手不复制其凭证。

升级完成后，在浏览器扩展管理页重新加载助手，再刷新岗位页。源码、通用安装包和 skill 不包含真实简历、作品集、个人资料、账号凭证或配对码。转交他人时使用通用安装包，不发送已经使用过的 `private/`。

## 仓库与检查

完整技能位于 `skills/boss-greeting/`，包括 `SKILL.md`、`references/install.md` 和 `assets/app/`。在 app 目录运行：

```powershell
node --test tests/*.test.mjs extension/tests/*.test.cjs
```

Chrome 139+ 可运行 `node extension/tests/real-extension-qa.cjs`，使用临时浏览器资料目录验证真实 MV3 工具栏弹窗的配对、连接及重启保存，并用拦截的本地页面验证三个平台的站内跳转和浮窗恢复。默认在 43127 启动测试服务；若助手已运行，改用 `--pairing-file <助手目录/private/pairing.txt>`，只检查真实服务健康状态，不调用模型或访问真实招聘网站，不输出配对码。

发布时先更新 `CHANGELOG.md`，再运行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/release.ps1`，同时生成干净源码、带 Node.js 的 Windows 便携包，以及按版本保存的本地快照和校验文件。单独导出仍可使用 `scripts/export-github.ps1`，单独打包使用 `scripts/package.ps1`。Codex 需单独安装和登录；这些脚本不创建 Git 提交或推送。界面检查脚本使用隔离 Chrome 和模拟网页，不使用日常浏览器资料。
