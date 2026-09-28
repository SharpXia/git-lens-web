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
 * @param {unknown} value - 待校验的标签 id
 */
function assertTabId(value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError('gitLensTabbar 的标签 id 必须是正整数');
  }
}

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
};

contextBridge.exposeInMainWorld('gitLensTabbar', Object.freeze(gitLensTabbar));
