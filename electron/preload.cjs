/**
 * Git Lens Web 桌面版 preload 脚本。
 *
 * 运行环境：sandbox: true + contextIsolation: true（契约 §6）。
 * 沙箱化 preload 只能使用 CommonJS 且仅能 require 限定的 Electron 内置模块；
 * 因仓库 package.json 为 "type": "module"，这里使用 .cjs 扩展名强制按 CommonJS 解释。
 *
 * 只暴露契约 §6 冻结的 `window.gitLens`，不新增任何通道；
 * 所有入参在进入 IPC 前完成类型校验，主进程仍会二次校验。
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
    throw new TypeError(`gitLens.${name} 的参数必须是函数`);
  }
}

/**
 * 校验外部链接为 http/https 字符串。
 * @param {unknown} value - 待校验的值
 */
function assertHttpUrl(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) {
    throw new TypeError('gitLens.openExternal 仅支持 http/https 链接');
  }
}

const gitLens = {
  /** 页面据此判定桌面模式；浏览器模式下 window.gitLens 不存在 */
  isDesktop: true,

  /**
   * 读取运行时信息。
   * @returns {Promise<{appVersion: string, electronVersion: string, platform: string, arch: string, configDir: string, git: object}>}
   */
  getRuntimeInfo() {
    return ipcRenderer.invoke('git-lens:get-runtime-info');
  },

  /**
   * 打开原生目录选择对话框。
   * @returns {Promise<string|null>} 选择的目录绝对路径；取消返回 null
   */
  chooseDirectory() {
    return ipcRenderer.invoke('git-lens:choose-directory');
  },

  /**
   * 订阅本地服务状态变化。
   * @param {(state: 'ready'|'restarting'|'crashed'|'stopped') => void} callback - 状态回调
   * @returns {() => void} 取消订阅函数
   */
  onServiceState(callback) {
    assertFunction(callback, 'onServiceState');
    // 先挂监听再请求订阅，保证不漏掉主进程立即回发的当前状态
    const listener = (_event, state) => {
      try {
        callback(state);
      } catch {
        // 页面回调异常不应影响 IPC 链路，也不暴露到主进程
      }
    };
    ipcRenderer.on('git-lens:service-state', listener);
    ipcRenderer.send('git-lens:subscribe-service-state');
    return () => {
      ipcRenderer.removeListener('git-lens:service-state', listener);
    };
  },

  /**
   * 经主进程校验后用系统浏览器打开外部链接。
   * @param {string} url - 仅允许 http/https
   * @returns {Promise<void>}
   */
  openExternal(url) {
    assertHttpUrl(url);
    return ipcRenderer.invoke('git-lens:open-external', url);
  },
};

contextBridge.exposeInMainWorld('gitLens', Object.freeze(gitLens));
