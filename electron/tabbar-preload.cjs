/**
 * Git Lens 桌面版标签条 preload（契约 §15：Shell 自有 chrome 的受控 API）。
 *
 * 运行环境与应用 preload 相同：sandbox: true + contextIsolation: true，
 * 因此只能是 CommonJS（仓库 package.json 为 "type": "module"，用 .cjs 强制）。
 *
 * 暴露且仅暴露 `window.gitLensTabbar`，全部通道使用 git-lens-tabbar: 前缀；
 * 入参在进入 IPC 前完成类型校验，主进程还会校验 sender 身份与参数。
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 校验回调参数为函数，失败时抛出中文类型错误。
 * @param {unknown} value - 待校验的值
 * @param {string} name - 参数名（用于错误提示）
 */
function assertFunction(value, name) {
  if (typeof value !== 'function') {
    throw new TypeError(`gitLensTabbar.${name} 的参数必须是函数`);
  }
}

/**
 * 校验标签 id 为正整数。
 * @param {unknown} value - 待校验的值
 */
function assertTabId(value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError('gitLensTabbar 的标签 id 必须是正整数');
  }
}

/** 更新进度的合法阶段（download 阶段必带 0-100 的 percent） */
const UPDATE_PHASES = ['download', 'verify', 'ready'];

const gitLensTabbar = {
  /**
   * 订阅标签集合变化（含当前激活态）。
   * @param {(state: {tabs: Array<{id: number, title: string, active: boolean}>, activeId: number|null}) => void} callback - 状态回调
   * @returns {() => void} 取消订阅函数
   */
  onTabsChanged(callback) {
    assertFunction(callback, 'onTabsChanged');
    // 先挂监听再请求订阅，保证不漏掉主进程立即回发的当前状态
    const listener = (_event, state) => {
      // 只把结构符合预期的状态交给页面，异常数据静默丢弃
      if (!state || !Array.isArray(state.tabs)) return;
      try {
        callback(state);
      } catch {
        // 页面回调异常不应影响 IPC 链路
      }
    };
    ipcRenderer.on('git-lens-tabbar:state-changed', listener);
    ipcRenderer.send('git-lens-tabbar:subscribe');
    return () => {
      ipcRenderer.removeListener('git-lens-tabbar:state-changed', listener);
    };
  },

  /**
   * 订阅窗口全屏态变化（契约 §17.1.1：主进程在进出全屏及标签条加载完成时推送）。
   * @param {(fullscreen: boolean) => void} callback - 全屏态回调（true=全屏中）
   * @returns {() => void} 取消订阅函数
   */
  onFullscreenChanged(callback) {
    assertFunction(callback, 'onFullscreenChanged');
    const listener = (_event, payload) => {
      // 只把全屏态为布尔的载荷交给页面，异常数据静默丢弃
      if (!payload || typeof payload.fullscreen !== 'boolean') return;
      try {
        callback(payload.fullscreen);
      } catch {
        // 页面回调异常不应影响 IPC 链路
      }
    };
    ipcRenderer.on('git-lens-tabbar:fullscreen-changed', listener);
    return () => {
      ipcRenderer.removeListener('git-lens-tabbar:fullscreen-changed', listener);
    };
  },

  /**
   * 订阅应用内更新进度（下载/校验/就绪；null 表示空闲，页面应隐藏进度展示）。
   * @param {(progress: {phase: 'download'|'verify'|'ready', percent?: number, transferred?: number, total?: number}|null) => void} callback - 进度回调
   * @returns {() => void} 取消订阅函数
   */
  onUpdateProgress(callback) {
    assertFunction(callback, 'onUpdateProgress');
    const listener = (_event, progress) => {
      // 只放行结构合法的载荷：空闲 null，或已知阶段且 download 必带 0-100 百分比
      const valid = progress === null || (
        UPDATE_PHASES.includes(progress?.phase)
        && (progress.phase !== 'download'
          || (Number.isFinite(progress.percent) && progress.percent >= 0 && progress.percent <= 100))
      );
      if (!valid) return;
      try {
        callback(progress);
      } catch {
        // 页面回调异常不应影响 IPC 链路
      }
    };
    ipcRenderer.on('git-lens-tabbar:update-progress', listener);
    return () => {
      ipcRenderer.removeListener('git-lens-tabbar:update-progress', listener);
    };
  },

  /** 请求新建标签（加载应用首页，契约 §15） */
  newTab() {
    ipcRenderer.send('git-lens-tabbar:new-tab');
  },

  /**
   * 请求关闭指定标签。
   * @param {number} id - 标签 id（来自 onTabsChanged 推送）
   */
  closeTab(id) {
    assertTabId(id);
    ipcRenderer.send('git-lens-tabbar:close-tab', id);
  },

  /**
   * 请求激活指定标签。
   * @param {number} id - 标签 id（来自 onTabsChanged 推送）
   */
  activateTab(id) {
    assertTabId(id);
    ipcRenderer.send('git-lens-tabbar:activate-tab', id);
  },

  /**
   * 请求将标签插入另一标签前，null 表示移到末尾。
   * @param {number} id - 被移动的标签 id
   * @param {number|null} beforeId - 插入位置右侧标签 id
   * @returns {void} 经 IPC 通知主进程，最终顺序由状态订阅回传
   */
  moveTab(id, beforeId) {
    assertTabId(id);
    if (beforeId !== null) assertTabId(beforeId);
    ipcRenderer.send('git-lens-tabbar:move-tab', id, beforeId);
  },
};

contextBridge.exposeInMainWorld('gitLensTabbar', Object.freeze(gitLensTabbar));
