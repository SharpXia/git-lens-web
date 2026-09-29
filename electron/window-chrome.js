/**
 * 窗口 chrome 融合选项（契约 §17）：按平台给出主窗口的融合标题栏参数。
 *
 * 独立纯模块（无 Electron 依赖）的原因：主进程 createMainWindow 与冒烟自验
 * （electron/checks/smoke.mjs）import 同一份定义断言逐字段取值，保证
 * 「实现」与「测试」不漂移（同 service-config-dir.js 的共用模式）。
 */

/** 顶部标签条固定高度（DIP，与 main.js 的 TABBAR_HEIGHT 同源语义：契约 §15/§17） */
export const TABBAR_HEIGHT_DIP = 38;

/**
 * 按平台返回主窗口 chrome 融合选项（契约 §17），展开进 BrowserWindow 构造参数。
 *  - darwin：hiddenInset 隐藏原生标题栏，红绿灯留在左上；trafficLightPosition
 *    使其在 38px 标签条内近似垂直居中（x=12 左留白、y=13 顶部偏移）；
 *  - win32/linux：titleBarOverlay 由系统绘制右上角窗口控制按钮，底色/前景色与
 *    标签条一致（#010409/#c9d1d9）、高度同标签条 38px。
 *    ⚠️ win32/linux 真机未验收（契约 §1 平台矩阵标注），以实机人工验证为准。
 * @param {string} platform - process.platform
 * @returns {Record<string, unknown>} 追加进 BrowserWindow 构造参数的 chrome 选项
 */
export function windowChromeOptions(platform) {
  if (platform === 'darwin') {
    return {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 12, y: 13 },
    };
  }
  return {
    titleBarOverlay: {
      color: '#010409',
      symbolColor: '#c9d1d9',
      height: TABBAR_HEIGHT_DIP,
    },
  };
}
