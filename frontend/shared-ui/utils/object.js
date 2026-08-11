export function deepMerge (target, source) {
  for (const key of Object.keys(source)) {
    const val = source[key]
    if (val !== null && typeof val === 'object' && !Array.isArray(val) && typeof target[key] === 'object' && target[key] !== null) {
      deepMerge(target[key], val)
    } else {
      target[key] = val
    }
  }
}
