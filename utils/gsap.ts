import type { gsap as GsapType } from 'gsap'

let instance: typeof GsapType | null = null
let loading: Promise<typeof GsapType> | null = null

/** Lazy-load GSAP — keeps it out of the initial bundle. */
export function loadGsap(): Promise<typeof GsapType> {
  if (instance) return Promise.resolve(instance)
  if (loading) return loading
  loading = import('gsap').then((mod) => {
    instance = mod.gsap
    return instance
  })
  return loading
}

/** Synchronous accessor — returns null before loadGsap() resolves. */
export function getGsap(): typeof GsapType | null {
  return instance
}
