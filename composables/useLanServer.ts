/**
 * 局域网 Web 服务桥接层。
 *
 * 职责:
 * - 向原生插件 LocalServer 注册 'request' 监听,把每个 HTTP 请求交给
 *   lib/lan-api 的路由层处理,再把响应回填给原生层(respond)
 * - 提供 start / stop / 状态,端口偏好持久化在 localStorage
 *
 * Web / 测试环境:原生插件不存在,start() 返回失败,界面提示"仅原生可用"。
 */
import { ref } from 'vue'
import { handleLanRequest, type LanApiDeps } from '~/lib/lan-api'
import { useCardRepository } from '~/lib/db'
import { useAIConfigState, useCollections } from '~/composables/useAppState'
import { useCheckinState } from '~/composables/useCheckinState'
import { getFullscreenPreference, setFullscreenPreference, isNativePlatform } from '~/composables/useNativeBridge'
import { APP_VERSION } from '~/lib/update'
import {
  readAIConfigFromStorage,
  readActiveCollectionFromStorage,
  readCheckinConfigFromStorage,
} from '~/lib/lan-config'

/** 端口持久化键。 */
export const LAN_PORT_KEY = 'abdrop.lan.port'

export function useLanServer() {
  const repo = useCardRepository()
  const { save: saveAIConfig } = useAIConfigState()
  const { select } = useCollections()
  const checkin = useCheckinState()

  /** 是否正在运行(以原生返回为准)。 */
  const running = ref(false)
  /** 局域网访问地址。 */
  const url = ref('')
  /** 错误信息(启动失败等)。 */
  const error = ref('')
  /** 端口输入(默认 8080)。 */
  const port = ref(8080)

  /** 读取持久化的端口偏好。 */
  function loadPort() {
    try {
      const saved = window.localStorage.getItem(LAN_PORT_KEY)
      const n = saved ? parseInt(saved, 10) : 8080
      if (Number.isFinite(n) && n > 0 && n <= 65535) port.value = n
    } catch {
      /* 隐私模式忽略 */
    }
  }

  /** 保存端口偏好。 */
  function savePort() {
    try {
      window.localStorage.setItem(LAN_PORT_KEY, String(port.value))
    } catch {
      /* 忽略 */
    }
  }

  /** 组装路由层依赖(全部指向真实仓库与配置)。 */
  function buildDeps(): LanApiDeps {
    return {
      repo,
      version: APP_VERSION,
      // 配置一律读持久化存储(localStorage),而非内存 state:
      // Web 服务请求到来时 App 可能处于"从未打开设置页"的状态,内存里只有默认值;
      // localStorage 才是软件配置真正的落盘处,保证网页看到的 = 软件里存的。
      getAIConfig: () => Promise.resolve(readAIConfigFromStorage()),
      saveAIConfig: (cfg) => saveAIConfig(cfg),
      getActiveCollectionId: () => Promise.resolve(readActiveCollectionFromStorage()),
      setActiveCollectionId: async (id) => {
        select(id)
      },
      getCheckinConfig: () => Promise.resolve(readCheckinConfigFromStorage()),
      saveCheckinConfig: (cfg) => checkin.updateConfig(cfg),
      getFullscreenPreference,
      setFullscreenPreference,
    }
  }

  /** 注册原生请求监听(幂等)。 */
  async function attachListener(): Promise<void> {
    if (!isNativePlatform()) return
    try {
      const plugin = (window as any).Capacitor?.Plugins?.LocalServer
      if (!plugin) return
      await plugin.addListener('request', async (data: { requestId: string; method: string; path: string; body: string }) => {
        const resp = await handleLanRequest(
          data.method,
          data.path,
          data.body ?? '',
          buildDeps(),
        )
        await plugin.respond({
          requestId: data.requestId,
          status: resp.status,
          contentType: resp.contentType,
          body: resp.body,
        })
      })
    } catch {
      /* 原生插件缺失:仅 Web 预览,忽略 */
    }
  }

  /** 启动服务。 */
  async function start(): Promise<boolean> {
    error.value = ''
    if (!isNativePlatform()) {
      error.value = '仅原生 App 内可用(网页预览无此能力)'
      return false
    }
    savePort()
    try {
      const plugin = (window as any).Capacitor?.Plugins?.LocalServer
      if (!plugin) {
        error.value = '原生插件未注册'
        return false
      }
      const res = await plugin.start({ port: port.value })
      running.value = Boolean(res?.running)
      url.value = res?.url ?? ''
      if (!running.value) error.value = '启动失败'
      return running.value
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
      return false
    }
  }

  /** 停止服务。 */
  async function stop(): Promise<void> {
    if (!isNativePlatform()) return
    try {
      const plugin = (window as any).Capacitor?.Plugins?.LocalServer
      await plugin?.stop({})
    } catch {
      /* 忽略 */
    }
    running.value = false
    url.value = ''
  }

  return {
    running,
    url,
    error,
    port,
    loadPort,
    start,
    stop,
    attachListener,
  }
}
