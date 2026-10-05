---
name: "lark"
description: "统一管理飞书消息、文档、云盘、多维表格、电子表格、日历、会议、邮箱、审批、任务、通讯录、知识库等能力。"
version: "1.0.0"
author: ZSense
license: Proprietary
platforms: [macos, linux, windows]
---

# 飞书统一技能

## When to Use

- 用户需要查询或管理飞书中的消息、群聊、文档、云盘、多维表格、电子表格、日历、会议、邮箱、审批、任务、通讯录、知识库或开放平台资源时使用。

## Instructions

1. 先调用内置 `run_lark_cli` 执行 `skills list`，确认当前 CLI 提供的具体能力名称。
2. 再执行 `skills read <技能名>`，读取与当前请求最相关的详细说明；不要一次加载全部能力。
3. 按详细说明查询对应命令的 `--help`，确认参数后再执行。
4. 查询、读取和列举操作可以直接执行；认证、发送、创建、修改、删除以及其他外部写入必须遵循 ZSense 审批。
5. 不得把 App Secret、Access Token、Refresh Token、密码或验证码写进参数、日志或对话正文；使用 CLI 的安全配置与登录流程。
6. 涉及本地文件时只使用当前会话工作区内的相对路径，并在执行后核对返回的资源 ID、状态和数量。

## 用户授权闭环（ZSense 专用）

1. 先运行 `auth status --json`。若用户身份可用但目标读取仍报权限不足，区分“用户缺少授权 scope”与 `app_scope_not_applied`；后者必须由应用开发者在飞书开放平台申请应用权限，重复扫码无法解决。
2. 遇到 `token_missing` 或用户 scope 不足时，根据错误里的 `missing_scopes` 选择最小必要范围，调用 `run_lark_cli` 的 `auth login --scope "所需 scope"`。ZSense 会自动以非阻塞模式发起设备授权、安全暂存设备码，并生成本次专用的二维码文件。不要用终端、`nohup` 或 `auth login --no-wait` 的原始输出自行管理设备码。
3. 把 ZSense 返回的 `verification_url` 和可选 `qr_file` 告诉用户，**结束这一轮回复**。不要在同一轮等待或反复生成新链接；链接过期才重来。
4. 用户在同一会话确认后，调用 `run_lark_cli` 参数 `["auth", "complete"]`。这是 ZSense 的封装命令，不是 lark-cli 原生命令；它会用暂存设备码完成令牌换取并核验 `auth status`，无需把设备码发给模型或写入对话。
5. 只有 `auth complete` 确认成功后才重试原操作；若仍报 scope 不足，按缺失权限处理，不宣称授权成功。

## Failure Handling

- 如果命令或字段发生变化，重新运行 `skills list`、`skills read` 和对应命令的 `--help`，不要猜测参数。
- `auth qrcode` 的原生命令以 URL 作为位置参数，**没有** `--url`；正常授权流程由 ZSense 自动生成二维码，无需单独调用。
- 如果权限不足或远端拒绝，保留错误类型、缺失 scope 等摘要并告诉用户，不要输出令牌、设备码或包含凭证的日志。

## Verification

- 读取操作核对资源名称、ID、更新时间或记录数量。
- 写入操作完成后再次读取目标资源，确认修改已经在飞书侧生效。
