# 项目代理工作准则

这个文件用于指导 Codex、Claude 等代码代理在本项目中的后续改动。README 面向开源用户，不要把仅用于代理协作的要求写入 README。

## 总体要求

- 开始任何产品文案、分类流程、统计口径或视频卡片交互改动前，必须先完整阅读 [`docs/user-facing-language.md`](docs/user-facing-language.md)。其中记录了已经确认的普通用户术语、功能边界和交互命名；新改动不得重新引入已废弃或容易混淆的表达。
- 涉及 B站接口、字段或请求逻辑时，优先参考 [bilibili-API-collect](https://github.com/pskdje/bilibili-API-collect/tree/main) 中整理的接口说明。
- 每次代码或文档改动都要同步更新版本号，并保持 `README.md`、`manifest.json`、`package.json`、`src/shared.js` 和 `tests/shared.test.mjs` 中的版本一致。
- 不需要每次都用 npm 做详细验证；扩展加载和真实页面行为由用户安装插件后手动检测。

## 本项目改动习惯

- 改动要尽量贴合现有 Manifest V3 扩展结构，不引入不必要的构建步骤。
- 不要覆盖手动分类结果；涉及分类修复、重置或 LLM 导入时，要保留 `manual` 来源的分类。
- 修改页面交互时，注意避免重新引入滚动跳动、批量选择失效、文本选择丢失或输入法体验问题。
