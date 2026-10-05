import { CheckCircle2, ExternalLink, LoaderCircle, RefreshCw, ShieldCheck, TriangleAlert } from 'lucide-react'
import type { DwsAuthStatus } from '../types'

interface DwsAuthSetupDialogProps {
  status: DwsAuthStatus
  onLogin: () => Promise<void>
  onRefresh: () => Promise<void>
  onLater: () => void
}

export function DwsAuthSetupDialog({ status, onLogin, onRefresh, onLater }: DwsAuthSetupDialogProps) {
  const busy = status.state === 'checking' || status.state === 'authorizing'
  const unavailable = !status.available
  return (
    <div className="modal-layer dws-auth-layer" role="presentation">
      <section className="dws-auth-dialog" role="dialog" aria-modal="true" aria-labelledby="dws-auth-title" aria-describedby="dws-auth-description">
        <header>
          <span className={`dws-auth-mark ${status.state}`}>
            {busy ? <LoaderCircle className="spin" size={24} /> : status.authenticated ? <CheckCircle2 size={24} /> : <ShieldCheck size={24} />}
          </span>
          <span>
            <small>DINGTALK FILE ACCESS</small>
            <h2 id="dws-auth-title">连接钉钉文件读取</h2>
          </span>
        </header>
        <div className="dws-auth-body">
          <p id="dws-auth-description">ZSense 会在你首次使用钉钉能力时检查 dws 登录状态。登录后，机器人会通过钉钉原始消息定位你发送或引用的文件，并把文件保存到当前会话工作区后交给 Agent 读取。</p>
          <div className={`dws-auth-status ${status.state}`}>
            {status.state === 'error' || unavailable ? <TriangleAlert size={17} /> : busy ? <LoaderCircle className="spin" size={17} /> : <ShieldCheck size={17} />}
            <span><strong>{busy ? '正在等待授权' : unavailable ? 'dws 当前不可用' : '需要钉钉登录'}</strong><small>{status.message}</small></span>
          </div>
          <ol>
            <li><span>1</span><div><strong>打开安全授权页</strong><small>点击登录后由 ZSense 内置临时浏览器打开 dws 授权，不需要填写 Token。</small></div></li>
            <li><span>2</span><div><strong>在钉钉确认登录</strong><small>授权完成后页面会自动关闭，ZSense 会立即重新验证登录状态。</small></div></li>
            <li><span>3</span><div><strong>启用文件读取</strong><small>优先读取 quotedMessage 与 resourceRefs；机器人回调下载仅作为兼容兜底。</small></div></li>
          </ol>
        </div>
        <footer>
          <button className="button secondary" type="button" onClick={onLater} disabled={busy}>暂不使用钉钉文件</button>
          <button className="button secondary" type="button" onClick={() => void onRefresh()} disabled={busy}><RefreshCw size={15} />重新检测</button>
          <button className="button primary" type="button" onClick={() => void onLogin()} disabled={busy || unavailable}>{busy ? <LoaderCircle className="spin" size={15} /> : <ExternalLink size={15} />}{status.state === 'authorizing' ? '等待钉钉确认…' : '登录钉钉'}</button>
        </footer>
      </section>
    </div>
  )
}
