# 项目代码规范

本仓库的代码风格由根目录的 `eslint.config.mjs` 统一定义（ESLint flat config）。
无论用 Claude Code、Cursor、Copilot 还是手写，生成的代码都以这份配置为准。

## 约定
- 生成或修改代码后，须符合 `eslint.config.mjs` 中已启用的规则。
- 当前已启用的风格规则：
  - 语句末尾不加分号（`@stylistic/semi: never`）
  - 字符串使用单引号（`@stylistic/quotes: single`）
- 完成改动后运行 `npm run lint` 校验；可用 `npm run lint:fix` 自动修复。
- 新增规范时，请在 `eslint.config.mjs` 的 rules 块中**逐条添加**，不要整套引入第三方预设。

## 异步代码风格
- 异步调用**优先用 Promise 链**：`fn().then().catch()`，需要收尾清理时再接 `.finally()`。
- **仅当**封装函数内部存在多个异步操作的**顺序依赖**（后一步依赖前一步的结果）时，才使用 `async/await`。
- 封装函数应直接 `return` 这条 Promise，把错误/结果继续交给调用方链式处理；不要在不需要的地方 `try/catch` 吞掉错误。
- 该约定属于语义层面，**ESLint 无法自动校验**，由生成代码与审查时人工遵守。
