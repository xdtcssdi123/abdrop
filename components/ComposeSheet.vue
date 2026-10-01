<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
/**
 * ComposeSheet —— 从设置页「录入知识点」按钮进入的录入框。
 *
 * 交互契约:
 *   - 半透明磨砂面板,从下方浮起;点遮罩 / Esc 关闭
 *   - 支持拍照选图与文字输入
 *   - 「AI 归纳」在录入页调用,结果填入**正面/背面**(Anki 字段结构),
 *     用户可再手动编辑后落库
 *   - 未启用 AI 时不阻塞保存:直接把原文作为正面
 */
import type { AIConfig, Collection } from '~/types'
import { summarizeKnowledgeMany, summarizeMany, draftsFromImageResults } from '~/lib/ai'
import { firstLine } from '~/lib/ai'
import { captureImage, platformFetch } from '~/composables/useNativeBridge'
import { scrollIntoViewOnKeyboard } from '~/composables/useViewport'

const props = defineProps<{
  open: boolean
  collections: readonly Collection[]
  activeCollectionId: string
  aiConfig: AIConfig
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'save', payload: {
    sourceText: string
    front: string
    back: string
    imageUri: string
    tags: string[]
    collectionId: string
  }): void
}>()

/** 原文(录入源) */
const sourceText = ref('')
/** 正面 / 背面 */
const front = ref('')
const back = ref('')
const tagsText = ref('')
/** 已选图片列表(可多张,「AI 识图拆卡」逐张成卡) */
const images = ref<string[]>([])
/** 「AI 识图拆卡」生成的卡片草稿(可编辑,保存时逐张入库) */
const drafts = ref<Array<{ imageUri: string; front: string; back: string; keywords: string[] }>>([])
const collectionId = ref(props.activeCollectionId)
const summarizing = ref(false)
/** 进度文案,如「识别中 2/3」 */
const summarizeProgress = ref('')
const aiError = ref('')
const aiDone = ref(false)

const textareaEl = ref<HTMLTextAreaElement | null>(null)

/** 可保存条件:有原文/正背面,或至少一张图/一张草稿。 */
const canSave = computed(
  () =>
    Boolean(
      sourceText.value.trim() ||
        front.value.trim() ||
        back.value.trim() ||
        images.value.length ||
        drafts.value.length,
    ),
)

const aiReady = computed(
  () => props.aiConfig.enabled && Boolean(props.aiConfig.apiKey) && Boolean(props.aiConfig.baseUrl),
)

const aiHint = computed(() => (props.aiConfig.enabled ? '' : '未启用 AI —— 到设置页配置后可自动归纳补全'))

/** 解析标签输入:`#a #b` 或 `a,b` 都能认。 */
const parsedTags = computed(() =>
  tagsText.value
    .split(/[\s,，、#]+/)
    .map((t) => t.trim())
    .filter(Boolean),
)

/** 打开时聚焦并同步当前合集。 */
watch(
  () => props.open,
  async (isOpen) => {
    if (!isOpen) return
    collectionId.value = props.activeCollectionId
    await nextTick()
    textareaEl.value?.focus()
    // 移动端:聚焦后键盘会盖住输入框,主动滚进视野
    scrollIntoViewOnKeyboard(textareaEl.value)
  },
)

/**
 * 输入框聚焦时确保可见。
 * 键盘弹出后 CSS 变量 --kb-inset 才更新,这里再滚一次兜底。
 */
function onFieldFocus(e: FocusEvent) {
  scrollIntoViewOnKeyboard(e.target as HTMLElement)
}

async function onPickImage() {
  const shot = await captureImage()
  if (shot?.dataUrl) images.value = [...images.value, shot.dataUrl]
}

function onRemoveImage(index: number) {
  images.value = images.value.filter((_, i) => i !== index)
}

function onRemoveDraft(index: number) {
  drafts.value = drafts.value.filter((_, i) => i !== index)
}

async function onSummarize() {
  aiError.value = ''
  summarizeProgress.value = ''
  if (!aiReady.value) {
    aiError.value = aiHint.value || '请先在设置页完成 AI 配置'
    return
  }
  const text = sourceText.value.trim()
  const imageList = images.value
  // 有文字或有图片(且开启识别)即可归纳
  const canRecognize = Boolean(text || (imageList.length && props.aiConfig.vision))
  if (!canRecognize) {
    aiError.value =
      imageList.length && !props.aiConfig.vision
        ? '已选图片但未开启识别图片 —— 到设置页打开「识别图片」'
        : '请先输入知识点原文,或拍照后开启图片识别'
    return
  }

  summarizing.value = true
  try {
    if (imageList.length) {
      // 有图 → 识图拆卡:每张图可拆出多张卡片草稿
      const results = await summarizeMany(
        imageList,
        text,
        props.aiConfig,
        platformFetch,
        (done, total) => (summarizeProgress.value = `识别中 ${done}/${total}`),
      )
      const { drafts: parsedDrafts, failed } = draftsFromImageResults(results, text)
      drafts.value = parsedDrafts
      summarizeProgress.value = ''
      if (failed.length) {
        aiError.value = failed
          .map((f) => `${failed.length} 张识别失败:${f.error}`)
          .join('\n')
      }
      if (!drafts.value.length && !failed.length) {
        aiError.value = 'AI 未返回可识别的卡片内容'
      }
    } else {
      // 无图 → 文本拆卡:一段文字也可能包含多个独立知识点,拆成多张草稿
      const result = await summarizeKnowledgeMany(text, props.aiConfig, platformFetch)
      if (result.ok) {
        drafts.value = result.data.map((card) => ({
          imageUri: '',
          front: card.front,
          back: card.back,
          keywords: card.keywords,
        }))
        if (result.data[0]?.keywords.length) {
          const merged = new Set([...parsedTags.value, ...result.data[0].keywords])
          tagsText.value = [...merged].join(' ')
        }
        aiDone.value = true
      } else {
        aiError.value = result.error
      }
    }
  } finally {
    summarizing.value = false
  }
}

function reset() {
  sourceText.value = ''
  front.value = ''
  back.value = ''
  tagsText.value = ''
  images.value = []
  drafts.value = []
  aiError.value = ''
  aiDone.value = false
  summarizeProgress.value = ''
}

function onSave() {
  if (!canSave.value) return
  // 正面兜底:AI 未调用时用原文首行作为正面,保证卡片可用
  const fallbackFront = front.value.trim() || firstLine(sourceText.value) || '未命名知识点'

  if (drafts.value.length) {
    // 识图拆卡:逐张草稿保存为独立卡片(每卡带自己的图与内容)
    for (const draft of drafts.value) {
      emit('save', {
        sourceText: sourceText.value.trim() || draft.front,
        front: draft.front.trim() || firstLine(sourceText.value) || '未命名知识点',
        back: draft.back.trim(),
        imageUri: draft.imageUri,
        tags: [...new Set([...parsedTags.value, ...(draft.keywords ?? [])])],
        collectionId: collectionId.value,
      })
    }
    reset()
    return
  }

  emit('save', {
    sourceText: sourceText.value.trim() || fallbackFront,
    front: fallbackFront,
    back: back.value.trim(),
    imageUri: images.value[0] ?? '',
    tags: parsedTags.value,
    collectionId: collectionId.value,
  })
  reset()
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') onSave()
}
</script>

<template>
  <Transition name="sheet">
    <div v-if="open" class="compose" @keydown="onKeydown">
      <div class="compose__scrim" @click="emit('close')" />

      <div class="compose__panel glass" role="dialog" aria-modal="true" aria-label="录入知识点">
        <div class="compose__handle" aria-hidden="true" />

        <header class="compose__head">
          <h2 class="compose__title">录入知识点</h2>
          <button class="compose__close" type="button" aria-label="关闭" @click="emit('close')">
            <svg viewBox="0 0 24 24" width="18" height="18">
              <path
                d="M6 6 L18 18 M18 6 L6 18"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
              />
            </svg>
          </button>
        </header>

        <div class="compose__body scroll-area">
          <!-- 原文输入 -->
          <label class="field">
            <span class="field__label">知识点原文</span>
            <textarea
              ref="textareaEl"
              v-model="sourceText"
              class="field__textarea"
              rows="3"
              placeholder="手动输入,或拍照后补充说明…"
              @focus="onFieldFocus"
            />
          </label>

          <!-- 已选图片(可多张;「AI 识图拆卡」逐张成卡) -->
          <div v-if="images.length" class="img-grid">
            <div v-for="(img, i) in images" :key="`${i}-${img.slice(0, 24)}`" class="img-cell">
              <img :src="img" :alt="`已选图片 ${i + 1}`" />
              <button class="img-cell__remove" type="button" :aria-label="`移除图片${i + 1}`" @click="onRemoveImage(i)">×</button>
            </div>
          </div>

          <!-- 操作行 -->
          <div class="actions">
            <button class="ghost-btn" type="button" @click="onPickImage">
              <svg viewBox="0 0 24 24" width="17" height="17">
                <path
                  d="M4 7h3l1.5-2h7L17 7h3v12H4z M12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.6"
                  stroke-linejoin="round"
                />
              </svg>
              添加图片(可多张)
            </button>

            <button
              class="ghost-btn"
              type="button"
              :disabled="summarizing"
              :aria-busy="summarizing"
              @click="onSummarize"
            >
              <svg viewBox="0 0 24 24" width="17" height="17">
                <path
                  d="M12 3.5 L13.8 9.2 L19.5 11 L13.8 12.8 L12 18.5 L10.2 12.8 L4.5 11 L10.2 9.2 Z"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linejoin="round"
                />
              </svg>
              {{ summarizing ? summarizeProgress || '归纳中…' : images.length ? `AI 识图拆卡 (${images.length})` : 'AI 归纳(拆卡)' }}
            </button>

            <span v-if="aiDone" class="done-tag">已归纳</span>
          </div>

          <p v-if="summarizeProgress" class="hint">{{ summarizeProgress }}</p>

          <div v-if="drafts.length" class="drafts">
            <span class="field__label">识别出的卡片({{ drafts.length }})—— 可编辑,保存时逐张入库</span>
            <div v-for="(draft, i) in drafts" :key="`${draft.imageUri}-${i}`" class="draft">
              <div class="draft__head">
                <img class="draft__thumb" :src="draft.imageUri" alt="卡片图片" />
                <span class="draft__order">第 {{ i + 1 }} 张</span>
                <button class="draft__remove" type="button" @click="onRemoveDraft(i)">移除</button>
              </div>
              <textarea
                v-model="draft.front"
                class="field__textarea field__textarea--sm"
                rows="2"
                placeholder="正面 · 问题"
                @focus="onFieldFocus"
              />
              <textarea
                v-model="draft.back"
                class="field__textarea field__textarea--sm"
                rows="3"
                placeholder="背面 · 答案"
                @focus="onFieldFocus"
              />
            </div>
          </div>

          <p v-if="aiHint && !aiError" class="hint">{{ aiHint }}</p>
          <p v-if="aiError" class="hint hint--error">{{ aiError }}</p>

          <!-- 卡片正反面(对齐 Anki 字段) -->
          <label class="field">
            <span class="field__label">正面 · 问题(留空则自动取原文首句)</span>
            <textarea
              v-model="front"
              class="field__textarea field__textarea--sm"
              rows="2"
              placeholder="这张卡要考察什么?"
              @focus="onFieldFocus"
            />
          </label>

          <label class="field">
            <span class="field__label">背面 · 答案</span>
            <textarea
              v-model="back"
              class="field__textarea field__textarea--sm"
              rows="3"
              placeholder="答案 / 解释(AI 归纳会自动填入)"
              @focus="onFieldFocus"
            />
          </label>

          <label class="field">
            <span class="field__label">标签(空格分隔,便于同步 Anki)</span>
            <input
              v-model="tagsText"
              class="field__input"
              type="text"
              placeholder="例如 数学 极限"
              @focus="onFieldFocus"
            />
          </label>

          <!-- 合集选择 -->
          <div class="field">
            <span class="field__label">归入合集</span>
            <div class="chips">
              <button
                v-for="col in collections"
                :key="col.id"
                class="chip"
                :class="{ 'chip--on': collectionId === col.id }"
                type="button"
                @click="collectionId = col.id"
              >
                {{ col.name }}
              </button>
            </div>
          </div>
        </div>

        <footer class="compose__foot">
          <button class="save-btn" type="button" :disabled="!canSave" @click="onSave">
            {{ drafts.length ? `保存 ${drafts.length} 张卡片` : '保存卡片' }}
          </button>
        </footer>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.compose {
  position: fixed;
  inset: 0;
  z-index: var(--z-sheet);
  display: flex;
  align-items: flex-end;
}

.compose__scrim {
  position: absolute;
  inset: 0;
  background: rgba(20, 28, 38, 0.28);
  backdrop-filter: blur(2px);
}

.compose__panel {
  position: relative;
  width: 100%;
  /*
   * 面板高度上限。
   * 先用 vh 给旧版 Chrome(<108 不支持 dvh)兜底,再用 dvh 覆盖。
   * 减去 --kb-inset 保证软键盘弹出时底部保存按钮始终可见。
   */
  max-height: min(88vh, calc(100vh - var(--kb-inset, 0px) - 16px));
  max-height: min(88dvh, calc(100dvh - var(--kb-inset, 0px) - 16px));
  /* 键盘弹出时整个面板上推,输入区不被遮挡 */
  margin-bottom: var(--kb-inset, 0px);
  transition: margin-bottom 200ms cubic-bezier(0.22, 1, 0.36, 1);
  display: flex;
  flex-direction: column;
  padding: 8px calc(18px + var(--safe-right)) calc(16px + var(--safe-bottom))
    calc(18px + var(--safe-left));
  border-radius: var(--radius-sheet) var(--radius-sheet) 0 0;
  background: rgba(252, 253, 254, 0.88);
  box-shadow: 0 -12px 40px rgba(15, 23, 42, 0.16);
}

.compose__handle {
  width: 36px;
  height: 4px;
  border-radius: 2px;
  background: rgba(27, 36, 48, 0.15);
  margin: 4px auto 10px;
}

.compose__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.compose__title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--ink-1);
}

.compose__close {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  color: var(--ink-2);
  background: rgba(27, 36, 48, 0.05);
}

.compose__body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 12px 0;
}

/* 同 settings/admin:flex 列滚动容器子项禁止收缩 */
.compose__body > * {
  flex-shrink: 0;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field__label {
  font-size: 14px;
  color: var(--ink-3);
  letter-spacing: 0.02em;
}

.field__textarea,
.field__input {
  width: 100%;
  resize: none;
  padding: 11px 12px;
  border-radius: 10px;
  border: 1px solid rgba(27, 36, 48, 0.1);
  background: rgba(255, 255, 255, 0.8);
  font-size: 17px;
  line-height: 1.6;
  color: var(--ink-1);
  outline: none;
}

.field__textarea--sm {
  font-size: 16px;
}

.field__textarea:focus,
.field__input:focus {
  border-color: rgba(63, 191, 127, 0.55);
  box-shadow: 0 0 0 3px rgba(63, 191, 127, 0.12);
}

/* 已选图片:横向小网格,每张可移除 */
.img-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
  gap: 8px;
}

.img-cell {
  position: relative;
  border-radius: 10px;
  overflow: hidden;
  aspect-ratio: 1;
}

.img-cell img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.img-cell__remove {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  font-size: 15px;
  line-height: 1;
  color: #fff;
  background: rgba(20, 28, 38, 0.55);
}

/* 识图拆卡草稿:每张卡可编辑正反面 */
.drafts {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.draft {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border-radius: 12px;
  background: rgba(27, 36, 48, 0.04);
}

.draft__head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.draft__thumb {
  width: 44px;
  height: 44px;
  border-radius: 8px;
  object-fit: cover;
}

.draft__order {
  flex: 1;
  font-size: 13px;
  color: var(--ink-3);
}

.draft__remove {
  font-size: 13px;
  padding: 4px 10px;
  border-radius: 999px;
  color: var(--danger);
  background: rgba(224, 106, 106, 0.1);
}

.actions {
  display: flex;
  gap: 10px;
  align-items: center;
}

.ghost-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 10px 16px;
  border-radius: 999px;
  font-size: 15px;
  color: var(--ink-2);
  background: rgba(27, 36, 48, 0.05);
}

.ghost-btn:disabled {
  opacity: 0.5;
}

.done-tag {
  font-size: 13px;
  color: var(--pass);
}

.hint {
  margin: 0;
  font-size: 14px;
  color: var(--ink-3);
}

.hint--error {
  color: var(--danger);
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.chip {
  font-size: 14px;
  padding: 8px 15px;
  border-radius: 999px;
  color: var(--ink-2);
  background: rgba(27, 36, 48, 0.05);
}

.chip--on {
  color: #fff;
  background: var(--ink-1);
}

.compose__foot {
  flex: 0 0 auto;
  padding-top: 6px;
}

.save-btn {
  width: 100%;
  padding: 16px;
  border-radius: 12px;
  font-size: 17px;
  font-weight: 600;
  color: #fff;
  background: var(--ink-1);
}

.save-btn:disabled {
  opacity: 0.35;
}

.sheet-enter-active,
.sheet-leave-active {
  transition: opacity 240ms cubic-bezier(0.22, 1, 0.36, 1);
}
.sheet-enter-active .compose__panel,
.sheet-leave-active .compose__panel {
  transition: transform 280ms cubic-bezier(0.22, 1, 0.36, 1);
}
.sheet-enter-from,
.sheet-leave-to {
  opacity: 0;
}
.sheet-enter-from .compose__panel,
.sheet-leave-to .compose__panel {
  transform: translateY(100%);
}
</style>
