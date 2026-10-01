/**
 * 原生能力桥接:Camera / Haptics / Filesystem / HTTP。
 *
 * 关键约束:Web 端与测试环境必须完全可用 —— 所有原生调用都做能力探测,
 * 缺失时优雅降级(拍照降级为 <input type="file">,震动降级为 no-op)。
 */

/** 是否运行在 Capacitor 原生容器内。 */
export function isNativePlatform(): boolean {
  if (typeof window === 'undefined') return false
  const cap = (window as any).Capacitor
  return Boolean(cap?.isNativePlatform?.())
}

/** 状态栏持久化键(设置页开关)。 */
export const FULLSCREEN_KEY = 'abdrop.fullscreen'

/** 读取全屏沉浸(隐藏状态栏)偏好。 */
export async function getFullscreenPreference(): Promise<boolean> {
  try {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem(FULLSCREEN_KEY) === '1'
  } catch {
    return false
  }
}

/** 保存全屏沉浸偏好。 */
export async function setFullscreenPreference(on: boolean): Promise<void> {
  try {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(FULLSCREEN_KEY, on ? '1' : '0')
  } catch {
    /* 隐私模式忽略 */
  }
}

/**
 * 应用全屏沉浸:原生容器内切换系统状态栏显隐。
 * Web/测试环境降级:仅通过 CSS 变量标记,不影响功能。
 * @returns 是否成功应用(Capacitor StatusBar 可用时 true)
 */
export async function applyFullscreen(on: boolean): Promise<boolean> {
  if (!isNativePlatform()) {
    // Web 预览:仍写入标记,页面按沉浸布局(无状态栏可藏)
    document.documentElement.classList.toggle('fullscreen', on)
    return false
  }
  try {
    const { StatusBar } = await import('@capacitor/status-bar')
    if (on) {
      await StatusBar.hide()
      // 沉浸模式:内容延伸到状态栏区域
      await StatusBar.setOverlaysWebView({ overlay: true })
    } else {
      await StatusBar.setOverlaysWebView({ overlay: false })
      await StatusBar.show()
    }
    return true
  } catch {
    // 插件缺失不阻塞
    return false
  }
}

/**
 * 跨环境 fetch:原生走 CapacitorHttp,Web 走普通 fetch。
 *
 * 为什么需要:WebView 里的 `fetch` 受 CORS 限制 —— 用户自定义网关
 * (尤其局域网 http 网关,如 192.168.x.x)往往不返回 CORS 头,WebView
 * 直接拦截响应,表现为"测试不通 / 获取不到模型列表"。原生 HTTP 通道
 * 走系统网络栈,没有 CORS,自建网关即可直连。
 *
 * 生命周期与签名对齐标准 fetch:返回 Response,支持 AbortSignal 取消,
 * 上层代码(testAIConnection / listModels / summarizeKnowledge)无需区分环境。
 */
export async function platformFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  if (!isNativePlatform()) return fetch(input, init)

  const { CapacitorHttp } = await import('@capacitor/core')
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  const method = (init?.method ?? 'GET').toUpperCase()
  const headers = init?.headers as Record<string, string> | undefined
  // CapacitorHttp 收对象而非 JSON 字符串
  const body = init?.body ? JSON.parse(String(init.body)) : undefined

  const run = () =>
    CapacitorHttp.request({
      url,
      method: method as any,
      headers: headers ?? {},
      data: body,
      // 与 lib/ai.ts 默认超时一致,避免长请求无限挂起
      connectTimeout: 20_000,
      readTimeout: 120_000,
    })

  return new Promise((resolve, reject) => {
    if (init?.signal?.aborted) {
      reject(new DOMException('The operation was aborted.', 'AbortError'))
      return
    }
    const onAbort = () => reject(new DOMException('The operation was aborted.', 'AbortError'))
    init?.signal?.addEventListener('abort', onAbort, { once: true })
    run()
      .then((res) => {
        const data = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? '')
        resolve(
          new Response(data, {
            status: res.status,
            headers: { 'content-type': 'application/json' },
          }),
        )
      })
      .catch(reject)
      .finally(() => init?.signal?.removeEventListener('abort', onAbort))
  })
}

/** 轻震动反馈:滑动吸合 / 双击唤起时调用。 */
export async function hapticTap(style: 'light' | 'medium' = 'light'): Promise<void> {
  if (!isNativePlatform()) {
    // Web 端降级到 Vibration API
    try {
      navigator.vibrate?.(style === 'light' ? 8 : 16)
    } catch {
      /* 不支持则忽略 */
    }
    return
  }
  try {
    const { Haptics, ImpactStyle } = await import('@capacitor/haptics')
    await Haptics.impact({
      style: style === 'light' ? ImpactStyle.Light : ImpactStyle.Medium,
    })
  } catch {
    /* 原生插件缺失不阻塞交互 */
  }
}

export interface CapturedImage {
  /** dataURL,可直接存 IndexedDB 并用于 <img src> */
  dataUrl: string
}

/**
 * 拍照 / 选图。
 * - 原生:Capacitor Camera(自动带 PROMPT 让用户选拍照或相册)
 * - Web:落到隐藏的 <input type="file" accept="image/*" capture>
 */
export async function captureImage(): Promise<CapturedImage | null> {
  if (isNativePlatform()) {
    try {
      const { Camera, CameraResultType, CameraSource } = await import('@capacitor/camera')
      const photo = await Camera.getPhoto({
        quality: 70,
        width: 1280,
        allowEditing: false,
        resultType: CameraResultType.DataUrl,
        source: CameraSource.Prompt,
      })
      if (photo.dataUrl) return { dataUrl: photo.dataUrl }
      return null
    } catch {
      // 用户取消或权限被拒 → 返回 null,不抛错
      return null
    }
  }
  return captureImageWeb()
}

/** Web 端文件选择降级实现。 */
export function captureImageWeb(): Promise<CapturedImage | null> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') return resolve(null)
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.style.display = 'none'
    let settled = false

    const finish = (value: CapturedImage | null) => {
      if (settled) return
      settled = true
      input.remove()
      resolve(value)
    }

    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) return finish(null)
      const reader = new FileReader()
      reader.onload = () => finish({ dataUrl: String(reader.result ?? '') })
      reader.onerror = () => finish(null)
      reader.readAsDataURL(file)
    })
    // 用户直接关闭选择框时不会触发 change,靠 focus 回落兜底
    input.addEventListener('cancel', () => finish(null))

    document.body.appendChild(input)
    input.click()
  })
}

/**
 * 导出文件到本地(原生走 Filesystem,Web 走 Blob 下载)。
 * content 传字符串按 UTF-8 写;传 Uint8Array/ArrayBuffer 按二进制写(zip 等)。
 */
export async function saveExportFile(
  filename: string,
  content: string | Uint8Array | ArrayBuffer,
): Promise<{ ok: boolean; message: string }> {
  const isBinary = typeof content !== 'string'
  if (isNativePlatform()) {
    try {
      const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem')
      if (isBinary) {
        // 二进制:base64 编码写入(原生端 data 接受 base64)
        const base64 = bytesToBase64(content)
        await Filesystem.writeFile({
          path: filename,
          data: base64,
          directory: Directory.Documents,
          recursive: true,
        })
      } else {
        await Filesystem.writeFile({
          path: filename,
          data: content,
          directory: Directory.Documents,
          encoding: Encoding.UTF8,
          recursive: true,
        })
      }
      return { ok: true, message: `已保存到「文档」:${filename}` }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : '保存失败' }
    }
  }

  try {
    // Blob 接受 string / Uint8Array / ArrayBuffer;fflate 的泛型差异用 BlobPart 中转
    const blob = new Blob([content as BlobPart], {
      type: isBinary ? 'application/zip' : 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    // 交给浏览器读完再释放
    setTimeout(() => URL.revokeObjectURL(url), 3000)
    return { ok: true, message: `已下载 ${filename}` }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : '导出失败' }
  }
}

/** 把二进制转为 base64(原生端 Filesystem 接受 base64 字符串)。 */
function bytesToBase64(data: string | Uint8Array | ArrayBuffer): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}
