/**
 * 打开 APKG 文件识别 —— 纯逻辑测试。
 *
 * 覆盖:从 content:// / file:// URI 提取文件名、扩展名白名单、
 * URL 解码、query/fragment 剥离、取不到名字时的 .apkg 兜底。
 */
import { describe, expect, it } from 'vitest'
import { apkgNameFromUri, importFileNameFromUri } from '~/lib/open-apkg'

describe('apkgNameFromUri', () => {
  it('从 file:// 路径取文件名', () => {
    expect(apkgNameFromUri('file:///storage/emulated/0/Download/my deck.apkg')).toBe(
      'my deck.apkg',
    )
  })

  it('URL 编码的文件名解码', () => {
    expect(apkgNameFromUri('file:///sdcard/%E6%95%B0%E5%AD%A6.apkg')).toBe('数学.apkg')
  })

  it('content URI 带文件名时提取', () => {
    expect(apkgNameFromUri('content://com.android.providers.downloads/downloads/42/card.apkg')).toBe(
      'card.apkg',
    )
  })

  it('content URI 纯 id 无文件名 → null(由兜底名处理)', () => {
    expect(apkgNameFromUri('content://com.android.providers.downloads/document/123')).toBeNull()
  })

  it('剥离 query / fragment', () => {
    expect(apkgNameFromUri('file:///sdcard/a.apkg?download=1#top')).toBe('a.apkg')
  })

  it('扩展名白名单:apkg / colpkg / anki 都认,其余不认', () => {
    expect(apkgNameFromUri('file:///x/1.apkg')).toBe('1.apkg')
    expect(apkgNameFromUri('file:///x/2.colpkg')).toBe('2.colpkg')
    expect(apkgNameFromUri('file:///x/3.anki')).toBe('3.anki')
    expect(apkgNameFromUri('file:///x/4.txt')).toBeNull()
    expect(apkgNameFromUri('file:///x/5.zip')).toBeNull()
    expect(apkgNameFromUri(null)).toBeNull()
    expect(apkgNameFromUri('')).toBeNull()
  })
})

describe('importFileNameFromUri(兜底)', () => {
  it('能识别就用原名,否则兜底 imported.apkg(保证走 apkg 解析)', () => {
    expect(importFileNameFromUri('content://x/document/9/words.apkg')).toBe('words.apkg')
    expect(importFileNameFromUri('content://x/document/9')).toBe('imported.apkg')
    expect(importFileNameFromUri(null)).toBe('imported.apkg')
  })
})