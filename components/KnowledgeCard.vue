<script setup lang="ts">
import { ref, computed } from 'vue'
/**
 * 知识卡片组件 —— 全屏卡片堆叠的单元。
 *
 * 只负责「把一条记录画成一张磨砂玻璃卡片」,不含任何手势逻辑。
 * 手势由父级 CardStack 统一处理,保证同一时刻只有顶层卡响应。
 *
 * 内容布局对齐 Anki:正面(问题)居中突出,背面(答案)默认折叠 ——
 * 单击翻面查看答案,保证「先回忆再看答案」的记忆有效性。
 */
import type { KnowledgeCard } from '~/types'
import { describeDue, memoryStrength, syncStateLabel } from '~/lib/srs'
import { paletteFor, paletteVars } from '~/lib/palette'
import { STACK } from '~/lib/motion'

const props = withDefaults(
  defineProps<{
    card: KnowledgeCard
    /** 堆叠深度:0 = 顶层 */
    depth?: number
    /** 是否为顶层(顶层才可翻面) */
    active?: boolean
    /** 合集名,显示在角标 */
    collectionName?: string
    /** 是否已翻面显示答案 */
    revealed?: boolean
    /**
     * 合集在列表中的序号 —— 用于无碰撞地分配卡片颜色。
     * 未提供时按合集 id 哈希兜底(可能与别的合集撞色)。
     */
    paletteIndex?: number
  }>(),
  { depth: 0, active: true, collectionName: '', revealed: false, paletteIndex: undefined },
)

/** 堆叠静止态样式(跟手位移由父级 wrapper 施加,两者自然叠加)。 */
const style = computed(() => {
  const d = props.depth
  const scale = 1 - d * STACK.scaleStep
  const baseY = d * STACK.offsetStep
  const rotate = d * STACK.rotateStep
  const blur = STACK.shadowBlur + d * STACK.shadowBlurStep
  const alpha = STACK.shadowAlpha + d * STACK.shadowAlphaStep
  return {
    transform: `translate3d(0, ${baseY}px, ${-d * STACK.depthStep}px) rotateZ(${rotate}deg) scale(${scale})`,
    opacity: 1 - d * STACK.opacityStep,
    zIndex: 10 - d,
    boxShadow: `0 ${blur}px ${blur * 2}px -6px rgba(15, 23, 42, ${alpha})`,
    // 卡片配色由合集决定:同一合集永远同一色,形成位置记忆
    ...paletteVars(paletteFor(props.card.collectionId, props.paletteIndex)),
  }
})

const strength = computed(() => memoryStrength(props.card.level))
const dueText = computed(() => describeDue(props.card))
const stateText = computed(() => syncStateLabel(props.card.syncState))

/** 顶层卡片才显示答案;深层堆叠层只露正面。 */
const showBack = computed(() => props.active && props.revealed && Boolean(props.card.back))

/** 长答案超过一定长度时收一收字号,避免溢出。 */
const backIsLong = computed(() => props.card.back.length > 120)
</script>

<template>
  <article class="card gpu" :style="style" :data-depth="depth">
    <!-- 顶部:记忆强度细条 + 到期/状态角标 -->
    <header class="card__top">
      <div class="meter" :aria-label="`记忆等级 ${card.level}`">
        <span
          class="meter__fill"
          :style="{
            width: `${strength * 100}%`,
            background: card.level >= 4 ? 'var(--pass)' : 'var(--card-accent)',
          }"
        />
      </div>
      <span class="card__state">{{ stateText }}</span>
      <span class="card__due">{{ dueText }}</span>
    </header>

    <!-- 正面 -->
    <div class="card__content">
      <p v-if="!card.front && !card.back" class="card__empty">空卡片</p>
      <p v-else class="card__front">{{ card.front || card.back }}</p>

      <!-- 背面:仅顶层且翻面后显示 -->
      <template v-if="showBack && card.front">
        <div class="card__divider" />
        <p class="card__back" :class="{ 'card__back--long': backIsLong }">{{ card.back }}</p>
      </template>

      <!-- 未翻面时的提示 -->
      <p v-else-if="active && card.back && card.front" class="card__peek">单击查看答案</p>

      <img v-if="card.imageUri" class="card__image" :src="card.imageUri" alt="知识点配图" />
    </div>

    <!-- 底部:合集 + 标签 + 复习次数 -->
    <footer class="card__bottom">
      <span class="chip chip--collection">{{ collectionName || '未分类' }}</span>
      <span v-if="card.tags.length" class="chip">#{{ card.tags[0] }}</span>
      <span class="chip chip--ghost">复习 {{ card.reviewCount }} 次</span>
    </footer>
  </article>
</template>

<style scoped>
.card {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  /*
   * 卡片是居中的独立实体,不再贴屏幕边缘,
   * 所以**不**需要安全区底部内边距(加了反而底部凭空多一块空白)。
   * 内边距按卡片自身尺寸收缩,与 --card-w 保持比例。
   */
  padding: 22px 20px;
  border-radius: var(--radius-card);
  /*
   * 卡片底色。
   *
   * 刻意**不用 backdrop-filter**:
   *   三张堆叠卡各带一层 backdrop-filter 时,移动端 GPU 每帧都要
   *   对每张卡重算一次背景模糊,是滑动掉帧最直接的原因。而卡片本身
   *   已是极浅的实色渐变,磨砂效果在视觉上几乎不可见 —— 付出的性能
   *   代价换不来观感收益。这里改用"浅色渐变 + 半透明白边 + 静态高光"
   *   来还原质感,全部是静态绘制,不参与每帧合成。
   */
  background:
    linear-gradient(150deg, var(--card-tint-a, rgba(255, 255, 255, 0.94)) 0%,
      var(--card-tint-b, rgba(255, 255, 255, 0.86)) 100%);
  border: 1px solid rgba(255, 255, 255, 0.92);
  /* 左侧一根强调色细线:颜色识别的主要锚点 */
  border-left: 3px solid var(--card-accent, rgba(27, 36, 48, 0.15));
  transform-origin: center 88%;
  overflow: hidden;
  contain: layout paint style;
}

/* 右上角一层极淡的色晕,增加卡片"有颜色"的观感但不压文字 */
.card::after {
  content: '';
  position: absolute;
  top: -40%;
  right: -30%;
  width: 70%;
  height: 70%;
  border-radius: 50%;
  background: var(--card-accent, transparent);
  opacity: 0.07;
  pointer-events: none;
}

/*
 * 左上角静态高光,用来替代磨砂玻璃的"通透感"。
 * 是纯静态绘制,滑动时不产生额外合成开销。
 */
.card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 40%;
  height: 45%;
  border-radius: var(--radius-card) 0 60% 0;
  background: linear-gradient(140deg, rgba(255, 255, 255, 0.5), rgba(255, 255, 255, 0));
  pointer-events: none;
  opacity: 0.75;
}

.card__top {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  position: relative;
  z-index: 1;
}

.meter {
  flex: 1;
  height: 4px;
  border-radius: 2px;
  background: rgba(27, 36, 48, 0.1);
  overflow: hidden;
}

.meter__fill {
  display: block;
  height: 100%;
  border-radius: 2px;
  transition: width 320ms cubic-bezier(0.22, 1, 0.36, 1);
}

.card__state,
.card__due {
  font-size: 12px;
  font-weight: 500;
  color: var(--ink-2);
  letter-spacing: 0.01em;
  white-space: nowrap;
}

.card__content {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 13px;
  min-height: 0;
  overflow: hidden;
  position: relative;
  z-index: 1;
}

/* 正面:卡片的主体。卡片变小后,28px 在视觉上比原来的 30px 更醒目 */
.card__front {
  margin: 0;
  font-size: 28px;
  line-height: 1.42;
  font-weight: 650;
  color: var(--ink-1);
  letter-spacing: 0.01em;
  white-space: pre-wrap;
  word-break: break-word;
}

.card__divider {
  width: 34px;
  height: 2px;
  border-radius: 1px;
  background: var(--card-accent);
  opacity: 0.5;
  flex: 0 0 auto;
}

/* 背面:比正面略小,但依然保持高可读性 */
.card__back {
  margin: 0;
  font-size: 19px;
  line-height: 1.62;
  color: var(--ink-1);
  white-space: pre-wrap;
  word-break: break-word;
  overflow-y: auto;
  max-height: 60%;
  overscroll-behavior: contain;
}

/* 超长答案略收字号,换取"不用滚动就能读完" */
.card__back--long {
  font-size: 17px;
  line-height: 1.58;
}

.card__peek {
  margin: 0;
  font-size: 14px;
  color: var(--ink-3);
}

.card__empty {
  margin: 0;
  color: var(--ink-3);
  font-size: 18px;
}

.card__image {
  width: 100%;
  max-height: 28%;
  object-fit: cover;
  border-radius: 10px;
}

.card__bottom {
  flex: 0 0 auto;
  display: flex;
  gap: 8px;
  align-items: center;
  position: relative;
  z-index: 1;
}

.chip {
  font-size: 12px;
  line-height: 1;
  padding: 6px 10px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.72);
  color: var(--ink-2);
  max-width: 42%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 合集标签用卡片自己的强调色,是最直接的颜色识别点 */
.chip--collection {
  color: var(--card-accent);
  font-weight: 600;
  background: rgba(255, 255, 255, 0.85);
}

.chip--ghost {
  background: transparent;
  color: var(--ink-3);
  padding-left: 0;
}
</style>
