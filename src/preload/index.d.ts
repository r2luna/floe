import type { RookeryApi } from './index'

declare global {
  interface Window {
    rookery: RookeryApi
  }
}

export {}
