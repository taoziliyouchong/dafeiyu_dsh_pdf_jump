# 发布清单（DSH 社区）

这个目录是可直接发布的插件仓库内容。下面每一步做完再进下一步。

## 0. 发布前在本机验证

```sh
npm install
npm run smoke -- "D:\path\to\manual.pdf" 3
```

`scripts/smoke.mjs` 会起本地服务，跑四条路由：单页 HTML、页图 PNG、缩略图 JPEG、整本页（页锚点）。每条打印耗时与字节数，任一失败会抛错退出。

## 0.5 检查打包内容

```sh
npm pack --dry-run
```

包里只应出现：`index.js`、`native.js`、`lib/`、`assets/`、`cordis.patch.yml`、两个 README、`LICENSE`。`node_modules/`、`publish/`、`scripts/`、`design/` 都不该进包。图标与截图必须放在 `assets/`，README 用相对路径引用。

## 1. 建 GitHub 仓库

- 公开仓库，名字建议 `dsh-pdf-jump`（与 `package.json` 的 `name` 一致）。
- 推送本目录内容（`node_modules/`、`*.tgz` 已被 `.gitignore` 排除）。
- 给仓库加 topic：`dsh-plugin`（收录检查会看）。
- 仓库创建要满 1 天才能进目录（自动检查），当天建好、第二天再提 PR。

## 2. 填占位符

- `package.json`：可加 `"repository": { "type": "git", "url": "https://github.com/OWNER/dsh-pdf-jump" }`，把 `OWNER` 换成你的 GitHub 用户名。
- `publish/registry-entry.yml`：三处 `OWNER` 全部替换。
- 若用 npm 发布，先确认包名可用：`npm view dsh-pdf-jump version`（当前未占用）。

## 3. 发布到 npm（可选但推荐）

```sh
npm publish --access public
```

不发布 npm 也能被收录：安装命令可以走 GitHub（`dsh plugin --profile web add github:OWNER/dsh-pdf-jump`）。发布 npm 的好处是市场能做版本更新检查。

## 4. 提交目录收录

到 GitHub 仓库 `awesome-dsh-plugin/awesome-dsh-plugin` 开 PR，只加一个文件：

- 路径：`data/plugins/<OWNER>__dsh-pdf-jump.yml`
- 内容：`publish/registry-entry.yml` 去掉 `OWNER` 占位后的全文

不要动包里代码；README 中英两份内容保持同步。合并后站点与 dshmarket 通常一天内自动出现。

## 5. 之后的版本更新

1. 改 `package.json` 的 `version`（语义化版本）。
2. 打 tag：`git tag v0.1.1 && git push --tags`。
3. `npm publish`（如果走 npm）。
4. 目录条目本身不用改，市场按 npm 版本或 GitHub HEAD 检查更新。

## 收录要求对照

| 要求 | 本仓库状态 |
| --- | --- |
| `package.json` 声明 `dsh.bundle.patch` | 已声明，指向 `cordis.patch.yml` |
| 仓库有真实可用代码 | 有（渲染、服务、工具注册） |
| 仓库满 1 天 | 建库后次日再提 PR |
| 加 `dsh-plugin` topic | 建库时加 |
| 描述只说功能、不夸大 | `registry-entry.yml` 已按实际能力写 |
| 分类贴合 | `docs`（文档查看）；若市场更偏工具类，维护者会改 |
