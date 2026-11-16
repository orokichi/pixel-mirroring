# Pixelミラーリング

Android スマートフォン（Pixel など）の画面を PC のブラウザで**全画面**に表示し、そのまま操作する独立した Web アプリ（PWA）です。Quick Link アプリと同じペアリングコード／QR／USB ケーブルでつながるので、スマホ側に新しいアプリを入れる必要はありません。

- **Web**: Vercel（`pixel-mirroring` プロジェクト）
- **スマホ側**: Quick Link アプリ v1.5.1 以降

## できること

| 機能 | 内容 |
|---|---|
| ミラーリング | ポップアップなし（ユーザー補助の `takeScreenshot`）／なめらかモード（MediaProjection） |
| 操作 | クリック＝タップ、ダブルクリック、長押し、ドラッグ＝スワイプ、ホイール＝スクロール、右クリック＝戻る |
| キーボード | 文字入力・Enter・Backspace・Tab・矢印・Esc（戻る）・Home・Ctrl+V・Ctrl+A |
| ツールバー | 戻る・ホーム・履歴・通知・クイック設定・画面ロック・画面点灯・音量・自動回転・クリップボード |
| 接続 | 同じ Wi-Fi で直接（P2P）／USB ケーブル（ADB over WebUSB、ネット不要）／クラウド（PeerJS） |
| 全画面 | `100dvh` のレイアウト＋フルスクリーンボタン。画面の縦横比に合わせて最大サイズで表示 |

## ポップアップなしのしくみ

ユーザー補助（リモート操作）を一度オンにしておくと、Android の `AccessibilityService.takeScreenshot()` で画面を取得します。MediaProjection の「画面の共有を開始しますか？」は出ません。ただしプラットフォームが取得間隔を約 333ms（毎秒 3 コマ程度）に制限しているため、なめらかさが必要なときは「なめらかモード」（MediaProjection・毎秒 15〜20 コマ・開始のたびに許可）を使います。

## 構成

- `src/link.ts` — 通信とプロトコル（Quick Link と完全互換）
  - クラウド: PeerJS（`tsunagu-link-<code>`）、LAN: スマホの認証付きシグナリング（`/ping`・`/signal`）＋ WebRTC DataChannel、USB: `localabstract:tsunagu-usb`（`[len:u32][utf8 JSON]`）
  - フレーム: `[0x00]+JSON` / `[0x01][id][idx][total]+chunk(16000B)`
  - ペアリング: QR `tsunagu:CODE:SECRET`、初回は PC 側で許可
- `src/App.tsx` — 全画面 UI（ステージ・ツールバー・テキストバー・設定・使い方）
- `src/styles.css` — Material 3 Expressive 風のダーク／ライト対応スタイル
- `public/sw.js` — オフライン起動用の Service Worker（このオリジンのみ）

## ビルド

```
npm ci
npm run build     # tsc --noEmit && vite build
```

## 公開（Vercel）

`vercel.json` に `buildCommand` / `outputDirectory` を書いてあるので、Vercel でリポジトリをインポートするだけで公開できます（Framework: Vite、Root Directory: リポジトリ直下）。
