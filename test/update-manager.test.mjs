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
