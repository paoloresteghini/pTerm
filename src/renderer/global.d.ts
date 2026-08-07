/// <reference types="vite/client" />

import type { PTermApi } from '../shared/ipc'

declare global {
  interface Window {
    pterm: PTermApi
  }
}

export {}
