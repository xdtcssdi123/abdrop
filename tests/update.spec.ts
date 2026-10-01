/**
 * GitHub Release 更新检测测试。
 *
 * - 版本解析/比较:标签去 v 前缀、点分数字缺位补 0、非数字段忽略
 * - APK 资产挑选:优先 release 正式版,退而求其次任意 .apk
 * - checkForUpdate:有更新 / 无更新 / 404 / 网络失败,均返回可读结果不抛异常
 */
import { describe, expect, it } from 'vitest'
import {
  APP_VERSION,
  compareVersions,
  checkForUpdate,
  findApkAsset,
  isNewerVersion,
  latestReleaseUrl,
  parseVersion,
  type GitHubRelease,
} from '~/lib/update'

describe('parseVersion', () => {
  it('去掉 v 前缀,拆成数字数组', () => {
    expect(parseVersion('v1.0.0')).toEqual([1, 0, 0])
    expect(parseVersion('1.0')).toEqual([1, 0])
  })
  it('忽略非数字段(预发布后缀等)', () => {
    expect(parseVersion('v1.2.0-beta.1')).toEqual([1, 2, 0, 1])
  })
  it('空串退化为空数组', () => {
    expect(parseVersion('')).toEqual([])
  })
})

describe('compareVersions / isNewerVersion', () => {
  it('缺位补 0:1.0 等于 1.0.0', () => {
    expect(compareVersions('1.0', '1.0.0')).toBe(0)
    expect(compareVersions('v1.0.0', '1.0')).toBe(0)
  })
  it('patch 递增判定为更新', () => {
    expect(compareVersions('1.0.0', '1.0.1')).toBe(-1)
    expect(isNewerVersion('1.0.0', 'v1.0.1')).toBe(true)
    expect(isNewerVersion('1.0', 'v1.0.1')).toBe(true)
  })
  it('minor / major 递增判定为更新', () => {
    expect(compareVersions('1.0', '1.1')).toBe(-1)
    expect(compareVersions('1.9', '2.0')).toBe(-1)
  })
  it('本地更高时无更新', () => {
    expect(isNewerVersion('1.1', 'v1.0.0')).toBe(false)
    expect(compareVersions('1.1', '1.0.9')).toBe(1)
  })
})

describe('findApkAsset', () => {
  const mk = (name: string) => ({ name, size: 1, browser_download_url: `https://x/${name}` })
  it('优先 release 正式版 APK', () => {
    const assets = [mk('ABDrop-1.0-debug.apk'), mk('ABDrop-1.0-release.apk')]
    expect(findApkAsset(assets)?.name).toBe('ABDrop-1.0-release.apk')
  })
  it('无 release 字样时退回任意 .apk', () => {
    const assets = [mk('readme.txt'), mk('app.apk')]
    expect(findApkAsset(assets)?.name).toBe('app.apk')
  })
  it('无 APK 或无资产返回 null', () => {
    expect(findApkAsset([mk('readme.txt')])).toBeNull()
    expect(findApkAsset([])).toBeNull()
    expect(findApkAsset(undefined as unknown as GitHubRelease['assets'])).toBeNull()
  })
})

describe('latestReleaseUrl', () => {
  it('拼接 owner/repo 并做 URL 编码', () => {
    expect(latestReleaseUrl('my-name', 'abdrop')).toBe(
      'https://api.github.com/repos/my-name/abdrop/releases/latest',
    )
  })
})

describe('checkForUpdate', () => {
  const releaseBody = (tag: string, assets: GitHubRelease['assets']): GitHubRelease => ({
    tag_name: tag,
    name: tag,
    body: '更新说明',
    published_at: '2026-10-01T00:00:00Z',
    html_url: `https://github.com/u/abdrop/releases/tag/${tag}`,
    assets,
  })

  it('远端更新时 hasUpdate=true 并找到 APK 资产', async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify(releaseBody('v1.0.1', [{ name: 'ABDrop-1.0.1-release.apk', size: 1, browser_download_url: 'u' }])), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }) as Response
    const r = await checkForUpdate('u', 'abdrop', fetchImpl, '1.0')
    expect(r.hasUpdate).toBe(true)
    expect(r.latest).toBe('v1.0.1')
    expect(r.apkAsset?.name).toBe('ABDrop-1.0.1-release.apk')
    expect(r.release?.body).toBe('更新说明')
    expect(r.error).toBeUndefined()
  })

  it('本地已最新时 hasUpdate=false,latest 仍返回远端 tag', async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify(releaseBody('v1.0', [])), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }) as Response
    const r = await checkForUpdate('u', 'abdrop', fetchImpl, APP_VERSION)
    expect(r.hasUpdate).toBe(false)
    expect(r.latest).toBe('v1.0')
  })

  it('404 返回可读错误,不抛异常', async () => {
    const fetchImpl = async () =>
      new Response('Not Found', { status: 404 }) as Response
    const r = await checkForUpdate('u', 'missing', fetchImpl)
    expect(r.hasUpdate).toBe(false)
    expect(r.error).toContain('仓库或 Release 不存在')
  })

  it('网络失败返回错误信息,不抛异常', async () => {
    const fetchImpl = async () => {
      throw new Error('Network Error')
    }
    const r = await checkForUpdate('u', 'abdrop', fetchImpl)
    expect(r.hasUpdate).toBe(false)
    expect(r.error).toBe('Network Error')
  })

  it('使用默认本地版本常量', async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify(releaseBody('v1.0', [])), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }) as Response
    const r = await checkForUpdate('u', 'abdrop', fetchImpl)
    expect(r.local).toBe(APP_VERSION)
  })
})