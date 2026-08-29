import type { FloeApi } from './index'

declare global {
  interface Window {
    floe: FloeApi
  }
}

export {}
