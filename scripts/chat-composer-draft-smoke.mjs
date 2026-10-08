import assert from 'node:assert/strict'
import fs from 'node:fs'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { chatComposerDraftKey, moveChatComposerDraft, readChatComposerDraft, updateChatComposerDraft } from '../src/services/chat-composer-drafts.ts'

const first = chatComposerDraftKey('native', 'conversation-first')
const second = chatComposerDraftKey('native', 'conversation-second')
const bot = chatComposerDraftKey('bot', 'conversation-first', 'atlas')
const multiline = '第一行\n第二行\n\n第四行'
updateChatComposerDraft(first, (current) => ({ ...current, text: multiline }))
updateChatComposerDraft(second, (current) => ({ ...current, text: '另一个会话的草稿' }))
updateChatComposerDraft(bot, (current) => ({ ...current, text: 'Bot 的独立草稿' }))
assert.equal(readChatComposerDraft(first).text, multiline, '切换回原会话后应恢复未发送的换行文字')
assert.equal(readChatComposerDraft(second).text, '另一个会话的草稿')
assert.equal(readChatComposerDraft(bot).text, 'Bot 的独立草稿', 'Bot 草稿不能与 AI 对话混用')

const attachment = { path: '/tmp/draft-example.png', name: 'draft-example.png', kind: 'image' }
updateChatComposerDraft(first, (current) => ({ ...current, attachments: [attachment] }))
assert.deepEqual(readChatComposerDraft(first).attachments, [attachment], '未发送附件也应跟随原会话')
const newChat = chatComposerDraftKey('native', undefined, '', 12)
const createdChat = chatComposerDraftKey('native', 'conversation-created')
updateChatComposerDraft(newChat, () => ({ text: '等待回复时继续写的内容', attachments: [] }))
moveChatComposerDraft(newChat, createdChat)
assert.equal(readChatComposerDraft(createdChat).text, '等待回复时继续写的内容', '新会话获得 ID 后不能丢失执行期间输入的草稿')
assert.equal(readChatComposerDraft(newChat).text, '')
updateChatComposerDraft(first, () => ({ text: '', attachments: [] }))
assert.equal(readChatComposerDraft(first).text, '', '发送后草稿应清空')
assert.equal(readChatComposerDraft(first).attachments.length, 0)

const html = renderToStaticMarkup(React.createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, multiline))
assert.match(html, /第一行\n第二行/, 'Markdown 解析后软换行仍在文本节点中')
assert.match(fs.readFileSync('src/styles.css', 'utf8'), /\.chat-message\.user \.markdown-content p \{ white-space: pre-wrap; \}/,
  '用户消息必须以保留换行的方式显示')
const nativeSource = fs.readFileSync('src/components/NativeChatPage.tsx', 'utf8')
const botSource = fs.readFileSync('src/components/ChatDialog.tsx', 'utf8')
assert.match(nativeSource, /useChatComposerDraft\(composerDraftKey\)/)
assert.match(botSource, /useChatComposerDraft\(composerDraftKey\)/)
assert.match(nativeSource, /moveChatComposerDraft\(composerDraftKey/)
assert.match(botSource, /moveChatComposerDraft\(composerDraftKey/)
console.log(JSON.stringify({ ok: true, perConversationDrafts: true, botIsolation: true, newConversationMigration: true, attachments: true, multilinePreview: true }))
