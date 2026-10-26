import type { IconProps } from './icons/props.ts'

/** Native viewBox of {@link FISH_LOGO_PATH} (width and height in user units). */
export const FISH_LOGO_VIEWBOX = { width: 24, height: 18 }

/** Stroke width of {@link FISH_LOGO_PATH} in viewBox units. */
export const FISH_LOGO_STROKE_WIDTH = 2.5

/** The FLUX wave mark: three open subpaths drawn as round-capped strokes, exported for consumers that compose their own svg around the same geometry. */
export const FISH_LOGO_PATH = 'M5 4.2C8 1.4 11 1.4 13.5 4.2S19 7 21.5 4.2'
  + 'M2.5 9C5.5 6.2 8.5 6.2 11.5 9S17.5 11.8 21.5 9'
  + 'M2.5 13.8C5 11 8 11 10.5 13.8S16 16.6 19 13.8'

/**
 * Render the FLUX wave mark.
 * @param props.size - width in px (default 24; height keeps the 24:18 ratio).
 * @param props.className - extra class for layout placement.
 * @returns the logo svg (aria-hidden; pair with the wordmark for accessibility).
 */
export function FishLogo({ size = 24, className }: IconProps) {
  return (
    <svg
      width={size}
      height={(size * FISH_LOGO_VIEWBOX.height) / FISH_LOGO_VIEWBOX.width}
      className={className}
      viewBox={`0 0 ${FISH_LOGO_VIEWBOX.width} ${FISH_LOGO_VIEWBOX.height}`}
      fill="none"
      aria-hidden="true"
    >
      <path d={FISH_LOGO_PATH} stroke="currentColor" strokeWidth={FISH_LOGO_STROKE_WIDTH} strokeLinecap="round" />
    </svg>
  )
}
