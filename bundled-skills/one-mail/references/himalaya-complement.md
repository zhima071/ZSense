---
name: himalaya
description: "Himalaya CLI：从终端收发 IMAP/SMTP 邮件。"
version: 1.1.0
author: community
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [Email, IMAP, SMTP, CLI, Communication]
    homepage: https://github.com/pimalaya/himalaya
prerequisites:
  commands: [himalaya]
---

# Himalaya Email CLI

Himalaya 是一款 CLI 邮件客户端，可让你通过 IMAP、SMTP、Notmuch 或 Sendmail 后端从终端管理邮件。

本技能与 Hermes 邮件网关适配器相互独立。网关适配器让人可以给代理发邮件，并使用 Hermes 内置的 IMAP/SMTP 适配器；本技能则让代理通过终端工具操作邮箱，并需要外部的 `himalaya` CLI。

## 参考文档

- `references/configuration.md`（配置文件设置 + IMAP/SMTP 认证）
- `references/message-composition.md`（MML 语法，用于撰写邮件）

## 先决条件

1. 已安装 Himalaya CLI（用 `himalaya --version` 验证）
2. 在 `~/.config/himalaya/config.toml` 有配置文件
3. 已配置 IMAP/SMTP 凭据（密码安全存储）

### 安装

```bash
# Pre-built binary (Linux/macOS — recommended)
curl -sSL https://raw.githubusercontent.com/pimalaya/himalaya/master/install.sh | PREFIX=~/.local sh

# macOS via Homebrew
brew install himalaya

# Or via cargo (any platform with Rust)
cargo install himalaya --locked
```

## 配置设置

运行交互式向导来设置账号：

```bash
himalaya account configure
```

或手动创建 `~/.config/himalaya/config.toml`：

```toml
[accounts.personal]
email = "you@example.com"
display-name = "Your Name"
default = true

backend.type = "imap"
backend.host = "imap.example.com"
backend.port = 993
backend.encryption.type = "tls"
backend.login = "you@example.com"
backend.auth.type = "password"
backend.auth.cmd = "pass show email/imap"  # or use keyring

message.send.backend.type = "smtp"
message.send.backend.host = "smtp.example.com"
message.send.backend.port = 587
message.send.backend.encryption.type = "start-tls"
message.send.backend.login = "you@example.com"
message.send.backend.auth.type = "password"
message.send.backend.auth.cmd = "pass show email/smtp"

# Folder aliases (himalaya v1.2.0+ syntax). Required whenever the
# server's folder names don't match himalaya's canonical names
# (inbox/sent/drafts/trash). Gmail is the common case — see
# `references/configuration.md` for the `[Gmail]/Sent Mail` mapping.
folder.aliases.inbox = "INBOX"
folder.aliases.sent = "Sent"
folder.aliases.drafts = "Drafts"
folder.aliases.trash = "Trash"
```

> **提醒关于别名语法。** 早于 v1.2.0 的文档曾使用 `[accounts.NAME.folder.alias]` 子节（单数 `alias`）。v1.2.0 会静默忽略该形式——TOML 能正常解析，但别名解析器从未读取它，因此每次查找都会回退到规范名称。在 Gmail 上这意味着在 SMTP 投递成功*之后*保存到“已发送”会失败，且 `himalaya message send` 以非零码退出。任何在那个退出码上重试的调用者（代理、脚本、用户）都会重新执行整个发送流程——包括 SMTP——从而向收件人产生重复邮件。请始终使用 `folder.aliases.X`（复数、点分隔的键，直接位于 `[accounts.NAME]` 之下）。

## 与 Hermes 集成的说明

- **读取、列出、搜索、移动、删除** 都可以直接通过终端工具完成
- **撰写/回复/转发** — 为确保可靠性，推荐使用管道输入（`cat << EOF | himalaya template send`）。交互式 `$EDITOR` 模式配合 `pty=true` + 后台 + process 工具可用，但需要了解所用编辑器及其命令
- 使用 `--output json` 获得更易于编程解析的结构化输出
- `himalaya account configure` 向导需要交互式输入——请使用 PTY 模式：`terminal(command="himalaya account configure", pty=true)`

## 常用操作

### 列出文件夹

```bash
himalaya folder list
```

### 列出邮件

列出 INBOX（默认）中的邮件：

```bash
himalaya envelope list
```

列出指定文件夹中的邮件：

```bash
himalaya envelope list --folder "Sent"
```

带分页列出：

```bash
himalaya envelope list --page 1 --page-size 20
```

### 搜索邮件

```bash
himalaya envelope list from john@example.com subject meeting
```

### 读取邮件

按 ID 读取邮件（显示纯文本）：

```bash
himalaya message read 42
```

导出原始 MIME：

```bash
himalaya message export 42 --full
```

### 回复邮件

要从 Hermes 非交互式地回复，请先读取原始邮件，撰写回复，然后管道输入：

```bash
# Get the reply template, edit it, and send
himalaya template reply 42 | sed 's/^$/\nYour reply text here\n/' | himalaya template send
```

或手动构建回复：

```bash
cat << 'EOF' | himalaya template send
From: you@example.com
To: sender@example.com
Subject: Re: Original Subject
In-Reply-To: <original-message-id>

Your reply here.
EOF
```

回复全部（交互式——需要 `$EDITOR`，请改用上面的模板方法）：

```bash
himalaya message reply 42 --all
```

### 转发邮件

```bash
# Get forward template and pipe with modifications
himalaya template forward 42 | sed 's/^To:.*/To: newrecipient@example.com/' | himalaya template send
```

### 撰写新邮件

**非交互式（在 Hermes 中使用）**— 通过 stdin 管道传入消息：

```bash
cat << 'EOF' | himalaya template send
From: you@example.com
To: recipient@example.com
Subject: Test Message

Hello from Himalaya!
EOF
```

或用 headers 标志：

```bash
himalaya message write -H "To:recipient@example.com" -H "Subject:Test" "Message body here"
```

注意：不带管道输入的 `himalaya message write` 会打开 `$EDITOR`。这在 `pty=true` + 后台模式下可行，但管道输入更简单、更可靠。

### 移动/复制邮件

移动到文件夹（目标文件夹在前，再是消息 ID）：

```bash
himalaya message move "Archive" 42
```

复制到文件夹（目标文件夹在前，再是消息 ID）：

```bash
himalaya message copy "Important" 42
```

### 删除邮件

```bash
himalaya message delete 42
```

### 管理标记

添加标记：

```bash
himalaya flag add 42 --flag seen
```

移除标记：

```bash
himalaya flag remove 42 --flag seen
```

## 多账号

列出账号：

```bash
himalaya account list
```

使用特定账号：

```bash
himalaya --account work envelope list
```

## 附件

保存消息中的附件：

```bash
himalaya attachment download 42
```

保存到指定目录：

```bash
himalaya attachment download 42 --downloads-dir ~/Downloads
```

## 输出格式

大多数命令支持 `--output` 以获取结构化输出：

```bash
himalaya envelope list --output json
himalaya envelope list --output plain
```

## 调试

启用调试日志：

```bash
RUST_LOG=debug himalaya envelope list
```

带回溯的完整跟踪：

```bash
RUST_LOG=trace RUST_BACKTRACE=1 himalaya envelope list
```

## 提示

- 使用 `himalaya --help` 或 `himalaya <command> --help` 查看详细用法。
- 消息 ID 是相对于当前文件夹的；切换文件夹后请重新列出。
- 要撰写带附件的富格式邮件，请使用 MML 语法（见 `references/message-composition.md`）。
- 使用 `pass`、系统钥匙串或能够输出密码的命令来安全存储密码。
