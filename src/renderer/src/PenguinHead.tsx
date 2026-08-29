/**
 * The Pinguim head — the app's own mark — in every personality you can pick.
 *
 * One shape family: the same ring and beak from `assets/pa-head.svg`, with the
 * ring thinned (inner hole r=258) so the face has room, and a per-variant face
 * drawn inside it. Four variants also break the silhouette (Punk, Crown, Tuft,
 * Antenna) and one takes a bite out of it (Chipped), which is why the viewBox
 * carries headroom the original didn't need.
 *
 * Components rather than <img src>: the shapes take `currentColor` and theme
 * from CSS like every other icon here. The SVG files in `assets/penguins/` are
 * the same art, kept as the design source.
 */
import type { ReactNode } from 'react'
import { PENGUIN_HEADS, type PenguinColorId, type PenguinHeadId } from '../../shared/types'

/** The ring, the beak, and the hole in the middle. Identical in every variant. */
const HEAD = 'M735.075 408.15 C738.826 386.087 748.092 110.305 745.224 107.437 C744.341 106.555 713.454 104.79 676.609 103.466 L609.539 101.039 L594.978 88.2429 C550.632 48.9715 494.152 20.0697 434.363 6.17028 C419.14 2.64027 405.681 1.3165 373.029 0.875252 C350.084 0.434001 328.242 0.654674 324.491 1.09592 A361 361 0 1 0 735.075 408.15 Z M118.5 353.0a258.0 258.0 0 1 0 516.0 0a258.0 258.0 0 1 0 -516.0 0Z'

/** Chipped is the one variant whose head path differs: a wedge cut out of it. */
const HOLES: Partial<Record<PenguinHeadId, string>> = {
  chipped: 'M-38 487L181 491L102 695Z'
}

export const PENGUIN_LABELS: Record<PenguinHeadId, string> = {
  classic: 'Classic',
  sleepy: 'Sleepy',
  surprised: 'Surprised',
  focused: 'Focused',
  skeptical: 'Skeptical',
  cool: 'Cool',
  wink: 'Wink',
  cute: 'Cute',
  zen: 'Zen',
  robot: 'Robot',
  punk: 'Punk',
  tired: 'Tired',
  happy: 'Happy',
  angry: 'Angry',
  dizzy: 'Dizzy',
  dreamer: 'Dreamer',
  ninja: 'Ninja',
  scanner: 'Scanner',
  spark: 'Spark',
  sad: 'Sad',
  crown: 'Crown',
  tuft: 'Tuft',
  antenna: 'Antenna',
  chipped: 'Chipped'
}

export const PENGUIN_COLOR_LABELS: Record<PenguinColorId, string> = {
  accent: 'Accent',
  ice: 'Ice',
  green: 'Green',
  blue: 'Blue',
  violet: 'Violet',
  amber: 'Amber',
  red: 'Red',
  plain: 'Plain'
}

/** The class that paints a head. The tones themselves are `--pen-*` in index.css. */
export const penguinTone = (color: PenguinColorId): string => `penguin-tone-${color}`

const FACES: Record<PenguinHeadId, ReactNode> = {
  classic: (
    <>
      <circle cx="431" cy="279" r="56"/>
    </>
  ),
  sleepy: (
    <>
      <path d="M366 296q62 44 124 0" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="44"/>
    </>
  ),
  surprised: (
    <>
      <circle cx="431" cy="279" r="62" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="38"/>
    </>
  ),
  focused: (
    <>
      <circle cx="449" cy="262" r="36"/>
    </>
  ),
  skeptical: (
    <>
      <circle cx="428" cy="296" r="52"/>
      <path d="M348 226L456 200" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="38"/>
    </>
  ),
  cool: (
    <>
      <path d="M336 300L472 272" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="68"/>
    </>
  ),
  wink: (
    <>
      <path d="M366 300q62 -54 124 0" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="44"/>
    </>
  ),
  cute: (
    <>
      <circle cx="416" cy="306" r="80"/>
    </>
  ),
  zen: (
    <>
      <path d="M360 292h128" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="40"/>
    </>
  ),
  robot: (
    <>
      <circle cx="404" cy="276" r="88" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="30"/>
      <circle cx="404" cy="276" r="28"/>
    </>
  ),
  punk: (
    <>
      <path d="M280 76L152 -54L188 125Z"/>
      <path d="M180 131L13 59L113 211Z"/>
      <path d="M108 220L-74 216L76 319Z"/>
      <circle cx="431" cy="279" r="56"/>
    </>
  ),
  tired: (
    <>
      <circle cx="428" cy="300" r="50"/>
      <path d="M356 240L478 224" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="28"/>
    </>
  ),
  happy: (
    <>
      <circle cx="428" cy="256" r="50"/>
      <path d="M368 352q60 44 120 0" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="38"/>
    </>
  ),
  angry: (
    <>
      <circle cx="440" cy="310" r="44"/>
      <path d="M350 194L470 240" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="40"/>
    </>
  ),
  dizzy: (
    <>
      <path d="M418 270L419 269L421 269L422 269L424 269L425 269L427 269L429 270L430 271L432 272L433 273L435 275L436 277L437 279L438 281L438 283L438 286L438 288L438 291L437 293L436 296L434 298L432 301L430 303L428 305L425 306L422 307L419 308L416 309L412 309L409 309L405 308L401 307L398 306L395 304L392 301L389 299L386 295L384 292L382 288L381 284L380 280L380 275L380 271L380 266L382 261L383 257L386 253L389 249L392 245L396 242L400 239L405 236L410 235L415 233L420 232L426 232L432 233L437 234L443 236L448 239L453 242L458 246L462 250L466 255L469 260L471 266L473 272L474 279L475 285L475 292L473 299L472 305L469 312L465 318L461 323L456 329L451 333L445 337L438 341L431 343L424 345L417 346L409 346L401 345L394 344L386 341L379 337L372 333L366 328L360 322L355 315L351 308L347 301L345 292L343 284L343 275L343 266L344 258L347 249L350 241L355 233L360 225L366 219L373 212L381 207L389 203L398 199L407 197L417 196L427 195L437 196L446 198L456 201L465 206L474 211L482 218L489 225L496 233L501 242L505 252" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="20"/>
    </>
  ),
  dreamer: (
    <>
      <path d="M366 300q62 44 124 0" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="42"/>
      <circle cx="302" cy="208" r="26"/>
      <circle cx="240" cy="266" r="15"/>
    </>
  ),
  ninja: (
    <>
      <path fillRule="evenodd" d="M130.8 403.8L630.8 353.8A48 48 0 0 0 621.2 258.2L121.2 308.2A48 48 0 0 0 130.8 403.8Z M398 290a54 24 0 1 0 108 0a54 24 0 1 0 -108 0Z"/>
    </>
  ),
  scanner: (
    <>
      <circle cx="348" cy="292" r="24"/>
      <circle cx="420" cy="284" r="24"/>
      <circle cx="492" cy="276" r="24"/>
    </>
  ),
  spark: (
    <>
      <circle cx="424" cy="300" r="60" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="30"/>
      <circle cx="424" cy="300" r="18"/>
      <path d="M330 176L352 210M424 150L424 190M518 176L496 210" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="24"/>
    </>
  ),
  sad: (
    <>
      <circle cx="428" cy="252" r="50"/>
      <path d="M428 336c34 52 44 72 44 88a44 44 0 1 1-88 0c0-16 10-36 44-88Z"/>
    </>
  ),
  crown: (
    <>
      <path d="M581 145L655 -13L556 -70L456 73Z"/>
      <path d="M446 70L430 -104L316 -104L300 70Z"/>
      <path d="M290 73L190 -70L91 -13L165 145Z"/>
      <circle cx="431" cy="279" r="56"/>
    </>
  ),
  tuft: (
    <>
      <path d="M186 148C112 40 214 -60 330 -34" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="46"/>
      <circle cx="431" cy="279" r="56"/>
    </>
  ),
  antenna: (
    <>
      <path d="M356 56L322 -46" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="26"/>
      <circle cx="316" cy="-72" r="42"/>
      <circle cx="431" cy="279" r="56"/>
    </>
  ),
  chipped: (
    <>
      <circle cx="431" cy="279" r="56"/>
    </>
  )
}

export function PenguinHead({
  variant = 'classic',
  size = 26,
  className
}: {
  variant?: PenguinHeadId
  size?: number
  className?: string
}): ReactNode {
  // An unknown id (a hand-edited floe.toml, a variant dropped in a later
  // version) draws the original rather than nothing at all.
  const id: PenguinHeadId = PENGUIN_HEADS.includes(variant) ? variant : 'classic'
  return (
    <svg
      width={size}
      height={size}
      viewBox="-67 -120 880 880"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path fillRule="evenodd" d={HOLES[id] ? `${HEAD} ${HOLES[id]}` : HEAD} />
      {FACES[id]}
    </svg>
  )
}
