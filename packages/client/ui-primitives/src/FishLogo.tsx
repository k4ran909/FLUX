import type { IconProps } from './icons/props.ts'

/** Native viewBox of {@link FISH_LOGO_PATH}: the mark's painted bounds widened to a 4:3 box. */
export const FISH_LOGO_VIEWBOX = { x: 21.33, y: 48, width: 301.33, height: 226 }

/** Stroke width of {@link FISH_LOGO_PATH} in viewBox units; the stroke rounds the block corners. */
export const FISH_LOGO_STROKE_WIDTH = 12

/** The FLUX block mark: four closed polygons, filled and stroked with round joins, exported for consumers that compose their own svg around the same geometry. */
export const FISH_LOGO_PATH = 'M134 102L214 60L214 138L134 138Z'
  + 'M232 54L258 54L232 70Z'
  + 'M108 156L214 156L214 226L134 268L134 184L86 184Z'
  + 'M232 157L258 157L232 173Z'

/**
 * Render the FLUX block mark.
 * @param props.size - width in px (default 24; height keeps the 4:3 ratio).
 * @param props.className - extra class for layout placement.
 * @returns the logo svg (aria-hidden; pair with the wordmark for accessibility).
 */
export function FishLogo({ size = 24, className }: IconProps) {
  const { x, y, width, height } = FISH_LOGO_VIEWBOX
  return (
    <svg
      width={size}
      height={(size * height) / width}
      className={className}
      viewBox={`${x} ${y} ${width} ${height}`}
      fill="none"
      aria-hidden="true"
    >
      <path
        d={FISH_LOGO_PATH}
        fill="currentColor"
        stroke="currentColor"
        strokeWidth={FISH_LOGO_STROKE_WIDTH}
        strokeLinejoin="round"
      />
    </svg>
  )
}
