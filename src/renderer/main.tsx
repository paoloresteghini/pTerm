import './index.css'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { applyTheme, bootTheme } from './theme'

// Before `createRoot`, deliberately. React's first paint has to land on the
// stored palette: applying it after mount would show the default theme for a
// frame on every launch, and the app opens onto a window full of terminals.
applyTheme(bootTheme())

const el = document.getElementById('root')
if (!el) throw new Error('#root missing from index.html')
createRoot(el).render(<App />)
