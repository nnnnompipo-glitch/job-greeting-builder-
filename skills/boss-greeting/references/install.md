# 安装与 Codex 登录

本版支持 Windows 10/11、Chrome/Edge，以及 BOSS直聘、猎聘、智联招聘网页版。安装 AI 客户端与实际生成程序是两层：豆包等有本地工具的客户端可以安装技能；生成统一由本机 Codex CLI 使用用户的 ChatGPT 登录完成。不要索取其他模型 API Key，也不把任意聊天客户端的登录当作本地程序凭证。

## 定位与检测

技能目录必须同时包含 `SKILL.md`、`references/install.md` 和完整 `assets/app/`，其中有 `scripts/install.mjs`、`scripts/codex.mjs`、`scripts/bootstrap.ps1`、`server/`、`extension/`、`templates/`。仅安装说明文件不足以运行。

以技能真实目录为当前目录，或使用脚本绝对路径：

```powershell
node assets/app/scripts/install.mjs --diagnose
```

Node 未加入 PATH 时：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File assets/app/scripts/bootstrap.ps1 -Diagnose
```

诊断只寻找可执行文件并调用 `codex login status`，不执行模型生成、不读认证文件、不搜索聊天登录或 API 环境变量。Codex 桌面应用可能附带可用原生命令行。检测到其路径时优先复用，不重复安装。

## 补齐 Codex 并登录

缺少 Codex 时，按 [官方 CLI 安装说明](https://learn.chatgpt.com/docs/codex/cli) 安装。在已有 npm 的环境可运行：

```powershell
npm install -g @openai/codex@latest
```

Node 便携二进制不代表 npm 也已安装。无 npm 时使用 [官方 Windows 独立安装器说明](https://learn.chatgpt.com/docs/enterprise/windows-deployment)，不要下载第三方修改版。正常安装后，必要时打开新终端，使用户 PATH 更新。

让用户用自己的账号完成浏览器认证：

```powershell
codex login
codex login status
```

`codex login` 默认开启 ChatGPT 浏览器登录。若本机回调不可用，可按 [官方认证说明](https://learn.chatgpt.com/docs/auth) 使用 `codex login --device-auth`，前提是账号或工作区允许设备码登录。认证需要用户自行完成，不代填密码、不复制登录缓存。

`login status` 的退出码为 0 只说明有认证信息，还必须确认方式为 ChatGPT。API Key 登录、状态未知、检查超时都不能报告为本版可用。登录成功也不等于实际生成通过，账号可用权限与额度以实际状态为准。

## 部署和升级

```powershell
node assets/app/scripts/install.mjs --start
```

或运行 `powershell -NoProfile -ExecutionPolicy Bypass -File assets/app/scripts/bootstrap.ps1 -Start`。默认程序目录为 `%LOCALAPPDATA%/BOSS-Greeting-Helper`；以安装输出的 appRoot、extensionPath、pairingFile 为准。技能文件与运行状态分开，更新技能不会清空运行目录 private。安装器只复制明确列出的程序文件。

1.3.0 将旧版非 Codex 模型配置先备份到本机 private，再迁移到 Codex；不再调用旧接口，不把旧密钥或备份带入公开源码、安装包。保留个人资料、配对与四档语气，不修改 Codex 自己的账号状态。

## 浏览器与资料

在 `chrome://extensions` 或 `edge://extensions` 按正常界面加载 extensionPath。用 pairingFile 中的本机配对码完成配对；不要将配对码输出到聊天或日志。设置页检查 Codex 登录并填写用户自己的专业、学历、目标地区、真实经历、项目职责与作品依据。没有资料时报告“个人资料待补充”，不填开发者信息。

为便于生成有证据的招呼语，可补充明确的相关工作年限、本人项目行动与交付、成果数字的单位与范围、相关作品或证书，以及当前已确认的到岗时间。未知或冲突的信息保留为空或注明待核对，不为了凑齐模板要求用户填入估算数字；团队整体结果与本人贡献分开记录。

资料可导入 PDF、PNG/JPG/JPEG/BMP、UTF-8 TXT/MD，每个文件 25 MiB，PDF 最多识别前 40 页。Windows 本机 OCR 后先显示预览，核对并确认加入、保存后才用于生成；OCR 不支持时按系统错误补齐识别语言组件，不转发其他识别服务。

默认严肃专业，也可选择亲和活泼、热情夸张、灵动巧思。启用前台检测，刷新岗位详情。验证标题与正文对应、草稿与依据出现、切换岗位或语气不展示旧结果。猎聘、智联的登录或正文展开由用户正常完成。实际生成成功后才能报告生成通道已验证；发送始终由用户手动完成。

升级扩展后请在扩展管理页重新加载，再刷新岗位页。停止服务运行 appRoot 下的 `scripts/stop.ps1`。完成报告分别说明技能、运行环境、Codex 登录、服务、浏览器、资料与实际生成状态，不把待办写成成功。
