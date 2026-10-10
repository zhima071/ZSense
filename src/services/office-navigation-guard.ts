type NavigationGuard = () => Promise<boolean> | boolean
const guards = new Map<string, NavigationGuard>()
let request: Promise<boolean> | null = null

export function registerOfficeNavigationGuard(id: string, guard: NavigationGuard) {
  guards.set(id, guard)
  return () => { if (guards.get(id) === guard) guards.delete(id) }
}

export function requestOfficeNavigation(): Promise<boolean> {
  if (request) return request
  request = (async () => {
    for (const guard of [...guards.values()]) if (!await guard()) return false
    return true
  })().finally(() => { request = null })
  return request
}
