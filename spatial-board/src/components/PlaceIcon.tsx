interface PlaceIconProps {
  iconKey: string
}

const svgProps = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  focusable: false,
}

export function PlaceIcon({ iconKey }: PlaceIconProps) {
  switch (iconKey) {
    case 'house':
      return (
        <svg {...svgProps}>
          <path d="M3.5 10.5 12 3.8l8.5 6.7" />
          <path d="M5.8 9.2v10.3h12.4V9.2M9.7 19.5v-5.7h4.6v5.7" />
        </svg>
      )
    case 'bed':
      return (
        <svg {...svgProps}>
          <path d="M4 5.5v14M20 10v9.5M4 16.5h16M7 9.5h4.5a3 3 0 0 1 3 3v4M7 9.5v7" />
          <circle cx="8.3" cy="7.2" r="1.7" />
        </svg>
      )
    case 'toilet':
      return (
        <svg {...svgProps}>
          <path d="M7 3.5h7v6H7zM14 6.5h2.5" />
          <path d="M7 9.5h10c0 4.3-2.4 6.6-6.2 6.6S5 13.8 5 11.5h2" />
          <path d="M10.8 16.1v3.4M8.3 19.5h5" />
        </svg>
      )
    case 'landmark':
      return (
        <svg {...svgProps}>
          <path d="m3.5 9 8.5-5 8.5 5M5 9h14M6.5 9v8M10.2 9v8M13.8 9v8M17.5 9v8M4.5 17h15M3.5 20h17" />
        </svg>
      )
    case 'shop':
      return (
        <svg {...svgProps}>
          <path d="M4 9.5v10h16v-10M3 9.5l1.8-5h14.4l1.8 5" />
          <path d="M3 9.5c0 1.4 1 2.4 2.2 2.4s2.3-1 2.3-2.4c0 1.4 1 2.4 2.2 2.4s2.3-1 2.3-2.4c0 1.4 1 2.4 2.3 2.4s2.2-1 2.2-2.4c0 1.4 1 2.4 2.3 2.4S21 10.9 21 9.5" />
          <path d="M8 19.5v-4.8h5v4.8" />
        </svg>
      )
    case 'base':
      return (
        <svg {...svgProps}>
          <path d="M4 20V8l8-4 8 4v12M8 20v-5h8v5M7.5 10.5h.01M12 10.5h.01M16.5 10.5h.01" />
          <path d="M2.8 20h18.4" />
        </svg>
      )
    case 'control':
      return (
        <svg {...svgProps}>
          <path d="M5 4v16M12 4v16M19 4v16" />
          <path d="M2.5 8h5M9.5 15h5M16.5 10h5" />
          <circle cx="5" cy="8" r="1.8" fill="var(--place-fill)" />
          <circle cx="12" cy="15" r="1.8" fill="var(--place-fill)" />
          <circle cx="19" cy="10" r="1.8" fill="var(--place-fill)" />
        </svg>
      )
    case 'planet':
      return (
        <svg {...svgProps}>
          <circle cx="12" cy="12" r="6.2" />
          <path d="M4.4 8.8C1.8 10.7 2.1 12.5 5.2 14c3.8 1.9 10.7 2.3 14.1.7 3-1.4 3.1-3.2.4-4.8" />
          <path d="M10 7.3c1.1.6 1.8 1.4 2.1 2.4" />
        </svg>
      )
    default:
      return (
        <svg {...svgProps}>
          <path d="M12 21s6.5-5.6 6.5-11.5a6.5 6.5 0 1 0-13 0C5.5 15.4 12 21 12 21Z" />
          <circle cx="12" cy="9.5" r="2.3" />
        </svg>
      )
  }
}
