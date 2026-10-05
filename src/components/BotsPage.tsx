import { ArrowRight, Bot as BotIcon, LoaderCircle, PanelLeft, Plus, Search } from 'lucide-react'
import { useState } from 'react'
import type { Bot, Conversation, GatewayConnection } from '../types'
import { BotActionsMenu } from './BotActionsMenu'
import { ChannelBadge, StatusLabel } from './Overview'

interface BotsPageProps {
  bots: Bot[]
  conversations: Conversation[]
  gatewayConnections: GatewayConnection[]
  hiddenSidebarBotIds: string[]
  onToggleSidebarBot: (botId: string) => Promise<void>
  onOpenBot: (id: string) => void
  onCreate: () => void
  onUpdate: (bot: Bot) => void | Promise<void>
  onDuplicate: (bot: Bot) => Promise<void>
  onDelete: (bot: Bot) => Promise<void>
}

export function BotsPage({ bots, conversations, gatewayConnections, hiddenSidebarBotIds, onToggleSidebarBot, onOpenBot, onCreate, onUpdate, onDuplicate, onDelete }: BotsPageProps) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<'all' | 'online' | 'paused'>('all')
  const [sidebarUpdatingId, setSidebarUpdatingId] = useState('')
  const visibleBots = bots.filter((bot) => `${bot.name} ${bot.role} ${bot.description}`.toLowerCase().includes(query.toLowerCase()) && (status === 'all' || bot.status === status))

  const toggleSidebar = async (botId: string) => {
    setSidebarUpdatingId(botId)
    try { await onToggleSidebarBot(botId) }
    catch { /* The parent shows the actionable error notice. */ }
    finally { setSidebarUpdatingId('') }
  }

  return (
    <div className="page">
      <section className="page-heading">
        <div><span className="eyebrow">BOT DIRECTORY</span><h1>你的 Bots</h1><p>每一个 Bot 都拥有自己的身份、记忆边界和消息入口。</p></div>
        <button className="button primary" onClick={onCreate}><Plus size={17} />创建 Bot</button>
      </section>
      <div className="toolbar">
        <label className="search-field"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Bot、角色或能力" /></label>
        <div className="segmented"><button className={status === 'all' ? 'active' : ''} onClick={() => setStatus('all')}>全部 {bots.length}</button><button className={status === 'online' ? 'active' : ''} onClick={() => setStatus('online')}>运行中 {bots.filter((bot) => bot.status === 'online').length}</button><button className={status === 'paused' ? 'active' : ''} onClick={() => setStatus('paused')}>已暂停 {bots.filter((bot) => bot.status === 'paused').length}</button></div>
      </div>
      <div className="bot-card-grid">
        {visibleBots.map((bot) => {
          const conversationCount = conversations.filter((conversation) => conversation.kind === 'bot' && conversation.botId === bot.id).length
          const gatewayCount = gatewayConnections.filter((connection) => connection.botId === bot.id).length
          const shownInSidebar = !hiddenSidebarBotIds.includes(bot.id)
          return <article className="bot-card" key={bot.id}>
            <div className="bot-card-top">
              <span className="large-avatar" style={{ '--avatar': bot.color } as React.CSSProperties}>{bot.initials}<i className={`presence ${bot.status}`} /></span>
              <div className="bot-card-controls">
                <button type="button" className={`bot-sidebar-toggle ${shownInSidebar ? 'active' : ''}`} aria-pressed={shownInSidebar} disabled={Boolean(sidebarUpdatingId)} onClick={() => void toggleSidebar(bot.id)} title={shownInSidebar ? '从左侧“我的 Bots”隐藏' : '显示在左侧“我的 Bots”'}>
                  {sidebarUpdatingId === bot.id ? <LoaderCircle className="spin" size={14} /> : <PanelLeft size={14} />}
                  <span>{shownInSidebar ? '侧栏显示' : '侧栏隐藏'}</span>
                </button>
                <BotActionsMenu bot={bot} conversationCount={conversationCount} gatewayCount={gatewayCount} onUpdate={onUpdate} onDuplicate={onDuplicate} onDelete={onDelete} />
              </div>
            </div>
            <StatusLabel status={bot.status} />
            <h2>{bot.name}</h2>
            <span className="bot-role">{bot.role}</span>
            <p>{bot.description}</p>
            <div className="bot-card-stats">
              <span><small>长期记忆</small><strong>{bot.memoryCount.toLocaleString()}</strong></span>
              <span><small>对话</small><strong>{conversationCount}</strong></span>
              <span><small>成功率</small><strong>{bot.successRate}%</strong></span>
            </div>
            <div className="bot-card-footer">
              <div className="channel-stack">{bot.channels.map((channel) => <ChannelBadge key={channel} id={channel} compact />)}</div>
              <button className="text-button" onClick={() => onOpenBot(bot.id)}>打开工作区 <ArrowRight size={15} /></button>
            </div>
          </article>
        })}
        <button className="new-bot-card" onClick={onCreate}>
          <span><BotIcon size={22} /><Plus size={14} /></span>
          <strong>创建新的 Bot</strong>
          <small>分配独立记忆与消息入口</small>
        </button>
      </div>
    </div>
  )
}
