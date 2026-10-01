/**
 * GitHub Release 更新检测(纯逻辑,零框架依赖,可单测)。
 *
 * 版本来源:
 * - 原生:App.getInfo() 返回的 versionName(build.gradle 的 versionName)
 * - Web / 测试:回退到与 build.gradle 保持一致的常量 APP_VERSION
 *
 * 发布约定(发新版时同步修改):
 * - android/app/build.gradle 的 versionCode / versionName
 * - 本文件底部 APP_VERSION / APP_VERSION_CODE
 * - GitHub Release tag 形如 v1.0.0,APK 资产名含 release 且以 .apk 结尾
 */

export const APP_VERSION = '1.0'
export const APP_VERSION_CODE = 1

/**
 * GitHub 仓库(发版与更新检测共用)。
 */
export const UPDATE_REPO_OWNER = 'xdtcssdi123'
export const UPDATE_REPO_NAME = 'abdrop'

export interface GitHubAsset {
  name: string
  size: number
  browser_download_url: string
}

export interface GitHubRelease {
  tag_name: string
  name: string
  body: string
  published_at: string
  html_url: string
  assets: GitHubAsset[]
}

export interface UpdateCheckResult {
  /** 本地版本(versionName) */
  local: string
  /** 远端 tag(如 v1.0.0),无 release 时为 null */
  latest: string | null
  /** 远端是否严格更新 */
  hasUpdate: boolean
  release: GitHubRelease | null
  /** release 里的 APK 资产(优先 release 版) */
  apkAsset: GitHubAsset | null
  /** 失败原因(网络 / 404 等) */
  error?: string
}

/** 归一成数字数组便于比较:"v1.0.0" / "1.0" / "1.0-beta" → [1,0,0] / [1,0] / [1,0] */
export function parseVersion(v: string): number[] {
  return String(v)
    .trim()
    .replace(/^v/i, '')
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map((n) => parseInt(n, 10) || 0)
}

/** 语义化比较 a vs b,缺位补 0。a < b 返回 -1。 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** 远端版本是否严格高于本地。 */
export function isNewerVersion(local: string, remote: string): boolean {
  return compareVersions(remote, local) > 0
}

/** 从 release 资产里找 APK:优先带 release 字样的正式版,其次任意 .apk。 */
export function findApkAsset(assets: GitHubAsset[]): GitHubAsset | null {
  if (!Array.isArray(assets)) return null
  return (
    assets.find((a) => /release/i.test(a.name) && /\.apk$/i.test(a.name)) ??
    assets.find((a) => /\.apk$/i.test(a.name)) ??
    null
  )
}

/** GitHub API 的 latest release 地址。 */
export function latestReleaseUrl(owner: string, repo: string): string {
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/latest`
}

/**
 * 检查更新:GET latest release(经传入的 fetchImpl,原生走 platformFetch 绕 CORS)。
 * 网络 / 仓库不存在等任何失败都返回带 error 的结果,不抛异常。
 */
export async function checkForUpdate(
  owner: string,
  repo: string,
  fetchImpl: typeof fetch,
  localVersion: string = APP_VERSION,
): Promise<UpdateCheckResult> {
  try {
    const res = await fetchImpl(latestReleaseUrl(owner, repo))
    if (!res.ok) {
      const msg =
        res.status === 404
          ? '仓库或 Release 不存在'
          : res.status === 403
            ? 'GitHub API 限流,稍后再试'
            : `GitHub 返回 ${res.status}`
      return { local: localVersion, latest: null, hasUpdate: false, release: null, apkAsset: null, error: msg }
    }
    const release = (await res.json()) as GitHubRelease
    const latest = release.tag_name
    const hasUpdate = isNewerVersion(localVersion, latest)
    return {
      local: localVersion,
      latest,
      hasUpdate,
      release,
      apkAsset: findApkAsset(release.assets ?? []),
      error: undefined,
    }
  } catch (err) {
    return {
      local: localVersion,
      latest: null,
      hasUpdate: false,
      release: null,
      apkAsset: null,
      error: err instanceof Error ? err.message : '网络错误',
    }
  }
}