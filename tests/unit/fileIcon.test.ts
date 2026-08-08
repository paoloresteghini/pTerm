/**
 * Which icon and colour a file tree row gets.
 *
 * Pure, so the mapping is testable without a DOM — this repo's vitest runs
 * `environment: 'node'`, so anything living inside the component could not be
 * tested at all.
 */
import { describe, it, expect } from 'vitest'
import { iconFor } from '../../src/renderer/lib/fileIcon'

const kind = (name: string): string => iconFor(name).kind

describe('iconFor', () => {
  it.each([
    ['App.tsx', 'react'],
    ['index.ts', 'typescript'],
    ['main.js', 'javascript'],
    ['thing.jsx', 'react'],
    ['package.json', 'json'],
    ['README.md', 'markdown'],
    ['index.css', 'style'],
    ['index.html', 'html'],
    ['config.yml', 'yaml'],
    ['release.sh', 'shell'],
    ['script.py', 'python'],
    ['main.go', 'go'],
    ['lib.rs', 'rust'],
    ['schema.sql', 'database'],
    ['logo.png', 'image'],
    ['notes.txt', 'text'],
  ])('gives %s the %s icon', (name, expected) => {
    expect(kind(name)).toBe(expected)
  })

  it('falls back to a plain file icon for an unknown extension', () => {
    expect(kind('mystery.qqq')).toBe('file')
    expect(kind('noextension')).toBe('file')
  })

  /*
   * Whole-name matches beat the extension. `.env` has no extension at all in
   * the usual sense — splitting on the last dot gives `env` for a file whose
   * name IS `.env` — so a dotfile has to be recognised by name or it picks up
   * whatever its trailing segment happens to collide with.
   */
  it.each([
    ['.gitignore', 'git'],
    ['.gitattributes', 'git'],
    ['.env', 'config'],
    ['.env.example', 'config'],
    ['.editorconfig', 'config'],
    ['Dockerfile', 'docker'],
    // The name wins over the .yml extension, which is what the screenshot this
    // was built from shows: a whale, not a YAML icon.
    ['docker-compose.yml', 'docker'],
    ['package-lock.json', 'lock'],
    ['composer.lock', 'lock'],
  ])('recognises %s by name, as %s', (name, expected) => {
    expect(kind(name)).toBe(expected)
  })

  // A lock file is JSON by extension and a lock by name, and the name has to
  // win or `package-lock.json` is indistinguishable from `package.json`.
  it('prefers the name over the extension where both match', () => {
    expect(kind('package-lock.json')).toBe('lock')
    expect(kind('package.json')).toBe('json')
  })

  it('is case insensitive', () => {
    expect(kind('README.MD')).toBe('markdown')
    expect(kind('Makefile')).toBe(kind('makefile'))
  })

  it('reads the extension off the last dot, not the first', () => {
    expect(kind('export.query-model.stub')).toBe(kind('a.stub'))
    expect(kind('vite.config.ts')).toBe('typescript')
  })

  it('gives every kind a colour', () => {
    for (const name of ['App.tsx', 'a.json', 'b.md', '.gitignore', 'mystery.qqq']) {
      expect(iconFor(name).color).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })

  // The tree draws directories differently, and a directory named like a file
  // must not be given the file's icon.
  it('gives a directory the folder icon whatever it is called', () => {
    expect(iconFor('src', true).kind).toBe('folder')
    expect(iconFor('styles.css', true).kind).toBe('folder')
  })
})
