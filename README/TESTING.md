# 测试

在仓库根目录使用 Node.js 24 或更新版本：

```sh
npm ci
npm test
npm run build
```

`npm test` 使用 Vitest 运行共享模型、真实 SQLite 后端集成和 React 工作台测试。后端测试各自创建独立数据库，不要求外部服务。

开发时可以指定文件或项目缩小范围：

```sh
npx vitest run apps/server/src/ui.test.ts
npx vitest run frontend/src/test/topic-detail-page.test.tsx
npm run typecheck
```

重点检查消息部件及版本引用、事务提交与重复重试、结算守恒和推翻、组织恢复、原发送操作、分页期间的增量同步，以及非线性布局。浏览器检查使用单独的测试数据库和本地测试账号。
