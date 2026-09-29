/**
 * 原生能力桥接:Camera / Haptics / Filesystem。
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

/** 导出 JSON 文本到本地文件(原生走 Filesystem,Web 走 Blob 下载)。 */
export async function saveExportFile(
  filename: string,
  content: string,
): Promise<{ ok: boolean; message: string }> {
  if (isNativePlatform()) {
    try {
      const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem')
      await Filesystem.writeFile({
        path: filename,
        data: content,
        directory: Directory.Documents,
        encoding: Encoding.UTF8,
        recursive: true,
      })
      return { ok: true, message: `已保存到「文档」:${filename}` }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : '保存失败' }
    }
  }

  try {
    const blob = new Blob([content], { type: 'application/json' })
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
