<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
/**
 * ComposeSheet —— 双击空白处唤起的录入框。
 *
 * 交互契约:
 *   - 半透明磨砂面板,从下方浮起;点遮罩 / Esc 关闭
 *   - 支持拍照选图与文字输入
 *   - 「AI 归纳」在录入页调用,结果填入**正面/背面**(Anki 字段结构),
 *     用户可再手动编辑后落库
 *   - 未启用 AI 时不阻塞保存:直接把原文作为正面
 */
import type { AIConfig, Collection } from '~/types'
import { summarizeKnowledge } from '~/lib/ai'
import { firstLine } from '~/lib/ai'
import { captureImage } from '~/composables/useNativeBridge'
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
const imageUri = ref('')
const collectionId = ref(props.activeCollectionId)
const summarizing = ref(false)
const aiError = ref('')
const aiDone = ref(false)

const textareaEl = ref<HTMLTextAreaElement | null>(null)

/** 可保存条件:至少有原文,或至少填了正面/背面。 */
const canSave = computed(
  () => Boolean(sourceText.value.trim() || front.value.trim() || back.value.trim() || imageUri.value),
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
  if (shot?.dataUrl) imageUri.value = shot.dataUrl
}

async function onSummarize() {
  aiError.value = ''
  if (!aiReady.value) {
    aiError.value = aiHint.value || '请先在设置页完成 AI 配置'
    return
  }
  const text = sourceText.value.trim()
  if (!text) {
    aiError.value = '请先输入知识点原文'
    return
  }

  summarizing.value = true
  try {
    const result = await summarizeKnowledge(text, props.aiConfig)
    if (result.ok) {
      front.value = result.data.front
      back.value = result.data.back
      // 关键词自动并进标签(已填写的标签不覆盖)
      if (result.data.keywords.length) {
        const merged = new Set([...parsedTags.value, ...result.data.keywords])
        tagsText.value = [...merged].join(' ')
      }
      aiDone.value = true
    } else {
      aiError.value = result.error
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
  imageUri.value = ''
  aiError.value = ''
  aiDone.value = false
}

function onSave() {
  if (!canSave.value) return
  // 正面兜底:AI 未调用时用原文首行作为正面,保证卡片可用
  const finalFront = front.value.trim() || firstLine(sourceText.value) || '未命名知识点'
  emit('save', {
    sourceText: sourceText.value.trim() || finalFront,
    front: finalFront,
    back: back.value.trim(),
    imageUri: imageUri.value,
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

          <!-- 图片预览 -->
          <div v-if="imageUri" class="preview">
            <img :src="imageUri" alt="已选图片" />
            <button class="preview__remove" type="button" @click="imageUri = ''">移除</button>
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
              拍照 / 选图
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
              {{ summarizing ? '归纳中…' : 'AI 归纳' }}
            </button>

            <span v-if="aiDone" class="done-tag">已归纳</span>
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
          <button class="save-btn" type="button" :disabled="!canSave" @click="onSave">保存卡片</button>
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

.preview {
  position: relative;
  border-radius: 10px;
  overflow: hidden;
  max-height: 180px;
}

.preview img {
  width: 100%;
  max-height: 180px;
  object-fit: cover;
  display: block;
}

.preview__remove {
  position: absolute;
  top: 8px;
  right: 8px;
  font-size: 14px;
  padding: 4px 10px;
  border-radius: 999px;
  color: #fff;
  background: rgba(20, 28, 38, 0.55);
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
