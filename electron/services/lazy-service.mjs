// 惰性服务包装：首次真正被用到时才构造，避免应用启动阶段把所有能力都实例化。
// 用 Proxy 转发全部属性访问，因此已有的调用点（svc.method()）无需任何改动。
export function createLazyService(factory) {
  let instance = null
  const resolve = () => (instance ??= factory())
  return new Proxy(
    {},
    {
      get(_target, prop) {
        const value = resolve()[prop]
        return typeof value === 'function' ? value.bind(resolve()) : value
      },
      set(_target, prop, value) {
        resolve()[prop] = value
        return true
      },
      has(_target, prop) {
        return prop in resolve()
      },
      ownKeys() {
        return Reflect.ownKeys(resolve())
      },
      getOwnPropertyDescriptor(_target, prop) {
        return Object.getOwnPropertyDescriptor(resolve(), prop)
      },
    },
  )
}
