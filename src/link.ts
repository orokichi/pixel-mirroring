// Pixelミラーリング — the link between this page and the paired Android phone.
//
// It speaks exactly the protocol the Quick Link Android app already uses, so no
// new APK is needed to use this app: the same pairing code / QR, the same LAN
// direct route, the same USB cable socket and the same cloud fallback. What is
// left out is everything that is not mirroring and control — notifications,
// SMS, files, photos — so this page starts small and stays fast.
//
// The heavy libraries (PeerJS, the ADB stack, the QR renderer) are imported the
// moment they are needed, never on the first paint.
import type { Adb, AdbSocket } from '@yume-chan/adb'
import type { AdbDaemonWebUsbDevice } from '@yume-chan/adb-daemon-webusb'
import type { DataConnection } from 'peerjs'
import type PeerType from 'peerjs'

export type Phase = 'starting' | 'waiting' | 'connected'
export type Via = 'lan' | 'cloud' | 'usb'
export type MirrorState = 'off' | 'requesting' | 'live' | 'denied' | 'error'
/** '' = not running, 'accessibility' = popup-free screenshot stream,
 *  'projection' = MediaProjection (smooth, asks for consent each start). */
export type MirrorMode = '' | 'accessibility' | 'projection'

export interface Device { name: string; model: string; android: string }
export interface LanEps { ips: string[]; port: number }

export interface Sys { rotate: boolean | null; vol: number; volMax: number; muted: boolean }

export interface State {
  phase: Phase
  code: string
  secret: string
  error?: string
  device?: Device
  via?: Via
  sys?: Sys | null
  /** A phone asked to pair: the person confirms it here. */
  pending?: { name: string; accept: () => void; reject: () => void }
  /** ユーザー補助（リモート操作 / 画面取得）がスマホ側でオン. */
  acc: boolean
  mirror: MirrorState
  mode: MirrorMode
  /** The phone's real screen size, in pixels. */
  w: number; h: number
  fps: number
  reason?: string
  latency: number | null
  /** One short line under the header (errors, hints). */
  note?: string
  usbSupported: boolean
  usbBusy: boolean
  usbMessage?: string
  lan?: LanEps
  lanManual?: LanEps
  lanBusy: boolean
  /** PC のキーボードをスマホへ送る（設定に近いトグル）. */
  kb: boolean
  /** The picture is held outside React state (see onFrame). */
  hasFrame: boolean
}

const AL = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const rand = (n: number, a = AL) =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => a[b % a.length]).join('')
const ls = {
  get: (k: string) => { try { return localStorage.getItem('pm.' + k) } catch { return null } },
  set: (k: string, v: string) => { try { localStorage.setItem('pm.' + k, v) } catch {} },
  del: (k: string) => { try { localStorage.removeItem('pm.' + k) } catch {} },
}

const HEARTBEAT_MS = 4000
const HEARTBEAT_DEAD_MS = 14000

function parseLan(s: string | null): LanEps | undefined {
  try {
    const v = JSON.parse(s || 'null')
    if (v && Array.isArray(v.ips) && v.ips.length && v.port > 0) return { ips: v.ips.slice(0, 4), port: v.port }
  } catch {}
  return undefined
}

async function sha256Hex(s: string) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')
}

/* ------------------------------------------------------------------ framing
   LAN / cloud: JSON text framed as [0x00]+utf8, or
   [0x01][id:u32][idx:u16][total:u16]+slice(<=16000B) when large.
   USB: [length:u32 big-endian][utf8 JSON] on a byte stream.
   These are the phone's own codecs (bridge.html / UsbServer.kt). */
interface Transport {
  kind: Via
  readonly open: boolean
  send(m: any): void
  close(): void
  buffered(): number
}

const FRAME_CHUNK = 16000
let frameSeq = 1
function encodeFrames(text: string): ArrayBuffer[] {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length <= FRAME_CHUNK) {
    const f = new Uint8Array(bytes.length + 1); f[0] = 0; f.set(bytes, 1); return [f.buffer]
  }
  const id = (frameSeq = (frameSeq + 1) >>> 0) || (frameSeq = 1)
  const total = Math.ceil(bytes.length / FRAME_CHUNK)
  const out: ArrayBuffer[] = []
  for (let i = 0; i < total; i++) {
    const slice = bytes.subarray(i * FRAME_CHUNK, (i + 1) * FRAME_CHUNK)
    const f = new Uint8Array(9 + slice.length); const dv = new DataView(f.buffer)
    f[0] = 1; dv.setUint32(1, id); dv.setUint16(5, i); dv.setUint16(7, total); f.set(slice, 9)
    out.push(f.buffer)
  }
  return out
}
function makeFrameDecoder(onText: (s: string) => void) {
  const pending = new Map<number, { parts: (Uint8Array | undefined)[]; got: number }>()
  const dec = new TextDecoder()
  return (buf: ArrayBuffer) => {
    const u = new Uint8Array(buf); if (!u.length) return
    if (u[0] === 0) { onText(dec.decode(u.subarray(1))); return }
    if (u[0] !== 1 || u.length < 9) return
    const dv = new DataView(u.buffer, u.byteOffset, u.byteLength)
    const id = dv.getUint32(1), idx = dv.getUint16(5), total = dv.getUint16(7)
    let p = pending.get(id); if (!p) { p = { parts: new Array(total), got: 0 }; pending.set(id, p) }
    if (p.parts[idx] === undefined) { p.parts[idx] = u.slice(9); p.got++ }
    if (p.got === total) {
      pending.delete(id)
      let len = 0; for (const x of p.parts) len += x!.length
      const all = new Uint8Array(len); let o = 0
      for (const x of p.parts) { all.set(x!, o); o += x!.length }
      onText(dec.decode(all))
    }
  }
}
function waitIce(pc: RTCPeerConnection, ms: number) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise<void>((res) => {
    const to = setTimeout(done, ms)
    function done() { pc.removeEventListener('icegatheringstatechange', f); clearTimeout(to); res() }
    function f() { if (pc.iceGatheringState === 'complete') done() }
    pc.addEventListener('icegatheringstatechange', f)
  })
}
function firstOk<T>(promises: Promise<T>[]): Promise<T> {
  return new Promise((resolve, reject) => {
    let left = promises.length
    if (!left) return reject(new Error('none'))
    for (const p of promises) p.then(resolve, () => { if (--left === 0) reject(new Error('all failed')) })
  })
}

class PeerTransport implements Transport {
  kind: Via = 'cloud'
  constructor(private c: DataConnection) {}
  get open() { return this.c.open }
  send(m: any) { this.c.send(m) }
  close() { try { this.c.close() } catch {} }
  buffered() { return ((this.c as any).dataChannel as RTCDataChannel | undefined)?.bufferedAmount ?? 0 }
}

class LanTransport implements Transport {
  kind: Via = 'lan'
  onmsg: (m: any) => void = () => {}
  onclose: () => void = () => {}
  private closed = false
  private dec = makeFrameDecoder((s) => { try { this.onmsg(JSON.parse(s)) } catch {} })
  constructor(private pc: RTCPeerConnection, private dc: RTCDataChannel) {
    dc.binaryType = 'arraybuffer'
    dc.onmessage = (e) => { if (e.data instanceof ArrayBuffer) this.dec(e.data) }
    dc.onclose = () => this.fireClose()
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed') this.fireClose()
    }
  }
  private fireClose() { if (!this.closed) { this.closed = true; this.onclose() } }
  get open() { return this.dc.readyState === 'open' }
  send(m: any) { for (const f of encodeFrames(JSON.stringify(m))) this.dc.send(f) }
  close() { try { this.dc.close() } catch {} try { this.pc.close() } catch {} this.fireClose() }
  buffered() { return this.dc.bufferedAmount }
}

/* USB cable: the browser is the ADB host (WebUSB), and the phone serves the
   same JSON protocol on `localabstract:tsunagu-usb`. No network at all. */
const USB_SOCKET = 'localabstract:tsunagu-usb'
const USB_MAX_FRAME = 16 * 1024 * 1024
export const usbSupported = () => typeof navigator !== 'undefined' && !!(navigator as any).usb

class UsbTransport implements Transport {
  kind: Via = 'usb'
  onmsg: (m: any) => void = () => {}
  onclose: () => void = () => {}
  private closed = false
  private acc = new Uint8Array(0)
  private queue: Uint8Array[] = []
  private queued = 0
  private writing = false
  private reader: any
  private writer: any
  private dec = new TextDecoder()
  constructor(private sock: AdbSocket) {
    this.reader = (sock.readable as any).getReader()
    this.writer = (sock.writable as any).getWriter()
    void this.pump()
  }
  private async pump() {
    try {
      for (;;) {
        const { value, done } = await this.reader.read()
        if (done) break
        if (value) this.feed(value as Uint8Array)
      }
    } catch { /* unplugged */ }
    this.fireClose()
  }
  private feed(chunk: Uint8Array) {
    if (this.closed) return
    const all = new Uint8Array(this.acc.length + chunk.length)
    all.set(this.acc); all.set(chunk, this.acc.length)
    let off = 0
    while (all.length - off >= 4) {
      const len = ((all[off] << 24) | (all[off + 1] << 16) | (all[off + 2] << 8) | all[off + 3]) >>> 0
      if (len === 0 || len > USB_MAX_FRAME) { this.close(); return }
      if (all.length - off - 4 < len) break
      const body = all.subarray(off + 4, off + 4 + len)
      off += 4 + len
      try { this.onmsg(JSON.parse(this.dec.decode(body))) } catch {}
    }
    this.acc = all.slice(off)
  }
  private async drain() {
    if (this.writing) return
    this.writing = true
    try {
      while (this.queue.length && !this.closed) {
        const f = this.queue.shift()!
        await this.writer.write(f)
        this.queued -= f.length
      }
    } catch { this.fireClose() }
    this.writing = false
  }
  private fireClose() { if (!this.closed) { this.closed = true; this.onclose() } }
  get open() { return !this.closed }
  send(m: any) {
    if (this.closed) return
    const body = new TextEncoder().encode(JSON.stringify(m))
    const f = new Uint8Array(4 + body.length)
    new DataView(f.buffer).setUint32(0, body.length)
    f.set(body, 4)
    this.queue.push(f); this.queued += f.length
    void this.drain()
  }
  close() {
    if (this.closed) return
    this.closed = true
    try { void this.writer?.close() } catch {}
    try { void this.reader?.cancel() } catch {}
    try { void (this.sock as any).close?.() } catch {}
    this.onclose()
  }
  buffered() { return this.queued }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(message)), ms)
    p.then((v) => { clearTimeout(to); resolve(v) }, (e) => { clearTimeout(to); reject(e) })
  })
}
class UsbNoAppError extends Error {}
function usbErrorText(e: any): string {
  const name = String(e?.name || '')
  const msg = String(e?.message || '')
  if (/busy/i.test(name) || /busy/i.test(msg)) return 'スマホが他の adb（Android Studio・adb コマンド等）に使われています。それを閉じてから、もう一度お試しください。'
  if (name === 'NotFoundError') return 'USB デバイスが選ばれませんでした。'
  if (name === 'SecurityError' || name === 'NetworkError' || name === 'NotAllowedError') return 'USB へのアクセスが許可されませんでした。スマホの画面の確認で「許可」を押してください。'
  if (name === 'InvalidStateError') return 'USB デバイスが既に使われています。ケーブルを差し直してからお試しください。'
  return 'USB 接続に失敗しました' + (msg ? `（${msg}）` : '')
}

/** One restart attempt is enough for a route that failed this cycle. */
class Mirror {
  state: State
  private subs = new Set<() => void>()
  private peer?: PeerType
  private conn?: Transport
  private pendingLan?: LanTransport
  private pendingUsb?: UsbTransport
  private lanTrying = false
  private lanAttemptAt = 0
  private lanFailures = 0
  private usbT?: UsbTransport
  private usbDevice?: AdbDaemonWebUsbDevice
  private adb?: Adb
  private cred?: any
  private lastRx = 0
  private pongs = 0
  private hbTimer?: number
  private reconnectTimer?: number
  private reconnectAttempts = 0
  private peerEpoch = 0
  private frameCb?: (url: string, w: number, h: number) => void
  /** Auto-start runs once per connection, so stopping the mirror stays stopped. */
  private autoStartTried = false
  private noteTimer?: number
  /** Auto-start mirroring on connect (設定, default on). */
  auto = ls.get('auto') !== '0'
  /** Stream options the phone applies while capturing. */
  long = Number(ls.get('long')) || 900
  quality = Number(ls.get('q')) || 62

  constructor() {
    let code = ls.get('code')
    let secret = ls.get('secret')
    if (!code || code.length !== 6) { code = rand(6); ls.set('code', code) }
    if (!secret) { secret = rand(20); ls.set('secret', secret) }
    this.state = {
      phase: 'starting', code, secret,
      acc: false, mirror: 'off', mode: '', w: 0, h: 0, fps: 0, latency: null,
      usbSupported: usbSupported(), usbBusy: false,
      lanManual: parseLan(ls.get('lanManual')), lanBusy: false, kb: ls.get('kb') !== '0', hasFrame: false,
    }
    void this.start()
    void this.tryLan()
    this.startHeartbeat()
    window.setInterval(() => this.health(), 15000)
    window.addEventListener('focus', () => { if (!this.conn?.open) this.reconnectNow() })
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return
      if (!this.conn?.open) this.reconnectNow()
      else { this.lastRx = Date.now(); this.heartbeat() }
    })
    window.addEventListener('online', () => { this.reconnectAttempts = 0; this.reconnectNow() })
  }

  /* ---------------- store ---------------- */
  subscribe = (f: () => void) => { this.subs.add(f); return () => { this.subs.delete(f) } }
  get = () => this.state
  private set(p: Partial<State>) { this.state = { ...this.state, ...p }; this.subs.forEach((f) => f()) }
  note(text: string, ms = 5000) {
    this.set({ note: text })
    clearTimeout(this.noteTimer)
    this.noteTimer = window.setTimeout(() => this.set({ note: undefined }), ms)
  }

  get qrText() { return `tsunagu:${this.state.code}:${this.state.secret}` }

  regenerate() {
    const code = rand(6), secret = rand(20)
    ls.set('code', code); ls.set('secret', secret); ls.set('trusted', '[]')
    this.conn?.close(); this.pendingLan?.close()
    this.set({ code, secret, phase: 'starting', device: undefined, via: undefined, pending: undefined })
    void this.start()
    this.note('ペアリングコードを作り直しました。スマホで読み取り直してください', 7000)
  }

  /* ---------------- cloud (PeerJS) ---------------- */
  private async start() {
    const epoch = ++this.peerEpoch
    try { this.peer?.destroy() } catch {}
    let Peer: typeof PeerType
    try { Peer = (await import('peerjs')).default } catch { this.set({ phase: 'starting' }); this.scheduleReconnect(); return }
    if (epoch !== this.peerEpoch) return
    let peer: PeerType
    try { peer = new Peer('tsunagu-link-' + this.state.code.toLowerCase(), { debug: 0 }) } catch { this.set({ phase: 'starting' }); this.scheduleReconnect(); return }
    this.peer = peer
    peer.on('open', () => { this.reconnectAttempts = 0; this.set({ phase: this.conn?.open ? 'connected' : 'waiting', error: undefined }) })
    peer.on('connection', (c) => {
      const t = new PeerTransport(c)
      c.on('data', (d: any) => this.onData(t, d))
      c.on('close', () => this.onTransportClose(t))
      c.on('error', () => {})
    })
    peer.on('disconnected', () => {
      if (peer.destroyed) return
      try { peer.reconnect() } catch { setTimeout(() => this.scheduleReconnect(), 1500) }
    })
    peer.on('error', (e: any) => {
      if (e.type === 'unavailable-id') this.set({ error: 'このコードは別のタブで使用中です。ほかのタブを閉じてください。' })
      else if (e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error') {
        if (!(this.conn?.kind === 'usb' && this.conn.open)) this.set({ phase: 'starting' })
        this.scheduleReconnect()
      }
    })
  }

  /* ---------------- liveness ---------------- */
  private startHeartbeat() {
    if (this.hbTimer) return
    this.hbTimer = window.setInterval(() => this.heartbeat(), HEARTBEAT_MS)
  }
  private heartbeat() {
    const c = this.conn
    const now = Date.now()
    if (!c) { if (this.state.phase === 'connected') this.set({ phase: 'waiting', via: undefined }); return }
    if (!c.open) { this.dropStale(); return }
    const hidden = typeof document !== 'undefined' && document.hidden
    if (!hidden && this.pongs > 0 && this.lastRx && now - this.lastRx > HEARTBEAT_DEAD_MS) { this.dropStale(); return }
    try { c.send({ t: 'ping', ts: now }) } catch { this.dropStale() }
  }
  private health() {
    if (!this.conn?.open) {
      const p: any = this.peer
      if (!p || p.destroyed) { void this.start(); return }
      if (p.disconnected) { try { p.reconnect() } catch { void this.start() } }
    }
    void this.tryLan()
  }
  private dropStale() {
    const c = this.conn
    this.conn = undefined
    this.set({ phase: 'waiting', via: undefined, mirror: 'off', mode: '', fps: 0, latency: null })
    try { c?.close() } catch {}
    this.note('接続が応答しないため、つなぎ直しています…')
    this.scheduleReconnect(300)
  }
  private scheduleReconnect(delay?: number) {
    const attempt = this.reconnectAttempts++
    const wait = delay ?? Math.min(15000, 500 * Math.pow(1.7, attempt)) + Math.random() * 500
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = window.setTimeout(() => this.reconnectNow(), wait)
  }
  private reconnectNow() {
    if (this.conn?.open) return
    const p: any = this.peer
    if (!p || p.destroyed) void this.start()
    else if (p.disconnected) { try { p.reconnect() } catch { void this.start() } }
    if (navigator.onLine) void this.tryLan()
  }

  /* ---------------- LAN direct (same Wi-Fi) ---------------- */
  private lanTargets(): LanEps[] {
    const out: LanEps[] = []
    const manual = parseLan(ls.get('lanManual'))
    if (manual) out.push(manual)
    const learned = parseLan(ls.get('lan'))
    if (learned) out.push(learned)
    return out
  }
  private async lanAuth(): Promise<string[]> {
    const trusted: string[] = JSON.parse(ls.get('trusted') || '[]')
    return Promise.all([this.state.secret, ...trusted].map(sha256Hex))
  }
  private async lanFetch(ip: string, port: number, path: string, body: any, timeoutMs: number): Promise<any> {
    const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      const r = await fetch(`http://${ip}:${port}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: ctl.signal,
      })
      if (!r.ok) throw new Error('http ' + r.status)
      return await r.json()
    } finally { clearTimeout(to) }
  }
  private async tryLan() {
    if ((this.conn?.kind === 'usb' && this.conn.open) || this.lanTrying || (this.conn?.kind === 'lan' && this.conn.open) || this.pendingLan) return
    const targets = this.lanTargets()
    if (!targets.length) return
    const wait = Math.min(60000, 5000 * Math.pow(1.5, this.lanFailures))
    if (Date.now() - this.lanAttemptAt < wait) return
    this.lanAttemptAt = Date.now()
    this.lanTrying = true
    let ok = false
    try {
      for (const eps of targets) { if (await this.lanConnect(eps)) { ok = true; break } }
    } catch { /* cloud keeps working */ } finally {
      this.lanTrying = false
      this.lanFailures = ok ? 0 : Math.min(8, this.lanFailures + 1)
    }
  }
  private async lanConnect(eps: LanEps): Promise<boolean> {
    this.pendingLan?.close(); this.pendingLan = undefined
    const auth = await this.lanAuth()
    const ip = await firstOk(eps.ips.map(async (ip) => { await this.lanFetch(ip, eps.port, '/ping', { auth }, 1500); return ip }))
    if (this.conn?.kind === 'lan' && this.conn.open) return true
    const pc = new RTCPeerConnection({ iceServers: [] })
    const dc = pc.createDataChannel('tsunagu')
    const t = new LanTransport(pc, dc)
    this.pendingLan = t
    t.onmsg = (m) => this.onData(t, m)
    t.onclose = () => this.onTransportClose(t)
    try {
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      await waitIce(pc, 2000)
      const sdp = pc.localDescription?.sdp
      if (!sdp) throw new Error('no local sdp')
      const ans = await this.lanFetch(ip, eps.port, '/signal', { auth, sdp }, 12000)
      if (this.pendingLan !== t) return false
      await pc.setRemoteDescription({ type: 'answer', sdp: ans.sdp })
    } catch {
      t.close(); if (this.pendingLan === t) this.pendingLan = undefined; return false
    }
    setTimeout(() => { if (this.pendingLan === t) { this.pendingLan = undefined; t.close() } }, 8000)
    return true
  }
  /** 設定: a fixed IP:port for a phone that never announces itself. */
  setManualLan(ip: string, port: number): boolean {
    const host = ip.trim()
    const octets = host.split('.')
    if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(host) || octets.some((n) => Number(n) > 255)) {
      this.note('IP アドレスを正しく入力してください（例: 192.168.1.23）'); return false
    }
    if (!(port >= 1 && port <= 65535)) { this.note('ポート番号を確認してください（通常は 47822）'); return false }
    const eps: LanEps = { ips: [host], port }
    ls.set('lanManual', JSON.stringify(eps))
    this.set({ lanManual: eps })
    this.note('ローカル接続先を保存しました')
    void this.tryLan()
    return true
  }
  clearManualLan() {
    ls.del('lanManual')
    this.set({ lanManual: undefined })
    this.note('自動検出に戻しました')
    void this.tryLan()
  }
  async connectLocal(): Promise<boolean> {
    const target = this.lanTargets()[0]
    if (!target) { this.note('ローカル接続先がまだ分かりません。スマホと一度つないでください'); return false }
    this.set({ lanBusy: true })
    let ok = false
    try { ok = await this.lanConnect(target) } finally { this.set({ lanBusy: false }) }
    this.note(ok ? '同じネットワークで直接つながります…' : `${target.ips[0]}:${target.port} に接続できませんでした`)
    return ok
  }

  /* ---------------- USB cable ---------------- */
  async connectUsb(): Promise<boolean> {
    if (!usbSupported()) { this.set({ usbMessage: 'このブラウザは USB 接続に対応していません。PC の Chrome か Edge でお試しください。' }); return false }
    if (this.state.usbBusy) return false
    if (this.conn?.kind === 'usb' && this.conn.open) return true
    this.set({ usbBusy: true, usbMessage: undefined })
    try {
      const adbUsb = await import('@yume-chan/adb-daemon-webusb')
      const manager = adbUsb.AdbDaemonWebUsbDeviceManager.BROWSER
      if (!manager) { this.set({ usbMessage: 'このブラウザは USB 接続に対応していません。' }); return false }
      let device = this.usbDevice
      if (!device) {
        const known = await Promise.resolve(manager.getDevices()).catch(() => [] as AdbDaemonWebUsbDevice[])
        device = known[0]
      }
      if (!device) {
        this.set({ usbMessage: 'スマホの「USB デバッグ」を ON にして USB ケーブルでつなぎ、一覧からスマホを選んでください。' })
        device = await Promise.resolve(manager.requestDevice()).catch(() => undefined)
      }
      if (!device) { this.set({ usbMessage: 'USB デバイスが選ばれませんでした。' }); return false }
      return await this.usbOpen(device)
    } catch (e: any) {
      const msg = usbErrorText(e)
      this.set({ usbMessage: msg }); this.note(msg, 7000)
      return false
    } finally { this.set({ usbBusy: false }) }
  }
  private async usbOpen(device: AdbDaemonWebUsbDevice): Promise<boolean> {
    this.usbT?.close(); this.usbT = undefined
    this.set({ usbMessage: 'USB で接続しています…（スマホに「USB デバッグを許可しますか？」が出たら「許可」）' })
    try {
      const [{ Adb, AdbDaemonTransport }, { default: AdbWebCredentialStore }] = await Promise.all([
        import('@yume-chan/adb'),
        import('@yume-chan/adb-credential-web'),
      ])
      if (!this.cred) this.cred = new AdbWebCredentialStore('Pixelミラーリング')
      const connection = await withTimeout(device.connect(), 20000, 'USB デバイスを開けませんでした。ケーブルを差し直してお試しください。')
      const transport = await withTimeout(
        AdbDaemonTransport.authenticate({ serial: device.serial, connection, credentialStore: this.cred }),
        90000,
        'スマホの「USB デバッグを許可しますか？」で「許可」を押してください。',
      )
      this.adb = new Adb(transport)
      let sock: any
      try {
        sock = await withTimeout(this.adb.createSocket(USB_SOCKET), 15000, 'no-app')
      } catch (e: any) {
        throw new UsbNoAppError(String(e?.message || e))
      }
      const t = new UsbTransport(sock)
      this.pendingUsb = t
      t.onmsg = (m) => this.onData(t, m)
      t.onclose = () => this.onTransportClose(t)
      this.usbDevice = device
      t.send({ t: 'usb_auth', auth: [...await this.lanAuth(), await sha256Hex(this.state.code)] })
      setTimeout(() => {
        if (this.pendingUsb !== t) return
        this.pendingUsb = undefined; t.close()
        this.set({ usbMessage: 'スマホから応答がありません。スマホで Quick Link アプリを開いたままにしてください。' })
      }, 15000)
      return true
    } catch (e: any) {
      const msg = e instanceof UsbNoAppError
        ? 'スマホの Quick Link アプリ（v1.5.1 以降）を開いたままにしてから、もう一度お試しください。'
        : usbErrorText(e)
      this.set({ usbMessage: msg }); this.note(msg, 7000)
      try { void this.adb?.close() } catch {}
      this.adb = undefined
      try { void (device.raw as any)?.close?.() } catch {}
      return false
    }
  }
  disconnectUsb() {
    const t = this.conn?.kind === 'usb' ? this.conn : this.usbT || this.pendingUsb
    if (this.conn === t) this.conn = undefined
    this.pendingUsb = undefined; this.usbT = undefined
    t?.close()
    try { void this.adb?.close() } catch {}
    this.adb = undefined
    this.set({ usbMessage: undefined })
    if (!this.conn) this.set({ phase: this.peer ? 'waiting' : 'starting', via: undefined, mirror: 'off', mode: '' })
    this.reconnectAttempts = 0
    setTimeout(() => this.reconnectNow(), 400)
  }

  /* ---------------- connection plumbing ---------------- */
  private onTransportClose(t: Transport) {
    if (this.pendingLan === t) { this.pendingLan = undefined; return }
    if (this.pendingUsb === t) { this.pendingUsb = undefined; return }
    if (t.kind === 'usb') {
      if (this.usbT === t) this.usbT = undefined
      try { void this.adb?.close() } catch {}
      this.adb = undefined
    }
    if (this.conn === t) {
      this.conn = undefined
      this.set({ phase: 'waiting', via: undefined, mirror: 'off', mode: '', fps: 0, latency: null })
      this.note(t.kind === 'usb' ? 'USB ケーブルの接続が切れました' : 'スマートフォンとの接続が切れました')
      this.scheduleReconnect(1000)
    }
  }

  private pcInfo() {
    const ua = navigator.userAgent
    const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'ブラウザ'
    const os = /CrOS/.test(ua) ? 'ChromeOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /Linux/.test(ua) ? 'Linux' : 'PC'
    const name = os === 'ChromeOS' ? 'Chromebook' : os === 'Windows' ? 'Windows PC' : os === 'macOS' ? 'Mac' : os === 'Linux' ? 'Linux PC' : 'PC'
    return { name, browser, os, battery: null, charging: null, online: navigator.onLine, visible: !document.hidden, screen: `${screen.width}×${screen.height}`, lang: navigator.language, pwa: matchMedia('(display-mode: standalone)').matches }
  }

  private accept(c: Transport, hello: any) {
    const previous = this.conn
    this.conn = c
    this.lastRx = Date.now()
    this.pongs = 0
    this.autoStartTried = false
    this.reconnectAttempts = 0
    if (this.pendingLan === c) this.pendingLan = undefined
    if (c.kind === 'usb') { this.pendingUsb = undefined; this.usbT = c as UsbTransport }
    if (previous && previous !== c) { try { previous.close() } catch {} }
    let token = hello.token
    const trusted: string[] = JSON.parse(ls.get('trusted') || '[]')
    if (!trusted.includes(token)) { token = rand(24); trusted.push(token); ls.set('trusted', JSON.stringify(trusted.slice(-10))) }
    const me = this.pcInfo()
    c.send({ t: 'welcome', token, pc: me.name, pcInfo: me })
    this.learnLan(hello.lan)
    this.set({
      phase: 'connected', via: c.kind,
      device: { name: hello.name || 'Android', model: hello.model || '', android: hello.android || '' },
      pending: undefined, usbMessage: undefined, error: undefined,
    })
    // Everything this app needs from the phone: what it can do right now.
    c.send({ t: 'get', what: 'remote' })
    c.send({ t: 'get', what: 'sys' })
    this.note(`${hello.name || 'スマートフォン'} と接続しました（${c.kind === 'usb' ? 'USB ケーブル' : c.kind === 'lan' ? '同じ Wi-Fi' : 'クラウド経由'}）`, 3000)
    // Mirroring starts by itself: with ユーザー補助 on, the phone shows its screen
    // with no dialog and no tap on the phone at all. The permission state usually
    // arrives a moment after the welcome, so this is tried both here and when
    // remote_state lands (see maybeAutoStart).
    setTimeout(() => this.maybeAutoStart(), 400)
  }

  private onData(c: Transport, m: any) {
    if (!m || typeof m !== 'object') return
    if (c === this.conn) {
      this.lastRx = Date.now()
      if (m.t === 'pong') { this.pongs++; if (m.ts) this.set({ latency: Math.max(0, Date.now() - Number(m.ts)) }) }
    }
    if (m.t === 'hello') {
      const rank: Record<Via, number> = { usb: 3, lan: 2, cloud: 1 }
      if (this.conn?.open && rank[this.conn.kind] > rank[c.kind]) { c.close(); return }
      const trusted: string[] = JSON.parse(ls.get('trusted') || '[]')
      if (m.token === this.state.secret || trusted.includes(m.token)) this.accept(c, m)
      else this.set({ pending: { name: m.name || 'Android', accept: () => this.accept(c, m), reject: () => { c.close(); this.set({ pending: undefined }); this.note('接続を断りました') } } })
      return
    }
    if (c !== this.conn) return
    switch (m.t) {
      case 'pong': break
      case 'remote_state':
        this.set({
          acc: !!m.acc,
          mirror: (['off', 'requesting', 'live', 'denied', 'error'] as const).includes(m.mirror) ? m.mirror : 'off',
          mode: (['accessibility', 'projection'] as const).includes(m.mode) ? m.mode : '',
          w: Number(m.w) || 0, h: Number(m.h) || 0, fps: Number(m.fps) || 0, reason: m.reason || undefined,
        })
        this.maybeAutoStart()
        break
      case 'mirror_state': {
        const st = (['off', 'requesting', 'live', 'denied', 'error'] as const).includes(m.state) ? m.state : 'off'
        const mode = (['accessibility', 'projection'] as const).includes(m.mode) ? m.mode : this.state.mode
        this.set({ mirror: st, mode, w: Number(m.w) || this.state.w, h: Number(m.h) || this.state.h, fps: Number(m.fps) || 0, reason: m.reason || undefined, hasFrame: st === 'live' ? this.state.hasFrame : false })
        if (st === 'denied') this.note('スマホで画面共有が許可されませんでした', 6000)
        if (st === 'error') this.note(`画面を取得できませんでした（${m.reason === 'secure' ? '保護された画面' : 'ユーザー補助の画面取得'}）`, 8000)
        break
      }
      case 'mirror_frame': this.onFrameMsg(String(m.d || ''), Number(m.w) || 0, Number(m.h) || 0); break
      case 'acc_state': this.set({ acc: !!m.on }); break
      case 'sys': this.set({ sys: m.sys }); break
      case 'sys_err': this.note(m.text || '操作できませんでした'); if (m.sys) this.set({ sys: m.sys }); break
      case 'toast': this.note(String(m.text || ''), 4000); break
      case 'info': if (m.info?.lan) this.learnLan(m.info.lan); break
    }

  }

  private learnLan(lan: any) {
    if (!lan || !Array.isArray(lan.ips) || !lan.ips.length || !(lan.port > 0)) return
    const v = JSON.stringify({ ips: lan.ips.slice(0, 4), port: lan.port })
    if (ls.get('lan') !== v) {
      ls.set('lan', v)
      this.set({ lan: { ips: lan.ips.slice(0, 4), port: lan.port } })
      this.tryLan()
    }
  }

  send(m: any) { if (this.conn?.open) this.conn.send(m) }

  /* ---------------- mirroring ---------------- */
  onFrame(cb: ((url: string, w: number, h: number) => void) | null) {
    this.frameCb = cb || undefined
    return () => { if (this.frameCb === cb) this.frameCb = undefined }
  }
  private onFrameMsg(d: string, w: number, h: number) {
    if (!d) return
    if (!this.state.hasFrame) this.set({ hasFrame: true })
    this.frameCb?.(d.startsWith('data:') ? d : 'data:image/jpeg;base64,' + d, w, h)
  }
  refreshRemote() { this.send({ t: 'get', what: 'remote' }) }

  /** Start the mirror as soon as the phone says ユーザー補助 is on — once per
   *  connection, so a person who stopped it keeps it stopped. */
  private maybeAutoStart() {
    if (!this.auto || this.autoStartTried) return
    if (this.state.phase !== 'connected' || !this.state.acc) return
    if (this.state.mirror === 'live' || this.state.mirror === 'requesting') return
    this.autoStartTried = true
    this.mirrorStart()
  }

  /** Starts the mirror. Default: the popup-free accessibility stream. */
  mirrorStart(mode?: 'projection' | 'accessibility') {
    if (!this.conn?.open) { this.note('スマートフォンが接続されていません'); return }
    this.send({ t: 'mirror_start', mode: mode || '', long: this.long, q: this.quality })
    this.set({ mirror: 'requesting', reason: undefined, hasFrame: false })
  }
  mirrorStop() {
    this.send({ t: 'mirror_stop' })
    this.set({ mirror: 'off', mode: '', fps: 0, hasFrame: false })
  }
  /** 画質・大きさ: applied to the running stream as well. */
  setQuality(long: number, q: number) {
    this.long = long; this.quality = q
    ls.set('long', String(long)); ls.set('q', String(q))
    this.send({ t: 'mirror_opts', long, q })
  }
  setAuto(on: boolean) { this.auto = on; ls.set('auto', on ? '1' : '0'); this.set({}) }
  toggleKb() { const on = !this.state.kb; ls.set('kb', on ? '1' : '0'); this.set({ kb: on }) }

  /* ---------------- input ---------------- */
  tap(x: number, y: number) { this.send({ t: 'rm_tap', x, y }) }
  longPress(x: number, y: number) { this.send({ t: 'rm_long', x, y }) }
  swipe(x1: number, y1: number, x2: number, y2: number, ms: number) { this.send({ t: 'rm_swipe', x1, y1, x2, y2, ms }) }
  scroll(dir: 'up' | 'down' | 'left' | 'right', x: number, y: number) { this.send({ t: 'rm_scroll', dir, x, y }) }
  text(text: string) { if (text) this.send({ t: 'rm_text', text }) }
  key(key: string) { this.send({ t: 'rm_key', key }) }
  hover(x: number, y: number) { this.send({ t: 'rm_hover', x, y }) }
  /** Opens a permission screen on the phone (ユーザー補助 / 通知). */
  perm(which: 'accessibility' | 'projection') {
    if (which === 'accessibility') { this.send({ t: 'perm_open', which: 'accessibility' }); this.note('スマホで「ユーザー補助」の画面を開きました', 5000) }
    else { this.mirrorStart('projection') }
  }

  /* ---------------- phone system controls (音量・自動回転) ---------------- */
  setSys(p: Record<string, unknown>) {
    this.send({ t: 'sys_set', ...p })
    const s = this.state.sys
    if (!s) return
    const next = { ...s }
    if (p.key === 'rotate') next.rotate = !!p.on
    else if (p.key === 'vol') { next.vol = Number(p.value); next.muted = false }
    this.set({ sys: next })
  }
  volumeUp() { const s = this.state.sys; if (s) this.setSys({ key: 'vol', value: Math.min(s.volMax, s.vol + 1) }) }
  volumeDown() { const s = this.state.sys; if (s) this.setSys({ key: 'vol', value: Math.max(0, s.vol - 1) }) }
  toggleRotate() { const s = this.state.sys; if (s) this.setSys({ key: 'rotate', on: !s.rotate }) }
  /** PC のクリップボードをスマホのクリップボードへ（共有シート相当）。 */
  async sendClipboard() {
    try {
      const t = await navigator.clipboard.readText()
      if (!t) { this.note('クリップボードが空です'); return }
      this.send({ t: 'clip', text: t })
      this.note('スマホのクリップボードに送りました')
    } catch { this.note('クリップボードの読み取りが許可されていません') }
  }
}

export const link = new Mirror()
