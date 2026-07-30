/// <reference types="vite/client" />

import type { PrcliApi } from '../shared/ipc'

declare global {
  interface Window {
    prcli: PrcliApi
  }
}

export {}
