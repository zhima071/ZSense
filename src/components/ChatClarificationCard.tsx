import { Check, CircleHelp, LoaderCircle, ShieldAlert, ShieldCheck, X } from 'lucide-react'
import { FormEvent, useEffect, useMemo, useState } from 'react'
import { errorMessage } from '../services/desktop'
import type { ChatClarification, ChatClarificationAnswer, ChatClarificationQuestion } from '../types'

interface ChatClarificationCardProps {
  clarification: ChatClarification
  expired?: boolean
  onRespond: (answers: ChatClarificationAnswer[]) => Promise<void>
}

interface AnswerDraft {
  choices: string[]
  text: string
}

interface CardState {
  drafts: Record<string, AnswerDraft>
  submitted: boolean
  stale: boolean
}

const recommendedSuffix = '(Recommended)'
// 卡片会随视图切换被卸载重建（切到别的会话再切回来）。把「已经选了什么 / 提交过没有 / 是否已失效」
// 放在组件外面的按请求 ID 索引的表里，重建时才能恢复，而不是变回一张空白卡片。
const cardStates = new Map<string, CardState>()
const cardStateLimit = 40

function readCardState(key: string): CardState | undefined {
  const state = cardStates.get(key)
  if (!state) return undefined
  // 最近使用过的保持在前面，超出上限时丢弃最旧的
  cardStates.delete(key)
  cardStates.set(key, state)
  return state
}

function writeCardState(key: string, state: CardState) {
  cardStates.delete(key)
  cardStates.set(key, state)
  while (cardStates.size > cardStateLimit) {
    const oldest = cardStates.keys().next().value
    if (oldest === undefined) break
    cardStates.delete(oldest)
  }
}

function visibleChoice(choice: string) {
  return choice.endsWith(recommendedSuffix) ? choice.slice(0, -recommendedSuffix.length).trim() : choice
}

function questionKey(question: ChatClarificationQuestion, index: number) {
  return question.questionId || `single-${index}`
}

function initialDrafts(clarification: ChatClarification) {
  const drafts: Record<string, AnswerDraft> = {}
  clarification.questions.forEach((question, index) => {
    const key = questionKey(question, index)
    const locked = question.questionId ? clarification.lockedAnswers[question.questionId] : ''
    if (!locked) {
      drafts[key] = { choices: [], text: '' }
      return
    }
    let lockedValues = [locked]
    if (question.multiSelect) {
      try {
        const parsed = JSON.parse(locked)
        if (Array.isArray(parsed) && parsed.every((value) => typeof value === 'string')) lockedValues = parsed
      } catch { /* older application versions may persist a scalar answer */ }
    }
    const choices = question.choices.filter((choice) => lockedValues.includes(visibleChoice(choice)))
    drafts[key] = choices.length ? { choices, text: '' } : { choices: [], text: locked }
  })
  return drafts
}

function cardKeyOf(clarification: ChatClarification) {
  return clarification.requestId
}

function readState(clarification: ChatClarification): CardState {
  return readCardState(cardKeyOf(clarification)) || { drafts: initialDrafts(clarification), submitted: false, stale: false }
}

// 主进程已经不再等待这个澄清时（运行结束、被取消或已处理过），继续提交必然失败。
function isGoneMessage(message: string) {
  return /已经处理|已经结束|已失效|无法显示审批界面|不存在/.test(message)
}

export function ChatClarificationCard({ clarification, expired = false, onRespond }: ChatClarificationCardProps) {
  const [state, setState] = useState<CardState>(() => readState(clarification))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const { drafts, submitted, stale } = state

  const update = (next: Partial<CardState>) => {
    setState((current) => {
      const merged = { ...current, ...next }
      writeCardState(cardKeyOf(clarification), merged)
      return merged
    })
  }

  useEffect(() => {
    // 请求 ID 变化（同一个会话里出现新的澄清）时才重置；视图切换重建时保留已填内容。
    setState(readState(clarification))
    setSubmitting(false)
    setError('')
  }, [clarification.requestId])

  const answerFor = (question: ChatClarificationQuestion, index: number) => {
    const draft = drafts[questionKey(question, index)] || { choices: [], text: '' }
    if (draft.text.trim()) return draft.text.trim()
    if (!draft.choices.length) return ''
    const choices = draft.choices.map(visibleChoice)
    return question.multiSelect ? JSON.stringify(choices) : choices[0]
  }

  const answers = useMemo(() => clarification.questions.map((question, index) => ({
    ...(question.questionId ? { questionId: question.questionId } : {}),
    answer: answerFor(question, index),
  })), [clarification.questions, drafts])
  const answeredCount = answers.filter((answer) => answer.answer).length
  const isApproval = clarification.kind === 'approval'
  const unfinished = clarification.questions.length - answeredCount

  const toggleChoice = (question: ChatClarificationQuestion, index: number, choice: string) => {
    const key = questionKey(question, index)
    const draft = drafts[key] || { choices: [], text: '' }
    const selected = draft.choices.includes(choice)
    const choices = question.multiSelect
      ? selected ? draft.choices.filter((value) => value !== choice) : [...draft.choices, choice]
      : [choice]
    update({ drafts: { ...drafts, [key]: { choices, text: '' } } })
  }

  const updateText = (question: ChatClarificationQuestion, index: number, text: string) => {
    const key = questionKey(question, index)
    update({ drafts: { ...drafts, [key]: { choices: [], text } } })
  }

  const respond = async (payload: ChatClarificationAnswer[]) => {
    if (submitting || submitted || stale || expired) return
    setSubmitting(true)
    setError('')
    try {
      await onRespond(payload)
      update({ submitted: true })
    } catch (reason) {
      const message = errorMessage(reason)
      // 运行已经结束（或这个选择已被处理过）时不再让用户反复点击：直接标成失效并说明下一步。
      if (isGoneMessage(message)) update({ stale: true, submitted: false })
      else setError(message)
    } finally {
      setSubmitting(false)
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (answeredCount !== clarification.questions.length) return
    await respond(answers)
  }

  const skip = () => respond([])
  const respondApproval = (choice: string) => respond([{ answer: visibleChoice(choice) }])

  if (expired) return <div className="chat-clarification-result expired" role="status">{isApproval ? <ShieldAlert size={16} /> : <CircleHelp size={16} />}<span><strong>{isApproval ? '审批已超时' : '选择已超时'}</strong><small>{isApproval ? '为保护你的数据，本次操作已拒绝。' : 'ZSense 已跳过这个问题并继续处理。'}</small></span></div>
  if (stale) return <div className="chat-clarification-result expired" role="status">{isApproval ? <ShieldAlert size={16} /> : <CircleHelp size={16} />}<span><strong>{isApproval ? '这次审批已经失效' : '这次选择已经失效'}</strong><small>对应的运行已经结束或被取消，ZSense 不会再等待这个回答。重新发送一遍需求即可继续。</small></span></div>
  if (submitted) return <div className="chat-clarification-result" role="status" aria-live="polite"><Check size={16} /><span><strong>{isApproval ? '授权选择已提交' : '选择已提交'}</strong><small>ZSense 正在继续处理，请稍候…</small></span></div>

  return (
    <form className={`chat-clarification ${isApproval ? 'approval' : ''}`} onSubmit={submit} aria-label={isApproval ? 'ZSense 操作审批' : 'ZSense 需要补充信息'}>
      <header>
        <span>{isApproval ? <ShieldAlert size={17} /> : <CircleHelp size={17} />}</span>
        <div><strong>{isApproval ? clarification.approvalLabel || '需要授权的操作' : 'ZSense 需要你的选择'}</strong><small>{isApproval ? '只有可能产生重要影响的操作才会询问' : clarification.questions.length > 1 ? `${answeredCount}/${clarification.questions.length} 个问题已回答` : '回答后将继续当前任务'}</small></div>
      </header>
      <div className="chat-clarification-questions">
        {clarification.questions.map((question, index) => {
          const key = questionKey(question, index)
          const draft = drafts[key] || { choices: [], text: '' }
          return (
            <fieldset key={key} disabled={submitting}>
              <legend>{clarification.questions.length > 1 && <span>{index + 1}</span>}{question.question}</legend>
              {question.choices.length > 0 && <div className="chat-clarification-choices">
                {question.choices.map((choice) => {
                  const selected = draft.choices.includes(choice)
                  const approvalClass = isApproval ? visibleChoice(choice) === '拒绝' ? 'approval-deny' : visibleChoice(choice) === '始终允许此类操作' ? 'approval-always' : 'approval-once' : ''
                  const ApprovalIcon = visibleChoice(choice) === '拒绝' ? X : visibleChoice(choice) === '始终允许此类操作' ? ShieldCheck : Check
                  return <button type="button" key={choice} className={`${selected ? 'selected' : ''} ${approvalClass}`} aria-pressed={isApproval ? undefined : selected} onClick={() => isApproval ? void respondApproval(choice) : toggleChoice(question, index, choice)} disabled={submitting}>{isApproval ? <i>{submitting ? <LoaderCircle className="spin" size={13} /> : <ApprovalIcon size={13} />}</i> : <i>{selected && <Check size={13} />}</i>}<span>{visibleChoice(choice)}{choice.endsWith(recommendedSuffix) && <small>推荐</small>}</span></button>
                })}
              </div>}
              {!isApproval && <label className="chat-clarification-other">
                <span>{question.choices.length ? '其他回答' : '你的回答'}</span>
                <textarea rows={2} maxLength={8_000} value={draft.text} onChange={(event) => updateText(question, index, event.target.value)} placeholder={question.choices.length ? '也可以输入自己的答案' : '请输入补充信息'} />
              </label>}
            </fieldset>
          )
        })}
      </div>
      {isApproval && clarification.approvalAutoReason && <p className="chat-approval-auto-note">{clarification.approvalAutoState === 'disabled' ? '未开启自动审批' : clarification.approvalAutoState === 'denied' ? '自动审批判断需要人工确认' : '自动审批这次没有给出判断'}：{clarification.approvalAutoReason}</p>}
      {isApproval && <p className="chat-approval-note">“始终允许”只对当前工作区内的这一类操作生效，可随时在“设置 → 工具与 MCP”撤销；永久禁止的系统级操作不会被放行。</p>}
      {error && <p className="chat-clarification-error" role="alert">{error}</p>}
      {!isApproval && <footer>
        <button type="button" className="button ghost" onClick={() => void skip()} disabled={submitting}>跳过</button>
        <button type="submit" className="button primary" disabled={submitting || answeredCount !== clarification.questions.length}>{submitting ? <><LoaderCircle className="spin" size={14} />正在提交…</> : unfinished > 0 ? `还差 ${unfinished} 项` : '继续'}</button>
      </footer>}
    </form>
  )
}
