import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createUpdateController } from '../electron/update-manager.js';

class FakeUpdater extends EventEmitter {
  constructor(result) {
    super();
    this.result = result;
    this.checks = 0;
    this.downloads = 0;
    this.installs = 0;
    this.autoDownload = null;
    this.autoInstallOnAppQuit = null;
    this.allowPrerelease = null;
    this.allowDowngrade = null;
    this.logger = undefined;
  }

  async checkForUpdates() {
    this.checks += 1;
    return this.result;
  }

  async downloadUpdate() {
    this.downloads += 1;
  }

  quitAndInstall() {
    this.installs += 1;
  }
}

test('更新控制器：开发运行不访问 updater，手动检查给出明确提示', async () => {
  const updater = new FakeUpdater(null);
  const messages = [];
  const controller = createUpdateController({
    updater,
    enabled: false,
    version: '1.0.1',
    showMessageBox: async (options) => { messages.push(options); return { response: 0 }; },
    prepareInstall: async () => {},
    beforeInstall: async () => {},
    log: () => {},
  });
  await controller.checkForUpdates({ manual: true });
  assert.equal(updater.checks, 0);
  assert.equal(messages.length, 1);
  assert.match(messages[0].detail, /正式签名/);
  controller.dispose();
});

test('更新控制器：同一时间只检查一次，下载后确认并走服务退出再安装', async () => {
  const updater = new FakeUpdater({ isUpdateAvailable: true, updateInfo: { version: '1.0.2' } });
  const messages = [];
  const steps = [];
  const controller = createUpdateController({
    updater,
    enabled: true,
    version: '1.0.1',
    showMessageBox: async (options) => {
      messages.push(options);
      return { response: 0 };
    },
    prepareInstall: async () => { steps.push('prepare'); },
    beforeInstall: async () => { steps.push('before-install'); },
    log: () => {},
  });
  await Promise.all([controller.checkForUpdates({ manual: true }), controller.checkForUpdates()]);
  assert.equal(updater.checks, 1);
  assert.equal(updater.downloads, 1);
  assert.equal(updater.installs, 1);
  assert.deepEqual(steps, ['prepare', 'before-install']);
  assert.equal(messages.length, 2);
  controller.dispose();
});

test('更新控制器：无更新的手动检查显示当前版本', async () => {
  const updater = new FakeUpdater({ isUpdateAvailable: false, updateInfo: { version: '1.0.1' } });
  const messages = [];
  const controller = createUpdateController({
    updater,
    enabled: true,
    version: '1.0.1',
    showMessageBox: async (options) => { messages.push(options); return { response: 0 }; },
    prepareInstall: async () => {},
    beforeInstall: async () => {},
    log: () => {},
  });
  await controller.checkForUpdates({ manual: true });
  assert.equal(updater.downloads, 0);
  assert.match(messages[0].message, /最新版本/);
  controller.dispose();
});

test('更新控制器：下载进度、校验与就绪阶段经 onProgress 结构化推送', async () => {
  const updater = new FakeUpdater({ isUpdateAvailable: true, updateInfo: { version: '1.1.0' } });
  const progressEvents = [];
  const controller = createUpdateController({
    updater,
    enabled: true,
    version: '1.0.1',
    showMessageBox: async () => ({ response: 0 }),
    prepareInstall: async () => {},
    beforeInstall: async () => {},
    log: () => {},
    onProgress: (progress) => progressEvents.push(progress),
  });
  // 模拟真实时序：下载期间原生 updater 持续回报进度事件
  updater.downloadUpdate = async () => {
    updater.emit('download-progress', { percent: 42.5, transferred: 425, total: 1000 });
    updater.emit('download-progress', { percent: 100, transferred: 1000, total: 1000 });
  };
  await controller.checkForUpdates({ manual: true });
  assert.deepEqual(progressEvents[0], { phase: 'download', percent: 42, transferred: 425, total: 1000 });
  assert.deepEqual(progressEvents[1], { phase: 'download', percent: 100, transferred: 1000, total: 1000 });
  assert.deepEqual(progressEvents[2], { phase: 'verify' });
  assert.deepEqual(progressEvents[3], { phase: 'ready' });
  controller.dispose();
});

test('更新控制器：更新失败时进度最终清空为 null', async () => {
  const updater = new FakeUpdater({ isUpdateAvailable: true, updateInfo: { version: '1.1.0' } });
  const messages = [];
  const progressEvents = [];
  const controller = createUpdateController({
    updater,
    enabled: true,
    version: '1.0.1',
    showMessageBox: async (options) => { messages.push(options); return { response: 0 }; },
    prepareInstall: async () => {},
    beforeInstall: async () => {},
    log: () => {},
    onProgress: (progress) => progressEvents.push(progress),
  });
  updater.downloadUpdate = async () => {
    updater.emit('download-progress', { percent: 30, transferred: 300, total: 1000 });
    throw new Error('网络中断');
  };
  await controller.checkForUpdates({ manual: true });
  assert.deepEqual(progressEvents[0], { phase: 'download', percent: 30, transferred: 300, total: 1000 });
  assert.equal(progressEvents[progressEvents.length - 1], null);
  assert.equal(messages.at(-1).title, '更新失败');
  assert.match(messages.at(-1).detail, /网络中断/);
  controller.dispose();
});
