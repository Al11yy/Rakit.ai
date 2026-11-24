/**
 * One drawn icon system: 16px box, 1.5 stroke, round caps, currentColor.
 * No glyphs standing in for icons.
 */
type Props = { className?: string }

const base = (className?: string) => ({
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  className,
  'aria-hidden': true,
  width: 16,
  height: 16,
})

export const IconLayers = ({ className }: Props) => (
  <svg {...base(className)}>
    <path d="M8 1.8 14 5l-6 3.2L2 5l6-3.2Z" />
    <path d="M2 8.4 8 11.6l6-3.2" />
    <path d="M2 11.6 8 14.8l6-3.2" />
  </svg>
)

export const IconTable = ({ className }: Props) => (
  <svg {...base(className)}>
    <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.4" />
    <path d="M1.8 6.2h12.4M6.4 6.2v7" />
  </svg>
)

export const IconCoins = ({ className }: Props) => (
  <svg {...base(className)}>
    <ellipse cx="8" cy="4.2" rx="5.2" ry="2.4" />
    <path d="M2.8 4.2v3.6c0 1.3 2.3 2.4 5.2 2.4s5.2-1.1 5.2-2.4V4.2" />
    <path d="M2.8 7.8v3.6c0 1.3 2.3 2.4 5.2 2.4s5.2-1.1 5.2-2.4V7.8" />
  </svg>
)

export const IconPlus = ({ className }: Props) => (
  <svg {...base(className)}>
    <path d="M8 3.4v9.2M3.4 8h9.2" />
  </svg>
)

export const IconArrowUpRight = ({ className }: Props) => (
  <svg {...base(className)}>
    <path d="M4.6 11.4 11.4 4.6M5.8 4.6h5.6v5.6" />
  </svg>
)

export const IconCheck = ({ className }: Props) => (
  <svg {...base(className)}>
    <path d="M3.2 8.4 6.4 11.6l6.4-7.2" />
  </svg>
)

export const IconAlert = ({ className }: Props) => (
  <svg {...base(className)}>
    <path d="M8 2.6v6.2M8 11.6v1.8" />
  </svg>
)

export const IconWand = ({ className }: Props) => (
  <svg {...base(className)}>
    <path d="M3 13 11.4 4.6M9.6 2.8l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1Z" />
  </svg>
)

export const IconSliders = ({ className }: Props) => (
  <svg {...base(className)}>
    <path d="M2.4 5h7M12.4 5h1.2M2.4 11h1.2M6.6 11h7" />
    <circle cx="10.6" cy="5" r="1.6" />
    <circle cx="4.8" cy="11" r="1.6" />
  </svg>
)

export const IconRocket = ({ className }: Props) => (
  <svg {...base(className)}>
    <path d="M6.2 9.8 2.6 13.4M9.4 2.2c2.2-.6 4.4.4 4.4.4s1 2.2.4 4.4c-.6 2.2-3.4 4.6-5.4 5.6L5.4 9.2c1-2 3.4-4.8 5.6-5.4Z" />
    <circle cx="10.4" cy="5.6" r="1.2" />
  </svg>
)

export const IconClose = ({ className }: Props) => (
  <svg {...base(className)}>
    <path d="M4.2 4.2 11.8 11.8M11.8 4.2 4.2 11.8" />
  </svg>
)

export const IconExternal = ({ className }: Props) => (
  <svg {...base(className)}>
    <path d="M9.4 2.8h3.8v3.8M13.2 2.8 7.6 8.4" />
    <path d="M11.6 9.4v2.4a1.4 1.4 0 0 1-1.4 1.4H4.2a1.4 1.4 0 0 1-1.4-1.4V5.8a1.4 1.4 0 0 1 1.4-1.4h2.4" />
  </svg>
)

export const IconTrash = ({ className }: Props) => (
  <svg {...base(className)}>
    <path d="M2.8 4.4h10.4M6.4 4.4V3.2a.8.8 0 0 1 .8-.8h1.6a.8.8 0 0 1 .8.8v1.2" />
    <path d="M4.2 4.4v8.2a1.2 1.2 0 0 0 1.2 1.2h5.2a1.2 1.2 0 0 0 1.2-1.2V4.4" />
    <path d="M6.8 7v4M9.2 7v4" />
  </svg>
)

export const IconChevronDown = ({ className }: Props) => (
  <svg {...base(className)}>
    <path d="M4.4 6.4 8 10l3.6-3.6" />
  </svg>
)

export const IconChat = ({ className }: Props) => (
  <svg {...base(className)}>
    <path d="M2.2 3.4h11.6v7.2H7.4L3.8 13.4v-2.8H2.2V3.4Z" />
    <path d="M5 6.2h6M5 8.2h3.6" />
  </svg>
)
