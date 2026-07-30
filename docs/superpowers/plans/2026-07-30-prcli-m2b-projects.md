# PRCLI Milestone 2b — Projects, Sidebar and Presets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Five customers in a sidebar, each owning its own tabs and its own commands — with nothing running that the UI cannot reach.

**Architecture:** Milestone 2a already runs any number of tmux-backed tabs restored from live tmux. This milestone adds a project above the tab: config gains a projects array, the sidebar lists them, and the tab bar narrows to one project at a time. **A tab belongs to a project by the slug inside its tmux session name — never by a stored id**, so Unsorted is a computed definition rather than a maintained list, and deleting a project needs no special handling.

**Tech Stack:** Electron 43.2.0, TypeScript 7.0.2 (strict), Vite via Electron Forge 7.11.2, node-pty 1.1.0, @xterm/xterm 6.0.0, React 19.2.0, Vitest 4.1.10, Playwright 1.62.0, tmux ≥ 3.3. New in this milestone: Tailwind v4 and shadcn/ui-idiom components.

**Size note:** 14 tasks — larger than M1 or M2a, chosen deliberately over splitting into 2b-i/2b-ii. Tasks 1–8 are main-process and pure-logic work with real tests; 9–14 are renderer. If execution starts slipping, the natural cut is after Task 9: everything up to there is structure, and 10–14 is the UI on top of it.

## Global Constraints

- Platform: macOS only. No Windows or Linux branches.
- All tmux invocations go through `TmuxAdapter`. No `execFile('tmux', …)` elsewhere in app code. Test files may call tmux directly.
- Every tmux session name is `prcli-<projectSlug>-<id>`, built only via `encodeSessionName`.
- **Slugs match `/^[a-z0-9_]+$/` — underscores, never dashes.** `decodeSessionName` splits on exactly three dash-separated parts, so a dash inside a slug breaks both encode and decode.
- Integration tests use the dedicated tmux socket `-L prcli-test`; E2E uses `PRCLI_TMUX_SOCKET`. Neither may ever touch the developer's own tmux server, which holds live irreplaceable sessions.
- Tests must never read or write the real `~/.prcli` (use `PRCLI_CONFIG_DIR`) or the real `~/Code` (use `PRCLI_PROJECTS_ROOT`).
- `node-pty` is main-process only; renderer code imports no Node built-ins and reaches privilege only through `window.prcli`.
- `tsconfig.json` has `"strict": true`. Keep it clean — no `any`, no non-null assertions, no `@ts-` suppressions.
- **Live tmux decides what exists; config supplies only order and selection.**
- **The durable record and the attached-client set are different things. Never derive one from the other, and never infer a session's death from a client's death.**
- Never weaken, loosen or delete an existing test assertion to make something pass. If a test contradicts the code, stop and report it.
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  ```
- Spec: `docs/superpowers/specs/2026-07-30-prcli-m2b-projects-design.md`. Parent design of record: `docs/superpowers/specs/2026-07-30-prcli-design.md`.

## Existing interfaces this milestone builds on

- `src/main/tmux/names.ts` — `SESSION_PREFIX`, `slugify(name)`, `newSessionId()`, `encodeSessionName({projectSlug,id})`, `decodeSessionName(name)`, `isPrcliSession(name)`
- `src/main/tmux/adapter.ts` — `TmuxAdapter({bin?,socket?})` with `readonly bin`, `baseArgs()`, `version()`, `listSessions()`, `listPrcliSessions()`, `hasSession(name)`, `killSession(name)`, `setSessionOption(name,option,value)`, `getSessionOption(name,option)`; `TmuxNotInstalledError`
- `src/main/sessions/manager.ts` — `SessionManager(adapter)` with `open(OpenInput)`, `get`, `list`, `write`, `resize`, `detach`, `detachAll`, `kill`, `hasSession`, `findOrphans`, `onData`, `onExit`; types `TabRecord`, `OpenInput`, `ExitReason`
- `src/main/state/store.ts` — `ConfigStore(filePath)` with `read()`, `write(config)`, `static defaultPath()`; `PrcliConfig` (v2)
- `src/main/ipc/restore.ts` — `restoreWorkspace(manager, store): Promise<RestoreResult>`
- `src/shared/ipc.ts` — `CHANNELS`, `TabDescriptor`, `OpenRequest`, `DataEvent`, `ExitEvent` (with `sessionAlive`), `RestoreResult`, `PrcliApi`
- `src/renderer/tabs.ts` — `TabsState`, `TabsAction`, `INITIAL_TABS_STATE`, `neighbourOf`, `tabsReducer`

## File Structure

| File | Responsibility |
|---|---|
| `src/renderer/index.css` | Tailwind entry and the `@theme` design tokens |
| `src/renderer/lib/cn.ts` | `clsx` + `tailwind-merge` class combiner |
| `src/renderer/ui/Button.tsx` | shadcn-idiom button |
| `src/renderer/ui/Dialog.tsx` | shadcn-idiom dialog over Radix |
| `vite.renderer.config.mts` (modify) | Register the Tailwind Vite plugin |
| `src/main/state/store.ts` (modify) | Config v3, v2→v3 migration |
| `src/main/projects/projects.ts` | Slug allocation, reserved guard, project CRUD over a config |
| `src/main/projects/manifest.ts` | Read and validate a repo's `.prcli.json` |
| `src/main/projects/discovery.ts` | Scan `PRCLI_PROJECTS_ROOT` for candidates |
| `src/main/tmux/adapter.ts` (modify) | `renameSession` |
| `src/main/ipc/restore.ts` (modify) | Resolve projects, Unsorted, per-project active tab; use the serialise queue |
| `src/main/ipc/register.ts` (modify) | Project channels, `moveTabToProject`, `pickFolder`, cwd guard |
| `src/shared/ipc.ts` (modify) | Project types and channels |
| `src/preload/index.ts` (modify) | Expose the new channels |
| `src/renderer/workspace.ts` | Workspace reducer, replacing `tabs.ts` |
| `src/renderer/Sidebar.tsx` | Project tree, tab lists, counts, Unsorted |
| `src/renderer/AddProjectDialog.tsx` | Candidate list plus folder picker |
| `src/renderer/RightPanel.tsx` | Active project's presets, ⇧⌘\ collapse |
| `src/renderer/TabBar.tsx` (modify) | Filter to the active project |
| `src/renderer/App.tsx` (modify) | Wire everything, keyboard, layout |
| `src/main/index.ts` (modify) | Menu entries for the new shortcuts |
| `tests/unit/store.test.ts` (modify) | v2→v3 migration |
| `tests/unit/projects.test.ts` | Slug allocation and CRUD |
| `tests/unit/manifest.test.ts` | Manifest parse and merge |
| `tests/unit/discovery.test.ts` | Candidate scanning |
| `tests/unit/workspace.test.ts` | Workspace reducer (M2a's tabs tests ported) |
| `tests/integration/adapter.test.ts` (modify) | `renameSession` |
| `tests/integration/restore.test.ts` (modify) | Grouping, Unsorted, active resolution |
| `tests/integration/persistence.test.ts` (modify) | Project channels, `moveTabToProject` |
| `tests/e2e/projects.spec.ts` | The milestone end to end |

---

### Task 1: Tailwind and the shadcn foundation

The parent spec commits to Tailwind + shadcn/ui and none of it is installed; every remaining task in this milestone writes chrome. Porting the three existing components now means writing them once.

shadcn/ui is a generator, not a dependency — it copies source into your repo. Rather than run its CLI (which wants a `components.json` and a `@/` path alias that would have to be threaded through three separate Vite configs plus `tsconfig.json`), this task vendors the two components 2b needs, in shadcn's idiom, using relative imports. Same result, far fewer moving parts in an Electron Forge build.

**Files:**
- Modify: `package.json`, `vite.renderer.config.mts`, `src/renderer/main.tsx`, `src/renderer/TabBar.tsx`, `src/renderer/App.tsx`, `src/renderer/Terminal.tsx`
- Create: `src/renderer/index.css`, `src/renderer/lib/cn.ts`, `src/renderer/ui/Button.tsx`, `src/renderer/ui/Dialog.tsx`

**Interfaces:**
- Consumes: nothing new
- Produces:
  - `cn(...inputs: ClassValue[]): string`
  - `Button(props: React.ComponentProps<'button'> & { variant?: 'default' | 'ghost'; size?: 'sm' | 'icon' }): JSX.Element`
  - `Dialog`, `DialogContent`, `DialogTitle`, `DialogDescription` — Radix wrappers
  - Design tokens usable as Tailwind utilities: `bg-bg`, `bg-surface`, `border-border`, `text-fg`, `text-muted`, `text-faint`, `text-accent`, `text-danger`, `font-mono`

- [ ] **Step 1: Install the dependencies**

Run:

```bash
npm i -D tailwindcss@latest @tailwindcss/vite@latest
npm i class-variance-authority@latest clsx@latest tailwind-merge@latest @radix-ui/react-dialog@latest lucide-react@latest
```

Then record the resolved versions — the plan deliberately does not pin them, because they must be checked live rather than guessed:

Run: `node -e "const p=require('./package.json');console.log(JSON.stringify({...p.dependencies,...p.devDependencies},null,1))"`

Put the resolved versions of the six new packages in your report.

- [ ] **Step 2: Register the Tailwind plugin**

Replace `vite.renderer.config.mts` entirely:

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
})
```

- [ ] **Step 3: Create the token sheet**

Create `src/renderer/index.css`:

```css
@import "tailwindcss";

/* The single source of truth for the app's colours.
   Tailwind v4 turns each --color-* into utilities: bg-surface, text-muted,
   border-border, and so on. */
@theme {
  --color-bg: #09090b;
  --color-surface: #0c0c0e;
  --color-border: #27272a;
  --color-fg: #fafafa;
  --color-muted: #71717a;
  --color-faint: #3f3f46;
  --color-accent: #a3e635;
  --color-danger: #f87171;

  /* xterm renders to a canvas and cannot read these variables, so
     Terminal.tsx repeats the two values it needs in a JS object. If you
     change --color-bg or --color-term-fg, change them there too. */
  --color-term-fg: #d4d4d8;

  --font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}

html, body, #root {
  height: 100%;
}
```

- [ ] **Step 4: Import it, and drop the inline body style**

In `src/renderer/main.tsx`, add as the first import:

```ts
import './index.css'
```

In `index.html` at the repo root, replace the `<body …>` opening tag:

```html
  <body style="margin:0;background:#09090b">
```

with:

```html
  <body class="m-0 bg-bg">
```

- [ ] **Step 5: Add the class combiner**

Create `src/renderer/lib/cn.ts`:

```ts
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Merge conditional classes, with later Tailwind utilities winning conflicts. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
```

- [ ] **Step 6: Add the Button**

Create `src/renderer/ui/Button.tsx`:

```tsx
import type { ComponentProps } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../lib/cn'

const button = cva(
  'inline-flex items-center justify-center gap-1.5 rounded font-mono transition-colors ' +
    'disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none ' +
    'focus-visible:ring-1 focus-visible:ring-accent',
  {
    variants: {
      variant: {
        default: 'bg-border text-fg hover:bg-faint',
        ghost: 'bg-transparent text-muted hover:text-fg hover:bg-border',
      },
      size: {
        sm: 'h-6 px-2 text-[11px]',
        icon: 'h-6 w-6 text-sm',
      },
    },
    defaultVariants: { variant: 'default', size: 'sm' },
  },
)

export function Button({
  className,
  variant,
  size,
  ...props
}: ComponentProps<'button'> & VariantProps<typeof button>) {
  return <button className={cn(button({ variant, size }), className)} {...props} />
}
```

- [ ] **Step 7: Add the Dialog**

Create `src/renderer/ui/Dialog.tsx`:

```tsx
import type { ComponentProps } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { cn } from '../lib/cn'

export const Dialog = DialogPrimitive.Root
export const DialogTitle = DialogPrimitive.Title
export const DialogDescription = DialogPrimitive.Description

export function DialogContent({
  className,
  children,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 bg-black/60" />
      <DialogPrimitive.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-50 w-[520px] max-w-[90vw] -translate-x-1/2 -translate-y-1/2',
          'rounded border border-border bg-surface p-4 font-mono text-fg shadow-xl',
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}
```

- [ ] **Step 8: Port TabBar.tsx**

Replace `src/renderer/TabBar.tsx` entirely. Every `data-testid` is unchanged — the E2E suite keys off them, and `tabbar` deliberately has no hyphen so that `[data-testid^="tab-"]` counts only real tabs:

```tsx
import type { TabDescriptor } from '../shared/ipc'
import { cn } from './lib/cn'

/** The tmux id is 16 hex characters; the first six are plenty to tell tabs apart. */
function label(tab: TabDescriptor): string {
  return `${tab.projectSlug} · ${tab.id.slice(0, 6)}`
}

export function TabBar({
  tabs,
  activeId,
  onActivate,
  onClose,
  onNew,
  canOpen,
}: {
  tabs: TabDescriptor[]
  activeId: string | null
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
  canOpen: boolean
}) {
  return (
    <div
      data-testid="tabbar"
      className="flex h-8 select-none items-stretch overflow-x-auto border-b border-border bg-surface font-mono text-[11px]"
    >
      {tabs.map((tab) => {
        const active = tab.id === activeId
        return (
          <div
            key={tab.id}
            data-testid={`tab-${tab.id}`}
            data-active={active ? 'true' : 'false'}
            onClick={() => onActivate(tab.id)}
            className={cn(
              'flex cursor-default items-center gap-1.5 whitespace-nowrap border-r border-border px-2.5',
              active ? 'bg-bg text-fg shadow-[inset_0_-1px_0_var(--color-accent)]' : 'text-muted',
            )}
          >
            <span>{label(tab)}</span>
            <button
              data-testid={`close-${tab.id}`}
              aria-label={`Close ${label(tab)}`}
              onClick={(event) => {
                // Without this the click also activates the tab being closed.
                event.stopPropagation()
                onClose(tab.id)
              }}
              className="cursor-default border-none bg-transparent p-0 text-xs leading-none text-inherit"
            >
              ×
            </button>
          </div>
        )
      })}
      <button
        data-testid="new-tab"
        aria-label="New terminal"
        onClick={onNew}
        disabled={!canOpen}
        className="cursor-default border-none bg-transparent px-3 text-sm text-faint disabled:opacity-40 enabled:hover:text-muted"
      >
        +
      </button>
    </div>
  )
}
```

Note the new `canOpen` prop. Task 13 passes it; until then `App.tsx` passes `canOpen` as a literal `true` (Step 9).

- [ ] **Step 9: Port App.tsx's markup**

In `src/renderer/App.tsx`, leave every hook, callback and effect exactly as it is. Replace only the returned JSX:

```tsx
  return (
    <div className="flex h-screen w-screen flex-col bg-bg">
      <TabBar
        tabs={state.tabs}
        activeId={state.activeId}
        onActivate={activateTab}
        onClose={closeTab}
        onNew={openTab}
        canOpen
      />
      {error ? (
        <pre
          data-testid="startup-error"
          className="m-0 whitespace-pre-wrap p-2 font-mono text-[13px] text-danger"
        >
          {error}
        </pre>
      ) : null}
      <div className="relative min-h-0 flex-1">
        {/* Every terminal stays mounted. Unmounting would dispose its xterm
            and lose local scrollback and viewport position on every switch. */}
        {state.tabs.map((tab) => {
          const active = tab.id === state.activeId
          return (
            <div
              key={tab.id}
              data-testid={active ? 'terminal-active' : `terminal-${tab.id}`}
              className={cn(
                // `visibility` rather than `display`, so a hidden tab is still
                // laid out and can measure itself. A display:none one never
                // fits, so it attaches at 80×24 and tmux shrinks the real
                // session to match — every background tab, on every launch.
                'absolute inset-0 p-2',
                active ? 'visible z-10' : 'invisible z-0 pointer-events-none',
              )}
            >
              <Terminal tabId={tab.id} visible={active} />
            </div>
          )
        })}
      </div>
    </div>
  )
```

Add `import { cn } from './lib/cn'` to the imports.

- [ ] **Step 10: Port Terminal.tsx**

In `src/renderer/Terminal.tsx`, change only the returned element:

```tsx
  return <div data-testid="terminal" ref={containerRef} className="h-full w-full" />
```

and add this comment immediately above the `theme:` line in the `new XTerm({…})` options:

```tsx
      // xterm renders to a canvas and cannot read the CSS variables in
      // index.css, so these two repeat --color-bg and --color-term-fg by
      // hand. Change them together.
```

- [ ] **Step 11: Verify nothing regressed**

Run: `npm run typecheck && npm test && npm run e2e`
Expected: typecheck clean, 105 tests pass, 13 E2E pass. The E2E suite keys off `data-testid`, all of which are unchanged.

**This step cannot tell you whether the port looks right** — only that it still functions. Say so plainly in your report rather than implying visual verification.

- [ ] **Step 12: Commit**

```bash
git add package.json package-lock.json vite.renderer.config.mts index.html src/renderer
git commit -m "$(cat <<'EOF'
Move the renderer onto Tailwind and shadcn-idiom components

The design of record commits to this stack and every remaining task in
this milestone writes chrome, so porting the three existing components
now means writing them once.

shadcn/ui is a generator rather than a dependency: its components are
vendored here in its idiom, with relative imports instead of a @/ alias
that would have to be threaded through three Vite configs.

Automated tests key off data-testid and cannot see whether this looks
right; that needs a hands-on pass.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Config v3

**Files:**
- Modify: `src/main/state/store.ts`
- Test: `tests/unit/store.test.ts`

**Interfaces:**
- Consumes: `TabRecord` from `src/main/sessions/manager.ts`
- Produces:
  - `interface Preset { id: string; label: string; command: string }`
  - `interface ProjectRecord { id: string; name: string; slug: string; cwd: string; presets: Preset[]; activeTabId: string | null }`
  - `interface PrcliConfig { version: 3; projects: ProjectRecord[]; activeProjectId: string | null; tabs: TabRecord[] }`
  - `ConfigStore.read()` migrates v1 and v2 files to v3 in memory without rewriting them

- [ ] **Step 1: Write the failing tests**

In `tests/unit/store.test.ts`, replace the existing `sampleConfig` declaration with:

```ts
const sampleConfig: PrcliConfig = {
  version: 3,
  activeProjectId: 'p1',
  projects: [
    {
      id: 'p1',
      name: 'Lumio',
      slug: 'lumio',
      cwd: '/Users/paolo/Code/Lumio',
      presets: [{ id: 'pr1', label: 'dev', command: 'npm run dev' }],
      activeTabId: 'a1b2c3d4e5f60718',
    },
  ],
  tabs: [
    {
      id: 'a1b2c3d4e5f60718',
      projectSlug: 'lumio',
      cwd: '/Users/paolo/Code/Lumio',
      tmuxSession: 'prcli-lumio-a1b2c3d4e5f60718',
    },
  ],
}
```

Every existing expectation of `{ version: 2, activeTabId: null, tabs: [] }` becomes:

```ts
{ version: 3, activeProjectId: null, projects: [], tabs: [] }
```

Update the `circular` cast in the write-failure test from `version: 2` to `version: 3`, leaving its assertion alone.

Replace the whole `describe('ConfigStore migration', …)` block with:

```ts
describe('ConfigStore migration', () => {
  const v2 = {
    version: 2,
    activeTabId: 'a1b2c3d4e5f60718',
    tabs: [
      {
        id: 'a1b2c3d4e5f60718',
        projectSlug: 'scratch',
        cwd: '/Users/paolo/Code',
        tmuxSession: 'prcli-scratch-a1b2c3d4e5f60718',
      },
      {
        id: '00000000000000ff',
        projectSlug: 'scratch',
        cwd: '/Users/paolo/Code',
        tmuxSession: 'prcli-scratch-00000000000000ff',
      },
    ],
  }

  const v1 = {
    version: 1,
    tabs: [
      {
        id: 'a1b2c3d4e5f60718',
        projectSlug: 'scratch',
        cwd: '/Users/paolo/Code',
        tmuxSession: 'prcli-scratch-a1b2c3d4e5f60718',
      },
    ],
  }

  it('reads a v2 file as v3, keeping tab order', async () => {
    await writeFile(file, JSON.stringify(v2), 'utf8')
    const config = await new ConfigStore(file).read()
    expect(config.version).toBe(3)
    expect(config.tabs.map((tab) => tab.id)).toEqual(['a1b2c3d4e5f60718', '00000000000000ff'])
  })

  // Synthesising a project from the slug is exactly the auto-create-from-slug
  // behaviour this milestone rejects. Migrated tabs belong to no project, and
  // restore surfaces them under Unsorted.
  it('invents no projects from a v2 file', async () => {
    await writeFile(file, JSON.stringify(v2), 'utf8')
    const config = await new ConfigStore(file).read()
    expect(config.projects).toEqual([])
    expect(config.activeProjectId).toBeNull()
  })

  it('drops v2\'s top-level active tab, which is now per-project', async () => {
    await writeFile(file, JSON.stringify(v2), 'utf8')
    const config: unknown = await new ConfigStore(file).read()
    expect(config).not.toHaveProperty('activeTabId')
  })

  it('still reads a v1 file, two versions back', async () => {
    await writeFile(file, JSON.stringify(v1), 'utf8')
    const config = await new ConfigStore(file).read()
    expect(config.version).toBe(3)
    expect(config.tabs.map((tab) => tab.id)).toEqual(['a1b2c3d4e5f60718'])
    expect(config.projects).toEqual([])
  })

  it('does not rewrite the file on read', async () => {
    await writeFile(file, JSON.stringify(v2), 'utf8')
    await new ConfigStore(file).read()
    const onDisk: unknown = JSON.parse(await readFile(file, 'utf8'))
    expect((onDisk as { version: number }).version).toBe(2)
  })

  it('keeps projects and their per-project active tabs on a v3 file', async () => {
    await writeFile(file, JSON.stringify(sampleConfig), 'utf8')
    const config = await new ConfigStore(file).read()
    expect(config.projects.map((p) => p.slug)).toEqual(['lumio'])
    expect(config.projects[0].activeTabId).toBe('a1b2c3d4e5f60718')
    expect(config.activeProjectId).toBe('p1')
  })

  it('defaults a v3 project with a missing presets array to an empty one', async () => {
    await writeFile(
      file,
      JSON.stringify({
        version: 3,
        activeProjectId: null,
        projects: [{ id: 'p1', name: 'Lumio', slug: 'lumio', cwd: '/tmp', activeTabId: null }],
        tabs: [],
      }),
      'utf8',
    )
    const config = await new ConfigStore(file).read()
    expect(config.projects[0].presets).toEqual([])
  })

  it('drops a project row that is not shaped like one', async () => {
    await writeFile(
      file,
      JSON.stringify({ version: 3, activeProjectId: null, projects: [null, 42], tabs: [] }),
      'utf8',
    )
    await expect(new ConfigStore(file).read().then((c) => c.projects)).resolves.toEqual([])
  })

  it('rejects an unknown future version rather than guessing', async () => {
    await writeFile(file, JSON.stringify({ version: 99, tabs: [] }), 'utf8')
    await expect(new ConfigStore(file).read())
      .resolves.toEqual({ version: 3, activeProjectId: null, projects: [], tabs: [] })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/store.test.ts`
Expected: FAIL — `version` is 2, `projects` undefined.

- [ ] **Step 3: Implement v3**

In `src/main/state/store.ts`, replace the `PrcliConfig` interface, `PrcliConfigV1`, `EMPTY`, `hasTabs` and `migrate` with:

```ts
export interface Preset {
  id: string
  label: string
  command: string
}

export interface ProjectRecord {
  id: string
  /** Display name. Freely renameable — the slug does not follow it. */
  name: string
  /** Immutable once allocated: it is baked into every session name. */
  slug: string
  cwd: string
  /** User-defined only. Repo presets merge in above this at read time. */
  presets: Preset[]
  /** Per-project, so returning to a project lands where you left it. */
  activeTabId: string | null
}

export interface PrcliConfig {
  version: 3
  /** Array order is sidebar order, and the order ⌘1–9 follows. */
  projects: ProjectRecord[]
  activeProjectId: string | null
  tabs: TabRecord[]
}

const EMPTY: PrcliConfig = { version: 3, projects: [], activeProjectId: null, tabs: [] }

function hasTabs(value: unknown): value is { version: number; tabs: TabRecord[] } {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { version?: unknown; tabs?: unknown }
  return typeof candidate.version === 'number' && Array.isArray(candidate.tabs)
}

function isProject(value: unknown): value is ProjectRecord {
  if (typeof value !== 'object' || value === null) return false
  const p = value as Partial<ProjectRecord>
  return (
    typeof p.id === 'string' &&
    typeof p.name === 'string' &&
    typeof p.slug === 'string' &&
    typeof p.cwd === 'string'
  )
}

/** Tolerate a project row missing its optional arrays rather than dropping it. */
function normaliseProject(project: ProjectRecord): ProjectRecord {
  return {
    ...project,
    presets: Array.isArray(project.presets) ? project.presets : [],
    activeTabId: typeof project.activeTabId === 'string' ? project.activeTabId : null,
  }
}

/**
 * v1 had no active tab. v2 had one, globally — a notion v3 replaces with one
 * per project, so it is dropped rather than guessed at.
 *
 * Neither v1 nor v2 had projects, and their tabs all carry the slug of the
 * single hardcoded project that no longer exists. Synthesising a project from
 * that slug is the auto-create-from-slug behaviour this milestone rejects, so
 * migrated tabs belong to nothing and restore lists them under Unsorted.
 */
function migrate(value: unknown): PrcliConfig {
  if (!hasTabs(value)) return { ...EMPTY }
  if (value.version === 3) {
    const v3 = value as Partial<PrcliConfig>
    const projects = Array.isArray(v3.projects) ? v3.projects.filter(isProject) : []
    return {
      version: 3,
      projects: projects.map(normaliseProject),
      activeProjectId: typeof v3.activeProjectId === 'string' ? v3.activeProjectId : null,
      tabs: value.tabs,
    }
  }
  if (value.version === 1 || value.version === 2) {
    return { version: 3, projects: [], activeProjectId: null, tabs: value.tabs }
  }
  // A version from the future: refuse to guess at its shape.
  return { ...EMPTY }
}
```

`read()` and `write()` are unchanged.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Fix the call sites**

Run: `npm run typecheck`
Expected: errors in `src/main/ipc/restore.ts` and `src/main/ipc/register.ts`, which both write `{ version: 2, activeTabId, tabs }`-shaped configs.

Make the **minimal** change to keep the branch green — Tasks 7 and 8 rewrite both properly:
- In `restore.ts`, change its `store.write({ version: 2, activeTabId, tabs })` call to `store.write({ ...saved, version: 3, tabs })` and have it return `activeTabId` resolved exactly as before.
- In `register.ts`, the `setActive` handler's `store.write({ ...config, activeTabId: id })` no longer typechecks because `activeTabId` is not a v3 field. Change it to a no-op body with the comment `// Task 8 reinstates this against per-project active tabs.` and leave the channel registered.

Re-run `npm run typecheck`.
Expected: clean.

- [ ] **Step 6: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: all green. Some `restore.test.ts` and `persistence.test.ts` assertions about the active tab may now be checking behaviour Task 7 will change — **if any test fails, stop and report it rather than editing the test.**

- [ ] **Step 7: Commit**

```bash
git add src/main/state/store.ts src/main/ipc/restore.ts src/main/ipc/register.ts tests/unit/store.test.ts
git commit -m "$(cat <<'EOF'
Add projects to the config

Config v3 records projects, sidebar order, which project is selected and
which tab is active within each. v1 and v2 files migrate in memory on
read; the file is left alone until something writes it.

Migration invents no projects. Old tabs carry the slug of the single
hardcoded project that no longer exists, and synthesising a project from
a slug is the behaviour this milestone rejects elsewhere — they surface
under Unsorted instead.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Slug allocation and project CRUD

Pure functions over a config value — no I/O, no Electron — so the rules about slug collisions are testable directly.

**Files:**
- Create: `src/main/projects/projects.ts`
- Test: `tests/unit/projects.test.ts`

**Interfaces:**
- Consumes: `PrcliConfig`, `ProjectRecord`, `Preset` from `src/main/state/store.ts`; `slugify` from `src/main/tmux/names.ts`
- Produces:
  - `const UNSORTED_ID = 'unsorted'`
  - `const RESERVED_SLUGS: ReadonlySet<string>`
  - `function allocateSlug(name: string, taken: Iterable<string>): string`
  - `function addProject(config: PrcliConfig, input: { name: string; cwd: string }): { config: PrcliConfig; project: ProjectRecord }`
  - `function removeProject(config: PrcliConfig, id: string): PrcliConfig`
  - `function updateProject(config: PrcliConfig, id: string, patch: { name?: string; presets?: Preset[] }): PrcliConfig`
  - `function reorderProjects(config: PrcliConfig, ids: string[]): PrcliConfig`
  - `function projectForSlug(config: PrcliConfig, slug: string): ProjectRecord | undefined`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/projects.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  UNSORTED_ID,
  allocateSlug,
  addProject,
  removeProject,
  updateProject,
  reorderProjects,
  projectForSlug,
} from '../../src/main/projects/projects'
import type { PrcliConfig } from '../../src/main/state/store'

const EMPTY: PrcliConfig = { version: 3, projects: [], activeProjectId: null, tabs: [] }

function withProjects(...names: string[]): PrcliConfig {
  return names.reduce<PrcliConfig>(
    (config, name) => addProject(config, { name, cwd: `/tmp/${name}` }).config,
    EMPTY,
  )
}

describe('allocateSlug', () => {
  it('slugifies the name when nothing is taken', () => {
    expect(allocateSlug('Lumio', [])).toBe('lumio')
  })

  it('separates a collision discriminator with an underscore, not a dash', () => {
    // names.ts defines slugs as /^[a-z0-9_]+$/ and decodes a session name by
    // splitting into exactly three dash-separated parts, so a dash here would
    // break encodeSessionName and decodeSessionName both.
    expect(allocateSlug('api', ['api'])).toBe('api_2')
  })

  it('keeps counting past the first collision', () => {
    expect(allocateSlug('api', ['api', 'api_2'])).toBe('api_3')
  })

  it('refuses the reserved Unsorted slug', () => {
    expect(allocateSlug('Unsorted', [])).toBe('unsorted_2')
  })

  it('produces a slug that survives a session-name round trip', () => {
    expect(allocateSlug('GCO — Queue Worker!', [])).toMatch(/^[a-z0-9_]+$/)
  })
})

describe('addProject', () => {
  it('appends to the end, which is sidebar order', () => {
    const config = withProjects('Adecco', 'Lumio')
    expect(config.projects.map((p) => p.name)).toEqual(['Adecco', 'Lumio'])
  })

  it('gives the first project focus when there was none', () => {
    const { config, project } = addProject(EMPTY, { name: 'Lumio', cwd: '/tmp/lumio' })
    expect(config.activeProjectId).toBe(project.id)
  })

  it('leaves the active project alone when one is already selected', () => {
    const first = withProjects('Adecco')
    const after = addProject(first, { name: 'Lumio', cwd: '/tmp/lumio' }).config
    expect(after.activeProjectId).toBe(first.activeProjectId)
  })

  it('gives every project a distinct id', () => {
    const config = withProjects('Adecco', 'Lumio')
    expect(new Set(config.projects.map((p) => p.id)).size).toBe(2)
  })

  it('starts a project with no presets and no active tab', () => {
    const { project } = addProject(EMPTY, { name: 'Lumio', cwd: '/tmp/lumio' })
    expect(project.presets).toEqual([])
    expect(project.activeTabId).toBeNull()
  })

  it('refuses a folder that is already a project', () => {
    const config = addProject(EMPTY, { name: 'Lumio', cwd: '/tmp/lumio' }).config
    expect(() => addProject(config, { name: 'Other', cwd: '/tmp/lumio' })).toThrow(/already/i)
  })

  it('discriminates a slug collision between two projects', () => {
    const config = withProjects('api', 'API')
    expect(config.projects.map((p) => p.slug)).toEqual(['api', 'api_2'])
  })
})

describe('removeProject', () => {
  it('removes the row', () => {
    const config = withProjects('Adecco', 'Lumio')
    const after = removeProject(config, config.projects[0].id)
    expect(after.projects.map((p) => p.name)).toEqual(['Lumio'])
  })

  // The sessions keep running; restore lists them under Unsorted because
  // their slug no longer matches anything. Nothing here should touch tabs.
  it('leaves the tabs alone', () => {
    const config: PrcliConfig = {
      ...withProjects('Lumio'),
      tabs: [
        {
          id: 'a1b2c3d4e5f60718',
          projectSlug: 'lumio',
          cwd: '/tmp/lumio',
          tmuxSession: 'prcli-lumio-a1b2c3d4e5f60718',
        },
      ],
    }
    const after = removeProject(config, config.projects[0].id)
    expect(after.tabs).toEqual(config.tabs)
  })

  it('moves focus to the neighbour when the active project goes', () => {
    const config = withProjects('Adecco', 'Lumio')
    const after = removeProject(config, config.projects[0].id)
    expect(after.activeProjectId).toBe(config.projects[1].id)
  })

  it('leaves nothing active when the last project goes', () => {
    const config = withProjects('Lumio')
    expect(removeProject(config, config.projects[0].id).activeProjectId).toBeNull()
  })

  it('ignores an unknown id', () => {
    const config = withProjects('Lumio')
    expect(removeProject(config, 'nope')).toEqual(config)
  })
})

describe('updateProject', () => {
  it('renames without touching the slug, which is baked into session names', () => {
    const config = withProjects('Lumio')
    const after = updateProject(config, config.projects[0].id, { name: 'Lumio Ltd' })
    expect(after.projects[0].name).toBe('Lumio Ltd')
    expect(after.projects[0].slug).toBe('lumio')
  })

  it('replaces the preset list', () => {
    const config = withProjects('Lumio')
    const presets = [{ id: 'pr1', label: 'dev', command: 'npm run dev' }]
    const after = updateProject(config, config.projects[0].id, { presets })
    expect(after.projects[0].presets).toEqual(presets)
  })

  it('ignores an unknown id', () => {
    const config = withProjects('Lumio')
    expect(updateProject(config, 'nope', { name: 'x' })).toEqual(config)
  })
})

describe('reorderProjects', () => {
  it('reorders to the given sequence', () => {
    const config = withProjects('Adecco', 'Lumio', 'GCO')
    const [a, l, g] = config.projects.map((p) => p.id)
    const after = reorderProjects(config, [g, a, l])
    expect(after.projects.map((p) => p.name)).toEqual(['GCO', 'Adecco', 'Lumio'])
  })

  it('appends anything the caller left out rather than dropping it', () => {
    const config = withProjects('Adecco', 'Lumio', 'GCO')
    const [, l] = config.projects.map((p) => p.id)
    const after = reorderProjects(config, [l])
    expect(after.projects.map((p) => p.name)).toEqual(['Lumio', 'Adecco', 'GCO'])
  })

  it('ignores ids that are not projects', () => {
    const config = withProjects('Adecco')
    expect(reorderProjects(config, ['nope']).projects.map((p) => p.name)).toEqual(['Adecco'])
  })
})

describe('projectForSlug', () => {
  it('finds the owner of a slug', () => {
    const config = withProjects('Lumio')
    expect(projectForSlug(config, 'lumio')?.name).toBe('Lumio')
  })

  it('returns undefined for a slug no project owns — that is what Unsorted means', () => {
    expect(projectForSlug(withProjects('Lumio'), 'scratch')).toBeUndefined()
  })

  it('never matches the reserved Unsorted id', () => {
    expect(projectForSlug(withProjects('Lumio'), UNSORTED_ID)).toBeUndefined()
  })
})

describe('immutability', () => {
  it('never mutates the config it is given', () => {
    const config = withProjects('Adecco', 'Lumio')
    const before = JSON.stringify(config)
    addProject(config, { name: 'GCO', cwd: '/tmp/gco' })
    removeProject(config, config.projects[0].id)
    updateProject(config, config.projects[0].id, { name: 'x' })
    reorderProjects(config, [config.projects[1].id])
    expect(JSON.stringify(config)).toBe(before)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/projects.test.ts`
Expected: FAIL — cannot resolve `../../src/main/projects/projects`.

- [ ] **Step 3: Implement**

Create `src/main/projects/projects.ts`:

```ts
import { randomBytes } from 'node:crypto'
import { slugify } from '../tmux/names'
import type { PrcliConfig, Preset, ProjectRecord } from '../state/store'

/**
 * The synthetic project that collects tabs whose slug matches nothing real.
 * Reserved so a user-created project can never shadow it.
 */
export const UNSORTED_ID = 'unsorted'

export const RESERVED_SLUGS: ReadonlySet<string> = new Set([UNSORTED_ID])

function newId(): string {
  return randomBytes(8).toString('hex')
}

/**
 * A session-safe slug that no existing project holds.
 *
 * The discriminator separator is `_`, not `-`: slugs must match
 * /^[a-z0-9_]+$/, and `decodeSessionName` splits a name into exactly three
 * dash-separated parts, so a dash inside a slug would break both directions.
 */
export function allocateSlug(name: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  const base = slugify(name)
  if (!used.has(base) && !RESERVED_SLUGS.has(base)) return base
  for (let n = 2; ; n += 1) {
    const candidate = `${base}_${n}`
    if (!used.has(candidate) && !RESERVED_SLUGS.has(candidate)) return candidate
  }
}

export function addProject(
  config: PrcliConfig,
  input: { name: string; cwd: string },
): { config: PrcliConfig; project: ProjectRecord } {
  if (config.projects.some((project) => project.cwd === input.cwd)) {
    throw new Error(`addProject: ${JSON.stringify(input.cwd)} is already a project`)
  }
  const project: ProjectRecord = {
    id: newId(),
    name: input.name,
    slug: allocateSlug(
      input.name,
      config.projects.map((existing) => existing.slug),
    ),
    cwd: input.cwd,
    presets: [],
    activeTabId: null,
  }
  return {
    config: {
      ...config,
      projects: [...config.projects, project],
      // The first project added becomes the selected one; later ones do not
      // steal focus from wherever the user is working.
      activeProjectId: config.activeProjectId ?? project.id,
    },
    project,
  }
}

export function removeProject(config: PrcliConfig, id: string): PrcliConfig {
  const index = config.projects.findIndex((project) => project.id === id)
  if (index === -1) return config
  const projects = config.projects.filter((project) => project.id !== id)
  // Same neighbour rule the tab bar uses: prefer the one to the right.
  const neighbour = config.projects[index + 1] ?? config.projects[index - 1]
  return {
    ...config,
    projects,
    activeProjectId:
      config.activeProjectId === id ? (neighbour?.id ?? null) : config.activeProjectId,
    // Tabs are untouched on purpose. Their sessions are still running; they
    // simply stop matching a project and surface under Unsorted.
  }
}

export function updateProject(
  config: PrcliConfig,
  id: string,
  patch: { name?: string; presets?: Preset[] },
): PrcliConfig {
  if (!config.projects.some((project) => project.id === id)) return config
  return {
    ...config,
    projects: config.projects.map((project) =>
      project.id === id
        ? {
            ...project,
            name: patch.name ?? project.name,
            presets: patch.presets ?? project.presets,
            // `slug` is deliberately absent: it is baked into every session
            // name for this project, and re-slugging would orphan all of them.
          }
        : project,
    ),
  }
}

export function reorderProjects(config: PrcliConfig, ids: string[]): PrcliConfig {
  const byId = new Map(config.projects.map((project) => [project.id, project]))
  const ordered: ProjectRecord[] = []
  for (const id of ids) {
    const project = byId.get(id)
    if (!project) continue
    byId.delete(id)
    ordered.push(project)
  }
  // Anything the caller did not mention keeps its relative order at the end,
  // so a stale id list cannot silently delete a project.
  ordered.push(...byId.values())
  return { ...config, projects: ordered }
}

export function projectForSlug(config: PrcliConfig, slug: string): ProjectRecord | undefined {
  return config.projects.find((project) => project.slug === slug)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/projects.test.ts`
Expected: PASS, 25 tests.

- [ ] **Step 5: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/main/projects/projects.ts tests/unit/projects.test.ts
git commit -m "$(cat <<'EOF'
Add slug allocation and project CRUD

Pure functions over a config value, so the collision rules are testable
without touching disk. Slugs are allocated once and never follow a
rename: they are baked into every session name for that project, and
re-slugging would orphan all of them.

The discriminator separator is an underscore. Slugs must match
[a-z0-9_]+ and session names decode by splitting on exactly three
dash-separated parts, so a dash would break both directions.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: The `.prcli.json` manifest

A repository ships its own commands so a project's presets travel with it.

**Files:**
- Create: `src/main/projects/manifest.ts`
- Test: `tests/unit/manifest.test.ts`

**Interfaces:**
- Consumes: `Preset` from `src/main/state/store.ts`
- Produces:
  - `interface ResolvedPreset { id: string; label: string; command: string; origin: 'user' | 'repo' }`
  - `function readManifest(cwd: string): Promise<Preset[]>` — repo presets, `[]` on any problem
  - `function mergePresets(user: Preset[], repo: Preset[]): ResolvedPreset[]`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/manifest.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readManifest, mergePresets } from '../../src/main/projects/manifest'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'prcli-manifest-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function manifest(contents: string): Promise<void> {
  await writeFile(join(dir, '.prcli.json'), contents, 'utf8')
}

describe('readManifest', () => {
  it('reads the declared presets', async () => {
    await manifest(JSON.stringify({ presets: [{ label: 'dev', command: 'npm run dev' }] }))
    const presets = await readManifest(dir)
    expect(presets.map((p) => p.label)).toEqual(['dev'])
    expect(presets[0].command).toBe('npm run dev')
  })

  it('gives every preset an id, since the file carries none', async () => {
    await manifest(JSON.stringify({ presets: [{ label: 'dev', command: 'npm run dev' }] }))
    expect((await readManifest(dir))[0].id).toEqual(expect.any(String))
  })

  it('returns nothing when there is no manifest', async () => {
    await expect(readManifest(dir)).resolves.toEqual([])
  })

  // One bad file in one customer's repo must never stop the app starting.
  it('returns nothing for malformed JSON rather than throwing', async () => {
    await manifest('{not json')
    await expect(readManifest(dir)).resolves.toEqual([])
  })

  it('returns nothing when presets is not an array', async () => {
    await manifest(JSON.stringify({ presets: 'nope' }))
    await expect(readManifest(dir)).resolves.toEqual([])
  })

  it('drops entries that are not shaped like a preset', async () => {
    await manifest(
      JSON.stringify({ presets: [{ label: 'ok', command: 'x' }, { label: 'no command' }, null] }),
    )
    await expect(readManifest(dir).then((p) => p.map((e) => e.label))).resolves.toEqual(['ok'])
  })

  it('returns nothing when the directory does not exist', async () => {
    await expect(readManifest(join(dir, 'gone'))).resolves.toEqual([])
  })

  it('returns nothing when .prcli.json is a directory', async () => {
    await mkdir(join(dir, '.prcli.json'))
    await expect(readManifest(dir)).resolves.toEqual([])
  })
})

describe('mergePresets', () => {
  const user = [{ id: 'u1', label: 'dev', command: 'npm run dev -- --port 4000' }]
  const repo = [
    { id: 'r1', label: 'dev', command: 'npm run dev' },
    { id: 'r2', label: 'queue', command: 'php artisan queue:work' },
  ]

  it('lets the user override a repo preset with the same label', () => {
    const merged = mergePresets(user, repo)
    expect(merged.find((p) => p.label === 'dev')?.command).toBe('npm run dev -- --port 4000')
  })

  it('keeps repo presets the user has not overridden', () => {
    expect(mergePresets(user, repo).map((p) => p.label).sort()).toEqual(['dev', 'queue'])
  })

  it('tags where each came from, so the panel can show provenance', () => {
    const merged = mergePresets(user, repo)
    expect(merged.find((p) => p.label === 'dev')?.origin).toBe('user')
    expect(merged.find((p) => p.label === 'queue')?.origin).toBe('repo')
  })

  it('puts user presets first', () => {
    expect(mergePresets(user, repo)[0].label).toBe('dev')
  })

  it('handles either side being empty', () => {
    expect(mergePresets([], repo).map((p) => p.origin)).toEqual(['repo', 'repo'])
    expect(mergePresets(user, []).map((p) => p.origin)).toEqual(['user'])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/manifest.test.ts`
Expected: FAIL — cannot resolve `../../src/main/projects/manifest`.

- [ ] **Step 3: Implement**

Create `src/main/projects/manifest.ts`:

```ts
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Preset } from '../state/store'

export interface ResolvedPreset extends Preset {
  /** Where this came from, so the panel can show which the repo supplied. */
  origin: 'user' | 'repo'
}

const MANIFEST = '.prcli.json'

function isPresetLike(value: unknown): value is { label: string; command: string } {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { label?: unknown; command?: unknown }
  return typeof candidate.label === 'string' && typeof candidate.command === 'string'
}

/**
 * Presets a repository declares for itself.
 *
 * Never throws, for the same reason `ConfigStore.read` never does: a damaged
 * file in one of five customers' repositories must not stop the app starting.
 * A missing, unreadable or malformed manifest simply contributes nothing.
 *
 * Read on every restore rather than cached at add time, so a repo's commands
 * track the repo.
 */
export async function readManifest(cwd: string): Promise<Preset[]> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(join(cwd, MANIFEST), 'utf8'))
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const presets = (parsed as { presets?: unknown }).presets
  if (!Array.isArray(presets)) return []
  return presets.filter(isPresetLike).map((preset) => ({
    // The file carries no id. This one only has to be stable within a render
    // and unique among the project's presets — nothing persists it.
    id: `repo:${preset.label}`,
    label: preset.label,
    command: preset.command,
  }))
}

/** User presets win on label, and sort first. */
export function mergePresets(user: Preset[], repo: Preset[]): ResolvedPreset[] {
  const overridden = new Set(user.map((preset) => preset.label))
  return [
    ...user.map((preset): ResolvedPreset => ({ ...preset, origin: 'user' })),
    ...repo
      .filter((preset) => !overridden.has(preset.label))
      .map((preset): ResolvedPreset => ({ ...preset, origin: 'repo' })),
  ]
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/manifest.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Run the full suite and commit**

Run: `npm test && npm run typecheck`
Expected: all green.

```bash
git add src/main/projects/manifest.ts tests/unit/manifest.test.ts
git commit -m "$(cat <<'EOF'
Read per-repository presets from .prcli.json

A project's commands travel with the repository. Read on every restore
rather than cached at add time, so they track the repo, and merged under
the user's own presets, which win on a label collision.

Never throws: a damaged manifest in one customer's repo must not stop
the app starting, the same contract ConfigStore.read holds.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Project discovery

**Files:**
- Create: `src/main/projects/discovery.ts`
- Test: `tests/unit/discovery.test.ts`

**Interfaces:**
- Produces:
  - `interface Candidate { name: string; cwd: string; markers: string[] }`
  - `function projectsRoot(): string` — `PRCLI_PROJECTS_ROOT` or `~/Code`
  - `function scanCandidates(taken: Iterable<string>): Promise<Candidate[]>`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/discovery.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanCandidates, projectsRoot } from '../../src/main/projects/discovery'

let root: string
const original = process.env.PRCLI_PROJECTS_ROOT

beforeEach(async () => {
  // Never scan the developer's real ~/Code, for the same reason tests never
  // touch the real ~/.prcli.
  root = await mkdtemp(join(tmpdir(), 'prcli-scan-'))
  process.env.PRCLI_PROJECTS_ROOT = root
})

afterEach(async () => {
  if (original === undefined) delete process.env.PRCLI_PROJECTS_ROOT
  else process.env.PRCLI_PROJECTS_ROOT = original
  await rm(root, { recursive: true, force: true })
})

async function repo(name: string, marker: string): Promise<string> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  if (marker === '.git') await mkdir(join(dir, '.git'))
  else await writeFile(join(dir, marker), '{}', 'utf8')
  return dir
}

describe('projectsRoot', () => {
  it('honours PRCLI_PROJECTS_ROOT', () => {
    expect(projectsRoot()).toBe(root)
  })

  it('falls back to ~/Code', () => {
    delete process.env.PRCLI_PROJECTS_ROOT
    expect(projectsRoot()).toMatch(/\/Code$/)
  })
})

describe('scanCandidates', () => {
  it('finds a git repository', async () => {
    await repo('lumio', '.git')
    await expect(scanCandidates([]).then((c) => c.map((e) => e.name))).resolves.toEqual(['lumio'])
  })

  it('finds a node project and a php one', async () => {
    await repo('web', 'package.json')
    await repo('api', 'composer.json')
    const names = (await scanCandidates([])).map((c) => c.name)
    expect(names.sort()).toEqual(['api', 'web'])
  })

  it('reports which markers it matched on', async () => {
    await repo('lumio', '.git')
    await writeFile(join(root, 'lumio', 'package.json'), '{}', 'utf8')
    const [candidate] = await scanCandidates([])
    expect(candidate.markers.sort()).toEqual(['.git', 'package.json'])
  })

  it('ignores a directory with no marker', async () => {
    await mkdir(join(root, 'notes'))
    await expect(scanCandidates([])).resolves.toEqual([])
  })

  it('ignores loose files at the root', async () => {
    await writeFile(join(root, 'todo.txt'), 'x', 'utf8')
    await expect(scanCandidates([])).resolves.toEqual([])
  })

  it('does not descend past one level', async () => {
    await mkdir(join(root, 'clients', 'lumio', '.git'), { recursive: true })
    await expect(scanCandidates([])).resolves.toEqual([])
  })

  it('excludes folders that are already projects', async () => {
    const lumio = await repo('lumio', '.git')
    await repo('adecco', '.git')
    await expect(scanCandidates([lumio]).then((c) => c.map((e) => e.name))).resolves.toEqual([
      'adecco',
    ])
  })

  it('sorts by name so the picker is stable', async () => {
    await repo('zeta', '.git')
    await repo('alpha', '.git')
    await expect(scanCandidates([]).then((c) => c.map((e) => e.name))).resolves.toEqual([
      'alpha',
      'zeta',
    ])
  })

  it('returns nothing when the root does not exist', async () => {
    process.env.PRCLI_PROJECTS_ROOT = join(root, 'gone')
    await expect(scanCandidates([])).resolves.toEqual([])
  })

  it('skips dotfile directories', async () => {
    await repo('.cache', '.git')
    await expect(scanCandidates([])).resolves.toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/discovery.test.ts`
Expected: FAIL — cannot resolve `../../src/main/projects/discovery`.

- [ ] **Step 3: Implement**

Create `src/main/projects/discovery.ts`:

```ts
import { readdir, access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface Candidate {
  name: string
  cwd: string
  /** Which of the markers below matched, so the picker can show why. */
  markers: string[]
}

/** A directory holding one of these is a project worth offering. */
const MARKERS = ['.git', 'package.json', 'composer.json']

/**
 * `PRCLI_PROJECTS_ROOT` exists so tests scan a temp directory instead of the
 * developer's real ~/Code, the same role PRCLI_CONFIG_DIR plays for config.
 */
export function projectsRoot(): string {
  return process.env.PRCLI_PROJECTS_ROOT ?? join(homedir(), 'Code')
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Directories one level below the root that look like projects.
 *
 * One level only: the root holds around twenty candidates of which roughly a
 * quarter are wanted, and recursing would turn that into hundreds.
 */
export async function scanCandidates(taken: Iterable<string>): Promise<Candidate[]> {
  const already = new Set(taken)
  let entries
  try {
    entries = await readdir(projectsRoot(), { withFileTypes: true })
  } catch {
    // No root, or unreadable. The picker still offers "Choose folder…".
    return []
  }

  const candidates: Candidate[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const cwd = join(projectsRoot(), entry.name)
    if (already.has(cwd)) continue
    const markers: string[] = []
    for (const marker of MARKERS) {
      if (await exists(join(cwd, marker))) markers.push(marker)
    }
    if (markers.length > 0) candidates.push({ name: entry.name, cwd, markers })
  }
  return candidates.sort((a, b) => a.name.localeCompare(b.name))
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/discovery.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Confirm the real ~/Code was never read**

Run: `npx vitest run tests/unit/discovery.test.ts 2>&1 | grep -c "$HOME/Code" || echo "clean"`
Expected: `clean`. Every test sets `PRCLI_PROJECTS_ROOT`; the one test that unsets it only calls `projectsRoot()`, which builds a path without reading it.

- [ ] **Step 6: Run the full suite and commit**

Run: `npm test && npm run typecheck`

```bash
git add src/main/projects/discovery.ts tests/unit/discovery.test.ts
git commit -m "$(cat <<'EOF'
Scan for candidate projects

One level below PRCLI_PROJECTS_ROOT, matching on .git, package.json or
composer.json. One level only: the root holds around twenty candidates
of which roughly a quarter are wanted, and recursing would find hundreds.

The env var exists so tests never scan the developer's real ~/Code, the
same role PRCLI_CONFIG_DIR plays for config.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Renaming a tmux session

Rehoming an Unsorted tab means changing the slug, and the slug lives inside the session name.

**Files:**
- Modify: `src/main/tmux/adapter.ts`
- Test: `tests/integration/adapter.test.ts`

**Interfaces:**
- Produces: `TmuxAdapter.renameSession(from: string, to: string): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Append to `tests/integration/adapter.test.ts`, alongside the other top-level `describe` blocks. `adapter`, `createSession` and `SOCKET` already exist at module scope — do not redeclare them:

```ts
describe('TmuxAdapter.renameSession', () => {
  it('renames a session, keeping it alive', async () => {
    await createSession('prcli-scratch-a1b2c3d4e5f60718')
    await adapter.renameSession('prcli-scratch-a1b2c3d4e5f60718', 'prcli-lumio-a1b2c3d4e5f60718')
    await expect(adapter.hasSession('prcli-lumio-a1b2c3d4e5f60718')).resolves.toBe(true)
    await expect(adapter.hasSession('prcli-scratch-a1b2c3d4e5f60718')).resolves.toBe(false)
  })

  it('throws when the source does not exist', async () => {
    await expect(
      adapter.renameSession('prcli-scratch-a1b2c3d4e5f60718', 'prcli-lumio-a1b2c3d4e5f60718'),
    ).rejects.toThrow()
  })

  it('throws rather than colliding with an existing name', async () => {
    await createSession('prcli-scratch-a1b2c3d4e5f60718')
    await createSession('prcli-lumio-00000000000000ff')
    await expect(
      adapter.renameSession('prcli-scratch-a1b2c3d4e5f60718', 'prcli-lumio-00000000000000ff'),
    ).rejects.toThrow()
    // The source must survive a refused rename.
    await expect(adapter.hasSession('prcli-scratch-a1b2c3d4e5f60718')).resolves.toBe(true)
  })

  it('targets exactly one session', async () => {
    await createSession('prcli-scratch-a1b2c3d4e5f60718')
    await createSession('prcli-scratch-00000000000000ff')
    await adapter.renameSession('prcli-scratch-a1b2c3d4e5f60718', 'prcli-lumio-a1b2c3d4e5f60718')
    await expect(adapter.hasSession('prcli-scratch-00000000000000ff')).resolves.toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/integration/adapter.test.ts`
Expected: FAIL — `adapter.renameSession is not a function`.

- [ ] **Step 3: Implement**

In `src/main/tmux/adapter.ts`, add after `killSession`:

```ts
  /**
   * Rename a session in place. Everything running inside it is untouched —
   * this only changes the name, and with it which project the tab matches.
   *
   * `=from` is exact-match syntax; without it `prcli-lumio` would match by
   * prefix. Note the target here takes no trailing colon: unlike
   * `set-option`/`show-options`, `rename-session`'s `-t` is a session target
   * already.
   */
  async renameSession(from: string, to: string): Promise<void> {
    await this.exec(['rename-session', '-t', `=${from}`, to])
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/integration/adapter.test.ts`
Expected: PASS.

If the collision test fails because tmux allows duplicate names on this version, **stop and report it** rather than deleting the assertion — it changes what Task 8's `moveTabToProject` has to guard against.

- [ ] **Step 5: Verify nothing leaked and commit**

Run: `npm test && npm run typecheck && tmux ls`
Expected: all green, and `tmux ls` shows no session this run created — every command above went to `-L prcli-test`.

```bash
git add src/main/tmux/adapter.ts tests/integration/adapter.test.ts
git commit -m "$(cat <<'EOF'
Add renameSession to the tmux adapter

Rehoming a tab from Unsorted into a real project means changing its
slug, and the slug lives inside the session name. Renaming in place
keeps the session, its scrollback and its running processes — the tab
id is the other half of the name and does not move.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Restore projects, Unsorted and per-project active tabs

The reconcile that M2a built for tabs now has to answer three questions instead of one: which projects exist, which is selected, and which tab is active inside each. It also stops bypassing the config write queue (M2a review finding I6).

**Files:**
- Modify: `src/main/ipc/restore.ts`, `src/shared/ipc.ts`, `src/main/projects/projects.ts`
- Test: `tests/integration/restore.test.ts`

**Interfaces:**
- Consumes: `readManifest`, `mergePresets` (Task 4); `SessionManager.detachAll/findOrphans/open`; `ConfigStore`
- Produces:
  - `const UNSORTED_ID = 'unsorted'` **moves to `src/shared/ipc.ts`** — the renderer needs it and cannot import from `src/main`. `src/main/projects/projects.ts` re-exports it from there so Task 3's imports keep working.
  - `interface ResolvedPreset { id: string; label: string; command: string; origin: 'user' | 'repo' }` — **moves here from `manifest.ts`**, which imports it instead
  - `interface ProjectDescriptor { id: string; name: string; slug: string; cwd: string; presets: ResolvedPreset[]; activeTabId: string | null; available: boolean }`
  - `interface RestoreResult { projects: ProjectDescriptor[]; tabs: TabDescriptor[]; activeProjectId: string | null }`
  - `restoreWorkspace(manager, store, serialise): Promise<RestoreResult>` — third parameter is the config write queue

- [ ] **Step 1: Add the wire types**

In `src/shared/ipc.ts`, add:

```ts
/**
 * The synthetic project collecting tabs whose slug matches no real one.
 * Lives here rather than in src/main because the renderer needs it too.
 */
export const UNSORTED_ID = 'unsorted'

/**
 * A preset as the renderer sees it: user and repo presets already merged.
 * Declared here rather than in src/main/projects/manifest.ts, which now
 * imports it — two structurally identical types under two names is exactly
 * the drift restore.ts already avoids for TabDescriptor.
 */
export interface ResolvedPreset {
  id: string
  label: string
  command: string
  origin: 'user' | 'repo'
}

export interface ProjectDescriptor {
  id: string
  name: string
  slug: string
  cwd: string
  presets: ResolvedPreset[]
  activeTabId: string | null
  /** False when `cwd` is no longer a directory — renamed or deleted. */
  available: boolean
}
```

and replace `RestoreResult` with:

```ts
export interface RestoreResult {
  /** Sidebar order. Unsorted, when present, is always last. */
  projects: ProjectDescriptor[]
  tabs: TabDescriptor[]
  activeProjectId: string | null
}
```

In `src/main/projects/manifest.ts`, delete the local `ResolvedPreset` declaration and replace it with `import { type ResolvedPreset } from '../../shared/ipc'` plus `export type { ResolvedPreset }`, so Task 4's consumers are unaffected.

In `src/main/projects/projects.ts`, delete the local `UNSORTED_ID` declaration and replace it with a re-export so Task 3's consumers are unaffected:

```ts
import { UNSORTED_ID } from '../../shared/ipc'
export { UNSORTED_ID }
```

- [ ] **Step 2: Write the failing tests**

In `tests/integration/restore.test.ts`, add these imports and helper at the top:

```ts
import { mkdir, writeFile as write } from 'node:fs/promises'
import { UNSORTED_ID } from '../../src/shared/ipc'
import type { PrcliConfig } from '../../src/main/state/store'

/** The config write queue. Restore is the only caller under test, so running
 *  each operation immediately is equivalent to the real serialised queue. */
const immediate = <T>(operation: () => Promise<T>): Promise<T> => operation()

function project(name: string, slug: string, cwd: string, activeTabId: string | null = null) {
  return { id: `id-${slug}`, name, slug, cwd, presets: [], activeTabId }
}
```

Change `configWith` to take the whole v3 config shape:

```ts
async function configWith(config: Omit<PrcliConfig, 'version'>): Promise<ConfigStore> {
  const dir = await mkdtemp(join(tmpdir(), 'prcli-restore-'))
  const file = join(dir, 'config.json')
  await write(file, JSON.stringify({ version: 3, ...config }), 'utf8')
  return new ConfigStore(file)
}
```

**Update every existing call in the file** to the new shape and to pass `immediate` as `restoreWorkspace`'s third argument. This is a mechanical signature change — do not alter what any existing test asserts.

Then add:

```ts
describe('restoreWorkspace projects', () => {
  it('groups a tab under the project whose slug it carries', async () => {
    await createStray('prcli-lumio-1111111111111111')
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const store = await configWith({
      projects: [project('Lumio', 'lumio', tmpdir())],
      activeProjectId: 'id-lumio',
      tabs: [],
    })

    const result = await restoreWorkspace(manager, store, immediate)

    expect(result.projects.map((p) => p.id)).toEqual(['id-lumio'])
    expect(result.projects[0].activeTabId).toBe('1111111111111111')
    manager.detachAll()
  })

  it('puts a tab matching no project under Unsorted, last', async () => {
    await createStray('prcli-lumio-1111111111111111')
    await createStray('prcli-scratch-2222222222222222')
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const store = await configWith({
      projects: [project('Lumio', 'lumio', tmpdir())],
      activeProjectId: 'id-lumio',
      tabs: [],
    })

    const result = await restoreWorkspace(manager, store, immediate)

    expect(result.projects.map((p) => p.id)).toEqual(['id-lumio', UNSORTED_ID])
    expect(result.projects[1].activeTabId).toBe('2222222222222222')
    manager.detachAll()
  })

  it('omits Unsorted entirely when every tab matches', async () => {
    await createStray('prcli-lumio-1111111111111111')
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const store = await configWith({
      projects: [project('Lumio', 'lumio', tmpdir())],
      activeProjectId: 'id-lumio',
      tabs: [],
    })

    const result = await restoreWorkspace(manager, store, immediate)

    expect(result.projects.map((p) => p.id)).not.toContain(UNSORTED_ID)
    manager.detachAll()
  })

  it('resolves each project\'s active tab independently', async () => {
    await createStray('prcli-lumio-1111111111111111')
    await createStray('prcli-lumio-2222222222222222')
    await createStray('prcli-gco-3333333333333333')
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const store = await configWith({
      projects: [
        project('Lumio', 'lumio', tmpdir(), '2222222222222222'),
        project('GCO', 'gco', tmpdir(), '3333333333333333'),
      ],
      activeProjectId: 'id-gco',
      tabs: [],
    })

    const result = await restoreWorkspace(manager, store, immediate)

    expect(result.projects[0].activeTabId).toBe('2222222222222222')
    expect(result.projects[1].activeTabId).toBe('3333333333333333')
    expect(result.activeProjectId).toBe('id-gco')
    manager.detachAll()
  })

  it('falls back to a project\'s first tab when its saved active tab died', async () => {
    await createStray('prcli-lumio-1111111111111111')
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const store = await configWith({
      projects: [project('Lumio', 'lumio', tmpdir(), '9999999999999999')],
      activeProjectId: 'id-lumio',
      tabs: [],
    })

    await expect(
      restoreWorkspace(manager, store, immediate).then((r) => r.projects[0].activeTabId),
    ).resolves.toBe('1111111111111111')
    manager.detachAll()
  })

  it('leaves a project with no live tabs holding no active tab', async () => {
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const store = await configWith({
      projects: [project('Lumio', 'lumio', tmpdir(), '9999999999999999')],
      activeProjectId: 'id-lumio',
      tabs: [],
    })

    await expect(
      restoreWorkspace(manager, store, immediate).then((r) => r.projects[0].activeTabId),
    ).resolves.toBeNull()
  })

  it('falls back to the first project when the saved one is gone', async () => {
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const store = await configWith({
      projects: [project('Lumio', 'lumio', tmpdir())],
      activeProjectId: 'id-vanished',
      tabs: [],
    })

    await expect(
      restoreWorkspace(manager, store, immediate).then((r) => r.activeProjectId),
    ).resolves.toBe('id-lumio')
  })

  it('can hold Unsorted as the selected project across a relaunch', async () => {
    await createStray('prcli-scratch-2222222222222222')
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const store = await configWith({ projects: [], activeProjectId: UNSORTED_ID, tabs: [] })

    await expect(
      restoreWorkspace(manager, store, immediate).then((r) => r.activeProjectId),
    ).resolves.toBe(UNSORTED_ID)
    manager.detachAll()
  })

  it('merges the repo\'s own presets under the user\'s', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'prcli-repo-'))
    await write(
      join(cwd, '.prcli.json'),
      JSON.stringify({ presets: [{ label: 'queue', command: 'php artisan queue:work' }] }),
      'utf8',
    )
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const store = await configWith({
      projects: [
        { ...project('Lumio', 'lumio', cwd), presets: [{ id: 'u1', label: 'dev', command: 'npm run dev' }] },
      ],
      activeProjectId: 'id-lumio',
      tabs: [],
    })

    const result = await restoreWorkspace(manager, store, immediate)

    expect(result.projects[0].presets.map((p) => `${p.label}:${p.origin}`)).toEqual([
      'dev:user',
      'queue:repo',
    ])
  })

  it('marks a project whose directory has gone as unavailable', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'prcli-gone-'))
    await rm(cwd, { recursive: true, force: true })
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const store = await configWith({
      projects: [project('Lumio', 'lumio', cwd)],
      activeProjectId: 'id-lumio',
      tabs: [],
    })

    await expect(
      restoreWorkspace(manager, store, immediate).then((r) => r.projects[0].available),
    ).resolves.toBe(false)
  })

  it('does not persist the synthetic Unsorted row', async () => {
    await createStray('prcli-scratch-2222222222222222')
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const store = await configWith({ projects: [], activeProjectId: null, tabs: [] })

    await restoreWorkspace(manager, store, immediate)

    await expect(store.read().then((c) => c.projects)).resolves.toEqual([])
    manager.detachAll()
  })

  it('writes each project\'s resolved active tab back to config', async () => {
    await createStray('prcli-lumio-1111111111111111')
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const store = await configWith({
      projects: [project('Lumio', 'lumio', tmpdir())],
      activeProjectId: 'id-lumio',
      tabs: [],
    })

    await restoreWorkspace(manager, store, immediate)

    await expect(store.read().then((c) => c.projects[0].activeTabId)).resolves.toBe(
      '1111111111111111',
    )
    manager.detachAll()
  })
})
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/integration/restore.test.ts`
Expected: FAIL — `restoreWorkspace` takes two arguments and returns no `projects`.

- [ ] **Step 4: Implement**

Replace `src/main/ipc/restore.ts` entirely:

```ts
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import type { SessionManager, TabRecord } from '../sessions/manager'
import type { ConfigStore, ProjectRecord } from '../state/store'
import { readManifest, mergePresets } from '../projects/manifest'
import {
  UNSORTED_ID,
  type ProjectDescriptor,
  type RestoreResult,
  type TabDescriptor,
} from '../../shared/ipc'

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Reconcile the saved workspace against what tmux actually has.
 *
 * Live tmux sessions decide what exists; config supplies display order, which
 * project is selected and which tab is active inside each. Deriving existence
 * from config instead is what made a session the app had lost track of
 * unreachable from the UI.
 *
 * A tab belongs to the project whose slug its session name carries. Nothing
 * stores that association, so it cannot go stale, and Unsorted is a definition
 * — tabs matching no project — rather than a list anyone maintains.
 *
 * The whole reconcile runs inside the caller's config write queue: it reads
 * and then writes, and an interleaved write from `open` or an exit would
 * otherwise be lost.
 */
export async function restoreWorkspace(
  manager: SessionManager,
  store: ConfigStore,
  serialise: <T>(operation: () => Promise<T>) => Promise<T>,
): Promise<RestoreResult> {
  return serialise(async () => {
    const saved = await store.read()

    // Any client we still hold is stale here by definition: a restore means
    // the renderer that owned it is gone. `findOrphans` excludes sessions we
    // have attached, so without this a second restore in one app lifetime — a
    // ⌘R, a renderer crash — sees nothing and strands everything.
    manager.detachAll()
    const orphans = await manager.findOrphans()
    const byId = new Map(orphans.map((orphan) => [orphan.id, orphan]))

    const ordered: TabRecord[] = []
    for (const row of saved.tabs) {
      const orphan = byId.get(row.id)
      if (!orphan) continue
      byId.delete(row.id)
      // The saved row carries the real cwd; the orphan's is synthesised.
      ordered.push({ ...orphan, cwd: row.cwd, command: row.command })
    }
    ordered.push(...byId.values())

    const tabs: TabDescriptor[] = []
    for (const record of ordered) {
      try {
        tabs.push(
          manager.open({
            id: record.id,
            projectSlug: record.projectSlug,
            cwd: record.cwd,
            command: record.command,
            tmuxSession: record.tmuxSession,
          }),
        )
      } catch {
        // One session that will not attach must not cost the user the ones
        // that did. tmux still has it, so the next restore tries afresh.
        continue
      }
    }

    const tabsOf = (slug: string): TabDescriptor[] =>
      tabs.filter((tab) => tab.projectSlug === slug)

    const resolveActive = (project: ProjectRecord): string | null => {
      const own = tabsOf(project.slug)
      return own.find((tab) => tab.id === project.activeTabId)?.id ?? own[0]?.id ?? null
    }

    const projects: ProjectDescriptor[] = []
    for (const project of saved.projects) {
      projects.push({
        id: project.id,
        name: project.name,
        slug: project.slug,
        cwd: project.cwd,
        presets: mergePresets(project.presets, await readManifest(project.cwd)),
        activeTabId: resolveActive(project),
        available: await isDirectory(project.cwd),
      })
    }

    // Unsorted exists only while something is in it.
    const known = new Set(saved.projects.map((project) => project.slug))
    const strays = tabs.filter((tab) => !known.has(tab.projectSlug))
    if (strays.length > 0) {
      projects.push({
        id: UNSORTED_ID,
        name: 'Unsorted',
        slug: UNSORTED_ID,
        // Never used to launch anything — every tab here has its own cwd.
        cwd: homedir(),
        presets: [],
        // Deliberately not persisted: this is a place to rehome a stray, not
        // one to live in.
        activeTabId: strays[0].id,
        available: true,
      })
    }

    const activeProjectId =
      projects.find((project) => project.id === saved.activeProjectId)?.id ??
      projects[0]?.id ??
      null

    await store.write({
      version: 3,
      // Only real projects are persisted; the Unsorted row is synthetic.
      projects: saved.projects.map((project) => ({
        ...project,
        activeTabId: resolveActive(project),
      })),
      activeProjectId,
      tabs,
    })

    return { projects, tabs, activeProjectId }
  })
}
```

- [ ] **Step 5: Update the one call site**

In `src/main/ipc/register.ts`, the restore handler must now pass the queue:

```ts
  ipcMain.handle(
    CHANNELS.restore,
    (): Promise<RestoreResult> => restoreWorkspace(manager, store, serialise),
  )
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/integration/restore.test.ts`
Expected: PASS — the twelve new tests plus every pre-existing one.

- [ ] **Step 7: Run everything**

Run: `npm test && npm run typecheck && npm run e2e`
Expected: all green. `tests/integration/persistence.test.ts` and the E2E suite both exercise restore; **if any assertion there fails, stop and report it** rather than editing the test.

- [ ] **Step 8: Verify nothing leaked and commit**

Run: `tmux ls && ls -l ~/.prcli`
Expected: no session this run created on the default socket, and `~/.prcli` untouched.

```bash
git add src/main/ipc/restore.ts src/main/ipc/register.ts src/shared/ipc.ts src/main/projects/projects.ts tests/integration/restore.test.ts
git commit -m "$(cat <<'EOF'
Restore projects, Unsorted and per-project active tabs

Reconcile now answers three questions instead of one: which projects
exist, which is selected, and which tab is active inside each. A tab
belongs to the project whose slug its session name carries, so nothing
stores that association and it cannot go stale — and Unsorted falls out
as a definition rather than a list anyone maintains.

The whole reconcile now runs inside the config write queue. It reads and
then writes, so an interleaved write from open or an exit could be lost;
that was finding I6 of the Milestone 2a review.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Project IPC

**Files:**
- Modify: `src/shared/ipc.ts`, `src/main/ipc/register.ts`, `src/main/ipc/restore.ts`, `src/main/sessions/manager.ts`, `src/main/state/store.ts`, `src/main/projects/discovery.ts`, `src/preload/index.ts`
- Create: `src/main/fsutil.ts`
- Test: `tests/integration/persistence.test.ts`

**Interfaces:**
- Produces:
  - `isDirectory(path: string): Promise<boolean>` in `src/main/fsutil.ts`
  - `describeProjects(projects: ProjectRecord[], tabs: TabDescriptor[]): Promise<ProjectDescriptor[]>` exported from `restore.ts`, used by both restore and every mutation handler
  - `SessionManager.moveToProject(id: string, projectSlug: string): Promise<TabRecord>`
  - Channels `addProject`, `updateProject`, `removeProject`, `reorderProjects`, `setActiveProject`, `scanCandidates`, `pickFolder`, `moveTabToProject`
  - `PrcliApi` gains the matching methods; every project mutation resolves to the fresh `ProjectDescriptor[]`

- [ ] **Step 1: Consolidate the wire types**

`Preset` currently lives in `store.ts` and `Candidate` in `discovery.ts`, but the renderer needs both and cannot import from `src/main`. Move both declarations into `src/shared/ipc.ts`:

```ts
export interface Preset {
  id: string
  label: string
  command: string
}

export interface Candidate {
  name: string
  cwd: string
  markers: string[]
}
```

Then in `src/main/state/store.ts` replace the local `Preset` declaration with `import { type Preset } from '../../shared/ipc'` plus `export type { Preset }`, and do the same for `Candidate` in `src/main/projects/discovery.ts`. Duplicating these shapes instead would let the two copies drift — the reason `restore.ts` already shares `TabDescriptor` rather than restating it.

Extract `isDirectory` from `restore.ts` into a new `src/main/fsutil.ts`:

```ts
import { stat } from 'node:fs/promises'

/** True only for a path that exists and is a directory. Never throws. */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}
```

and import it in `restore.ts` instead of declaring it there.

- [ ] **Step 2: Extract `describeProjects`**

In `src/main/ipc/restore.ts`, lift the project-description loop out of `restoreWorkspace` into an exported function, so mutation handlers return exactly the same shape restore does:

```ts
/**
 * Turn stored project rows into what the renderer draws: presets merged with
 * the repo's own, each project's active tab resolved against the tabs that
 * are actually live, and whether its directory still exists.
 *
 * Does not append Unsorted — that is restore's job, because only restore
 * knows the full live tab set.
 */
export async function describeProjects(
  projects: ProjectRecord[],
  tabs: TabDescriptor[],
): Promise<ProjectDescriptor[]> {
  const described: ProjectDescriptor[] = []
  for (const project of projects) {
    const own = tabs.filter((tab) => tab.projectSlug === project.slug)
    described.push({
      id: project.id,
      name: project.name,
      slug: project.slug,
      cwd: project.cwd,
      presets: mergePresets(project.presets, await readManifest(project.cwd)),
      activeTabId: own.find((tab) => tab.id === project.activeTabId)?.id ?? own[0]?.id ?? null,
      available: await isDirectory(project.cwd),
    })
  }
  return described
}
```

and have `restoreWorkspace` call `await describeProjects(saved.projects, tabs)` in place of its inline loop. Its Unsorted append, `activeProjectId` resolution and `store.write` are unchanged.

- [ ] **Step 3: Write the failing tests**

Append to `tests/integration/persistence.test.ts`. It already stubs `ipcMain` and captures handlers — follow the existing `openTab` / `killTab` helpers for the calling convention:

```ts
function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = ipc.handlers.get(channel)
  if (!handler) throw new Error(`no handler registered for ${channel}`)
  return handler(null as never, ...(args as never[])) as Promise<T>
}

describe('project channels', () => {
  it('adds a project and returns the new list', async () => {
    const projects = await invoke<ProjectDescriptor[]>(CHANNELS.addProject, {
      name: 'Lumio',
      cwd: tmpdir(),
    })
    expect(projects.map((p) => p.name)).toEqual(['Lumio'])
    await expect(store.read().then((c) => c.projects.map((p) => p.slug))).resolves.toEqual(['lumio'])
  })

  it('refuses the same folder twice', async () => {
    await invoke(CHANNELS.addProject, { name: 'Lumio', cwd: tmpdir() })
    await expect(invoke(CHANNELS.addProject, { name: 'Other', cwd: tmpdir() })).rejects.toThrow(
      /already/i,
    )
  })

  it('renames without moving the slug', async () => {
    const [added] = await invoke<ProjectDescriptor[]>(CHANNELS.addProject, {
      name: 'Lumio',
      cwd: tmpdir(),
    })
    const after = await invoke<ProjectDescriptor[]>(CHANNELS.updateProject, added.id, {
      name: 'Lumio Ltd',
    })
    expect(after[0].name).toBe('Lumio Ltd')
    expect(after[0].slug).toBe('lumio')
  })

  it('records the active tab against the project that owns it', async () => {
    await invoke(CHANNELS.addProject, { name: 'Lumio', cwd: tmpdir() })
    const tab = await openTabIn('lumio')
    ipc.listeners.get(CHANNELS.setActive)?.(null as never, tab.id as never)
    await settle(200)
    await expect(store.read().then((c) => c.projects[0].activeTabId)).resolves.toBe(tab.id)
  })

  // A tab under Unsorted has no project row to record it against, and its
  // active tab is deliberately not persisted.
  it('ignores setActive for a tab belonging to no project', async () => {
    const tab = await openTab()
    ipc.listeners.get(CHANNELS.setActive)?.(null as never, tab.id as never)
    await settle(200)
    await expect(store.read().then((c) => c.projects)).resolves.toEqual([])
  })

  it('moves a tab into a project by renaming its tmux session', async () => {
    const [project] = await invoke<ProjectDescriptor[]>(CHANNELS.addProject, {
      name: 'Lumio',
      cwd: tmpdir(),
    })
    const tab = await openTab()
    const before = tab.tmuxSession

    const moved = await invoke<{ tab: TabDescriptor }>(
      CHANNELS.moveTabToProject,
      tab.id,
      project.id,
    )

    expect(moved.tab.projectSlug).toBe('lumio')
    expect(moved.tab.id).toBe(tab.id)
    expect(moved.tab.tmuxSession).toBe(`prcli-lumio-${tab.id}`)
    const adapter = new TmuxAdapter({ socket: SOCKET })
    await expect(adapter.hasSession(moved.tab.tmuxSession)).resolves.toBe(true)
    await expect(adapter.hasSession(before)).resolves.toBe(false)
  })

  it('refuses to open a terminal in a directory that is not there', async () => {
    await expect(
      invoke(CHANNELS.open, {
        projectSlug: 'lumio',
        cwd: join(tmpdir(), 'definitely-not-here-9f3a'),
      }),
    ).rejects.toThrow(/not a directory/i)
  })
})
```

Add an `openTabIn(slug)` helper alongside the existing `openTab`, opening with that `projectSlug` and `cwd: tmpdir()`. Import `ProjectDescriptor`, `TabDescriptor` and `TmuxAdapter` at the top if they are not already there.

- [ ] **Step 4: Run to verify failure**

Run: `npx vitest run tests/integration/persistence.test.ts`
Expected: FAIL — no handler registered for `prcli:addProject`.

- [ ] **Step 5: Add `moveToProject` to the manager**

In `src/main/sessions/manager.ts`, add after `kill`:

```ts
  /**
   * Move a tab into another project by renaming its tmux session.
   *
   * The tab id is the second half of the name and does not change, so the
   * session keeps its scrollback and everything running inside it — only the
   * slug moves, and with it which project the tab matches. Our own client is
   * detached first because the session is being renamed underneath it, then
   * reattached under the new name.
   */
  async moveToProject(id: string, projectSlug: string): Promise<TabRecord> {
    const entry = this.entries.get(id)
    const current = entry?.record ?? (await this.findOrphans()).find((row) => row.id === id)
    if (!current) throw new Error(`moveToProject: no session for tab ${id}`)

    const tmuxSession = encodeSessionName({ projectSlug, id })
    if (tmuxSession === current.tmuxSession) return current

    if (entry) this.detach(id)
    await this.adapter.renameSession(current.tmuxSession, tmuxSession)
    return this.open({
      id,
      projectSlug,
      cwd: current.cwd,
      command: current.command,
      tmuxSession,
    })
  }
```

- [ ] **Step 6: Add the channels**

In `src/shared/ipc.ts`, add to `CHANNELS`:

```ts
  addProject: 'prcli:addProject',
  updateProject: 'prcli:updateProject',
  removeProject: 'prcli:removeProject',
  reorderProjects: 'prcli:reorderProjects',
  setActiveProject: 'prcli:setActiveProject',
  scanCandidates: 'prcli:scanCandidates',
  pickFolder: 'prcli:pickFolder',
  moveTabToProject: 'prcli:moveTabToProject',
```

and to `PrcliApi`:

```ts
  addProject(input: { name: string; cwd: string }): Promise<ProjectDescriptor[]>
  updateProject(id: string, patch: { name?: string; presets?: Preset[] }): Promise<ProjectDescriptor[]>
  removeProject(id: string): Promise<ProjectDescriptor[]>
  reorderProjects(ids: string[]): Promise<ProjectDescriptor[]>
  setActiveProject(id: string | null): void
  scanCandidates(): Promise<Candidate[]>
  pickFolder(): Promise<string | null>
  moveTabToProject(
    tabId: string,
    projectId: string,
  ): Promise<{ projects: ProjectDescriptor[]; tab: TabDescriptor }>
```

- [ ] **Step 7: Implement the handlers**

In `src/main/ipc/register.ts`, add these imports:

```ts
import { dialog } from 'electron'
import { isDirectory } from '../fsutil'
import { describeProjects, restoreWorkspace } from './restore'
import {
  addProject,
  removeProject,
  reorderProjects,
  updateProject,
  projectForSlug,
} from '../projects/projects'
import { scanCandidates } from '../projects/discovery'
```

Replace the `CHANNELS.open` handler's body so it guards the directory first:

```ts
  ipcMain.handle(CHANNELS.open, async (_event, request: OpenRequest): Promise<TabDescriptor> => {
    // node-pty does not throw on a missing cwd — it yields a live process that
    // produces nothing, so the tab renders permanently blank while its tmux
    // session is perfectly fine. Say what is actually wrong instead.
    if (!(await isDirectory(request.cwd))) {
      throw new Error(`Cannot open a terminal: ${request.cwd} is not a directory`)
    }
    const record = manager.open(request)
    await rememberTab(record)
    return record
  })
```

Reinstate `setActive` (Task 2 stubbed it) and add the rest:

```ts
  /** Every project mutation answers with the list the renderer should draw. */
  const described = (config: PrcliConfig): Promise<ProjectDescriptor[]> =>
    describeProjects(config.projects, manager.list())

  ipcMain.on(CHANNELS.setActive, (_event, id: string | null) => {
    void serialise(async () => {
      if (id === null) return
      const config = await store.read()
      const tab = config.tabs.find((saved) => saved.id === id)
      if (!tab) return
      const owner = projectForSlug(config, tab.projectSlug)
      // A tab under Unsorted has no row to record this on, by design.
      if (!owner) return
      await store.write({
        ...config,
        projects: config.projects.map((project) =>
          project.id === owner.id ? { ...project, activeTabId: id } : project,
        ),
      })
    })
  })

  ipcMain.on(CHANNELS.setActiveProject, (_event, id: string | null) => {
    void serialise(async () => {
      const config = await store.read()
      await store.write({ ...config, activeProjectId: id })
    })
  })

  ipcMain.handle(CHANNELS.addProject, (_event, input: { name: string; cwd: string }) =>
    serialise(async () => {
      const { config } = addProject(await store.read(), input)
      await store.write(config)
      return described(config)
    }),
  )

  ipcMain.handle(
    CHANNELS.updateProject,
    (_event, id: string, patch: { name?: string; presets?: Preset[] }) =>
      serialise(async () => {
        const config = updateProject(await store.read(), id, patch)
        await store.write(config)
        return described(config)
      }),
  )

  ipcMain.handle(CHANNELS.removeProject, (_event, id: string) =>
    serialise(async () => {
      // The project's sessions keep running. They stop matching a project and
      // surface under Unsorted, so nothing is stranded and nothing is killed.
      const config = removeProject(await store.read(), id)
      await store.write(config)
      return described(config)
    }),
  )

  ipcMain.handle(CHANNELS.reorderProjects, (_event, ids: string[]) =>
    serialise(async () => {
      const config = reorderProjects(await store.read(), ids)
      await store.write(config)
      return described(config)
    }),
  )

  ipcMain.handle(CHANNELS.scanCandidates, async (): Promise<Candidate[]> => {
    const config = await store.read()
    return scanCandidates(config.projects.map((project) => project.cwd))
  })

  ipcMain.handle(CHANNELS.pickFolder, async (): Promise<string | null> => {
    const window = getWindow()
    const result = window
      ? await dialog.showOpenDialog(window, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle(CHANNELS.moveTabToProject, (_event, tabId: string, projectId: string) =>
    serialise(async () => {
      const config = await store.read()
      const target = config.projects.find((project) => project.id === projectId)
      if (!target) throw new Error(`moveTabToProject: no project ${projectId}`)

      const tab = await manager.moveToProject(tabId, target.slug)
      const tabs = config.tabs.map((saved) => (saved.id === tabId ? tab : saved))
      await store.write({ ...config, tabs })
      return { projects: await describeProjects(config.projects, tabs), tab }
    }),
  )
```

Import `PrcliConfig`, `Preset`, `ProjectDescriptor` and `Candidate` types as needed.

- [ ] **Step 8: Expose them in the preload**

In `src/preload/index.ts`, add to the `api` object:

```ts
  addProject: (input) => ipcRenderer.invoke(CHANNELS.addProject, input),
  updateProject: (id, patch) => ipcRenderer.invoke(CHANNELS.updateProject, id, patch),
  removeProject: (id) => ipcRenderer.invoke(CHANNELS.removeProject, id),
  reorderProjects: (ids) => ipcRenderer.invoke(CHANNELS.reorderProjects, ids),
  setActiveProject: (id) => ipcRenderer.send(CHANNELS.setActiveProject, id),
  scanCandidates: () => ipcRenderer.invoke(CHANNELS.scanCandidates),
  pickFolder: () => ipcRenderer.invoke(CHANNELS.pickFolder),
  moveTabToProject: (tabId, projectId) =>
    ipcRenderer.invoke(CHANNELS.moveTabToProject, tabId, projectId),
```

- [ ] **Step 9: Run the tests**

Run: `npx vitest run tests/integration/persistence.test.ts`
Expected: PASS.

- [ ] **Step 10: Run everything, check for leaks, commit**

Run: `npm test && npm run typecheck && npm run e2e && tmux ls && ls -l ~/.prcli`
Expected: all green; no session on the default socket from this run; `~/.prcli` untouched.

```bash
git add src/shared/ipc.ts src/main src/preload/index.ts tests/integration/persistence.test.ts
git commit -m "$(cat <<'EOF'
Add the project IPC surface

Add, rename, remove and reorder projects; scan for candidates; pick a
folder; move a tab between projects. Every mutation answers with the
project list the renderer should draw, built by the same function
restore uses, so the two cannot drift.

Opening a terminal now checks its directory first. node-pty does not
throw on a missing cwd — it yields a live process that produces nothing,
so the tab renders permanently blank while its tmux session is fine.
That was harmless while cwd was a constant and is reachable now that
projects own their directories.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: The workspace reducer

M2a's `tabsReducer` gains a project dimension. One reducer rather than two, because the interesting rule — what becomes active when a tab closes — is now per project and would otherwise have to be shared between them.

**Files:**
- Create: `src/renderer/workspace.ts`
- Delete: `src/renderer/tabs.ts`
- Test: `tests/unit/workspace.test.ts`
- Delete: `tests/unit/tabs.test.ts`

**Interfaces:**
- Consumes: `TabDescriptor`, `ProjectDescriptor`, `UNSORTED_ID` from `src/shared/ipc.ts`
- Produces:
  - `interface WorkspaceState { projects: ProjectDescriptor[]; tabs: TabDescriptor[]; activeProjectId: string | null }`
  - `type WorkspaceAction` — `restored` | `projects` | `opened` | `removed` | `activatedTab` | `activatedProject` | `movedTab`
  - `const INITIAL_WORKSPACE_STATE: WorkspaceState`
  - `function neighbourOf(tabs: TabDescriptor[], id: string): string | null`
  - `function projectIdForTab(projects: ProjectDescriptor[], tab: TabDescriptor): string`
  - `function tabsOfProject(state: WorkspaceState, projectId: string): TabDescriptor[]`
  - `function activeProject(state: WorkspaceState): ProjectDescriptor | undefined`
  - `function activeTabId(state: WorkspaceState): string | null`
  - `function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState`

- [ ] **Step 1: Port the existing tests**

Create `tests/unit/workspace.test.ts` by carrying over every test in `tests/unit/tabs.test.ts` — all fifteen — and adapting them to the new shape. **They are ported, not dropped**: each assertion must survive in recognisable form. The `neighbourOf` block transfers unchanged.

```ts
import { describe, it, expect } from 'vitest'
import {
  INITIAL_WORKSPACE_STATE,
  workspaceReducer,
  neighbourOf,
  projectIdForTab,
  tabsOfProject,
  activeProject,
  activeTabId,
  type WorkspaceState,
} from '../../src/renderer/workspace'
import { UNSORTED_ID, type ProjectDescriptor, type TabDescriptor } from '../../src/shared/ipc'

function tab(id: string, projectSlug = 'lumio'): TabDescriptor {
  return { id, projectSlug, cwd: '/tmp', tmuxSession: `prcli-${projectSlug}-${id}` }
}

function project(id: string, slug: string, activeTabId: string | null = null): ProjectDescriptor {
  return {
    id,
    name: slug,
    slug,
    cwd: '/tmp',
    presets: [],
    activeTabId,
    available: true,
  }
}

const three: WorkspaceState = {
  projects: [project('p1', 'lumio', 'bbb')],
  tabs: [tab('aaa'), tab('bbb'), tab('ccc')],
  activeProjectId: 'p1',
}

describe('neighbourOf', () => {
  it('prefers the tab to the right', () => {
    expect(neighbourOf(three.tabs, 'aaa')).toBe('bbb')
  })

  it('falls back to the left for the last tab', () => {
    expect(neighbourOf(three.tabs, 'ccc')).toBe('bbb')
  })

  it('returns null when it was the only tab', () => {
    expect(neighbourOf([tab('aaa')], 'aaa')).toBeNull()
  })

  it('returns null for an unknown id', () => {
    expect(neighbourOf(three.tabs, 'zzz')).toBeNull()
  })
})

describe('projectIdForTab', () => {
  it('matches on the slug in the session name', () => {
    expect(projectIdForTab(three.projects, tab('aaa', 'lumio'))).toBe('p1')
  })

  it('falls back to Unsorted when no project owns the slug', () => {
    expect(projectIdForTab(three.projects, tab('aaa', 'scratch'))).toBe(UNSORTED_ID)
  })
})

describe('tabsOfProject', () => {
  it('returns only that project\'s tabs', () => {
    const state: WorkspaceState = {
      projects: [project('p1', 'lumio'), project('p2', 'gco')],
      tabs: [tab('aaa', 'lumio'), tab('bbb', 'gco'), tab('ccc', 'lumio')],
      activeProjectId: 'p1',
    }
    expect(tabsOfProject(state, 'p1').map((t) => t.id)).toEqual(['aaa', 'ccc'])
  })

  it('collects every unmatched tab under Unsorted', () => {
    const state: WorkspaceState = {
      projects: [project('p1', 'lumio')],
      tabs: [tab('aaa', 'lumio'), tab('bbb', 'scratch'), tab('ccc', 'old')],
      activeProjectId: 'p1',
    }
    expect(tabsOfProject(state, UNSORTED_ID).map((t) => t.id)).toEqual(['bbb', 'ccc'])
  })
})

describe('activeProject and activeTabId', () => {
  it('reads the active tab off the active project', () => {
    expect(activeProject(three)?.id).toBe('p1')
    expect(activeTabId(three)).toBe('bbb')
  })

  it('has no active tab when no project is selected', () => {
    expect(activeTabId({ ...three, activeProjectId: null })).toBeNull()
  })
})

describe('workspaceReducer', () => {
  it('starts empty', () => {
    expect(INITIAL_WORKSPACE_STATE).toEqual({ projects: [], tabs: [], activeProjectId: null })
  })

  it('replaces everything on restore', () => {
    const next = workspaceReducer(three, {
      type: 'restored',
      projects: [project('p9', 'gco', 'zzz')],
      tabs: [tab('zzz', 'gco')],
      activeProjectId: 'p9',
    })
    expect(next.tabs.map((t) => t.id)).toEqual(['zzz'])
    expect(next.activeProjectId).toBe('p9')
  })

  it('appends an opened tab and makes it its project\'s active one', () => {
    const next = workspaceReducer(three, { type: 'opened', tab: tab('ddd') })
    expect(next.tabs.map((t) => t.id)).toEqual(['aaa', 'bbb', 'ccc', 'ddd'])
    expect(activeTabId(next)).toBe('ddd')
  })

  it('ignores an opened tab that is already present', () => {
    const next = workspaceReducer(three, { type: 'opened', tab: tab('bbb') })
    expect(next.tabs.map((t) => t.id)).toEqual(['aaa', 'bbb', 'ccc'])
  })

  it('activates a tab', () => {
    expect(activeTabId(workspaceReducer(three, { type: 'activatedTab', id: 'ccc' }))).toBe('ccc')
  })

  it('ignores activation of an unknown tab', () => {
    expect(activeTabId(workspaceReducer(three, { type: 'activatedTab', id: 'zzz' }))).toBe('bbb')
  })

  it('removes a tab and moves the active one to its neighbour', () => {
    const next = workspaceReducer(three, { type: 'removed', id: 'bbb' })
    expect(next.tabs.map((t) => t.id)).toEqual(['aaa', 'ccc'])
    expect(activeTabId(next)).toBe('ccc')
  })

  it('leaves the active tab alone when removing a different one', () => {
    expect(activeTabId(workspaceReducer(three, { type: 'removed', id: 'aaa' }))).toBe('bbb')
  })

  it('goes back to nothing active when a project\'s last tab is removed', () => {
    const one: WorkspaceState = {
      projects: [project('p1', 'lumio', 'aaa')],
      tabs: [tab('aaa')],
      activeProjectId: 'p1',
    }
    const next = workspaceReducer(one, { type: 'removed', id: 'aaa' })
    expect(next.tabs).toEqual([])
    expect(activeTabId(next)).toBeNull()
  })

  it('ignores removal of an unknown tab', () => {
    expect(workspaceReducer(three, { type: 'removed', id: 'zzz' })).toEqual(three)
  })

  // Removing a tab from one project must not disturb another's selection.
  it('only touches the owning project\'s active tab', () => {
    const state: WorkspaceState = {
      projects: [project('p1', 'lumio', 'aaa'), project('p2', 'gco', 'bbb')],
      tabs: [tab('aaa', 'lumio'), tab('bbb', 'gco')],
      activeProjectId: 'p2',
    }
    const next = workspaceReducer(state, { type: 'removed', id: 'aaa' })
    expect(next.projects[1].activeTabId).toBe('bbb')
  })

  it('switches project', () => {
    const state: WorkspaceState = {
      ...three,
      projects: [...three.projects, project('p2', 'gco')],
    }
    expect(workspaceReducer(state, { type: 'activatedProject', id: 'p2' }).activeProjectId).toBe(
      'p2',
    )
  })

  it('ignores activation of an unknown project', () => {
    expect(workspaceReducer(three, { type: 'activatedProject', id: 'nope' }).activeProjectId).toBe(
      'p1',
    )
  })

  it('replaces the project list without disturbing tabs', () => {
    const next = workspaceReducer(three, { type: 'projects', projects: [project('p1', 'lumio')] })
    expect(next.tabs).toEqual(three.tabs)
  })

  it('drops the selection when the selected project disappears', () => {
    const next = workspaceReducer(three, { type: 'projects', projects: [project('p2', 'gco')] })
    expect(next.activeProjectId).toBe('p2')
  })

  it('re-slugs a moved tab in place, keeping its position', () => {
    const state: WorkspaceState = {
      projects: [project('p1', 'lumio')],
      tabs: [tab('aaa', 'scratch'), tab('bbb', 'scratch')],
      activeProjectId: 'p1',
    }
    const next = workspaceReducer(state, {
      type: 'movedTab',
      tab: tab('aaa', 'lumio'),
      projects: state.projects,
    })
    expect(next.tabs.map((t) => t.projectSlug)).toEqual(['lumio', 'scratch'])
  })

  it('never mutates the state it is given', () => {
    const before = JSON.stringify(three)
    workspaceReducer(three, { type: 'removed', id: 'bbb' })
    workspaceReducer(three, { type: 'opened', tab: tab('ddd') })
    workspaceReducer(three, { type: 'activatedTab', id: 'aaa' })
    expect(JSON.stringify(three)).toBe(before)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/workspace.test.ts`
Expected: FAIL — cannot resolve `../../src/renderer/workspace`.

- [ ] **Step 3: Implement**

Create `src/renderer/workspace.ts`:

```ts
import { UNSORTED_ID, type ProjectDescriptor, type TabDescriptor } from '../shared/ipc'

export interface WorkspaceState {
  /** Sidebar order. Unsorted, when present, is last. */
  projects: ProjectDescriptor[]
  /** Every tab across every project. The tab bar filters this. */
  tabs: TabDescriptor[]
  activeProjectId: string | null
}

export type WorkspaceAction =
  | {
      type: 'restored'
      projects: ProjectDescriptor[]
      tabs: TabDescriptor[]
      activeProjectId: string | null
    }
  | { type: 'projects'; projects: ProjectDescriptor[] }
  | { type: 'opened'; tab: TabDescriptor }
  | { type: 'removed'; id: string }
  | { type: 'activatedTab'; id: string }
  | { type: 'activatedProject'; id: string }
  | { type: 'movedTab'; tab: TabDescriptor; projects: ProjectDescriptor[] }

export const INITIAL_WORKSPACE_STATE: WorkspaceState = {
  projects: [],
  tabs: [],
  activeProjectId: null,
}

/**
 * Which tab to show once `id` goes away: the one to its right, or its left
 * when it was last. Null when it was the only one.
 */
export function neighbourOf(tabs: TabDescriptor[], id: string): string | null {
  const index = tabs.findIndex((tab) => tab.id === id)
  if (index === -1) return null
  const next = tabs[index + 1] ?? tabs[index - 1]
  return next?.id ?? null
}

/**
 * The project a tab belongs to, derived from the slug in its session name.
 *
 * Nothing stores this association, so it cannot go stale — and a tab whose
 * slug no project owns is, by definition, Unsorted.
 */
export function projectIdForTab(projects: ProjectDescriptor[], tab: TabDescriptor): string {
  return projects.find((project) => project.slug === tab.projectSlug)?.id ?? UNSORTED_ID
}

export function tabsOfProject(state: WorkspaceState, projectId: string): TabDescriptor[] {
  return state.tabs.filter((tab) => projectIdForTab(state.projects, tab) === projectId)
}

export function activeProject(state: WorkspaceState): ProjectDescriptor | undefined {
  return state.projects.find((project) => project.id === state.activeProjectId)
}

/** The active tab is a property of the active project, not of the workspace. */
export function activeTabId(state: WorkspaceState): string | null {
  return activeProject(state)?.activeTabId ?? null
}

function setActiveTab(
  state: WorkspaceState,
  projectId: string,
  activeTabId: string | null,
): WorkspaceState {
  return {
    ...state,
    projects: state.projects.map((project) =>
      project.id === projectId ? { ...project, activeTabId } : project,
    ),
  }
}

export function workspaceReducer(
  state: WorkspaceState,
  action: WorkspaceAction,
): WorkspaceState {
  switch (action.type) {
    case 'restored':
      return {
        projects: action.projects,
        tabs: action.tabs,
        activeProjectId: action.activeProjectId,
      }

    case 'projects': {
      const stillThere = action.projects.some((project) => project.id === state.activeProjectId)
      return {
        ...state,
        projects: action.projects,
        // A removed project must not leave the window pointing at nothing.
        activeProjectId: stillThere ? state.activeProjectId : (action.projects[0]?.id ?? null),
      }
    }

    case 'opened': {
      if (state.tabs.some((tab) => tab.id === action.tab.id)) return state
      const owner = projectIdForTab(state.projects, action.tab)
      return setActiveTab(
        { ...state, tabs: [...state.tabs, action.tab] },
        owner,
        action.tab.id,
      )
    }

    case 'activatedTab': {
      const tab = state.tabs.find((candidate) => candidate.id === action.id)
      if (!tab) return state
      return setActiveTab(state, projectIdForTab(state.projects, tab), action.id)
    }

    case 'activatedProject': {
      if (!state.projects.some((project) => project.id === action.id)) return state
      return { ...state, activeProjectId: action.id }
    }

    case 'removed': {
      const tab = state.tabs.find((candidate) => candidate.id === action.id)
      if (!tab) return state
      const owner = projectIdForTab(state.projects, tab)
      // Only the owning project's selection moves; every other project keeps
      // whichever tab it was on.
      const siblings = tabsOfProject(state, owner)
      const project = state.projects.find((candidate) => candidate.id === owner)
      const nextActive =
        project?.activeTabId === action.id
          ? neighbourOf(siblings, action.id)
          : (project?.activeTabId ?? null)
      return setActiveTab(
        { ...state, tabs: state.tabs.filter((candidate) => candidate.id !== action.id) },
        owner,
        nextActive,
      )
    }

    case 'movedTab':
      return {
        ...state,
        projects: action.projects,
        // Replaced in place: the tab keeps its position, and only its slug —
        // and therefore which project owns it — has changed.
        tabs: state.tabs.map((tab) => (tab.id === action.tab.id ? action.tab : tab)),
      }
  }
}
```

- [ ] **Step 4: Delete the superseded module**

```bash
git rm src/renderer/tabs.ts tests/unit/tabs.test.ts
```

`src/renderer/App.tsx` imports `tabsReducer` and will now fail to typecheck. Leave it broken — Task 13 rewrites it. To keep this task's checkpoint green, temporarily point `App.tsx`'s import at the new module and adapt its three usages minimally: `useReducer(workspaceReducer, INITIAL_WORKSPACE_STATE)`, `state.tabs`, and `activeTabId(state)` in place of `state.activeId`. Dispatches become `activatedTab` / `removed` / `opened`.

- [ ] **Step 5: Run everything and commit**

Run: `npx vitest run tests/unit/workspace.test.ts && npm test && npm run typecheck && npm run e2e`
Expected: PASS, 26 tests in the new file; everything else green.

```bash
git add src/renderer tests/unit/workspace.test.ts
git commit -m "$(cat <<'EOF'
Replace the tabs reducer with a workspace reducer

Tabs now live under projects, and the active tab is a property of a
project rather than of the window. One reducer rather than two: the
interesting rule — what becomes active when a tab closes — is per
project, and splitting it would mean sharing that rule across both.

Every test from the tabs reducer is carried over, not dropped.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: The sidebar

**Files:**
- Create: `src/renderer/Sidebar.tsx`

**Interfaces:**
- Consumes: `WorkspaceState`, `tabsOfProject`, `activeProject` from `workspace.ts`; `Button` from `ui/Button`
- Produces: `Sidebar(props)` — see the signature in Step 1

**Testids** — note the prefixes are deliberately distinct so that a
`[data-testid^="project-"]` selector counts only project rows. M2a shipped a
bug of exactly this shape, where `tab-bar` was matched by `[data-testid^="tab-"]`.

| Testid | Element |
|---|---|
| `sidebar` | The container |
| `project-<id>` | A project row |
| `stab-<id>` | A tab row under an expanded project |
| `pmenu-<id>` | That project's ⋯ button |
| `prename-<id>` / `pup-<id>` / `pdown-<id>` / `premove-<id>` | Menu items |
| `add-project` | The Add project button |

- [ ] **Step 1: Implement**

Create `src/renderer/Sidebar.tsx`:

```tsx
import { useState } from 'react'
import { UNSORTED_ID, type ProjectDescriptor, type TabDescriptor } from '../shared/ipc'
import { cn } from './lib/cn'
import { Button } from './ui/Button'

export function Sidebar({
  projects,
  activeProjectId,
  tabsOf,
  activeTabId,
  onSelectProject,
  onSelectTab,
  onRename,
  onMove,
  onRemove,
  onMoveTab,
  onAdd,
}: {
  projects: ProjectDescriptor[]
  activeProjectId: string | null
  tabsOf: (projectId: string) => TabDescriptor[]
  activeTabId: string | null
  onSelectProject: (id: string) => void
  onSelectTab: (id: string) => void
  onRename: (id: string, name: string) => void
  onMove: (id: string, direction: -1 | 1) => void
  onRemove: (id: string) => void
  onMoveTab: (tabId: string, projectId: string) => void
  onAdd: () => void
}) {
  const [menuFor, setMenuFor] = useState<string | null>(null)

  return (
    <div
      data-testid="sidebar"
      className="flex w-52 shrink-0 flex-col border-r border-border bg-surface font-mono text-[11px] select-none"
    >
      <div className="px-2.5 pb-1 pt-3 text-[10px] uppercase tracking-wider text-faint">
        Projects
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {projects.map((project, index) => {
          const active = project.id === activeProjectId
          const synthetic = project.id === UNSORTED_ID
          const tabs = tabsOf(project.id)
          return (
            <div key={project.id}>
              <div
                data-testid={`project-${project.id}`}
                data-active={active ? 'true' : 'false'}
                onClick={() => onSelectProject(project.id)}
                className={cn(
                  'group flex cursor-default items-center gap-1.5 px-2.5 py-1',
                  active ? 'bg-bg text-fg' : 'text-muted hover:text-fg',
                )}
              >
                {/* ⌘1–9 follows sidebar order, so the number is the shortcut. */}
                <span className="w-3 text-faint">{index < 9 ? index + 1 : ''}</span>
                <span className="flex-1 truncate">{project.name}</span>
                {!project.available ? (
                  <span title={`${project.cwd} is missing`} className="text-danger">
                    !
                  </span>
                ) : null}
                <span className="text-faint">{tabs.length || ''}</span>
                {synthetic ? null : (
                  <button
                    data-testid={`pmenu-${project.id}`}
                    aria-label={`Actions for ${project.name}`}
                    onClick={(event) => {
                      // Without this the click also selects the project.
                      event.stopPropagation()
                      setMenuFor((current) => (current === project.id ? null : project.id))
                    }}
                    className="cursor-default border-none bg-transparent px-0.5 text-faint hover:text-fg"
                  >
                    ⋯
                  </button>
                )}
              </div>

              {menuFor === project.id ? (
                <div className="flex flex-col border-y border-border bg-bg py-0.5">
                  <MenuItem
                    testid={`prename-${project.id}`}
                    label="Rename…"
                    onClick={() => {
                      setMenuFor(null)
                      const name = window.prompt('Project name', project.name)
                      if (name && name.trim()) onRename(project.id, name.trim())
                    }}
                  />
                  <MenuItem
                    testid={`pup-${project.id}`}
                    label="Move up"
                    disabled={index === 0}
                    onClick={() => {
                      setMenuFor(null)
                      onMove(project.id, -1)
                    }}
                  />
                  <MenuItem
                    testid={`pdown-${project.id}`}
                    label="Move down"
                    onClick={() => {
                      setMenuFor(null)
                      onMove(project.id, 1)
                    }}
                  />
                  <MenuItem
                    testid={`premove-${project.id}`}
                    label="Remove project"
                    onClick={() => {
                      setMenuFor(null)
                      onRemove(project.id)
                    }}
                  />
                </div>
              ) : null}

              {active
                ? tabs.map((tab) => (
                    <div key={tab.id} className="flex items-center gap-1 pl-8 pr-2.5">
                      <div
                        data-testid={`stab-${tab.id}`}
                        onClick={() => onSelectTab(tab.id)}
                        className={cn(
                          'flex-1 cursor-default truncate py-0.5',
                          tab.id === activeTabId ? 'text-fg' : 'text-muted hover:text-fg',
                        )}
                      >
                        {tab.projectSlug} · {tab.id.slice(0, 6)}
                      </div>
                      {/* Rehoming: a stray must be filable, or Unsorted is a
                          place things can be seen but never leave. Renaming
                          its tmux session is what actually moves it. */}
                      {synthetic ? (
                        <select
                          data-testid={`smove-${tab.id}`}
                          aria-label={`Move ${tab.id.slice(0, 6)} to a project`}
                          value=""
                          onChange={(event) => {
                            if (event.target.value) onMoveTab(tab.id, event.target.value)
                          }}
                          className="cursor-default border border-border bg-bg text-[10px] text-muted"
                        >
                          <option value="">move…</option>
                          {projects
                            .filter((candidate) => candidate.id !== UNSORTED_ID)
                            .map((candidate) => (
                              <option key={candidate.id} value={candidate.id}>
                                {candidate.name}
                              </option>
                            ))}
                        </select>
                      ) : null}
                    </div>
                  ))
                : null}
            </div>
          )
        })}
      </div>

      <div className="border-t border-border p-2">
        <Button data-testid="add-project" variant="ghost" onClick={onAdd} className="w-full">
          + Add project
        </Button>
      </div>
    </div>
  )
}

function MenuItem({
  testid,
  label,
  onClick,
  disabled,
}: {
  testid: string
  label: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      data-testid={testid}
      onClick={onClick}
      disabled={disabled}
      className="cursor-default border-none bg-transparent px-2.5 py-1 text-left text-muted hover:text-fg disabled:opacity-40"
    >
      {label}
    </button>
  )
}
```

Note: the Unsorted row gets no ⋯ menu — it cannot be renamed, reordered or removed. Its *tabs*, though, each carry a move control: without one a stray could be seen but never filed, and `moveTabToProject` would have no caller. The control is absent for real projects' tabs, which are already where they belong.

- [ ] **Step 2: Verify it compiles**

Run: `npm run typecheck && npm test`
Expected: both green. Nothing renders `Sidebar` yet; Task 13 does.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/Sidebar.tsx
git commit -m "$(cat <<'EOF'
Add the sidebar

A project row per customer in sidebar order, numbered to match ⌘1–9,
expanding to that project's tabs. Unsorted carries no actions menu: it
is not a project and cannot be renamed, reordered or removed. Its tabs
each carry a move control, so a stray can actually be filed.

Testid prefixes are deliberately disjoint so a project-row selector
cannot also match a menu button — M2a shipped that exact bug.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: The add-project dialog

**Files:**
- Create: `src/renderer/AddProjectDialog.tsx`

**Interfaces:**
- Consumes: `Candidate` from `src/shared/ipc.ts`; `Dialog`, `DialogContent`, `DialogTitle` from `ui/Dialog`; `Button`
- Produces: `AddProjectDialog(props: { open: boolean; onOpenChange(open: boolean): void; onAdd(input: { name: string; cwd: string }): void })`

- [ ] **Step 1: Implement**

Create `src/renderer/AddProjectDialog.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { basename } from './lib/basename'
import type { Candidate } from '../shared/ipc'
import { Dialog, DialogContent, DialogTitle } from './ui/Dialog'
import { Button } from './ui/Button'

export function AddProjectDialog({
  open,
  onOpenChange,
  onAdd,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdd: (input: { name: string; cwd: string }) => void
}) {
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [error, setError] = useState<string | null>(null)

  // Rescanned every time it opens: folders appear and disappear between uses.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setError(null)
    window.prcli
      .scanCandidates()
      .then((found) => {
        if (!cancelled) setCandidates(found)
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const add = (cwd: string): void => {
    onAdd({ name: basename(cwd), cwd })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="add-project-dialog">
        <DialogTitle className="mb-2 text-xs uppercase tracking-wider text-faint">
          Add project
        </DialogTitle>

        {error ? <p className="mb-2 text-[11px] text-danger">{error}</p> : null}

        <div className="mb-3 max-h-72 overflow-y-auto text-[11px]">
          {candidates.length === 0 ? (
            <p className="py-2 text-muted">
              Nothing found to suggest. Choose a folder instead.
            </p>
          ) : (
            candidates.map((candidate) => (
              <button
                key={candidate.cwd}
                data-testid={`candidate-${candidate.name}`}
                onClick={() => add(candidate.cwd)}
                className="flex w-full cursor-default items-baseline gap-2 border-none bg-transparent px-1 py-1 text-left text-muted hover:bg-border hover:text-fg"
              >
                <span className="flex-1 truncate">{candidate.name}</span>
                <span className="text-faint">{candidate.markers.join(' ')}</span>
              </button>
            ))
          )}
        </div>

        <Button
          data-testid="choose-folder"
          onClick={() => {
            void window.prcli.pickFolder().then((cwd) => {
              // Null means the user cancelled the picker.
              if (cwd) add(cwd)
            })
          }}
        >
          Choose folder…
        </Button>
      </DialogContent>
    </Dialog>
  )
}
```

Create `src/renderer/lib/basename.ts` — the renderer cannot import `node:path`:

```ts
/** Last path segment, without pulling node:path into the renderer. */
export function basename(path: string): string {
  const segments = path.split('/').filter(Boolean)
  return segments[segments.length - 1] ?? path
}
```

- [ ] **Step 2: Verify and commit**

Run: `npm run typecheck && npm test`

```bash
git add src/renderer/AddProjectDialog.tsx src/renderer/lib/basename.ts
git commit -m "$(cat <<'EOF'
Add the add-project dialog

Scanned candidates with the markers that matched, plus a folder picker
for anything outside the scan root. Rescans on every open, because
folders come and go between uses.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: The right panel

**Files:**
- Create: `src/renderer/RightPanel.tsx`

**Interfaces:**
- Consumes: `ProjectDescriptor` from `src/shared/ipc.ts`
- Produces: `RightPanel(props: { project: ProjectDescriptor | undefined; onRun(command: string): void })`

- [ ] **Step 1: Implement**

Create `src/renderer/RightPanel.tsx`:

```tsx
import type { ProjectDescriptor } from '../shared/ipc'

export function RightPanel({
  project,
  onRun,
}: {
  project: ProjectDescriptor | undefined
  onRun: (command: string) => void
}) {
  return (
    <div
      data-testid="rightpanel"
      className="flex w-52 shrink-0 flex-col border-l border-border bg-surface font-mono text-[11px] select-none"
    >
      <div className="px-2.5 pb-1 pt-3 text-[10px] uppercase tracking-wider text-faint">
        Presets
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <button
          data-testid="preset-claude"
          disabled={!project || !project.available}
          onClick={() => onRun('claude')}
          className="w-full cursor-default border-none bg-transparent px-2.5 py-1 text-left text-muted hover:text-fg disabled:opacity-40"
        >
          claude
        </button>
        {(project?.presets ?? []).map((preset) => (
          <button
            key={preset.id}
            data-testid={`preset-${preset.label}`}
            disabled={!project?.available}
            onClick={() => onRun(preset.command)}
            title={preset.command}
            className="flex w-full cursor-default items-baseline gap-2 border-none bg-transparent px-2.5 py-1 text-left text-muted hover:text-fg disabled:opacity-40"
          >
            <span className="flex-1 truncate">{preset.label}</span>
            {/* Provenance, so it is obvious which came from the repository. */}
            {preset.origin === 'repo' ? <span className="text-faint">repo</span> : null}
          </button>
        ))}
        {project && project.presets.length === 0 ? (
          <p className="px-2.5 py-1 text-faint">
            No presets. Add a .prcli.json to the repository.
          </p>
        ) : null}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify and commit**

Run: `npm run typecheck && npm test`

```bash
git add src/renderer/RightPanel.tsx
git commit -m "$(cat <<'EOF'
Add the presets panel

The active project's presets, merged from config and the repository's
own .prcli.json, with provenance shown so it is obvious which the repo
supplied. A `claude` entry sits above them: it needs no declaration.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Wire it together

**Files:**
- Rewrite: `src/renderer/App.tsx`
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: everything above
- Produces: the working multi-project window

- [ ] **Step 1: Rewrite App.tsx**

Replace `src/renderer/App.tsx` entirely:

```tsx
import { useCallback, useEffect, useReducer, useState } from 'react'
import { Terminal } from './Terminal'
import { TabBar } from './TabBar'
import { Sidebar } from './Sidebar'
import { RightPanel } from './RightPanel'
import { AddProjectDialog } from './AddProjectDialog'
import { cn } from './lib/cn'
import {
  INITIAL_WORKSPACE_STATE,
  activeProject,
  activeTabId,
  tabsOfProject,
  workspaceReducer,
} from './workspace'
import { UNSORTED_ID } from '../shared/ipc'

export function App() {
  const [state, dispatch] = useReducer(workspaceReducer, INITIAL_WORKSPACE_STATE)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [panelOpen, setPanelOpen] = useState(true)
  // Set once the workspace exists. Until then this window knows nothing about
  // what is selected and must not say anything about it — see the effects.
  const [ready, setReady] = useState(false)

  const fail = useCallback((reason: unknown) => {
    setError(reason instanceof Error ? reason.message : String(reason))
  }, [])

  const project = activeProject(state)
  const currentTabId = activeTabId(state)
  const currentTabs = state.activeProjectId ? tabsOfProject(state, state.activeProjectId) : []
  // Unsorted has no directory of its own, and a project whose folder has gone
  // cannot host a new terminal.
  const canOpen = Boolean(project) && project?.id !== UNSORTED_ID && project?.available === true

  const launch = useCallback(
    (command?: string) => {
      if (!project || !canOpen) return
      window.prcli
        .open({ projectSlug: project.slug, cwd: project.cwd, command })
        .then((tab) => dispatch({ type: 'opened', tab }))
        .catch(fail)
    },
    [project, canOpen, fail],
  )

  const openTab = useCallback(() => launch(), [launch])

  const closeTab = useCallback(
    (id: string) => {
      window.prcli
        .kill(id)
        .then(() => dispatch({ type: 'removed', id }))
        .catch(fail)
    },
    [fail],
  )

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const { projects, tabs, activeProjectId } = await window.prcli.restore()
      if (cancelled) return
      dispatch({ type: 'restored', projects, tabs, activeProjectId })
      setReady(true)
    })().catch((reason: unknown) => {
      // `ready` stays false: with no workspace there is nothing to report,
      // and saying so would overwrite what is on disk.
      if (!cancelled) fail(reason)
    })
    return () => {
      cancelled = true
    }
  }, [fail])

  // The one place that tells the main process what is selected, so every path
  // is covered — including the ones nothing calls directly, like a close or a
  // death moving the active tab to a neighbour.
  useEffect(() => {
    if (!ready) return
    window.prcli.setActive(currentTabId)
  }, [ready, currentTabId])

  useEffect(() => {
    if (!ready) return
    window.prcli.setActiveProject(state.activeProjectId)
  }, [ready, state.activeProjectId])

  // A client stopping is not a session dying. `Ctrl-b d` inside a pane, and
  // the detach restore does before it reattaches, both arrive here with the
  // session still running, and those tabs must stay.
  useEffect(
    () =>
      window.prcli.onExit(({ id, sessionAlive }) => {
        if (sessionAlive) return
        dispatch({ type: 'removed', id })
      }),
    [],
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.metaKey) return

      // `event.code`, not `event.key`: on macOS ⌥ rewrites `key`, so ⌥⌘1
      // arrives as "¡" and a key-based check would never fire.
      if (event.code === 'KeyT' && !event.altKey) {
        event.preventDefault()
        openTab()
        return
      }
      if (event.code === 'KeyW' && !event.altKey && currentTabId) {
        event.preventDefault()
        closeTab(currentTabId)
        return
      }
      if (event.code === 'Backslash' && event.shiftKey) {
        event.preventDefault()
        setPanelOpen((open) => !open)
        return
      }

      const digit = /^Digit([1-9])$/.exec(event.code)
      if (!digit) return
      const index = Number(digit[1]) - 1
      if (event.altKey) {
        const target = currentTabs[index]
        if (target) {
          event.preventDefault()
          dispatch({ type: 'activatedTab', id: target.id })
        }
        return
      }
      const target = state.projects[index]
      if (target) {
        event.preventDefault()
        dispatch({ type: 'activatedProject', id: target.id })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [currentTabId, currentTabs, state.projects, openTab, closeTab])

  return (
    <div className="flex h-screen w-screen bg-bg">
      <Sidebar
        projects={state.projects}
        activeProjectId={state.activeProjectId}
        tabsOf={(id) => tabsOfProject(state, id)}
        activeTabId={currentTabId}
        onSelectProject={(id) => dispatch({ type: 'activatedProject', id })}
        onSelectTab={(id) => dispatch({ type: 'activatedTab', id })}
        onAdd={() => setAdding(true)}
        onMoveTab={(tabId, projectId) => {
          // Renames the tmux session. The tab id is the other half of the
          // name, so it keeps its scrollback and everything running in it.
          window.prcli
            .moveTabToProject(tabId, projectId)
            .then(({ projects, tab }) => dispatch({ type: 'movedTab', tab, projects }))
            .catch(fail)
        }}
        onRename={(id, name) => {
          window.prcli
            .updateProject(id, { name })
            .then((projects) => dispatch({ type: 'projects', projects }))
            .catch(fail)
        }}
        onMove={(id, direction) => {
          const order = state.projects.filter((p) => p.id !== UNSORTED_ID).map((p) => p.id)
          const from = order.indexOf(id)
          const to = from + direction
          if (from === -1 || to < 0 || to >= order.length) return
          order.splice(to, 0, ...order.splice(from, 1))
          window.prcli
            .reorderProjects(order)
            .then((projects) => dispatch({ type: 'projects', projects }))
            .catch(fail)
        }}
        onRemove={(id) => {
          // The sessions keep running; they reappear under Unsorted, so a
          // relaunch is not needed to reach them again.
          window.prcli
            .removeProject(id)
            .then((projects) => dispatch({ type: 'projects', projects }))
            .catch(fail)
        }}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <TabBar
          tabs={currentTabs}
          activeId={currentTabId}
          onActivate={(id) => dispatch({ type: 'activatedTab', id })}
          onClose={closeTab}
          onNew={openTab}
          canOpen={canOpen}
        />
        {error ? (
          <pre
            data-testid="startup-error"
            className="m-0 whitespace-pre-wrap p-2 font-mono text-[13px] text-danger"
          >
            {error}
          </pre>
        ) : null}
        <div className="relative min-h-0 flex-1">
          {state.projects.length === 0 ? (
            <p
              data-testid="empty-state"
              className="p-4 font-mono text-[12px] text-muted"
            >
              No projects yet. Add one to open a terminal.
            </p>
          ) : null}
          {/* Every terminal stays mounted, across every project. Unmounting
              would dispose its xterm and lose scrollback on each switch. */}
          {state.tabs.map((tab) => {
            const visible = tab.id === currentTabId
            return (
              <div
                key={tab.id}
                data-testid={visible ? 'terminal-active' : `terminal-${tab.id}`}
                className={cn(
                  // `visibility`, not `display`: a hidden tab must stay laid
                  // out so it can measure itself, or it attaches at 80×24 and
                  // tmux shrinks the real session to match.
                  'absolute inset-0 p-2',
                  visible ? 'visible z-10' : 'invisible z-0 pointer-events-none',
                )}
              >
                <Terminal tabId={tab.id} visible={visible} />
              </div>
            )
          })}
        </div>
      </div>

      {panelOpen ? <RightPanel project={project} onRun={(command) => launch(command)} /> : null}

      <AddProjectDialog
        open={adding}
        onOpenChange={setAdding}
        onAdd={(input) => {
          window.prcli
            .addProject(input)
            .then((projects) => {
              dispatch({ type: 'projects', projects })
              const added = projects.find((candidate) => candidate.cwd === input.cwd)
              if (added) dispatch({ type: 'activatedProject', id: added.id })
            })
            .catch(fail)
        }}
      />
    </div>
  )
}
```

- [ ] **Step 2: Add the new shortcuts to the menu**

In `src/main/index.ts`, extend `installMenu`'s File submenu and add a View entry, both with `registerAccelerator: false` so the keystroke reaches the renderer, which owns the behaviour:

```ts
    {
      label: 'File',
      submenu: [
        {
          label: 'New Tab',
          accelerator: 'CmdOrCtrl+T',
          registerAccelerator: false,
          click: () => undefined,
        },
        {
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          // Displayed, but not claimed from the system — the keystroke
          // reaches the renderer instead.
          registerAccelerator: false,
          click: () => undefined,
        },
      ],
    },
```

and replace `{ role: 'viewMenu' }` with:

```ts
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Presets',
          accelerator: 'Shift+CmdOrCtrl+\\',
          registerAccelerator: false,
          click: () => undefined,
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
```

`reload` stays: M2a's C1 fix made restore reattach everything, and the design of record requires a reload to recover the workspace.

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm test && npm run e2e`
Expected: typecheck clean, unit and integration green.

The existing E2E suite will need its expectations revisited — it assumes a tab opens automatically on first run, which no longer happens without a project. **Do not edit those tests to make them pass.** Report exactly which fail and why; Task 14 rewrites the affected file deliberately.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/App.tsx src/main/index.ts
git commit -m "$(cat <<'EOF'
Render projects, tabs and presets together

The sidebar selects a project, the tab bar narrows to it, and the right
panel offers its commands. Every terminal across every project stays
mounted so switching costs nothing.

Keyboard reads event.code rather than event.key: on macOS ⌥ rewrites
key, so ⌥⌘1 arrives as "¡" and a key-based check would never fire.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: End-to-end coverage

**Files:**
- Create: `tests/e2e/projects.spec.ts`
- Modify: `tests/e2e/launch.spec.ts`, `tests/e2e/tabs.spec.ts`

**Interfaces:**
- Consumes: everything above

- [ ] **Step 1: Adapt the existing E2E suites to the new first run**

Both existing files assume the app opens a scratch tab on launch. It no longer does — a project has to exist first.

Driving the UI to add one is not an option here: `choose-folder` opens a native dialog Playwright cannot touch, and the scanned-candidate route needs a populated scan root these two files do not have. **Seed the config file directly** in `beforeEach` instead — `PRCLI_CONFIG_DIR` already points at a temp directory:

```ts
async function seedProject(slug: string, name: string): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), `prcli-proj-${slug}-`))
  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({
      version: 3,
      projects: [{ id: `id-${slug}`, name, slug, cwd, presets: [], activeTabId: null }],
      activeProjectId: `id-${slug}`,
      tabs: [],
    }),
    'utf8',
  )
  return cwd
}
```

Call `await seedProject('scratch', 'Scratch')` in each file's `beforeEach`, after `configDir` is created. Every existing assertion then holds unchanged, because the app restores that project and `+` works in it. **Change no assertion** — only add the seeding and, where a test previously relied on a tab existing at launch, an explicit `await window.getByTestId('new-tab').click()`.

Run `npm run e2e` and report exactly which tests needed which change.

- [ ] **Step 2: Write the new suite**

Create `tests/e2e/projects.spec.ts`:

```ts
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const run = promisify(execFile)
const SOCKET = 'prcli-e2e-projects'

let userDataDir: string
let configDir: string
let projectsRoot: string

async function launch(): Promise<ElectronApplication> {
  return electron.launch({
    args: ['.vite/build/main.js', `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      PRCLI_CONFIG_DIR: configDir,
      PRCLI_TMUX_SOCKET: SOCKET,
      // Never scan the developer's real ~/Code.
      PRCLI_PROJECTS_ROOT: projectsRoot,
    },
  })
}

async function killServer(): Promise<void> {
  try {
    await run('tmux', ['-L', SOCKET, 'kill-server'])
  } catch {
    // No server running.
  }
}

async function sessionNames(): Promise<string[]> {
  try {
    const { stdout } = await run('tmux', ['-L', SOCKET, 'list-sessions', '-F', '#{session_name}'])
    return stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  } catch {
    return []
  }
}

/** A directory under the scan root that discovery will offer as a candidate. */
async function candidate(name: string, manifest?: object): Promise<string> {
  const cwd = join(projectsRoot, name)
  await mkdir(join(cwd, '.git'), { recursive: true })
  if (manifest) await writeFile(join(cwd, '.prcli.json'), JSON.stringify(manifest), 'utf8')
  return cwd
}

async function seed(projects: object[], activeProjectId: string | null): Promise<void> {
  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({ version: 3, projects, activeProjectId, tabs: [] }),
    'utf8',
  )
}

test.beforeAll(async () => {
  await run('npm', ['run', 'package'])
})

test.beforeEach(async () => {
  await killServer()
  userDataDir = await mkdtemp(join(tmpdir(), 'prcli-proj-user-'))
  configDir = await mkdtemp(join(tmpdir(), 'prcli-proj-config-'))
  projectsRoot = await mkdtemp(join(tmpdir(), 'prcli-proj-root-'))
})

test.afterEach(async () => {
  await killServer()
  for (const dir of [userDataDir, configDir, projectsRoot]) {
    await rm(dir, { recursive: true, force: true })
  }
})

test('starts with no projects and opens no session', async () => {
  const app = await launch()
  const window = await app.firstWindow()
  await expect(window.getByTestId('empty-state')).toBeVisible()
  expect(await sessionNames()).toEqual([])
  await app.close()
})

test('adds a scanned candidate and opens a tab in it', async () => {
  await candidate('lumio')
  const app = await launch()
  const window = await app.firstWindow()

  await window.getByTestId('add-project').click()
  await window.getByTestId('candidate-lumio').click()
  // The id is generated at add time, so assert on the count and the name
  // rather than on a testid we cannot predict.
  await expect(window.locator('[data-testid^="project-"]')).toHaveCount(1)
  await expect(window.getByTestId('sidebar')).toContainText('lumio')

  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible({ timeout: 20_000 })
  await expect
    .poll(async () => (await sessionNames()).filter((n) => n.startsWith('prcli-lumio-')).length, {
      timeout: 20_000,
    })
    .toBe(1)

  await app.close()
})

test('the tab bar shows only the active project\'s tabs', async () => {
  const lumio = await candidate('lumio')
  const gco = await candidate('gco')
  await seed(
    [
      { id: 'id-lumio', name: 'Lumio', slug: 'lumio', cwd: lumio, presets: [], activeTabId: null },
      { id: 'id-gco', name: 'GCO', slug: 'gco', cwd: gco, presets: [], activeTabId: null },
    ],
    'id-lumio',
  )
  const app = await launch()
  const window = await app.firstWindow()

  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible({ timeout: 20_000 })
  await expect(window.locator('[data-testid^="tab-"]')).toHaveCount(1)

  await window.getByTestId('project-id-gco').click()
  // GCO has no tabs yet, so the bar empties rather than showing Lumio's.
  await expect(window.locator('[data-testid^="tab-"]')).toHaveCount(0)
  await window.getByTestId('new-tab').click()
  await expect.poll(async () => (await sessionNames()).length, { timeout: 20_000 }).toBe(2)
  await expect(window.locator('[data-testid^="tab-"]')).toHaveCount(1)

  await app.close()
})

test('⌘1 and ⌘2 switch project; ⌥⌘1 and ⌥⌘2 switch tab', async () => {
  const lumio = await candidate('lumio')
  const gco = await candidate('gco')
  await seed(
    [
      { id: 'id-lumio', name: 'Lumio', slug: 'lumio', cwd: lumio, presets: [], activeTabId: null },
      { id: 'id-gco', name: 'GCO', slug: 'gco', cwd: gco, presets: [], activeTabId: null },
    ],
    'id-lumio',
  )
  const app = await launch()
  const window = await app.firstWindow()

  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible({ timeout: 20_000 })
  await window.getByTestId('new-tab').click()
  await expect(window.locator('[data-testid^="tab-"]')).toHaveCount(2)

  await window.keyboard.press('Meta+Digit2')
  await expect(window.getByTestId('project-id-gco')).toHaveAttribute('data-active', 'true')
  await window.keyboard.press('Meta+Digit1')
  await expect(window.getByTestId('project-id-lumio')).toHaveAttribute('data-active', 'true')

  const tabs = window.locator('[data-testid^="tab-"]')
  const first = await tabs.first().getAttribute('data-testid')
  await window.keyboard.press('Alt+Meta+Digit1')
  await expect(window.locator(`[data-testid="${first}"]`)).toHaveAttribute('data-active', 'true')

  await app.close()
})

test('a preset declared by the repository launches its command', async () => {
  const lumio = await candidate('lumio', {
    presets: [{ label: 'marker', command: 'echo preset-ran; sleep 600' }],
  })
  await seed(
    [{ id: 'id-lumio', name: 'Lumio', slug: 'lumio', cwd: lumio, presets: [], activeTabId: null }],
    'id-lumio',
  )
  const app = await launch()
  const window = await app.firstWindow()

  await window.getByTestId('preset-marker').click()
  await expect(window.getByTestId('terminal-active')).toContainText('preset-ran', {
    timeout: 20_000,
  })

  await app.close()
})

test('restores the active project and each project\'s active tab', async () => {
  const lumio = await candidate('lumio')
  const gco = await candidate('gco')
  await seed(
    [
      { id: 'id-lumio', name: 'Lumio', slug: 'lumio', cwd: lumio, presets: [], activeTabId: null },
      { id: 'id-gco', name: 'GCO', slug: 'gco', cwd: gco, presets: [], activeTabId: null },
    ],
    'id-lumio',
  )
  const first = await launch()
  const firstWindow = await first.firstWindow()

  await firstWindow.getByTestId('new-tab').click()
  await expect(firstWindow.getByTestId('terminal-active')).toBeVisible({ timeout: 20_000 })
  await firstWindow.getByTestId('project-id-gco').click()
  await firstWindow.getByTestId('new-tab').click()
  await expect(firstWindow.getByTestId('terminal-active')).toBeVisible({ timeout: 20_000 })
  await firstWindow.getByTestId('terminal-active').click()
  await firstWindow.keyboard.type('echo gco-marker')
  await firstWindow.keyboard.press('Enter')
  await expect(firstWindow.getByTestId('terminal-active')).toContainText('gco-marker', {
    timeout: 20_000,
  })
  await first.close()

  const second = await launch()
  const secondWindow = await second.firstWindow()
  await expect(secondWindow.getByTestId('project-id-gco')).toHaveAttribute('data-active', 'true')
  await expect(secondWindow.getByTestId('terminal-active')).toContainText('gco-marker', {
    timeout: 20_000,
  })
  await second.close()
})

test('an Unsorted tab can be filed into a project, keeping its session', async () => {
  const lumio = await candidate('lumio')
  await seed(
    [{ id: 'id-lumio', name: 'Lumio', slug: 'lumio', cwd: lumio, presets: [], activeTabId: null }],
    'id-lumio',
  )
  // A session created behind the app's back, as a crash would leave.
  await run('tmux', [
    '-L', SOCKET, 'new-session', '-d', '-s', 'prcli-scratch-abcdef0123456789', 'sleep', '600',
  ])

  const app = await launch()
  const window = await app.firstWindow()

  await window.getByTestId('project-unsorted').click()
  await window.getByTestId('smove-abcdef0123456789').selectOption('id-lumio')

  await expect
    .poll(async () => (await sessionNames()).includes('prcli-lumio-abcdef0123456789'), {
      timeout: 20_000,
    })
    .toBe(true)
  // Renamed, not recreated: exactly one session, and the old name is gone.
  expect(await sessionNames()).toEqual(['prcli-lumio-abcdef0123456789'])

  await app.close()
})

test('a session whose project was removed shows under Unsorted, still alive', async () => {
  const lumio = await candidate('lumio')
  await seed(
    [{ id: 'id-lumio', name: 'Lumio', slug: 'lumio', cwd: lumio, presets: [], activeTabId: null }],
    'id-lumio',
  )
  const app = await launch()
  const window = await app.firstWindow()

  await window.getByTestId('new-tab').click()
  await expect(window.getByTestId('terminal-active')).toBeVisible({ timeout: 20_000 })
  const before = await sessionNames()
  expect(before).toHaveLength(1)

  await window.getByTestId('pmenu-id-lumio').click()
  await window.getByTestId('premove-id-lumio').click()

  await expect(window.getByTestId('project-unsorted')).toBeVisible()
  // Removing a project destroys nothing: the session is still running.
  expect(await sessionNames()).toEqual(before)

  await app.close()
})
```

- [ ] **Step 3: Run them**

Run: `npm run e2e -- tests/e2e/projects.spec.ts`
Expected: PASS, 8 tests.

- [ ] **Step 4: Run everything**

Run: `npm test && npm run typecheck && npm run e2e`
Expected: all green.

- [ ] **Step 5: Verify nothing leaked**

Run: `tmux ls && ls -l ~/.prcli && ls ~/Code | head -3`
Expected: no `prcli-*` session on the default socket beyond any the developer started themselves; `~/.prcli` unchanged; `~/Code` untouched — every test set `PRCLI_PROJECTS_ROOT`.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e
git commit -m "$(cat <<'EOF'
Cover projects end to end

Adding a scanned candidate, a tab bar that shows one project at a time,
⌘1–9 against ⌥⌘1–9, a repository's own preset launching, restore of both
the active project and each project's active tab, filing a stray out of
Unsorted, and a removed project's session surviving under Unsorted.

The existing suites are seeded with a project rather than relaxed: the
app no longer opens a tab on its own, so they need one to exist.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Milestone 2b done when

- The sidebar lists every added project, each expanding to its own tabs
- The tab bar shows only the active project's tabs
- ⌘1–9 switches project, ⌥⌘1–9 switches tab, ⌘T opens a shell in the active project, ⇧⌘\ toggles the presets panel
- A project is added from a scanned candidate or a chosen folder, and can be renamed, reordered and removed
- The right panel lists the active project's presets, merged from config and `.prcli.json`, and clicking one opens a tab running it
- A session whose slug matches no project appears under Unsorted, alive and reachable, and can be rehomed into a real project
- Quit and relaunch restores the active project and each project's active tab
- `npm test`, `npm run typecheck` and `npm run e2e` are green, and no `prcli-*` session is left on the default socket

## Deliberately not in this milestone

Status dots and the state model (they need M3's hook bridge before they can say anything true). The skills panel and ⌘K. Drag-to-reorder — reorder ships as menu items instead. Splits (Milestone 2c).

Carried forward from the M2a review and still open: N2 (`restore.ts` swallows a failed `open` with no logging), N3 (deleting App.tsx's `ready` guard fails no test), the menu's `Close Tab` item doing nothing when clicked, `getSessionOption` needing `-A`, the adapter's weak "targets exactly one session" assertion, and `app.focus({ steal: true })` on second-instance.

## Not covered by any automated test

Whether the Tailwind port looks right. The E2E suites key off `data-testid`, so they pass just as happily on a page that renders wrong. This needs a hands-on pass, alongside the TUI checklist outstanding since M1 — colours, status line, resize reflow, ⇧Tab permission cycling and mouse scrollback with `claude` running inside a tab.
