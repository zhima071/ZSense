---
name: skill-creator
description: 创建或更新 ZSense Skill，包括清晰的触发条件、执行步骤、验证方法，以及需要随技能分发的 scripts、references 和 assets。用户要求新建、编辑、整理或校验技能时使用。
version: 1.0.0
license: Complete terms in LICENSE.txt
platforms: [macos, linux, windows]
---

# ZSense Skill Creator

本文件基于 WorkBuddy Skill Creator 修改并适配 ZSense；原始内容及随附脚本按 Apache License 2.0 分发，修改内容由 ZSense 项目维护。

创建可以被 ZSense Agent Core 准确发现、按需加载并安全执行的技能。保持说明紧凑，只记录会真正改变 Agent 决策或执行方式的知识。

## When to Use

- 用户要求创建新的 Skill。
- 用户要求编辑、补全、重构或校验现有 Skill。
- 一段可复用工作流需要沉淀为 Skill，并附带脚本、参考资料或模板。

## Instructions

### 1. 明确用途

确认技能解决的具体问题、典型触发语句、输入输出和安全边界。信息已经足够时直接开始，不重复提问。

### 2. 选择最小目录结构

每个技能必须包含 `SKILL.md`，按实际需要再添加：

```text
skill-name/
|-- SKILL.md
|-- scripts/       可重复执行的确定性脚本
|-- references/    仅在相关任务中读取的详细资料
`-- assets/        模板、图片、字体等输出资源
```

不要创建空目录、示例占位文件、重复说明或无用途的 README。

### 3. 编写 SKILL.md

- 文件夹名和 frontmatter `name` 使用小写字母、数字和连字符，最长 64 个字符。
- frontmatter 至少包含 `name`、`description` 和 `version`。
- `description` 同时说明能力和触发场景，避免吸引无关请求。
- 正文至少包含 `When to Use`、`Instructions` 和 `Verification`。
- 把共同规则留在 `SKILL.md`；大量模式说明、API 结构或案例放进 `references/`，并从正文准确链接。
- 不把密码、Token、API Key、私钥或个人绝对路径写入技能。
- 不扩大用户授权；删除、发布、发送消息等外部操作仍需单独确认。

### 4. 在 ZSense 中创建

优先使用“设置 → 技能管理 → 新建技能”，这样 ZSense 会进行安全校验、保存版本并立即显示在技能列表。

需要由 Agent 初始化目录时，先取得用户批准，再在 ZSense 终端运行：

```bash
python3 "$ZSENSE_SKILLS_DIR/zsense-builtin/skill-creator/scripts/init_skill.py" my-skill --path "$ZSENSE_SKILLS_DIR/zsense-custom"
```

`ZSENSE_SKILLS_DIR` 由 ZSense 注入，指向应用自己的隔离技能空间。不要改写 WorkBuddy、CodeBuddy、Codex 或用户主目录下的其他技能目录。

### 5. 编辑现有技能

先完整读取现有 `SKILL.md`，再按其中的路由读取本次修改涉及的资源。保留无关元数据和文件。编辑 ZSense 内置技能时优先通过技能管理面板保存，以便自动标记为用户维护，后续升级不会覆盖。

### 6. 校验

运行：

```bash
python3 "$ZSENSE_SKILLS_DIR/zsense-builtin/skill-creator/scripts/quick_validate.py" <skill-folder>
```

若需要导出可分发压缩包，再运行：

```bash
python3 "$ZSENSE_SKILLS_DIR/zsense-builtin/skill-creator/scripts/package_skill.py" <skill-folder> <output-folder>
```

修复校验错误，并实际运行新增或修改过的脚本。仅检查文案是否存在不能证明技能可用。

## Verification

- `SKILL.md` 的名称、描述、版本和文件夹名一致。
- 触发条件明确，正文包含可执行步骤、失败边界与结果验证方法。
- 所有引用的脚本、参考资料和资源文件真实存在。
- 技能出现在 ZSense 技能列表中，并可按 Bot 分配。
- 未写入凭据、其他应用目录或与任务无关的配置。
