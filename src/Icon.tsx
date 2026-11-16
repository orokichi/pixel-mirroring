/** Material Symbols glyph (the icon font is loaded in index.html and cached by
 *  the service worker, so the icons also draw offline). */
export const Icon = ({ n, size = 22, className = '' }: { n: string; size?: number; className?: string }) => (
  <span className={'ms ' + className} style={{ fontSize: size }} aria-hidden="true">{n}</span>
)

/** The app mark: a phone inside a mirroring frame (drawn, never a raster file,
 *  so it stays crisp at any size and takes the theme's colour). */
export const Mark = ({ size = 40 }: { size?: number }) => (
  <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true" className="mark">
    <defs>
      <linearGradient id="pmg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="var(--pm-1)" />
        <stop offset="1" stopColor="var(--pm-2)" />
      </linearGradient>
    </defs>
    <rect x="2" y="2" width="44" height="44" rx="14" fill="url(#pmg)" />
    <rect x="15" y="9" width="18" height="30" rx="4" fill="none" stroke="var(--pm-on)" strokeWidth="2.4" />
    <rect x="20.6" y="12" width="6.8" height="1.8" rx=".9" fill="var(--pm-on)" opacity=".55" />
    <path d="M9 24h3M36 24h3" stroke="var(--pm-on)" strokeWidth="2.4" strokeLinecap="round" />
  </svg>
)
