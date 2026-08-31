// The palette every xterm in the app is built with, in one place.
//
// Two panels host a terminal now — the shell and a command's output — and a
// second copy of these values would drift the day one of them is tuned. xterm
// needs concrete values at construction, which is why they are literals here
// rather than read from the CSS variables: reading computed styles at mount
// would tie the shell's palette to whatever had painted first.

export const XTERM_THEME = {
  background: '#00000000', // transparent — the panel's own fill shows through
  foreground: '#c9ccd2',
  cursor: '#c9ccd2',
  selectionBackground: '#35496e88',
  black: '#22252c',
  red: '#c07a72',
  green: '#6ea86e',
  yellow: '#c9a05f',
  blue: '#7f9fd8',
  magenta: '#c07fb8',
  cyan: '#6fc3c3',
  white: '#c9ccd2',
  brightBlack: '#6d7280',
  brightRed: '#d3948c',
  brightGreen: '#8cc48c',
  brightYellow: '#dcbb7f',
  brightBlue: '#9db8e4',
  brightMagenta: '#d29ac9',
  brightCyan: '#8fd6d6',
  brightWhite: '#e8eaee'
}

// The solid colour to answer OSC 11 with. The theme background above is
// transparent so the panel shows through, but a program asking "what colour is
// the background?" must not be told "none": xterm's own answer is the
// transparent fill, which every program reads as black.
export const SOLID_BG = '#141519'

// xterm's OSC colour replies use 16-bit channels — `rgb:rrrr/gggg/bbbb`. A plain
// hex answer is not the format the query asks for and programs ignore it.
export const rgbChannels = (hex: string): string =>
  [1, 3, 5]
    .map((i) => {
      const b = hex.slice(i, i + 2)
      return b + b
    })
    .join('/')


