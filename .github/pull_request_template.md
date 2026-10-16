## 关联议题

Closes #

## 改了什么

<!-- 一段话说清，附关键文件 -->

## 写入范围

<!-- 本 PR 触碰的目录/文件，例如 lib/core/zip.mjs, test/zip.test.mjs -->

## 验证

<!-- 命令 + 关键输出（CI 之外的本地验证） -->

```sh
node --test test/
```

## 平台影响

- [ ] Linux
- [ ] Windows
- [ ] macOS
- [ ] 只影响文档/CI

## 回滚

<!-- 出问题怎么退回去 -->

## 清单

- [ ] 关联了议题
- [ ] 本地跑过 `node --test test/`
- [ ] 新增/修改的逻辑有测试覆盖
- [ ] 没有把 `@deepseek-ai/*` 放进 `dependencies`
- [ ] 没有触碰真实 `~/.dsh`（测试只用临时 DSH_HOME）
- [ ] 文档与代码同一次改动内更新
