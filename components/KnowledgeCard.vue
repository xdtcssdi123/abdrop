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
import { renderMarkdown } from '~/lib/markdown'
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
    /*
     * 阴影分两层:近处细接触影(实体感)+ 远处大扩散影(悬浮感)。
     * 全部静态绘制,不参与逐帧合成;数值随深度递增,保持堆叠层次。
     */
    boxShadow: `
      0 1px 1px rgba(15, 23, 42, ${Math.min(alpha * 0.55, 0.14)}),
      0 ${blur * 1.1}px ${blur * 2.6}px -8px rgba(15, 23, 42, ${alpha + 0.05})`,
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

/**
 * 正面标题是否可能超高(约 3 行以上)。
 * 未翻面时内容区默认居中 + overflow:hidden,超高会把顶部裁掉;
 * 标题过长时切换为「可滚动 + 顶部对齐」,保证第一行不被盖住。
 */
const frontOverflows = computed(
  () => (props.card.front || props.card.back).length > 96,
)
</script>

<template>
  <article class="card gpu" :style="style" :data-depth="depth" :class="{ 'card--deep': depth > 0 }">
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

    <!-- 正面/答案区:翻面后整体可滚动;未翻面时标题过长也切滚动,避免顶部被裁 -->
    <div
      class="card__content"
      :class="{
        'card__content--revealed card__scroll': showBack,
        'card__scroll card__content--front-overflows': !showBack && frontOverflows,
      }"
    >
      <p v-if="!card.front && !card.back" class="card__empty">空卡片</p>
      <!-- 正面:优先纯文本;无正面时退回 Markdown 渲染背面首部 -->
      <p v-else-if="card.front" class="card__front">{{ card.front }}</p>
      <div v-else class="card__front md-body" v-html="renderMarkdown(card.back)" />

      <!-- 背面:仅顶层且翻面后显示(Markdown 渲染) -->
      <template v-if="showBack && card.front">
        <div class="card__divider" />
        <div
          class="card__back md-body"
          :class="{ 'card__back--long': backIsLong }"
          v-html="renderMarkdown(card.back)"
        />
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
  /* 内高光:一圈极淡的白边,让卡片边缘"立"起来 */
  box-shadow: inset 0 0 0 0.5px rgba(255, 255, 255, 0.65);
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
  opacity: 0.1;
  filter: blur(0.01px); /* 触发 GPU 层,避免色晕边缘锯齿 */
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
  background: linear-gradient(140deg, rgba(255, 255, 255, 0.62), rgba(255, 255, 255, 0));
  pointer-events: none;
  opacity: 0.8;
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

/*
 * 未翻面但标题过长:从「居中 + 裁顶」切到「顶部对齐 + 可滚动」。
 * 这样长标题第一行完整可见,向上滚动可读全文,不会被 card__top 盖住。
 */
.card__content--front-overflows {
  justify-content: flex-start;
  overflow-y: auto;
  overscroll-behavior: contain;
  touch-action: pan-y;
  -webkit-overflow-scrolling: touch;
  padding-right: 4px;
  scrollbar-width: thin;
  scrollbar-color: rgba(27, 36, 48, 0.18) transparent;
}

/*
 * 翻面后的内容区:整体可滚动。
 * 问题(正面)缩小置顶,答案与图片从上到下自然排布;
 * 内容超高时滚动查看,而不是 overflow:hidden 把底部裁掉。
 */
.card__content--revealed {
  justify-content: flex-start;
  overflow-y: auto;
  overscroll-behavior: contain;
  /* 触控交给浏览器原生滚动;横向滑卡不冲突(.stack pan-y 已让出纵向) */
  touch-action: pan-y;
  -webkit-overflow-scrolling: touch;
  padding-right: 4px;
  scrollbar-width: thin;
  scrollbar-color: rgba(27, 36, 48, 0.18) transparent;
}

/* 翻面后:问题不再占主导,收缩为答案的引导行 */
.card__content--revealed .card__front {
  font-size: 17px;
  line-height: 1.48;
  font-weight: 600;
  flex: 0 0 auto;
}

.card__content--revealed .card__divider {
  flex: 0 0 auto;
}

/* 答案不再自限 60% 高:由外层整体滚动接管,长答案可读全文 */
.card__content--revealed .card__back {
  max-height: none;
  overflow: visible;
  flex: 0 0 auto;
}

/* 图片在滚动流中自然占位,不再被裁 */
.card__content--revealed .card__image {
  flex: 0 0 auto;
  max-height: 42%;
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

/*
 * 深层卡片(第二张及以下)的内容淡化。
 *
 * 为什么只淡化内容而不是整卡:整卡 opacity 已经按深度递减(0.88/0.76),
 * 但深色文字依然能透过顶层卡片的半透明背景显出来,造成字与字重叠。
 * 这里把「文字/标签/图片」独立压暗 —— 卡片可见的浅色边缘还在,堆叠
 * 层次不丢,但第二张卡的字不会干扰第一张。
 *
 * 过渡时长与 CardStack 补位动画(DURATION.refill = 420ms)一致:
 * 当第二张卡补位成第一张时,.card--deep 被移除,文字在补位动画期间
 * 同步恢复全不透明,不会出现"字先亮、卡后到"的错位。
 */
.card--deep {
  --deep-content-alpha: 0.42;
}

.card__top,
.card__front,
.card__back,
.card__peek,
.card__empty,
.card__bottom,
.card__image {
  opacity: var(--deep-content-alpha, 1);
  transition: opacity 420ms cubic-bezier(0.16, 0.84, 0.22, 1);
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
