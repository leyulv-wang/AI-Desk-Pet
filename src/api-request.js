/** One deadline for both response headers and body, with underlying cancellation. */
async function fetchBuffered(url, { timeoutMs = 60000, signal, fetchImpl = globalThis.fetch, ...options } = {}) {
  const controller = new AbortController()
  const abort = () => controller.abort(signal.reason)
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error(`API 请求超时（${timeoutMs}ms）`)), timeoutMs)
  let onAbort
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(controller.signal.reason || new DOMException('已取消', 'AbortError'))
    if (controller.signal.aborted) onAbort()
    else controller.signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([aborted, (async () => {
      controller.signal.throwIfAborted()
      const response = await fetchImpl(url, { ...options, signal: controller.signal })
      const bytes = await response.arrayBuffer()
      controller.signal.throwIfAborted()
      return new Response([204, 205, 304].includes(response.status) ? null : bytes, {
        status: response.status, statusText: response.statusText, headers: response.headers,
      })
    })()])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    controller.signal.removeEventListener('abort', onAbort)
  }
}
module.exports = { fetchBuffered }
