import { Command } from 'lucide-react'

export interface SlashCommandItem {
  id: string
  command: string
  title: string
  description: string
  keywords?: string
  group?: string
  /** 这条指令指向的 Bot：/bot <Bot 名> <指令> 会用到 */
  botId?: string
  /** 选中后直接插进输入框的提示词（技能 / 插件 / 提示词模板） */
  insertText?: string
  /** 需要再选一个名字的指令，例如 /bot、/skill */
  argument?: { label: string; hint: string; items: SlashCommandItem[] }
  run?: () => void | Promise<void>
}


export function SlashCommandMenu({ commands, selectedIndex, onSelect, prefix = '', hint = '' }: { commands: SlashCommandItem[]; selectedIndex: number; onSelect: (command: SlashCommandItem) => void; /** 二级菜单时显示成「/bot 名字」 */ prefix?: string; /** 二级菜单的用法提示 */ hint?: string }) {
  if (!commands.length) return null
  return (
    <div className="slash-command-menu" role="listbox" aria-label="快捷指令">
      <div className="slash-command-heading"><Command size={14} /><span>{prefix ? `/${prefix} · 选择${prefix === 'bot' ? ' Bot' : ''}` : '快捷指令'}</span><em>{commands.length} 项</em><small>{hint || '↑↓ 选择 · Enter 执行 · Esc 关闭'}</small></div>
      {commands.map((item, index) => <button key={item.id} type="button" role="option" aria-selected={index === selectedIndex} className={index === selectedIndex ? 'selected' : ''} onMouseDown={(event) => { event.preventDefault(); onSelect(item) }}><kbd>{prefix ? `/${prefix} ${item.command}` : `/${item.command}`}</kbd><span><strong>{item.title}{item.group && <em>{item.group}</em>}</strong><small>{item.description}</small></span></button>)}
    </div>
  )
}
