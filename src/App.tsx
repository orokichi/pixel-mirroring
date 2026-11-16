import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { link, usbSupported } from './link'
import { Icon, Mark } from './Icon'

const useLink = () => useSyncExternalStore(link.subscribe, link.get)

const NAV: [string, string, string][] = [
  ['back', '戻る', 'arrow_back'],
  ['home', 'ホーム', 'home'],
  ['recents', '履歴', 'history'],
  ['notifications', '通知', 'notifications'],
  ['quick_settings', 'クイック設定', 'tune'],
  ['lock', '画面ロック', 'lock'],
  ['screen_on', '画面を点ける', 'light_mode'],
]

const QUALITY: [string, number, number][] = [
  ['軽い（720px）', 720, 55],
  ['標準（900px）', 900, 62],
  ['きれい（1080px）', 1080, 72],
]

export default function App() {
  const s = useLink()
  const connected = s.phase === 'connected'

  return (
    <div className="app">
      <TopBar />
      <main className="body">
        <Stage />
        <Rail />
      </main>
      <BottomBar />
      <Settings />
      <Help />
      <Toast />
      {s.pending && (
        <div className="modal-wrap">
          <div className="sheet narrow">
            <h2 className="t-title">接続の許可</h2>
            <p className="t-body">
              <b>{s.pending.name}</b> から接続の要求があります。このスマートフォンと繋ぎますか？
            </p>
            <p className="t-small">許可すると、次回からは自動でつながります（この PC のブラウザに記憶します）。</p>
            <div className="row end gap">
              <button className="btn text" onClick={() => s.pending?.reject()}>断る</button>
              <button className="btn filled" onClick={() => s.pending?.accept()}><Icon n="check" />許可</button>
            </div>
          </div>
        </div>
      )}
      {!connected && !s.pending && <Pairing />}
    </div>
  )
}

/* ------------------------------------------------------------------ top bar */
function TopBar() {
  const s = useLink()
  const [full, setFull] = useState(!!document.fullscreenElement)
  useEffect(() => {
    const f = () => setFull(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', f)
    return () => document.removeEventListener('fullscreenchange', f)
  }, [])
  const toggleFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void document.documentElement.requestFullscreen().catch(() => {})
  }
  const viaLabel = s.via === 'usb' ? 'USB ケーブル' : s.via === 'lan' ? '同じ Wi-Fi' : s.via === 'cloud' ? 'クラウド' : ''
  return (
    <header className="top">
      <div className="brand">
        <Mark size={30} />
        <div className="brand-txt">
          <b>Pixelミラーリング</b>
          <span>{s.device ? `${s.device.name}${s.device.android ? ' · Android ' + s.device.android : ''}` : 'スマートフォンと接続していません'}</span>
        </div>
      </div>
      <div className="chips">
        <span className={'chip ' + (s.phase === 'connected' ? 'on' : '')}>
          <Icon n={s.via === 'usb' ? 'usb' : s.via === 'lan' ? 'wifi' : 'cloud'} size={18} />
          {s.phase === 'connected' ? viaLabel : s.phase === 'starting' ? '接続中…' : '待機中'}
        </span>
        {s.phase === 'connected' && (
          <span className="chip" title="スマホまでの往復時間">
            <Icon n="bolt" size={18} />{s.latency != null ? `${s.latency} ms` : '—'}
          </span>
        )}
        <span className={'chip ' + (s.mirror === 'live' ? 'on' : '')} title="フレームレート">
          <Icon n="screen_share" size={18} />{s.mirror === 'live' ? `${s.fps} fps` : '停止'}
        </span>
        {s.mirror === 'live' && (
          <span className="chip" title="取得方法">
            <Icon n={s.mode === 'projection' ? 'high_quality' : 'bolt'} size={18} />
            {s.mode === 'projection' ? 'なめらか' : 'ポップアップなし'}
          </span>
        )}
      </div>
      <div className="top-actions">
        <button className="icon-btn" onClick={() => link.refreshRemote()} title="状態を取得し直す"><Icon n="refresh" /></button>
        <button className="icon-btn" onClick={toggleFull} title={full ? '全画面を終了' : '全画面'}><Icon n={full ? 'fullscreen_exit' : 'fullscreen'} /></button>
        <button className="icon-btn" onClick={() => window.dispatchEvent(new CustomEvent('pm-settings'))} title="設定"><Icon n="settings" /></button>
        <button className="icon-btn" onClick={() => window.dispatchEvent(new CustomEvent('pm-help'))} title="使い方"><Icon n="help" /></button>
      </div>
    </header>
  )
}

/* -------------------------------------------------------------------- stage */
function Stage() {
  const s = useLink()
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const [ripples, setRipples] = useState<{ id: number; x: number; y: number }[]>([])
  const acc = s.acc
  const live = s.mirror === 'live'

  // Fit the phone into whatever space is left: the whole point of this app is
  // that the screen uses the window, so the picture is always as big as it can be.
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight })
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [])

  useEffect(() => link.onFrame((url) => {
    const img = new Image()
    img.onload = () => {
      const c = canvasRef.current
      if (!c) return
      if (c.width !== img.width || c.height !== img.height) { c.width = img.width; c.height = img.height }
      c.getContext('2d')?.drawImage(img, 0, 0)
    }
    img.src = url
  }), [])

  useEffect(() => { link.refreshRemote() }, [])

  /* Keyboard → phone. Keys go to the text bar when it has focus (in there they are
     ordinary editing keys); anywhere else they are the phone's, which is what
     makes typing fast: Esc=戻る, Enter, Backspace, Tab, arrows, Home, and plain
     characters buffered into one message. */
  const buf = useRef('')
  const bufTimer = useRef<number | undefined>(undefined)
  useEffect(() => {
    const flush = () => {
      if (bufTimer.current) { window.clearTimeout(bufTimer.current); bufTimer.current = undefined }
      const t = buf.current
      buf.current = ''
      if (t) link.text(t)
    }
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      if (!acc || !live || !s.kb || e.metaKey || e.altKey) return
      if (e.ctrlKey && e.key.toLowerCase() === 'v') {
        flush()
        void navigator.clipboard?.readText?.().then((t) => t && link.text(t)).catch(() => {})
        e.preventDefault(); return
      }
      if (e.ctrlKey && e.key.toLowerCase() === 'a') { flush(); link.key('select_all'); e.preventDefault(); return }
      const map: Record<string, string> = {
        Enter: 'enter', Backspace: 'backspace', Tab: 'tab', Escape: 'back', Delete: 'delete',
        ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Home: 'home',
      }
      if (map[e.key]) { flush(); link.key(map[e.key]); e.preventDefault(); return }
      if (e.key.length === 1) {
        buf.current += e.key
        if (bufTimer.current) window.clearTimeout(bufTimer.current)
        bufTimer.current = window.setTimeout(flush, 110)
        e.preventDefault()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey); flush() }
  }, [acc, live, s.kb])

  const ar = s.w && s.h ? s.w / s.h : 9 / 19.5
  const pad = 20
  const fitW = Math.max(120, Math.min(box.w - pad * 2, (box.h - pad * 2) * ar))
  const fitH = fitW / ar

  const norm = (e: { clientX: number; clientY: number }) => {
    const c = canvasRef.current
    if (!c) return null
    const b = c.getBoundingClientRect()
    if (!b.width || !b.height) return null
    return {
      x: Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)),
      y: Math.min(1, Math.max(0, (e.clientY - b.top) / b.height)),
    }
  }

  const drag = useRef<{ t: number; x: number; y: number } | null>(null)
  const hoverAt = useRef(0)
  const hear = useRef({ dx: 0, dy: 0, used: false })

  const hover = (p: { x: number; y: number } | null) => {
    if (!p || !acc || !live) return
    const now = Date.now()
    if (now - hoverAt.current < 110) return
    hoverAt.current = now
    link.hover(p.x, p.y)
  }

  const down = (e: React.PointerEvent) => {
    if (!acc || !live) return
    const p = norm(e)
    if (!p) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    drag.current = { t: Date.now(), x: p.x, y: p.y }
  }
  const move = (e: React.PointerEvent) => {
    const p = norm(e)
    if (!p) return
    if (!drag.current) hover(p)
  }
  const ripple = (x: number, y: number) => {
    const id = Date.now() + Math.random()
    setRipples((r) => [...r, { id, x, y }])
    window.setTimeout(() => setRipples((r) => r.filter((v) => v.id !== id)), 480)
  }
  const up = (e: React.PointerEvent) => {
    const d = drag.current
    drag.current = null
    if (!d || !acc || !live) return
    const p = norm(e)
    if (!p) return
    const dt = Date.now() - d.t
    const dist = Math.hypot(p.x - d.x, p.y - d.y)
    if (dist < 0.012) {
      // The ripple is drawn here at once: the tap reaches the phone in a few
      // milliseconds, and this shows the person it went.
      ripple(p.x, p.y)
      if (dt > 650) link.longPress(p.x, p.y)
      else link.tap(p.x, p.y)
    } else {
      link.swipe(d.x, d.y, p.x, p.y, Math.min(1200, Math.max(60, dt)))
    }
  }
  const wheel = (e: React.WheelEvent) => {
    if (!acc || !live) return
    const h = hear.current
    h.dx += e.deltaX
    h.dy += e.deltaY
    if (h.used) return
    h.used = true
    window.setTimeout(() => {
      const { dx, dy } = h
      h.dx = 0; h.dy = 0; h.used = false
      if (Math.abs(dy) < 6 && Math.abs(dx) < 6) return
      const dir = Math.abs(dy) > Math.abs(dx) ? (dy > 0 ? 'down' : 'up') : (dx > 0 ? 'right' : 'left')
      const p = norm(e as any) || { x: 0.5, y: 0.5 }
      link.scroll(dir, p.x, p.y)
    }, 90)
  }

  const showAccBanner = s.phase === 'connected' && !acc

  return (
    <div className="stage" ref={stageRef}>
      <div className="phone" style={{ width: fitW, height: fitH }}>
        <canvas
          ref={canvasRef}
          className={s.hasFrame ? 'on' : ''}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={() => { drag.current = null }}
          onWheel={wheel}
          onContextMenu={(e) => { e.preventDefault(); if (acc && live) link.key('back') }}
          aria-label="スマートフォンの画面"
        />
        {ripples.map((r) => (
          <span key={r.id} className="tap-ripple" style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%` }} aria-hidden="true" />
        ))}
        {!s.hasFrame && (
          <div className="blank">
            {s.mirror === 'requesting' || (s.mirror === 'live' && !s.hasFrame) ? (
              <>
                <span className="spinner" />
                <b>{s.mode === 'projection' ? 'スマホで「今すぐ開始」を押してください' : '画面を取得しています…'}</b>
                <span className="t-small">{s.mode === 'projection' ? 'なめらかモードは開始のたびに許可の確認が出ます' : 'ユーザー補助で取得するので、ダイアログは出ません'}</span>
              </>
            ) : s.mirror === 'error' || s.mirror === 'denied' ? (
              <>
                <Icon n="info" size={40} />
                <b>画面を映せませんでした</b>
                <span className="t-small">{s.reason === 'secure' ? 'この画面は保護されているため取得できません' : 'スマホの Quick Link アプリでユーザー補助をオンにしてから、もう一度お試しください'}</span>
                <button className="btn filled" onClick={() => link.mirrorStart()}><Icon n="refresh" />もう一度</button>
              </>
            ) : (
              <>
                <Icon n="screen_share" size={40} />
                <b>画面はまだ映っていません</b>
                <span className="t-small">{s.phase === 'connected' ? '「画面を映す」を押すと、確認ダイアログなしですぐ映ります' : 'スマートフォンと接続してください'}</span>
                {s.phase === 'connected' && <button className="btn filled" onClick={() => link.mirrorStart()}><Icon n="play_arrow" />画面を映す</button>}
              </>
            )}
          </div>
        )}
        {showAccBanner && (
          <div className="stage-banner">
            <Icon n="touch_app" size={18} />
            <span>ユーザー補助がオフのため操作できません。</span>
            <button className="btn small tonal" onClick={() => link.perm('accessibility')}>スマホで許可画面を開く</button>
          </div>
        )}
      </div>
    </div>
  )
}

/* --------------------------------------------------------------------- rail */
function Rail() {
  const s = useLink()
  const acc = s.acc
  const live = s.mirror === 'live'
  const kb = s.kb
  const sys = s.sys
  const act = (fn: () => void) => (e: React.MouseEvent) => { e.preventDefault(); fn() }
  return (
    <aside className="rail" aria-label="スマートフォンの操作">
      <div className="rail-group">
        {NAV.map(([k, label, ic]) => (
          <button key={k} className="rail-btn" disabled={!acc} title={label} aria-label={label}
            onClick={act(() => link.key(k))}>
            <Icon n={ic} />{k === 'home' && <i className="rail-dot" />}
          </button>
        ))}
      </div>
      <div className="rail-group">
        <button className="rail-btn" disabled={!acc || !sys} title="音量を上げる" aria-label="音量を上げる"
          onClick={act(() => link.volumeUp())}><Icon n="volume_up" /></button>
        <button className="rail-btn" disabled={!acc || !sys} title="音量を下げる" aria-label="音量を下げる"
          onClick={act(() => link.volumeDown())}><Icon n="volume_down" /></button>
        <button className={'rail-btn' + (sys?.rotate ? ' on' : '')} disabled={!sys} title="画面の自動回転" aria-label="画面の自動回転"
          onClick={act(() => link.toggleRotate())}><Icon n="screen_rotation" /></button>
        <button className="rail-btn" disabled={s.phase !== 'connected'} title="PC のクリップボードをスマホへ" aria-label="クリップボードを送る"
          onClick={act(() => void link.sendClipboard())}><Icon n="content_paste" /></button>
      </div>
      <div className="rail-group">
        {live ? (
          <button className="rail-btn accent" title="ミラーリングを停止" aria-label="ミラーリングを停止"
            onClick={act(() => link.mirrorStop())}><Icon n="stop_circle" /></button>
        ) : (
          <button className="rail-btn accent" disabled={s.phase !== 'connected'} title="画面を映す（ポップアップなし）" aria-label="画面を映す"
            onClick={act(() => link.mirrorStart())}><Icon n="play_arrow" /></button>
        )}
        <button className="rail-btn" disabled={s.phase !== 'connected'} title="なめらかモード（毎回許可が出ます）" aria-label="なめらかモード"
          onClick={act(() => link.mirrorStart('projection'))}><Icon n="high_quality" /></button>
        <button className={'rail-btn' + (kb ? ' on' : '')} title="キーボード入力を切り替え" aria-label="キーボード入力"
          onClick={act(() => link.toggleKb())}><Icon n={kb ? 'keyboard' : 'keyboard_hide'} /></button>
      </div>
      <div className="rail-group usb">
        <button className="rail-btn" disabled={!s.usbSupported || s.usbBusy} title="USB ケーブルで接続（ネット不要）" aria-label="USB 接続"
          onClick={act(() => void link.connectUsb())}><Icon n="usb" /></button>
      </div>
      {window.innerWidth > 1100 && <p className="rail-hint">Esc＝戻る / 矢印＝移動<br />Enter・Backspace・Ctrl+V</p>}    </aside>
  )
}

/* --------------------------------------------------------------- bottom bar */
function BottomBar() {
  const s = useLink()
  const [text, setText] = useState('')
  const acc = s.acc
  const live = s.mirror === 'live'
  const send = () => {
    if (!text) return
    link.text(text)
    setText('')
  }
  // Typing goes to whichever field has focus here — a plain text bar is far more
  // reliable than translating every keystroke into remote pokes.
  return (
    <footer className="bar">
      <div className="bar-left">
        <span className="bar-label"><Icon n="keyboard" size={18} />{acc ? '文字入力' : '操作はユーザー補助が必要'}</span>
      </div>
      <div className="bar-input">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); send() } }}
          placeholder="スマホの入力欄に送る文字（Enter で送信）"
          aria-label="スマホへ送る文字"
          disabled={!acc}
        />
        <button className="icon-btn filled" onClick={send} disabled={!acc || !text} title="送る"><Icon n="send" /></button>
      </div>
      <div className="bar-right">
        <button className="btn small tonal" disabled={!acc} onClick={() => void link.sendClipboard()}><Icon n="content_paste" />クリップボード</button>
        <button className="btn small tonal" disabled={!live} onClick={() => link.key('enter')}><Icon n="keyboard_return" />Enter</button>
        <span className="bar-fps">{live ? `${s.fps} fps` : s.phase === 'connected' ? '待機' : '未接続'}</span>
      </div>
    </footer>
  )
}

/* ------------------------------------------------------------------ pairing */
function Pairing() {
  const s = useLink()
  const [qr, setQr] = useState<string>('')
  useEffect(() => {
    let alive = true
    void import('qrcode').then((m) => m.default.toDataURL(link.qrText, {
      margin: 1, width: 320, errorCorrectionLevel: 'M',
      color: { dark: '#0d0d12', light: '#ffffff' },
    })).then((url) => { if (alive) setQr(url) }).catch(() => {})
    return () => { alive = false }
  }, [s.code, s.secret])
  return (
    <div className="modal-wrap pair">
      <div className="sheet pair-sheet">
        <div className="pair-cols">
          <div className="pair-main">
            <div className="row gap center">
              <Mark size={34} />
              <h1 className="t-head">Pixelミラーリング</h1>
            </div>
            <p className="t-body">
              スマホの <b>Quick Link</b> アプリで、この QR コードを読み取ってください。コードを入力する場合は下の 6 文字です。
            </p>
            <div className="qr-box">{qr ? <img src={qr} alt="ペアリング用 QR コード" /> : <span className="spinner" />}</div>
            <div className="code-row">
              <span className="code">{s.code.split('').join(' ')}</span>
              <button className="icon-btn" title="コードを作り直す" onClick={() => link.regenerate()}><Icon n="refresh" /></button>
            </div>
            <p className="t-small">
              一度つなげば、次からは同じ Wi-Fi で直接つながります（インターネットを経由しません）。USB ケーブルがあればネットなしでも使えます。
            </p>
            <div className="row gap wrap">
              <button className="btn tonal" disabled={!s.usbSupported || s.usbBusy} onClick={() => void link.connectUsb()}>
                <Icon n="usb" />USB ケーブルで接続
              </button>
              <button className="btn text" onClick={() => window.dispatchEvent(new CustomEvent('pm-settings'))}>
                <Icon n="settings" />ローカル接続先を指定
              </button>
            </div>
            {s.usbMessage && <p className="t-small warn">{s.usbMessage}</p>}
            {!usbSupported() && <p className="t-small">USB 接続は PC の Chrome / Edge で開いたときだけ使えます。</p>}
          </div>
          <div className="pair-side">
            <h2 className="t-title">はじめに、スマホで 2 つだけ</h2>
            <ol className="steps">
              <li><b>ユーザー補助（リモート操作）をオン</b><span>Quick Link アプリ →「連携する機能」→「ユーザー補助（リモート操作）」。操作と画面取得の両方がこれ 1 つで済み、画面共有のたびの確認ダイアログも出ません。</span></li>
              <li><b>Quick Link アプリを開いたままにする</b><span>アプリが動いている間、この画面とつながります。</span></li>
            </ol>
            <p className="t-small">スマホの画面は PC に表示するだけで、どこにも保存しません。</p>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ----------------------------------------------------------------- settings */
function Settings() {
  const s = useLink()
  const [open, setOpen] = useState(false)
  const [ip, setIp] = useState('')
  const [port, setPort] = useState('47822')
  const [auto, setAuto] = useState(link.auto)
  const [q, setQ] = useState(`${link.long}:${link.quality}`)
  useEffect(() => {
    const f = () => {
      const t = link.state.lanManual
      setOpen(true); setIp(t?.ips[0] || ''); setPort(String(t?.port || 47822))
    }
    window.addEventListener('pm-settings', f)
    return () => window.removeEventListener('pm-settings', f)
  }, [])
  if (!open) return null
  const close = () => setOpen(false)
  return (
    <div className="modal-wrap" onClick={close}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2 className="t-title">設定</h2>
          <button className="icon-btn" onClick={close}><Icon n="close" /></button>
        </div>

        <section className="sec">
          <h3 className="t-sub">画面の画質</h3>
          <div className="seg">
            {QUALITY.map(([label, long, quality]) => (
              <button key={long} className={'seg-btn' + (q === `${long}:${quality}` ? ' on' : '')}
                onClick={() => { setQ(`${long}:${quality}`); link.setQuality(long, quality) }}>{label}</button>
            ))}
          </div>
          <p className="t-small">ポップアップなしの取得（ユーザー補助）は Android の制限で毎秒 3 コマ程度までです。なめらかモード（MediaProjection）は毎秒 15〜20 コマですが、開始のたびにスマホで許可が必要です。</p>
        </section>

        <section className="sec">
          <label className="check">
            <input type="checkbox" checked={auto} onChange={(e) => { setAuto(e.target.checked); link.setAuto(e.target.checked) }} />
            <span>接続したら自動でミラーリングを始める</span>
          </label>
        </section>

        <section className="sec">
          <h3 className="t-sub">ローカル接続先（同じ Wi-Fi）</h3>
          <p className="t-small">ふだんは自動で見つかります。固定 IP のスマホなど、見つからないときだけ指定してください。</p>
          <div className="row gap">
            <input className="field" placeholder="192.168.1.23" value={ip} onChange={(e) => setIp(e.target.value)} inputMode="decimal" />
            <input className="field narrow" placeholder="47822" value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
          </div>
          <div className="row gap wrap">
            <button className="btn tonal" onClick={() => link.setManualLan(ip, Number(port))}><Icon n="save" />保存</button>
            <button className="btn text" onClick={() => { link.clearManualLan(); setIp('') }}>自動検出に戻す</button>
            <button className="btn text" disabled={s.lanBusy} onClick={() => void link.connectLocal()}><Icon n="link" />今すぐ試す</button>
          </div>
          <p className="t-small">{s.lan ? `いま分かっている接続先: ${s.lan.ips.join(' / ')}:${s.lan.port}` : 'スマホと一度つながると、接続先が自動で記録されます。'}</p>
        </section>

        <section className="sec">
          <h3 className="t-sub">接続</h3>
          <div className="kv"><span>状態</span><b>{s.phase === 'connected' ? `接続中（${s.via}）` : '待機中'}</b></div>
          <div className="kv"><span>端末</span><b>{s.device ? `${s.device.name} · ${s.device.model}` : '—'}</b></div>
          <div className="kv"><span>ユーザー補助</span><b>{s.acc ? 'オン' : 'オフ'}</b></div>
          <div className="kv"><span>ミラーリング</span><b>{s.mirror === 'live' ? `${s.mode === 'projection' ? 'なめらか' : 'ポップアップなし'} ${s.fps}fps` : '停止'}</b></div>
          <div className="row gap wrap">
            {s.via === 'usb' && <button className="btn tonal" onClick={() => link.disconnectUsb()}><Icon n="usb_off" />USB を外す</button>}
            <button className="btn text" onClick={() => link.regenerate()}><Icon n="key" />ペアリングコードを作り直す</button>
          </div>
        </section>

        <p className="t-small">Pixelミラーリング 1.0.0 · Quick Link アプリ v1.5.1 以降に対応</p>
      </div>
    </div>
  )
}

/* --------------------------------------------------------------------- help */
function Help() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const f = () => setOpen(true)
    window.addEventListener('pm-help', f)
    return () => window.removeEventListener('pm-help', f)
  }, [])
  if (!open) return null
  return (
    <div className="modal-wrap" onClick={() => setOpen(false)}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2 className="t-title">使い方</h2>
          <button className="icon-btn" onClick={() => setOpen(false)}><Icon n="close" /></button>
        </div>
        <ul className="help">
          <li><b>クリック</b> タップ / <b>ダブルクリック</b> 2 回タップ / <b>長押し</b> 長押し</li>
          <li><b>ドラッグ</b> スワイプ（画面のスクロール・スライダー）</li>
          <li><b>ホイール</b> スクロール / <b>右クリック</b> 戻る</li>
          <li><b>キーボード</b> 下の入力欄から文字を送信。Esc＝戻る、Enter、Backspace、Tab、矢印キー、Home も送れます（画面をクリックしてから打鍵）</li>
          <li><b>右のツールバー</b> 戻る・ホーム・履歴・通知・クイック設定・画面ロック・音量・自動回転・クリップボード</li>
          <li><b>画面を映す</b> ユーザー補助がオンなら、確認ダイアログなしですぐ映ります（毎秒 3 コマ程度）。なめらかにしたいときは「なめらかモード」で、開始時にスマホで許可します</li>
        </ul>
        <p className="t-small">電源ボタンの長押しメニューやロック画面での操作は Android が許可していないため行いません（画面ロックは実行できます）。</p>
        <p className="t-small">スマホは一度に 1 台の PC とペアリングします。Quick Link（元のアプリ）と交互に使うときは、切り替えた側でもう一度「許可」を押してください。</p>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------- toast */
function Toast() {
  const s = useLink()
  if (!s.note) return null
  return <div className="toast" role="status">{s.note}</div>
}
