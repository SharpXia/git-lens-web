/**
 * 更新控制器只负责用户确认与请求编排，安装包校验、架构选择和替换由 electron-updater 执行。
 * 依赖从主进程注入，测试可以覆盖安装边界而不修改真实应用或访问线上 Release。
 */

/**
 * 创建更新控制器。
 * @param {object} options - 主进程依赖
 * @param {object} options.updater - electron-updater 实例
 * @param {boolean} options.enabled - 仅正式签名的打包应用启用更新
 * @param {string} options.version - 当前应用版本
 * @param {(options: object) => Promise<{response: number}>} options.showMessageBox - 原生提示框
 * @param {() => Promise<void>} options.prepareInstall - 等待原生更新器校验安装包
 * @param {() => Promise<void>} options.beforeInstall - 安装前保存会话并关闭本地服务
 * @param {(message: string) => void} options.log - 主进程日志
 * @param {(status: string) => void} [options.onStatus] - 更新菜单状态
 * @returns {{checkForUpdates: (options?: {manual?: boolean}) => Promise<void>, scheduleInitialCheck: () => void, dispose: () => void}} 更新操作
 */
export function createUpdateController({ updater, enabled, version, showMessageBox, prepareInstall, beforeInstall, log, onStatus = () => {} }) {
  let operation = null;
  let manualCheck = false;
  let downloadedInfo = null;
  let downloadError = null;
  let disposed = false;
  let initialTimer = null;
  let intervalTimer = null;
  let installStarted = false;

  // 下载与重启都由用户确认；普通退出不会在用户不知情时替换应用。
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.logger = null;

  updater.on('download-progress', (progress) => {
    onStatus(`正在下载更新 ${Math.floor(progress.percent || 0)}%`);
  });
  updater.on('error', (err) => {
    downloadError = err;
    downloadedInfo = null;
    log(`应用更新失败：${err.message}`);
  });

  /** 已下载更新可以稍后从菜单再次进入，确认安装前先走本地服务退出协议。 */
  async function promptInstall() {
    if (!downloadedInfo || disposed || installStarted) return;
    const result = await showMessageBox({
      type: 'info',
      title: '更新已准备就绪',
      message: `Git Lens ${downloadedInfo.version} 已下载完成`,
      detail: '现在重启应用即可完成安装。',
      buttons: ['立即重启', '稍后重启'],
      defaultId: 0,
      cancelId: 1,
    });
    if (result.response !== 0 || disposed || !downloadedInfo || downloadError) return;
    installStarted = true;
    await beforeInstall();
    updater.quitAndInstall();
  }

  /** 一次操作包括检查、下载确认与安装确认，避免多次菜单点击叠加请求和弹窗。 */
  async function runCheck() {
    try {
      if (!enabled) {
        if (manualCheck) await showMessageBox({
          type: 'info',
          title: '检查更新',
          message: '当前运行方式不支持应用更新',
          detail: '开发运行与本机 ad-hoc 安装包不检查线上更新。请使用正式签名的 Git Lens 安装包。',
          buttons: ['确定'],
        });
        return;
      }
      if (downloadedInfo) {
        if (manualCheck) await promptInstall();
        return;
      }
      downloadError = null;
      onStatus('正在检查更新…');
      log('正在检查应用更新');
      const result = await updater.checkForUpdates();
      if (disposed) return;
      if (!result?.isUpdateAvailable) {
        if (manualCheck) await showMessageBox({
          type: 'info', title: '检查更新', message: '当前已是最新版本',
          detail: `Git Lens ${version} 已是最新版本。`, buttons: ['确定'],
        });
        return;
      }
      const info = result.updateInfo;
      const decision = await showMessageBox({
        type: 'info', title: '发现新版本', message: `Git Lens ${info.version} 已发布`,
        detail: `当前版本：${version}\n可以现在下载更新，下载完成后确认重启安装。`,
        buttons: ['下载更新', '稍后提醒'], defaultId: 0, cancelId: 1,
      });
      if (decision.response !== 0 || disposed) return;
      onStatus('正在下载更新…');
      await updater.downloadUpdate();
      // 原生 macOS 更新器先完成签名校验，确认可安装后才关闭当前应用的服务。
      onStatus('正在校验更新…');
      await prepareInstall();
      if (downloadError) throw downloadError;
      if (disposed) return;
      downloadedInfo = info;
      await promptInstall();
    } catch (err) {
      downloadedInfo = null;
      log(`应用更新操作失败：${err.message}`);
      if (!disposed && (manualCheck || downloadError)) await showMessageBox({
        type: 'error', title: '更新失败', message: '暂时无法完成应用更新',
        detail: `请稍后从「帮助 → 检查更新」重试。\n${err.message}`, buttons: ['确定'],
      });
    } finally {
      onStatus(downloadedInfo ? '重启并安装更新…' : '检查更新');
    }
  }

  /**
   * 发起更新检查；手动触发时，无更新或失败也展示反馈。
   * @param {{manual?: boolean}} [options] - 是否由菜单触发
   * @returns {Promise<void>} 本次更新交互结束后返回
   */
  function checkForUpdates({ manual = false } = {}) {
    if (disposed) return Promise.resolve();
    if (operation) {
      manualCheck ||= manual;
      return operation;
    }
    manualCheck = manual;
    operation = runCheck().finally(() => { operation = null; manualCheck = false; });
    return operation;
  }

  /** 启动后延迟检查，此后每 12 小时检查一次，长时间运行的应用也能发现发布。 */
  function scheduleInitialCheck() {
    if (!enabled || disposed || initialTimer || intervalTimer) return;
    initialTimer = setTimeout(() => { initialTimer = null; void checkForUpdates(); }, 8000);
    intervalTimer = setInterval(() => { void checkForUpdates(); }, 12 * 60 * 60 * 1000);
    initialTimer.unref?.();
    intervalTimer.unref?.();
  }

  /** 退出时清理计时器，在途请求完成后也不再弹框。 */
  function dispose() {
    disposed = true;
    clearTimeout(initialTimer);
    clearInterval(intervalTimer);
  }

  return { checkForUpdates, scheduleInitialCheck, dispose };
}

/**
 * 把已下载的 ZIP 交给 macOS 原生更新器，等待签名校验完成。
 * @param {import('electron').AutoUpdater} nativeUpdater - Electron 内置更新器
 * @returns {Promise<void>} 校验通过后返回，失败或超时拒绝
 */
export function prepareMacUpdate(nativeUpdater) {
  return new Promise((resolve, reject) => {
    const finish = (err) => {
      clearTimeout(timer);
      nativeUpdater.removeListener('update-downloaded', onReady);
      nativeUpdater.removeListener('error', onError);
      if (err) reject(err);
      else resolve();
    };
    const onReady = () => finish();
    const onError = (err) => finish(err);
    const timer = setTimeout(() => finish(new Error('更新安装包校验超时，请稍后重试')), 60000);
    nativeUpdater.once('update-downloaded', onReady);
    nativeUpdater.once('error', onError);
    try { nativeUpdater.checkForUpdates(); } catch (err) { finish(err); }
  });
}
