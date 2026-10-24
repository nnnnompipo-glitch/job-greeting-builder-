# 从 GitHub 安装和接入宿主模型

本技能支持 Windows 10/11 的 Chrome、Edge。模型提供商与 AI 客户端是两个层次：提供商生成文字；客户端需要本地工具才能安装、执行并常驻运行助手。

## 完整性与定位

安装后，本技能必须同时包含：

```text
boss-greeting/
  SKILL.md
  agents/openai.yaml
  references/install.md
  assets/app/
    server/
    extension/
    scripts/install.mjs
    scripts/configure-host.mjs
    scripts/bootstrap.ps1
    scripts/start.ps1
    scripts/stop.ps1
    templates/
```

如果只下载了 `SKILL.md`，继续取得同一仓库 `skills/boss-greeting/` 的完整目录。不要安装一份缺少 app 的说明文件后声称已经能够检测浏览器。

Skill 安装目录取决于宿主；使用宿主已知的技能路径。源码仓库中的目录是 `skills/boss-greeting`。使用支持 Agent Skills 的安装器时，可以让宿主自行安装该目录；通用 CLI 示例见仓库 README。不要向不支持技能的聊天客户端写入猜测的配置目录。

## 准备并诊断

以下命令以技能目录为当前目录；使用绝对路径也可。先确认 Node.js 22+，然后：

```powershell
node assets/app/scripts/install.mjs --diagnose
```

Windows 未将 Node 放入 PATH 时，可以运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File assets/app/scripts/bootstrap.ps1 -Diagnose
```

诊断不搜索账号存储、不调用付费生成，不写入模型密钥。仅当用户希望自动探测本机模型时增加 `--detect-local`，读取固定本机端口的 `/v1/models`。发现多个模型或多套服务时，展示脱敏候选，让用户明确选择。

## 应用已经明确的连接

优先顺序：用户本次明确指定的连接；宿主明确暴露并允许复用的当前连接；用户选择的本地服务。标准脚本支持 `BOSS_HELPER_*` 专用环境变量和若干命名提供商变量，详细候选由诊断输出。不能仅凭电脑装了某个 AI 或环境里存在某个 Key 就断言那是当前宿主模型。

完整、唯一且用户允许复用的环境配置可用：

```powershell
node assets/app/scripts/install.mjs --apply-host-env --start
```

显式指定服务和模型时，Key 只从指定环境变量读取，避免把明文放在命令行中：

```powershell
node assets/app/scripts/install.mjs --provider doubao --model "控制台中实际可调用的模型或接入点ID" --api-key-env ARK_API_KEY --start
node assets/app/scripts/install.mjs --provider deepseek --model "控制台中实际可调用的模型ID" --api-key-env DEEPSEEK_API_KEY --start
node assets/app/scripts/install.mjs --provider ollama --model "本机实际模型完整名称" --start
node assets/app/scripts/install.mjs --provider lmstudio --model "本地服务实际模型ID" --start
```

自定义 API 使用 `--provider openai-compatible --base-url "完整基础地址" --model "模型ID" --api-key-env "用户指定的变量名"`。程序自动添加 `/chat/completions`。

如果宿主明确是 Codex，且用户要求复用该宿主，可以选择 `--provider codex --start`，由已安装的命令行使用自己的登录。不要复制其认证文件。其他客户端的登录不会自动变成 Codex 登录。

默认保留已经配置好的模型。确实需要替换原连接时才增加 `--replace-model`。此标志只改变本助手，不修改宿主客户端的设置。API Key 只保存在实际 appRoot/private/config.json；不能把它提交到仓库。

默认 appRoot 是 `%LOCALAPPDATA%/BOSS-Greeting-Helper`，与 skill 安装目录分开，防止更新 skill 时丢失私有状态。自定义部署位置可用 `--install-dir "用户指定的固定目录"`。后续手动运行 configure-host.mjs 时增加 `--root "安装报告中的实际 appRoot"`，不能把技能源码目录误当作已部署目录。安装器只更新明确列出的程序文件，保留 private 中的资料、模型和配对码。

## 浏览器与个人资料

安装程序输出 appRoot、extensionPath 和 pairingFile，不输出配对码内容。打开 Chrome 的 `chrome://extensions` 或 Edge 的 `edge://extensions`，加载输出的 extensionPath。浏览器所要求的开发者模式、加载和权限由其正常界面完成；不要用注册表、策略或调试绕过。

将 pairingFile 内容填写到扩展弹窗；只在可信本地设置界面操作。打开“模型与个人资料设置”，从用户提供的简历、作品集整理真实事实：专业、学历、目标地区、项目职责、工具熟练程度、作品来源，以及明确不确定的内容。没有资料时先完成程序安装，明确报告“个人资料待补充”，不要填开发者信息或虚构经历。

实际生成前，在设置页执行“测试模型连接”。它只发送简短模拟文字，不带简历或真实岗位。Codex 通道显示选择状态，不额外消耗一次模型调用；需要在真实岗位生成后才算实际验证。

启用前台岗位检测，刷新岗位页面。验证职位被正确识别、草稿和依据出现、切换岗位不显示旧结果。不会自动发送。停止服务运行 app 的 `scripts/stop.ps1`。

## 完成报告

分别报告：技能文件已安装、运行环境已找到、服务是否启动、模型连接是否仅已配置还是已测试、浏览器是否加载、个人资料是否就绪。需要用户操作时给出实际本机路径和具体下一步，不把尚未完成的状态说成完成。

支持技能和本地执行的客户端可完成安装及配置；只有文字聊天能力的客户端可按本技能写草稿，但不能因此持续监控本机浏览器。MCP Sampling 等宿主推理通道需要客户端明确支持和授权，本版本不把普通聊天客户端包装成该通道。
