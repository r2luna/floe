/**
 * The floe mark — two ice floes drifting on open water, the literal reading of
 * the app's name. Inlined from assets/floe.svg for the same reason as
 * PenguinHead: the shape takes `currentColor` and themes from CSS.
 */
export function FloeMark({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 760 760"
      fill="none"
      stroke="currentColor"
      strokeWidth={48}
      strokeLinejoin="round"
      strokeLinecap="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M90 300L170 180L340 142L470 168L560 242L515 300Z" />
      <path d="M70 400q62 -34 124 0t124 0t124 0t124 0t124 0" />
      <path d="M430 568L482 480L596 466L652 520L606 568Z" />
      <path d="M132 660q62 -34 124 0t124 0t124 0t124 0" />
    </svg>
  )
}
