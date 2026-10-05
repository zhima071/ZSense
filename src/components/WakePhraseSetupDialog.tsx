import { Check, CircleAlert, LoaderCircle, Mic2, RefreshCw, ShieldCheck, Sparkles, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { startVoiceTextCapture, voiceTextRecognitionSupported, wakePhraseMatches, type VoiceTextCaptureHandle } from '../services/voice-wake'
import { VOICE_LANGUAGE } from '../services/voice-language'

interface WakePhraseSetupDialogProps {
  open: boolean
  initialPhrase: string
  onClose: () => void
  onApply: (phrase: string) => void
}

type EnrollmentStage = 'guide' | 'recording' | 'review' | 'testing' | 'success'

function cleanPhrase(value: string): string {
  return value.normalize('NFKC').trim().replace(/^[“”"'‘’]+|[“”"'‘’，。！？!?.,]+$/g, '').replace(/\s+/g, ' ').slice(0, 32)
}

function phraseError(value: string): string {
  const phrase = cleanPhrase(value)
  if (phrase.length < 2) return '唤醒词至少需要 2 个字符。'
  if (!/[\p{L}\p{N}]/u.test(phrase)) return '唤醒词需要包含文字或数字。'
  return ''
}

function stepState(stage: EnrollmentStage, step: number): 'done' | 'active' | '' {
  const current = stage === 'guide' ? 1 : stage === 'recording' || stage === 'review' ? 2 : 3
  return step < current ? 'done' : step === current ? 'active' : ''
}

export function WakePhraseSetupDialog({ open, initialPhrase, onClose, onApply }: WakePhraseSetupDialogProps) {
  const [stage, setStage] = useState<EnrollmentStage>('guide')
  const [phrase, setPhrase] = useState(initialPhrase)
  const [liveTranscript, setLiveTranscript] = useState('')
  const [testTranscript, setTestTranscript] = useState('')
  const [error, setError] = useState('')
  const captureRef = useRef<VoiceTextCaptureHandle | null>(null)
  const supported = voiceTextRecognitionSupported()

  const close = () => {
    captureRef.current?.cancel()
    captureRef.current = null
    onClose()
  }

  useEffect(() => {
    if (!open) return
    setStage('guide')
    setPhrase(initialPhrase || '你好 ZSense')
    setLiveTranscript('')
    setTestTranscript('')
    setError('')
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      captureRef.current?.cancel()
      captureRef.current = null
    }
  // Reset only when the dialog is opened; closing is handled by the parent.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) return null

  const record = async () => {
    setError('')
    setLiveTranscript('')
    setStage('recording')
    try {
      const capture = startVoiceTextCapture({
        language: VOICE_LANGUAGE,
        mode: 'enrollment',
        timeoutMs: 12_000,
        onInterim: setLiveTranscript,
      })
      captureRef.current = capture
      const result = await capture.result
      const nextPhrase = cleanPhrase(result.transcript)
      const nextError = phraseError(nextPhrase)
      if (nextError) throw new Error(nextError)
      setPhrase(nextPhrase)
      setLiveTranscript(result.transcript)
      setStage('review')
    } catch (recordError) {
      if (recordError instanceof Error && recordError.name === 'AbortError') return
      setError(recordError instanceof Error ? recordError.message : '唤醒词录入失败，请重试。')
      setStage('guide')
    } finally {
      captureRef.current = null
    }
  }

  const test = async () => {
    const nextError = phraseError(phrase)
    if (nextError) {
      setError(nextError)
      return
    }
    setError('')
    setTestTranscript('')
    setStage('testing')
    try {
      const capture = startVoiceTextCapture({
        language: VOICE_LANGUAGE,
        mode: 'enrollment',
        timeoutMs: 10_000,
        onInterim: setTestTranscript,
      })
      captureRef.current = capture
      const result = await capture.result
      setTestTranscript(result.transcript)
      if (!wakePhraseMatches(phrase, result.transcript)) {
        throw new Error(`听到“${result.transcript}”，但没有匹配“${cleanPhrase(phrase)}”。请保持相同说法再试一次。`)
      }
      setStage('success')
    } catch (testError) {
      if (testError instanceof Error && testError.name === 'AbortError') return
      setError(testError instanceof Error ? testError.message : '唤醒测试失败，请重试。')
      setStage('review')
    } finally {
      captureRef.current = null
    }
  }

  const apply = () => {
    const nextPhrase = cleanPhrase(phrase)
    const nextError = phraseError(nextPhrase)
    if (nextError) {
      setError(nextError)
      return
    }
    onApply(nextPhrase)
    close()
  }

  return createPortal(
    <div className="wake-enrollment-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}>
      <section className="wake-enrollment-dialog" role="dialog" aria-modal="true" aria-labelledby="wake-enrollment-title">
        <header>
          <span className="wake-enrollment-icon"><Sparkles size={20} /></span>
          <span><small>VOICE SETUP</small><h2 id="wake-enrollment-title">录入自定义唤醒词</h2><p>跟随引导说一次、确认文字，再进行一次唤醒测试。</p></span>
          <button type="button" className="icon-button" onClick={close} aria-label="关闭唤醒词录入"><X size={18} /></button>
        </header>

        <ol className="wake-enrollment-steps" aria-label="录入进度">
          {['准备', '录入', '测试'].map((label, index) => <li className={stepState(stage, index + 1)} key={label}><span>{stepState(stage, index + 1) === 'done' ? <Check size={13} /> : index + 1}</span><strong>{label}</strong></li>)}
        </ol>

        {stage === 'guide' && <div className="wake-enrollment-body">
          <div className="wake-enrollment-guidance">
            <strong>先准备一个容易识别的短语</strong>
            <ul><li>建议使用 4–8 个中文字符；品牌名称可以保留原文。</li><li>避开“你好”“开始”等日常高频短语，减少误唤醒。</li><li>在安静环境中，以平时说话的音量录入。</li></ul>
          </div>
          {!supported && <div className="wake-enrollment-alert" role="alert"><CircleAlert size={17} /><span>当前系统没有提供语音识别，仍可直接输入唤醒词并保存。</span></div>}
          <label className="wake-enrollment-input" htmlFor="wake-phrase-manual"><span>也可以直接输入</span><input id="wake-phrase-manual" value={phrase} maxLength={32} onChange={(event) => { setPhrase(event.target.value); setError('') }} placeholder="例如：你好小智" autoFocus /></label>
          {error && <div className="wake-enrollment-alert error" role="alert"><CircleAlert size={17} /><span>{error}</span></div>}
          <div className="wake-enrollment-actions"><button type="button" className="button secondary" onClick={apply}>直接使用</button><button type="button" className="button primary" onClick={() => void record()} disabled={!supported}><Mic2 size={17} />开始录入</button></div>
        </div>}

        {stage === 'recording' && <div className="wake-enrollment-body recording" aria-live="polite">
          <span className="wake-recording-orb"><Mic2 size={26} /><i /><i /></span>
          <strong>请清楚地说出你的唤醒词</strong>
          <p>{liveTranscript ? `正在识别：${liveTranscript}` : '正在聆听…说完后稍作停顿即可。'}</p>
          <button type="button" className="button secondary" onClick={() => { captureRef.current?.cancel(); setStage('guide') }}>取消录入</button>
        </div>}

        {(stage === 'review' || stage === 'testing') && <div className="wake-enrollment-body">
          <label className="wake-enrollment-input" htmlFor="wake-phrase-review"><span>识别到的唤醒词</span><input id="wake-phrase-review" value={phrase} maxLength={32} onChange={(event) => { setPhrase(event.target.value); setError('') }} /></label>
          <div className={`wake-test-card ${stage === 'testing' ? 'active' : ''}`} aria-live="polite"><span>{stage === 'testing' ? <LoaderCircle className="spin" size={21} /> : <Mic2 size={21} />}</span><div><strong>{stage === 'testing' ? `请再说一次“${cleanPhrase(phrase)}”` : '测试实际唤醒效果'}</strong><p>{stage === 'testing' ? testTranscript || '正在聆听…' : '测试通过后再使用，可以提前发现识别偏差。'}</p></div></div>
          {error && <div className="wake-enrollment-alert error" role="alert"><CircleAlert size={17} /><span>{error}</span></div>}
          <div className="wake-enrollment-actions"><button type="button" className="button secondary" onClick={() => void record()} disabled={stage === 'testing'}><RefreshCw size={16} />重新录入</button><button type="button" className="button primary" onClick={() => void test()} disabled={stage === 'testing'}>{stage === 'testing' ? <LoaderCircle className="spin" size={16} /> : <Mic2 size={16} />}测试唤醒</button></div>
        </div>}

        {stage === 'success' && <div className="wake-enrollment-body success" aria-live="polite">
          <span className="wake-success-icon"><Check size={26} /></span>
          <strong>唤醒测试成功</strong>
          <p>ZSense 已能识别“{cleanPhrase(phrase)}”。使用后，点击设置页的“保存设置”即可开始监听。</p>
          <div className="wake-enrollment-actions"><button type="button" className="button secondary" onClick={() => setStage('review')}>再测试一次</button><button type="button" className="button primary" onClick={apply}><Check size={16} />使用此唤醒词</button></div>
        </div>}

        <footer><ShieldCheck size={15} /><span>录入音频只用于本次识别，不写入数据库，也不会作为声纹保存。</span></footer>
      </section>
    </div>,
    document.body,
  )
}
