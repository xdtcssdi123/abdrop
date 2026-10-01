/**
 * 原生备份(「保存配置 / 加载配置」)测试。
 *
 * - 导出为 v3 快照:含 config(AI 配置 + 复习范围),卡片调度字段完整往返
 * - 导入时解析出 config 块,由 UI 层决定如何应用
 * - v2 老备份无 config,照常可导入(向后兼容)
 * - 非法 JSON / 缺 cards 字段 → 友好报错,不抛异常
 * - config 结构损坏时忽略配置块,卡片照常还原
 * - 重复导入幂等(已存在 id 跳过)
 */
import { describe, expect, it } from 'vitest'
import {
  exportNativeBackup,
  exportNativeBackupZip,
  importNativeBackup,
} from '~/lib/anki-io'
import { createMemoryRepository, type CardRepository } from '~/lib/db'
import { DEFAULT_AI_CONFIG } from '~/lib/ai'
import type { AppConfigSnapshot, KnowledgeCard } from '~/types'
import { strFromU8, unzipSync } from 'fflate'

function makeBackupFile(json: unknown): File {
  return new File([JSON.stringify(json)], 'abdrop-backup.json', { type: 'application/json' })
}

const NOW = 1_800_000_000_000

async function seedRepo(): Promise<{
  repo: CardRepository
  card: KnowledgeCard
  collectionId: string
}> {
  const repo = createMemoryRepository()
  const col = await repo.ensureCollection('数学')
  const card = await repo.addCard(
    { front: '什么是极限', back: '趋近过程的描述', collectionId: col.id },
    NOW,
  )
  return { repo, card, collectionId: col.id }
}

describe('原生备份 v3(保存配置/加载配置)', () => {
  it('导出 v3 快照:含 config 与卡片全部调度字段', async () => {
    const { repo, card, collectionId } = await seedRepo()
    const config: AppConfigSnapshot = {
      ai: {
        ...DEFAULT_AI_CONFIG,
        provider: 'deepseek',
        model: 'deepseek-chat',
        apiKey: 'sk-test',
        enabled: true,
      },
      activeCollectionId: collectionId,
    }
    const out = await exportNativeBackup(repo, config, new Date(NOW))
    expect(out.count).toBe(1)

    const parsed = JSON.parse(out.content as string)
    expect(parsed.version).toBe(3)
    expect(parsed.config).toEqual(config)
    expect(parsed.collections.map((c: any) => c.name)).toContain('数学')

    // 复习记忆字段完整往返:调度信息不丢
    const round = parsed.cards[0] as KnowledgeCard
    expect(round.id).toBe(card.id)
    expect(round.level).toBe(card.level)
    expect(round.nextReviewAt).toBe(card.nextReviewAt)
    expect(round.reviewCount).toBe(card.reviewCount)
  })

  it('不传 config 时不写 config 块(v2 兼容形态)', async () => {
    const { repo } = await seedRepo()
    const out = await exportNativeBackup(repo)
    const parsed = JSON.parse(out.content as string)
    expect(parsed.version).toBe(3)
    expect(parsed.config).toBeUndefined()
    expect(parsed.cards).toHaveLength(1)
  })

  it('导入 v3:还原卡片并解析出配置快照', async () => {
    const config: AppConfigSnapshot = {
      ai: {
        ...DEFAULT_AI_CONFIG,
        provider: 'anthropic',
        model: 'claude-3',
        apiKey: 'sk-ant-test',
      },
      activeCollectionId: 'math',
    }
    const target = createMemoryRepository()
    const file = makeBackupFile({
      version: 3,
      exportedAt: NOW,
      config,
      collections: [{ id: 'math', name: '数学', order: 0, createdAt: NOW }],
      cards: [
        {
          id: 'c1',
          front: 'Q',
          back: 'A',
          sourceText: '',
          collectionId: 'math',
          tags: [],
          modelName: '',
          level: 2,
          intervalDays: 4,
          ease: 2500,
          syncState: 'review',
          lapses: 0,
          createdAt: NOW,
          nextReviewAt: NOW - 1,
          lastReviewedAt: NOW - 86_400_000,
          reviewCount: 3,
          passCount: 2,
          failCount: 1,
          consecutiveFails: 0,
          imageUri: '',
          ankiNoteId: '',
          backEdited: false,
          deleted: false,
          updatedAt: NOW,
        },
      ],
    })
    const report = await importNativeBackup(file, target)
    expect(report.added).toBe(1)
    expect(report.skipped).toBe(0)
    expect(report.restoredConfig).toEqual(config)

    const read = await target.getCard('c1')
    expect(read?.level).toBe(2)
    expect(read?.nextReviewAt).toBe(NOW - 1)
  })

  it('导入 v2 老备份(无 config):卡片照常还原,无配置块', async () => {
    const target = createMemoryRepository()
    const file = makeBackupFile({
      version: 2,
      exportedAt: NOW,
      collections: [],
      cards: [
        {
          id: 'c2',
          front: '旧卡',
          back: '',
          sourceText: '',
          collectionId: 'inbox',
          tags: [],
          modelName: '',
          level: 0,
          intervalDays: 0,
          ease: 2500,
          syncState: 'new',
          lapses: 0,
          createdAt: NOW,
          nextReviewAt: NOW,
          lastReviewedAt: 0,
          reviewCount: 0,
          passCount: 0,
          failCount: 0,
          consecutiveFails: 0,
          imageUri: '',
          ankiNoteId: '',
          backEdited: false,
          deleted: false,
          updatedAt: NOW,
        },
      ],
    })
    const report = await importNativeBackup(file, target)
    expect(report.added).toBe(1)
    expect(report.restoredConfig).toBeUndefined()
  })

  it('非法 JSON:友好报错,不抛异常', async () => {
    const file = new File(['not json'], 'bad.json', { type: 'application/json' })
    const report = await importNativeBackup(file, createMemoryRepository())
    expect(report.added).toBe(0)
    expect(report.warnings[0]).toContain('JSON')
  })

  it('缺少 cards 字段:友好报错,不抛异常', async () => {
    const file = makeBackupFile({ version: 3, exportedAt: NOW })
    const report = await importNativeBackup(file, createMemoryRepository())
    expect(report.added).toBe(0)
    expect(report.warnings[0]).toContain('cards')
  })

  it('重复导入幂等:已存在 id 跳过,不产生重复卡', async () => {
    const { repo } = await seedRepo()
    const out = await exportNativeBackup(repo, undefined, new Date(NOW))
    const file = new File([out.content as string], 'backup.json', { type: 'application/json' })
    const report = await importNativeBackup(file, repo)
    expect(report.added).toBe(0)
    expect(report.skipped).toBe(1)
    expect(await repo.countCards()).toBe(1)
  })

  it('config 结构损坏时忽略配置块,卡片照常还原', async () => {
    const target = createMemoryRepository()
    const file = makeBackupFile({
      version: 3,
      exportedAt: NOW,
      config: { ai: 'broken', activeCollectionId: 123 },
      collections: [],
      cards: [
        {
          id: 'c3',
          front: 'Q3',
          back: '',
          sourceText: '',
          collectionId: 'inbox',
          tags: [],
          modelName: '',
          level: 0,
          intervalDays: 0,
          ease: 2500,
          syncState: 'new',
          lapses: 0,
          createdAt: NOW,
          nextReviewAt: NOW,
          lastReviewedAt: 0,
          reviewCount: 0,
          passCount: 0,
          failCount: 0,
          consecutiveFails: 0,
          imageUri: '',
          ankiNoteId: '',
          backEdited: false,
          deleted: false,
          updatedAt: NOW,
        },
      ],
    })
    const report = await importNativeBackup(file, target)
    expect(report.added).toBe(1)
    expect(report.restoredConfig).toBeUndefined()
  })
})

describe('zip 备份包(图片外置 + 全量还原)', () => {
  it('导出 zip:json + media 图片独立文件', async () => {
    const repo = createMemoryRepository()
    const col = await repo.ensureCollection('英语')
    const card = await repo.addCard(
      {
        front: 'word',
        back: '含义',
        collectionId: col.id,
        imageUri: 'data:image/png;base64,AAAA',
      },
      NOW,
    )

    const config: AppConfigSnapshot = {
      ai: { ...DEFAULT_AI_CONFIG, enabled: true, model: 'm' },
      activeCollectionId: col.id,
    }
    const out = await exportNativeBackupZip(repo, config, new Date(NOW))
    expect(out.mime).toBe('application/zip')
    expect(out.content).toBeInstanceOf(Uint8Array)

    const files = unzipSync(out.content as Uint8Array)
    // json 存在且含 config
    const json = JSON.parse(strFromU8(files['abdrop-backup.json']!))
    expect(json.version).toBe(4)
    expect(json.config).toEqual(config)
    // 图片外置:json 里是路径,media/ 里有二进制
    const stored = json.cards[0] as KnowledgeCard
    expect(stored.id).toBe(card.id)
    expect(stored.imageUri).toContain('media/')
    expect(files[stored.imageUri]).toBeTruthy()
  })

  it('导入 zip:图片从 media 回填为 dataURL,卡片/配置还原', async () => {
    // 先导出一份带图片的 zip
    const repo = createMemoryRepository()
    const col = await repo.ensureCollection('英语')
    await repo.addCard(
      {
        front: 'word',
        back: '含义',
        collectionId: col.id,
        imageUri: 'data:image/png;base64,QUJD',
      },
      NOW,
    )
    const config: AppConfigSnapshot = {
      ai: { ...DEFAULT_AI_CONFIG, enabled: true, model: 'm' },
      activeCollectionId: col.id,
    }
    const out = await exportNativeBackupZip(repo, config, new Date(NOW))

    // 用 zip 文件导入到新库
    const zipFile = new File([Uint8Array.from(out.content as Uint8Array)], 'abdrop-backup.zip', {
      type: 'application/zip',
    })
    const target = createMemoryRepository()
    const report = await importNativeBackup(zipFile, target)
    expect(report.added).toBe(1)
    expect(report.restoredConfig).toEqual(config)

    const restored = (await target.listCards())[0]
    expect(restored.front).toBe('word')
    // 图片被还原为 dataURL(不再是 media/ 路径)
    expect(restored.imageUri).toContain('data:image/png;base64,')
    expect(restored.imageUri).toContain('QUJD')
  })

  it('zip 包缺 json 时友好报错,不抛异常', async () => {
    const { zipSync } = await import('fflate')
    const { strToU8 } = await import('fflate')
    const bad = new File(
      [zipSync({ 'random.txt': strToU8('hello') })],
      'bad.zip',
      { type: 'application/zip' },
    )
    const report = await importNativeBackup(bad, createMemoryRepository())
    expect(report.added).toBe(0)
    expect(report.warnings.join()).toContain('abdrop-backup.json')
  })
})
