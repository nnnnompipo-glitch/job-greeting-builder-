# 发布与本地版本归档

每次发布先记录变化，再保存对应源码和构建产物。`CHANGELOG.md` 是公开更新日志；本机 `版本归档/` 保存各版本的实际文件、提交号和 SHA-256 校验值。个人简历、作品集、配对信息、账号设置及日志不进入这些分发归档。

## 发布流程

1. 更新 app 的 `package.json` 和 `extension/manifest.json`，保持版本号一致。仅修复或发布工具调整也应明确记录，避免把不同内容都叫“最新版”。
2. 在仓库根目录 `CHANGELOG.md` 顶部写入该版本的新增、修复、兼容变化和验证结果。只记录实际完成的内容；同版本的历史修复用提交链接区分。
3. 运行适合本次变更的检查。开发目录直接使用 `scripts/`；GitHub 布局中的 app 在 `skills/boss-greeting/assets/app/`。
4. 在 app 目录执行：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/release.ps1
   ```

   这会校验版本和更新日志，导出干净源码、生成 Windows 便携 ZIP，再写入本地版本目录并核对校验值。只生成源码可加 `-SourceOnly`；可用 `-ArchiveDirectory` 指定归档目录。
5. 将干净导出目录的源码提交到 GitHub。它必须包含 `CHANGELOG.md`、`RELEASING.md` 和 `skills/`，不要将整个开发目录或本地归档上传。脚本本身不提交、不推送。
6. 保存提交号与源码一致的最终快照：可在已经提交的干净源码中执行上述命令并加 `-CommitRef 完整提交号`。没有提交号的本地构建会明确留空，不冒充已提交版本。

## 归档内容

```text
版本归档/
  README.md                 可点击的版本目录
  index.json                版本索引
  v1.3.1/
    release/
      source/               干净源码
      artifacts/            源码 ZIP、便携 ZIP
      manifest.json         版本、提交、来源与每个文件的 SHA-256
      版本说明.md
```

同名快照内容相同会复用；内容不同则创建带时间与摘要后缀的新快照，保留旧文件。历史记录按 Git 提交恢复，原始安装包单独说明来源；不能把后补构建说成当年的原始安装包，也不能把同版本号当成同一次构建的证明。

核对某个快照：

```powershell
node scripts/archive-version.mjs --verify "版本归档/v1.3.1/release"
```

归档是应用版本备份。回退应用源码后仍应保留当前的个人资料与账号目录，不使用历史源码覆盖这些私有状态。
