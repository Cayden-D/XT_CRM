import { useEffect, useSyncExternalStore } from 'react'

/** What the user is looking at, so the AI sidebar can pass pointers (shop, view, open customer) with each question. */
export type AiFocus = { connectionId?: string; view?: string; customerId?: string; customerName?: string }
let focus: AiFocus = {}
const listeners = new Set<() => void>()
const emit = () => listeners.forEach(listener => listener())

export function setAiFocus(patch: AiFocus) {
  const next = { ...focus, ...patch }
  for (const key of Object.keys(next) as (keyof AiFocus)[]) if (next[key] === undefined) delete next[key]
  if (JSON.stringify(next) !== JSON.stringify(focus)) { focus = next; emit() }
}
export const resetAiFocus = () => { focus = {}; emit() }
export const useAiFocus = () => useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => focus)

/** Publishes part of the focus while the calling component is mounted, and clears those keys when it unmounts. */
export function useAiFocusPart(part: AiFocus) {
  const key = JSON.stringify(part)
  useEffect(() => {
    const value = JSON.parse(key) as AiFocus
    setAiFocus(value)
    return () => setAiFocus(Object.fromEntries(Object.keys(value).map(k => [k, undefined])) as AiFocus)
  }, [key])
}

/** Opens the AI sidebar from anywhere (e.g. inside a dialog), optionally with a prepared question. */
export const openAi = (prompt = '') => window.dispatchEvent(new CustomEvent<string>(OPEN_AI, { detail: prompt }))
export const OPEN_AI = 'crm:open-ai'

/** Pages listen for this to reload after the assistant saved something the user confirmed. */
export const DATA_CHANGED = 'crm:data-changed'
