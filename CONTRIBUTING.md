# Contributing / 协作规则

本仓库的每一次改动都必须留下可追溯的记录，**不接受直接推 `main`**。

## 流程

1. **开议题**：描述背景、交付物、验收标准、依赖。平台相关改动用 `platform-verify` 模板。
2. **开分支**：`<type>/<issue#>-<slug>`，例如 `feat/5-zip-engine`、`ci/2-matrix`。
3. **提 PR**：标题用 Conventional Commits，正文写 `Closes #N`（或 `Refs #N`），并填写 PR 模板。
4. **等 CI**：`ci / linux`、`ci / windows`、`ci / macos` 三个检查必须全绿。**每次合并前都必须跑 CI**，不允许跳过。
5. **合并**：squash merge 到 `main`，分支保护会拦住未过检查的合并。

## 提交信息

`feat:` `fix:` `ci:` `docs:` `test:` `refactor:` `chore:` + 中文或英文描述，末尾括号引用议题号（`(#5)`）。

## 代码约定

- ESM（`type: module`），相对导入必须带扩展名。
- `lib/index.js` 是**唯一**允许 `import '@deepseek-ai/*'` 的文件；那些包必须同时出现在 `peerDependencies`（运行时）里，**绝不放进 `dependencies`**（会静默不加载）。
- 所有可测试逻辑放 `lib/core/*.mjs`：零依赖、纯函数、可注入 fs/时钟。
- 测试放 `test/`，用 `node --test "test/**/*.test.mjs"`，不引入测试框架。
- 任何触碰文件系统的自动化都必须只用 `DSH_HOME` 指向的临时目录；真实 `~/.dsh` 只读。

## 平台

Linux / Windows / macOS 都要能跑。写路径用 `node:path`，不要硬编码 `/`；不要依赖执行位（Windows 没有），改为按 `manifest` 里的 mode 记录、能设则设。
