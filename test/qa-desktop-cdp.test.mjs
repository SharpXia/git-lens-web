import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildEvaluateSource,
  filterAppTargets,
  parseDevToolsActivePort
} from '../scripts/qa/desktop-shared.mjs';

test('DevToolsActivePort 解析：取首行调试端口，非法内容返回 null', () => {
  assert.equal(parseDevToolsActivePort('54321\n/devtools/browser/abc'), 54321, '首行为端口，其余行忽略');
  assert.equal(parseDevToolsActivePort(' 54321 \n'), 54321, '首尾空白容忍');
  assert.equal(parseDevToolsActivePort(''), null, '空内容非法');
  assert.equal(parseDevToolsActivePort('abc\n/devtools'), null, '非数字端口非法');
  assert.equal(parseDevToolsActivePort('0'), null, '0 非法（port 0 表示内核自选）');
  assert.equal(parseDevToolsActivePort('-3'), null, '负数非法');
  assert.equal(parseDevToolsActivePort(undefined), null, '非字符串非法');
});

test('evaluate 表达式构造：函数序列化 + JSON 实参，字符串按表达式原样求值', () => {
  const fn = (repoPath) => { window.selectRepo(repoPath); };
  assert.equal(
    buildEvaluateSource(fn, '/repos/repo-main'),
    '((repoPath) => { window.selectRepo(repoPath); })("/repos/repo-main")',
    '函数 + 实参：序列化后立即调用'
  );
  assert.equal(buildEvaluateSource(() => 1), '(() => 1)()', '无实参函数：空实参列表调用');
  assert.equal(buildEvaluateSource('document.readyState'), 'document.readyState', '字符串无实参：原样求值');
  assert.equal(
    buildEvaluateSource('window.selectRepo', '/repos/r'),
    '(window.selectRepo)("/repos/r")',
    '字符串 + 实参：包一层调用'
  );
});

test('应用目标过滤：只保留 URL 前缀匹配的 page 目标（排除 tabbar/空壳/非 page）', () => {
  const prefix = 'http://127.0.0.1:51000/';
  const targets = [
    { type: 'page', url: `${prefix}?repo=/repos/r`, id: 'app' },
    { type: 'page', url: prefix, id: 'app-root' },
    { type: 'page', url: 'file:///app/electron/tabbar.html', id: 'tabbar' },
    { type: 'page', url: '', id: 'shell' },
    { type: 'iframe', url: prefix, id: 'not-page' },
    { type: 'page', url: 'http://127.0.0.1:51999/', id: 'other-port' }
  ];
  const app = filterAppTargets(prefix, targets);
  assert.deepEqual(app.map((t) => t.id), ['app', 'app-root'], '仅同前缀 page 目标入选');
  assert.deepEqual(filterAppTargets(prefix, null), [], '空入参安全返回空数组');
});
