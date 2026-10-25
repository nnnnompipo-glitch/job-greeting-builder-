# 版本维护

维护本仓库时，每次发布都更新根目录 `CHANGELOG.md`，写清实际新增、修复及必要的兼容变化。保留旧条目和提交链接，不把尚未完成的功能写成已经发布。

发布前使 app 的 `package.json` 与 `extension/manifest.json` 版本一致，按 `RELEASING.md` 执行 `scripts/release.ps1`，保留本地版本快照与校验文件。GitHub 布局中的 app 位于 `skills/boss-greeting/assets/app/`；平铺开发目录可直接执行 `scripts/`。

公开提交应包含更新日志和干净源码；本地 `版本归档/`、`private/`、个人材料、认证信息及运行日志不进入仓库。既有快照不覆盖；修订保留为新快照。没有真实历史文件或提交依据时，明确说明，不能补造版本或原始安装包。
