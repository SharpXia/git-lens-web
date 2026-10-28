// Git Lens Web 页面主脚本。
// 自 G3 起从 index.html 内联 <script> 机械外置（CSP script-src 'self' 禁止内联脚本，契约 §14）。
// 迁移保持逐字节原样（含缩进与模板字符串内容），执行位置仍在 body 末尾、抽屉 DOM 之前，时序等价。
    let allRepos = [];
    let currentRepo = '';
    let currentWorktrees = [];
    let currentBranches = [];
    let currentMainBranch = '';
    let searchKeyword = '';
    let repoFilterKeyword = '';
    let filterStarredOnly = false;
    const repoPickerState = { open: false, visible: [], rowEls: [], highlight: -1 };
    let activeTab = 'overview';

    // Diff 状态持久化跟踪与恢复
    let currentDiffType = null; // 'worktree' | 'uncommitted' | null
    let currentUncommittedPath = '';
    let currentDiffBase = '';
    let currentDiffTarget = '';
    let currentDiffMode = null; // 'uncommitted' | 'all' | 'committed'
    let currentDiffComparison = null;
    let pendingRestoreState = null;
    let isRestoringHistory = false;
    let historyRestoreQueue = Promise.resolve();
    let scanDirectoryConfig = { customDirectories: [] };
    let scanDirectoryDraft = [];
    let worktreeRemoveRequest = null;

    // 桌面运行时判定：Electron Shell 经 preload 注入 window.gitLens（契约 §6）。
    // 浏览器模式无该全局，isDesktop 恒为 false，所有桌面分支均不生效、行为保持零变化。
    const isDesktop = Boolean(window.gitLens && window.gitLens.isDesktop);

    // ---- 主题系统（feat/theme-switcher）----
    // 预设主题 id 与展示名（顺序即下拉顺序；linear 为 :root 默认令牌，无需覆盖块）。
    // 选择持久化在 localStorage；桌面模式经 gitLens.setTheme 同步给原生标签条换肤。
    const THEME_OPTIONS = [
      ['glass', '液态玻璃（Apple 风 · 浅/深）'],
      ['linear', 'Linear（靛蓝工程）'],
      ['raycast', 'Raycast（余烬渐变）'],
      ['supabase', 'Supabase（翡翠石墨）'],
      ['discord', 'Discord（模糊紫）'],
      ['stripe', 'Stripe（雾紫 · 浅）'],
      ['perplexity', 'Perplexity（青瓷 · 浅）'],
      ['warm-clay', '暖陶奶油（浅）'],
      ['notion', 'Notion（暖纸 · 浅）'],
      ['macos', 'macOS（原生 · 浅）'],
      ['terminal', '终端 TUI（荧光绿）'],
      ['custom', '自定义…'],
    ];
    const THEME_STORAGE_KEY = 'gl-theme';
    const THEME_CUSTOM_STORAGE_KEY = 'gl-theme-custom';
    const THEME_CUSTOM_DEFAULTS = { mode: 'dark', accent: '#5e6ad2', radius: 'soft' };

    // 双态主题：预设 id → [亮色内部 id, 深色内部 id]；单态主题内部 id 即预设 id
    const DUAL_MODE_THEMES = {
      glass: ['glass-light', 'glass-dark'],
      macos: ['macos', 'macos-dark'],
      notion: ['notion', 'notion-dark'],
    };
    // 旧版把玻璃昼/夜当两个预设存储，启动时迁移到合并后的预设
    const LEGACY_THEME_MAP = { 'glass-light': 'glass', 'glass-dark': 'glass' };

    // 亮/深偏好：light / dark / system（跟随系统）
    const MODE_PREF_KEY = 'gl-theme-mode';
    const MODE_PREFS = ['light', 'dark', 'system'];
    const mediaDark = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null;

    /**
     * 读取亮/深偏好；存储缺失或非法时回落跟随系统。
     * @returns {'light'|'dark'|'system'} 偏好
     */
    function readModePref() {
      try {
        const stored = localStorage.getItem(MODE_PREF_KEY);
        if (MODE_PREFS.includes(stored)) return stored;
      } catch {
        // 存储不可用时按跟随系统处理
      }
      return 'system';
    }

    /**
     * 把偏好解析为实际模式；跟随系统时读取系统深色设置。
     * @param {'light'|'dark'|'system'} pref - 偏好
     * @returns {'light'|'dark'} 实际模式
     */
    function resolveModePref(pref) {
      return pref === 'system' ? (mediaDark && mediaDark.matches ? 'dark' : 'light') : pref;
    }

    /**
     * 由预设 + 偏好解析内部主题 id（双态主题按模式取变体，单态主题原样）。
     * @param {string} preset - 预设 id
     * @param {'light'|'dark'|'system'} pref - 偏好
     * @returns {string} 内部主题 id（对应 CSS 的 data-theme 值）
     */
    function resolveInternalTheme(preset, pref) {
      const dual = DUAL_MODE_THEMES[preset];
      if (!dual) return preset;
      return resolveModePref(pref) === 'dark' ? dual[1] : dual[0];
    }

    /**
     * 计算强调色相对亮度，决定主按钮文字用深还是浅。
     * @param {string} hex - #rrggbb 颜色
     * @returns {boolean} 是否偏亮
     */
    function isThemeAccentLight(hex) {
      const channel = (text) => {
        const value = parseInt(text, 16) / 255;
        return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
      };
      const luminance = 0.2126 * channel(hex.slice(1, 3))
        + 0.7152 * channel(hex.slice(3, 5))
        + 0.0722 * channel(hex.slice(5, 7));
      return luminance > 0.45;
    }

    /**
     * 读取自定义主题配置；存储缺失或字段非法时逐项回落默认值。
     * @returns {{mode: string, accent: string, radius: string}} 合法配置
     */
    function readThemeCustomConfig() {
      const config = { ...THEME_CUSTOM_DEFAULTS };
      try {
        const stored = JSON.parse(localStorage.getItem(THEME_CUSTOM_STORAGE_KEY) || '{}');
        if (typeof stored === 'object' && stored) {
          if (stored.mode === 'light' || stored.mode === 'dark') config.mode = stored.mode;
          if (typeof stored.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(stored.accent)) config.accent = stored.accent;
          if (['soft', 'sharp', 'round'].includes(stored.radius)) config.radius = stored.radius;
        }
      } catch {
        // 存储损坏时按默认配置处理
      }
      return config;
    }

    /**
     * 把自定义主题配置写入根元素（data-* 驱动 CSS 块，变量驱动强调色）。
     * @param {{mode: string, accent: string, radius: string}} config - 自定义配置
     */
    function applyThemeCustomVars(config) {
      const root = document.documentElement;
      root.dataset.customMode = config.mode;
      root.dataset.customRadius = config.radius;
      root.style.setProperty('--custom-accent', config.accent);
      // 主按钮文字颜色按强调色亮度自动取黑/白，避免浅色强调色上白字不可读
      root.style.setProperty('--custom-on-accent', isThemeAccentLight(config.accent) ? '#16161a' : '#ffffff');
    }

    /**
     * 把主题同步给原生标签条（红绿灯底色随主题）；浏览器模式无 gitLens 静默跳过。
     * @param {{preset: string, mode?: string, accent?: string}} config - 主题配置
     * @param {string} internalId - 内部主题 id（双态主题已按模式解析）
     */
    function pushThemeToShell(config, internalId) {
      if (!isDesktop || typeof window.gitLens?.setTheme !== 'function') return;
      const payload = config.preset === 'custom'
        ? { theme: 'custom', mode: config.mode, accent: config.accent }
        : { theme: internalId };
      try {
        window.gitLens.setTheme(payload);
      } catch (err) {
        console.warn('主题同步失败:', err && err.message);
      }
    }

    /**
     * 应用主题配置：按偏好解析内部主题并切换 data-theme，可选持久化预设。
     * @param {{preset: string, mode?: string, accent?: string, radius?: string}} config - 主题配置
     * @param {boolean} persist - 是否写入 localStorage
     */
    function applyThemeConfig(config, persist) {
      const modePref = readModePref();
      const internalId = resolveInternalTheme(config.preset, modePref);
      // 切主题瞬间禁用全局过渡：整页逐元素渐变会显得浑浊，且后台窗口下过渡时钟
      // 被节流会出现长时间停留在旧配色的观感
      const root = document.documentElement;
      root.classList.add('gl-theme-switching');
      root.dataset.theme = internalId;
      if (config.preset === 'custom') {
        const custom = {
          mode: config.mode || 'dark',
          accent: config.accent || THEME_CUSTOM_DEFAULTS.accent,
          radius: config.radius || 'soft',
        };
        applyThemeCustomVars(custom);
        if (persist) localStorage.setItem(THEME_CUSTOM_STORAGE_KEY, JSON.stringify(custom));
      }
      if (persist) localStorage.setItem(THEME_STORAGE_KEY, config.preset);
      // 程序化应用（启动恢复/自定义弹层实时预览）也要回写切换器显示，避免下拉框与实际主题脱节
      const select = document.getElementById('themeSelect');
      if (select && select.value !== config.preset) select.value = config.preset;
      const customBtn = document.getElementById('themeCustomBtn');
      if (customBtn) customBtn.style.display = config.preset === 'custom' ? '' : 'none';
      pushThemeToShell(config, internalId);
      // 过渡禁用只需覆盖本次重排的一帧，下一拍恢复常规过渡（hover 等）
      setTimeout(() => root.classList.remove('gl-theme-switching'), 80);
    }

    /**
     * 读取本地存储的主题预设；id 非法时回落 linear（旧版玻璃昼/夜迁移为合并预设）。
     * @returns {{preset: string, mode?: string, accent?: string, radius?: string}} 主题配置
     */
    function loadThemeConfig() {
      let preset = 'linear';
      try {
        let stored = localStorage.getItem(THEME_STORAGE_KEY);
        if (LEGACY_THEME_MAP[stored]) stored = LEGACY_THEME_MAP[stored];
        if (THEME_OPTIONS.some(([id]) => id === stored)) preset = stored;
      } catch {
        // 存储不可用时按默认主题处理
      }
      const config = { preset };
      if (preset === 'custom') Object.assign(config, readThemeCustomConfig());
      return config;
    }

    /**
     * 初始化主题切换器：填充下拉、恢复上次选择、挂接切换与自定义弹层事件。
     */
    function initThemeSwitcher() {
      const select = document.getElementById('themeSelect');
      const customBtn = document.getElementById('themeCustomBtn');
      const modal = document.getElementById('themeCustomModal');
      if (!select || !customBtn || !modal) return;

      for (const [id, label] of THEME_OPTIONS) {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = label;
        select.appendChild(option);
      }
      const current = loadThemeConfig();
      select.value = current.preset;
      customBtn.style.display = current.preset === 'custom' ? '' : 'none';

      select.addEventListener('change', () => {
        const presetId = select.value;
        if (presetId === 'custom') {
          const custom = readThemeCustomConfig();
          applyThemeConfig({ preset: 'custom', ...custom }, true);
          customBtn.style.display = '';
          modal.style.display = '';
          syncThemeCustomModal(custom);
          return;
        }
        customBtn.style.display = 'none';
        applyThemeConfig({ preset: presetId }, true);
      });

      customBtn.addEventListener('click', () => {
        modal.style.display = '';
        syncThemeCustomModal(readThemeCustomConfig());
      });

      const modeGroup = document.getElementById('themeCustomModeGroup');
      const accentInput = document.getElementById('themeCustomAccent');
      const accentValue = document.getElementById('themeCustomAccentValue');
      const radiusSelect = document.getElementById('themeCustomRadius');

      /**
       * 把配置回填到弹层控件；改动即时生效并持久化（实时换肤）。
       * @param {{mode: string, accent: string, radius: string}} config - 自定义配置
       */
      function syncThemeCustomModal(config) {
        for (const btn of modeGroup.querySelectorAll('.diff-mode-btn')) {
          btn.classList.toggle('active', btn.dataset.mode === config.mode);
        }
        accentInput.value = config.accent;
        accentValue.textContent = config.accent;
        radiusSelect.value = config.radius;
      }

      /**
       * 收集弹层当前配置并应用 + 持久化。
       */
      function applyCustomFromModal() {
        const activeMode = modeGroup.querySelector('.diff-mode-btn.active');
        const config = {
          mode: activeMode ? activeMode.dataset.mode : 'dark',
          accent: accentInput.value,
          radius: radiusSelect.value,
        };
        applyThemeConfig({ preset: 'custom', ...config }, true);
      }

      modeGroup.addEventListener('click', (event) => {
        const btn = event.target.closest('[data-action="theme-custom-mode"]');
        if (!btn) return;
        for (const item of modeGroup.querySelectorAll('.diff-mode-btn')) {
          item.classList.toggle('active', item === btn);
        }
        applyCustomFromModal();
      });
      accentInput.addEventListener('input', () => {
        accentValue.textContent = accentInput.value;
        applyCustomFromModal();
      });
      radiusSelect.addEventListener('change', applyCustomFromModal);

      // 恢复默认：配置回到默认值并即时生效
      document.getElementById('themeCustomResetBtn').addEventListener('click', () => {
        const defaults = { ...THEME_CUSTOM_DEFAULTS };
        applyThemeConfig({ preset: 'custom', ...defaults }, true);
        syncThemeCustomModal(defaults);
      });
      for (const btn of modal.querySelectorAll('[data-action="close-theme-custom"]')) {
        btn.addEventListener('click', () => { modal.style.display = 'none'; });
      }
      modal.addEventListener('click', (event) => {
        if (event.target === modal) modal.style.display = 'none';
      });
    }

    /**
     * 初始化亮/深三态按钮：点击在亮色 → 深色 → 跟随系统间循环，图标与提示同步。
     */
    function initThemeModeButton() {
      const btn = document.getElementById('themeModeBtn');
      if (!btn) return;
      const render = (pref) => {
        for (const icon of btn.querySelectorAll('[data-mode-icon]')) {
          icon.hidden = icon.dataset.modeIcon !== pref;
        }
        const resolved = resolveModePref(pref);
        const label = pref === 'system'
          ? `跟随系统（当前${resolved === 'dark' ? '深色' : '亮色'}）`
          : (pref === 'light' ? '亮色模式' : '深色模式');
        btn.title = label;
        btn.setAttribute('aria-label', label);
      };
      const pref = readModePref();
      render(pref);
      btn.addEventListener('click', () => {
        const next = MODE_PREFS[(MODE_PREFS.indexOf(readModePref()) + 1) % MODE_PREFS.length];
        try {
          localStorage.setItem(MODE_PREF_KEY, next);
        } catch {
          // 存储不可用时偏好仅在本次会话生效
        }
        render(next);
        applyThemeConfig(loadThemeConfig(), false);
      });
      // 跟随系统时监听系统深色切换，双态主题实时换边
      if (mediaDark && typeof mediaDark.addEventListener === 'function') {
        mediaDark.addEventListener('change', () => {
          if (readModePref() !== 'system') return;
          applyThemeConfig(loadThemeConfig(), false);
        });
      }
    }

    // 启动即恢复上次主题（persist=false：仅应用，不重复写存储），再挂切换器与三态按钮
    applyThemeConfig(loadThemeConfig(), false);
    initThemeSwitcher();
    initThemeModeButton();

    const TAB_TITLE_LABELS = {
      overview: '仓库总览',
      diff: '差异对比',
      mr: 'Merge Request',
      remote: '远端分支'
    };
    /**
     * 取出仓库的展示名称；扫描列表尚未完成时回退到路径末级目录。
     */
    function getCurrentRepoIdentity() {
      const repo = allRepos.find(item => item.path === currentRepo);
      if (repo) return repo;
      const parts = String(currentRepo || '').split(/[\\/]/).filter(Boolean);
      return currentRepo ? { name: parts[parts.length - 1] || 'Git Lens', group: '', path: currentRepo } : null;
    }

    /**
     * 只有同名仓库同时出现在扫描结果中时，标题才补充分组，避免标题过长。
     */
    function getCurrentRepoTitleName(repo) {
      if (!repo) return 'Git Lens';
      const sameNameCount = allRepos.filter(item => item.name === repo.name).length;
      return sameNameCount > 1 && repo.group ? `${repo.group}/${repo.name}` : repo.name;
    }

    /**
     * 返回统一的浅色 App icon，浏览器和 Electron 使用同一份品牌资产。
     */
    function buildProjectFavicon(repo) {
      return '/assets/git-lens-icon-light.png';
    }

    /**
     * 同步浏览器 tab 的标题和图标，确保切换仓库或功能页后仍能快速定位。
     */
    function updateDocumentIdentity() {
      const repo = getCurrentRepoIdentity();
      const titleName = getCurrentRepoTitleName(repo);
      const tabLabel = TAB_TITLE_LABELS[activeTab] || TAB_TITLE_LABELS.overview;
      document.title = repo ? `${titleName} · ${tabLabel} | Git Lens` : `Git Lens · ${tabLabel}`;
      const favicon = document.getElementById('appFavicon');
      if (favicon) favicon.href = buildProjectFavicon(repo);
    }

    // 可搜索 Diff 选择器实例与请求防竞态计数
    let diffBasePicker = null;
    let diffTargetPicker = null;
    const searchablePickers = []; // 所有可搜索选择器实例，用于统一「点击外部关闭」
    let diffRequestSeq = 0; // Diff 请求序列：仅最后一次请求的响应可上屏，丢弃过期响应
    let diffToolbarResizeObserver = null;
    const diffFindState = { open: false, query: '', matches: [], index: -1 };

    // 本地 Merge Request 状态
    let mrStatusFilter = 'all';  // MR 面板状态筛选：all | open | merged | rejected | canceled
    let mergeRequestsCache = []; // 最近一次成功拉取的 MR 列表
    let mrListReqSeq = 0;        // MR 列表请求序列防竞态
    let mrDetailReqSeq = 0;      // MR 详情请求序列防竞态
    let mrCommitsReqSeq = 0;     // MR 提交列表请求序列防竞态
    // 当前 MR 的四方判定结果 Promise（loadMrAheadBehind 产出）：
    // 提交列表渲染前等待它，用于在内容被目标吸收时附加事实说明
    let mrAheadBehindReady = Promise.resolve(null);
    let mrDrawerState = { isOpen: false, id: null }; // MR 详情抽屉状态（id 统一为字符串）
    let currentMrDetail = null;  // 抽屉当前展示的 MR 记录
    let createMrSourcePicker = null;
    let createMrTargetPicker = null;

    // 分支管理状态：目标工作区、本地/远端分支清单、请求防竞态与冲突编辑抽屉
    const remoteState = {
      targetWorktree: '',        // 目标工作区绝对路径（默认主工作区）
      branches: [],              // 最近一次拉取的远端分支清单
      localBranches: [],         // 最近一次拉取的本地分支清单
      localBranchesReqSeq: 0,
      lastFetchAt: null,         // 仓库级最近一次 fetch 时间（ISO，来自 /api/remote-branches）
      branchesReqSeq: 0,
      mergeState: null,          // 最近一次 /api/merge-state 响应
      mergeStateReqSeq: 0,
      checkoutModalBranch: null, // 检出弹层当前来源远端分支对象
      checkoutLocalModalBranch: null, // 本地分支检出弹层当前分支名
      createRemoteModalBranch: null, // 建远端分支弹层当前基准分支对象
      localBranchSort: 'recent',   // 本地分支列表排序口径（recent/name/ahead）
      remoteBranchSort: 'recent',  // 远端分支列表排序口径（recent/name/ahead）
      editingConflictPath: '',   // 冲突编辑抽屉当前文件（空串表示未打开）
      editWorktreePath: ''       // 编辑 Worktree 信息弹层的目标路径（空串表示未打开）
    };
    let switchBranchPicker = null; // 切换分支弹层的可搜索选择器

    // 自动刷新远端：频率档位与 localStorage 键；定时器在远端 Tab 激活时静默 fetch
    const REMOTE_AUTO_FETCH_STORAGE_KEY = 'git_lens_remote_auto_fetch';
    const REMOTE_AUTO_FETCH_INTERVALS = { '30s': 30 * 1000, '10m': 10 * 60 * 1000, '1h': 60 * 60 * 1000 };
    let remoteAutoFetchTimer = null;
    let remoteAutoFetching = false;

    // 合并前的新鲜度阈值：距上次 fetch 超过该时长时提示先刷新
    const REMOTE_FETCH_STALE_MS = 10 * 60 * 1000;

    /* 创建 Worktree 弹层状态：分支来源模式（existing=检出已有分支 / new=以起点新建分支） */
    let createWtBranchMode = 'existing';
    let worktreeCreateSubmitSeq = 0;
    // 目录/名称字段是否被用户手动改过：改过则分支切换时不再覆盖默认值
    let createWtDirTouched = false;
    let createWtNameTouched = false;

    function selectDiffMode(mode) {
      if (mode === currentDiffMode) return;
      currentDiffMode = mode;
      fetchAndRenderRefDiff(mode, true, true);
    }

    // 星标唯一事实源是服务端 <configDir>/stars.json（契约 §16，桌面随机端口不再丢星标）。
    // STARRED_STORAGE_KEY 是旧版 localStorage 键，仅保留用于一次性迁移，不再读写星标本身。
    const STARRED_STORAGE_KEY = 'git_lens_starred_repos';
    let starredReposCache = [];

    /**
     * 读取旧版 localStorage 星标数据（仅迁移用）；结构异常时按空列表处理。
     * @returns {string[]} 旧星标仓库路径列表
     */
    function readLegacyStarredRepos() {
      try {
        const parsed = JSON.parse(localStorage.getItem(STARRED_STORAGE_KEY) || 'null');
        return Array.isArray(parsed) ? parsed.filter(p => typeof p === 'string' && p) : [];
      } catch {
        return [];
      }
    }

    /**
     * 调用星标单项切换接口；服务端返回非 ok 时抛错供上层回滚与提示。
     * @param {string} repoPath - 仓库路径
     * @param {boolean} starred - true 加星、false 取消
     * @returns {Promise<{ok: true, starred: string[]}>}
     */
    async function postStar(repoPath, starred) {
      const res = await fetch('/api/stars', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoPath, starred })
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || '保存星标失败');
      return data;
    }

    /**
     * 从服务端拉取星标到内存缓存，并执行旧数据的一次性迁移（契约 §16）：
     * 仅当服务端为空且 localStorage 有旧数据时导入（逐条 POST，幂等去重）；
     * 全部成功才清除旧键，任一条失败静默保留 localStorage 待下次再试。
     */
    async function loadStarredRepos() {
      let serverStars = null;
      try {
        const res = await fetch('/api/stars');
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || '读取星标失败');
        if (Array.isArray(data.starred)) serverStars = data.starred;
      } catch (err) {
        // 服务不可达时保持缓存现状（通常随后 /api/projects 也会失败并进入错误态）
        console.warn('读取星标失败:', err.message);
        return;
      }

      if (serverStars.length === 0) {
        const legacy = readLegacyStarredRepos();
        if (legacy.length > 0) {
          let allImported = true;
          let latest = serverStars;
          for (const repoPath of legacy) {
            try {
              const data = await postStar(repoPath, true);
              latest = Array.isArray(data.starred) ? data.starred : latest;
            } catch (err) {
              // 导入失败不打断页面：静默保留 localStorage，下次加载再试
              allImported = false;
              console.warn('迁移旧星标失败:', err.message);
            }
          }
          if (allImported) {
            try { localStorage.removeItem(STARRED_STORAGE_KEY); } catch { /* 隐私模式等场景忽略 */ }
            starredReposCache = latest;
            return;
          }
        }
      }
      starredReposCache = serverStars;
    }

    /**
     * 取当前星标列表（内存缓存，由 loadStarredRepos/toggleStarRepo 维护）。
     * @returns {string[]}
     */
    function getStarredRepos() {
      return starredReposCache;
    }

    function isRepoStarred(repoPath) {
      return starredReposCache.includes(repoPath);
    }

    function toggleStarRepo(repoPath, e) {
      if (e) e.stopPropagation();
      // 乐观更新：先改本地缓存并重绘，再异步同步服务端；失败回滚缓存并按既有风格提示
      const wasStarred = starredReposCache.includes(repoPath);
      const previous = [...starredReposCache];
      starredReposCache = wasStarred
        ? starredReposCache.filter(p => p !== repoPath)
        : [...starredReposCache, repoPath];
      renderRepoDropdownList();
      updateRepoTriggerText();
      postStar(repoPath, !wasStarred).catch(err => {
        starredReposCache = previous;
        renderRepoDropdownList();
        updateRepoTriggerText();
        // 服务/网络原因失败走非阻断提示（DEF-006）：星标乐观更新已回滚，无需打断用户
        notifyRequestFailure(err, '星标保存失败：' + toDisplayErrorMessage(err, '无法连接本地服务'));
      });
    }
    const TAB_STATE_STORAGE_KEY = 'git_lens_tab_state';
    const SCAN_SETUP_PROMPTED_KEY = 'git_lens_scan_setup_prompted';

    async function loadScanDirectoryConfig() {
      try {
        const res = await fetch('/api/scan-directories');
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || '读取扫描目录失败');
        scanDirectoryConfig = {
          customDirectories: Array.isArray(data.customDirectories) ? data.customDirectories : []
        };
      } catch (err) {
        scanDirectoryConfig = { customDirectories: [] };
        console.warn('读取扫描目录配置失败:', err.message);
      }
    }

    function renderScanDirectoryList() {
      const container = document.getElementById('scanDirectoryList');
      if (!container) return;
      if (scanDirectoryDraft.length === 0) {
        container.innerHTML = '<div class="scan-directory-empty">尚未添加目录，保存后不会扫描任何仓库。</div>';
        return;
      }

      container.innerHTML = scanDirectoryDraft.map((directory, index) => `
        <div class="scan-directory-item">
          <span class="scan-directory-item-path" title="${escapeHtml(directory)}">${escapeHtml(directory)}</span>
          <span class="scan-directory-item-tag">自定义</span>
          <button class="btn-outline scan-directory-remove" type="button" data-action="scan-remove" data-index="${index}">移除</button>
        </div>
      `).join('');
      bindActions(container, {
        // index 是数字，直接经 data-index 传递
        'scan-remove': (el) => removeScanDirectory(Number(el.dataset.index))
      });
    }

    function openScanDirectoryModal(firstRun = false) {
      scanDirectoryDraft = [...scanDirectoryConfig.customDirectories];
      document.getElementById('scanDirectoryModalTitle').textContent = firstRun ? '首次使用：添加扫描目录' : '配置扫描目录';
      document.getElementById('scanDirectoryFirstRun').style.display = firstRun ? 'block' : 'none';
      document.getElementById('scanDirectoryError').textContent = '';
      document.getElementById('scanDirectoryModal').style.display = 'flex';
      renderScanDirectoryList();
      const input = document.getElementById('scanDirectoryInput');
      input.value = '';
      setTimeout(() => input.focus(), 0);
    }

    function closeScanDirectoryModal() {
      document.getElementById('scanDirectoryModal').style.display = 'none';
    }

    async function chooseScanDirectory() {
      const button = document.getElementById('chooseScanDirectoryBtn');
      const error = document.getElementById('scanDirectoryError');
      button.disabled = true;
      button.textContent = '正在打开…';
      error.textContent = '';
      try {
        let directory = null;
        if (isDesktop && typeof window.gitLens?.chooseDirectory === 'function') {
          // 桌面模式：经 preload 直连原生目录对话框（契约 §6）；用户取消时返回 null
          directory = await window.gitLens.chooseDirectory();
        } else {
          // 浏览器模式：沿用服务端系统选择器
          const res = await fetch('/api/choose-scan-directory', {
            method: 'POST',
            // 契约 §4 已批准偏差：此前该调用缺失 Content-Type 被服务放行；
            // 补齐 JSON 头后 Runtime 侧即可收紧该例外
            headers: { 'Content-Type': 'application/json' }
          });
          const data = await res.json();
          if (!data.ok) throw new Error(data.error || '打开目录选择器失败');
          directory = data.directory || null;
        }
        if (directory) {
          if (scanDirectoryDraft.includes(directory)) {
            error.textContent = '这个目录已经添加。';
          } else {
            scanDirectoryDraft.push(directory);
            renderScanDirectoryList();
          }
        }
      } catch (err) {
        error.textContent = toDisplayErrorMessage(err, '无法连接本地服务，打开目录选择器失败');
      } finally {
        button.disabled = false;
        button.textContent = '选择文件夹…';
      }
    }

    function addScanDirectory() {
      const input = document.getElementById('scanDirectoryInput');
      const directory = input.value.trim();
      const error = document.getElementById('scanDirectoryError');
      if (!directory) {
        error.textContent = '请输入要扫描的目录路径。';
        input.focus();
        return;
      }
      if (scanDirectoryDraft.includes(directory)) {
        error.textContent = '这个目录已经添加。';
        input.focus();
        return;
      }
      scanDirectoryDraft.push(directory);
      input.value = '';
      error.textContent = '';
      renderScanDirectoryList();
      input.focus();
    }

    function removeScanDirectory(index) {
      scanDirectoryDraft.splice(index, 1);
      document.getElementById('scanDirectoryError').textContent = '';
      renderScanDirectoryList();
    }

    async function saveScanDirectories() {
      const saveButton = document.getElementById('saveScanDirectoryBtn');
      const error = document.getElementById('scanDirectoryError');
      const pendingInput = document.getElementById('scanDirectoryInput').value.trim();
      if (pendingInput && !scanDirectoryDraft.includes(pendingInput)) {
        scanDirectoryDraft.push(pendingInput);
      }
      saveButton.disabled = true;
      saveButton.textContent = '保存中...';
      error.textContent = '';
      try {
        const res = await fetch('/api/scan-directories', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ directories: scanDirectoryDraft })
        });
        const data = await res.json();
        if (!data.ok) {
          const invalid = Array.isArray(data.invalidDirectories) ? `：${data.invalidDirectories.join('、')}` : '';
          throw new Error((data.error || '保存扫描目录失败') + invalid);
        }
        scanDirectoryConfig = {
          customDirectories: Array.isArray(data.customDirectories) ? data.customDirectories : []
        };
        closeScanDirectoryModal();
        await loadProjects();
      } catch (err) {
        error.textContent = toDisplayErrorMessage(err, '无法连接本地服务，保存扫描目录失败');
      } finally {
        saveButton.disabled = false;
        saveButton.textContent = '保存并扫描';
      }
    }

    function requestWorktreeRemoval(worktreePath, branchName, options = {}) {
      return new Promise((resolve) => {
        worktreeRemoveRequest = resolve;
        const checkbox = document.getElementById('deleteBoundBranchCheckbox');
        const label = document.getElementById('deleteBoundBranchLabel');
        const hint = document.getElementById('deleteBoundBranchHint');
        const allowBranchDelete = options.allowBranchDelete ?? Boolean(branchName);
        document.getElementById('worktreeRemoveModalTitle').textContent = options.title || '移除 Worktree';
        document.getElementById('worktreeRemovePath').textContent = worktreePath;
        checkbox.checked = false;
        checkbox.disabled = !allowBranchDelete;
        if (options.batch) {
          label.textContent = '同步删除候选 Worktree 的绑定分支';
          hint.textContent = allowBranchDelete
            ? '默认不勾选；勾选后只删除仍与这些 Worktree 绑定的分支。'
            : '候选 Worktree 都没有可同步删除的分支。';
        } else if (branchName) {
          label.textContent = `同步删除强绑定分支「${branchName}」`;
          hint.textContent = '默认不勾选；勾选后会在移除 Worktree 后强制删除该分支。';
        } else {
          label.textContent = '该 Worktree 没有可同步删除的分支';
          hint.textContent = '当前操作只会移除 Worktree。';
        }
        document.getElementById('worktreeRemoveModal').style.display = 'flex';
        setTimeout(() => (allowBranchDelete ? checkbox : document.querySelector('#worktreeRemoveModal button')).focus(), 0);
      });
    }

    async function fetchCleanupCandidates() {
      const res = await fetch(`/api/cleanup-candidates?path=${encodeURIComponent(currentRepo)}`);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || '获取清理候选失败');
      return data;
    }

    async function runBulkCleanup(kind) {
      const buttonId = kind === 'worktrees' ? 'cleanupWorktreesBtn' : 'cleanupBranchesBtn';
      const button = document.getElementById(buttonId);
      if (!currentRepo || !button) return;
      button.disabled = true;
      const originalText = button.textContent;
      button.textContent = '检查中...';
      try {
        const candidates = await fetchCleanupCandidates();
        if (kind === 'worktrees') {
          const items = candidates.worktrees || [];
          if (!items.length) {
            alert('没有符合条件的已同步 Worktree。失联引用请使用 Prune。');
            return;
          }
          const hasBranches = items.some(item => item.branch);
          const summary = items.map(item => `• ${item.path}${item.branch ? `（${item.branch}）` : ''}`).join('\n');
          const options = await requestWorktreeRemoval(
            `将移除以下 ${items.length} 个已同步 Worktree：\n${summary}`,
            '',
            { batch: true, allowBranchDelete: hasBranches, title: '批量移除已同步 Worktree' }
          );
          if (!options) return;

          button.textContent = '移除中...';
          const res = await fetch('/api/cleanup-synced-worktrees', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              repoPath: currentRepo,
              paths: items.map(item => item.path),
              deleteBoundBranches: options.deleteBranch
            })
          });
          const data = await res.json();
          if (!data.ok) throw new Error(data.error || '批量移除失败');
          const successCount = (data.results || []).filter(item => item.removed).length;
          const failed = (data.results || []).filter(item => !item.removed);
          await inspectRepo(currentRepo);
          alert(`已移除 ${successCount} 个 Worktree${failed.length ? `，${failed.length} 个因状态变化未处理` : ''}。`);
        } else {
          const items = candidates.branches || [];
          if (!items.length) {
            alert('没有符合条件的无效分支。');
            return;
          }
          const names = items.map(item => item.name);
          if (!confirm(`确认删除以下 ${names.length} 个已同步且未绑定的分支？\n\n${names.join('\n')}`)) return;

          button.textContent = '删除中...';
          const res = await fetch('/api/cleanup-redundant-branches', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ repoPath: currentRepo, names })
          });
          const data = await res.json();
          if (!data.ok) throw new Error(data.error || '批量删除分支失败');
          const successCount = (data.results || []).filter(item => item.deleted).length;
          const failed = (data.results || []).filter(item => !item.deleted);
          await inspectRepo(currentRepo);
          alert(`已删除 ${successCount} 个分支${failed.length ? `，${failed.length} 个因状态变化未处理` : ''}。`);
        }
      } catch (err) {
        // 服务/网络原因失败走非阻断提示（DEF-006），按钮状态在 finally 中恢复
        notifyRequestFailure(err, `清理失败：${toDisplayErrorMessage(err, '无法连接本地服务')}`);
      } finally {
        button.disabled = false;
        button.textContent = originalText;
      }
    }

    function closeWorktreeRemoveModal(confirmed) {
      const resolve = worktreeRemoveRequest;
      if (!resolve) return;
      const checkbox = document.getElementById('deleteBoundBranchCheckbox');
      worktreeRemoveRequest = null;
      document.getElementById('worktreeRemoveModal').style.display = 'none';
      resolve(confirmed ? { deleteBranch: checkbox.checked } : null);
    }

    // 状态管理：从 URL 或 sessionStorage 提取状态（支持多标签页独立隔离，刷新不丢状态）
    function getUrlState() {
      const url = new URL(window.location.href);
      const urlRepo = url.searchParams.get('repo');
      const urlTab = url.searchParams.get('tab');
      const urlQ = url.searchParams.get('q');
      const urlDiffType = url.searchParams.get('diffType');
      const urlUncommitted = url.searchParams.get('uncommitted');
      const urlBase = url.searchParams.get('base');
      const urlTarget = url.searchParams.get('target');
      // ref 模式的类型前缀；旧链接（diffType=worktree）无该参数，按 worktree 兼容解析
      const urlBaseType = url.searchParams.get('diffBaseType');
      const urlTargetType = url.searchParams.get('diffTargetType');
      const urlMode = url.searchParams.get('mode');
      const urlCommits = url.searchParams.get('commits');
      const urlCommitsFull = url.searchParams.get('commitsFull');
      const urlCommitsRef = url.searchParams.get('commitsRef');
      const urlCommitsBase = url.searchParams.get('commitsBase');
      const urlMr = url.searchParams.get('mr');

      if (!urlRepo && !urlTab && !urlQ && !urlDiffType && !urlCommits && !urlMr) return null;
      return {
          repo: urlRepo || '',
          tab: urlTab || 'overview',
          q: urlQ || '',
          diffType: urlDiffType || null,
          uncommitted: urlUncommitted || '',
          base: urlBase || '',
          target: urlTarget || '',
          baseType: urlBaseType === 'branch' ? 'branch' : 'worktree',
          targetType: urlTargetType === 'branch' ? 'branch' : 'worktree',
          mode: urlMode || null,
          commits: urlCommits || '',
          commitsFull: urlCommitsFull === '1',
          commitsRef: urlCommitsRef || '',
          commitsBase: urlCommitsBase || '',
          mr: urlMr || ''
      };
    }

    function getStoredState() {
      const urlState = getUrlState();
      if (urlState) return urlState;

      // 若 URL 无参数，尝试从本浏览器 Tab 独享的 sessionStorage 读取（隔离其他 Tab）
      try {
        const raw = sessionStorage.getItem(TAB_STATE_STORAGE_KEY);
        if (raw) return JSON.parse(raw);
      } catch (e) {}

      return null;
    }

    function syncStateToUrl(pushHistory = false) {
      try {
        const url = new URL(window.location.href);
        if (currentRepo) url.searchParams.set('repo', currentRepo);
        else url.searchParams.delete('repo');

        if (activeTab && activeTab !== 'overview') url.searchParams.set('tab', activeTab);
        else url.searchParams.delete('tab');

        if (searchKeyword) url.searchParams.set('q', searchKeyword);
        else url.searchParams.delete('q');

        if (activeTab === 'diff') {
          if (currentDiffType === 'uncommitted' && currentUncommittedPath) {
            url.searchParams.set('diffType', 'uncommitted');
            url.searchParams.set('uncommitted', currentUncommittedPath);
            url.searchParams.delete('base');
            url.searchParams.delete('target');
            url.searchParams.delete('diffBaseType');
            url.searchParams.delete('diffTargetType');
          } else if (currentDiffType === 'ref' || currentDiffType === 'worktree') {
            // 选择器保存的是 kind:value 身份串；旧格式 diffType=worktree 的 base/target 仍按裸 worktree 路径写出
            const b = splitRefIdentity(document.getElementById('diffBaseSelect')?.value || currentDiffBase);
            const t = splitRefIdentity(document.getElementById('diffTargetSelect')?.value || currentDiffTarget);
            if (b.value && t.value) {
              url.searchParams.set('diffType', currentDiffType);
              if (currentDiffType === 'ref') {
                url.searchParams.set('diffBaseType', b.kind);
                url.searchParams.set('diffTargetType', t.kind);
              } else {
                url.searchParams.delete('diffBaseType');
                url.searchParams.delete('diffTargetType');
              }
              url.searchParams.set('base', b.value);
              url.searchParams.set('target', t.value);
            } else {
              url.searchParams.delete('diffType');
              url.searchParams.delete('base');
              url.searchParams.delete('target');
              url.searchParams.delete('diffBaseType');
              url.searchParams.delete('diffTargetType');
            }
            url.searchParams.delete('uncommitted');
          } else {
            url.searchParams.delete('diffType');
            url.searchParams.delete('uncommitted');
            url.searchParams.delete('base');
            url.searchParams.delete('target');
            url.searchParams.delete('diffBaseType');
            url.searchParams.delete('diffTargetType');
          }
          if (currentDiffMode) url.searchParams.set('mode', currentDiffMode);
          else url.searchParams.delete('mode');
        } else {
          url.searchParams.delete('diffType');
          url.searchParams.delete('uncommitted');
          url.searchParams.delete('base');
          url.searchParams.delete('target');
          url.searchParams.delete('diffBaseType');
          url.searchParams.delete('diffTargetType');
          url.searchParams.delete('mode');
        }

        if (commitsDrawerState.isOpen && commitsDrawerState.worktreePath) {
          url.searchParams.set('commits', commitsDrawerState.worktreePath);
          if (commitsDrawerState.fullHistory) url.searchParams.set('commitsFull', '1');
          else url.searchParams.delete('commitsFull');
          if (commitsDrawerState.ref) url.searchParams.set('commitsRef', commitsDrawerState.ref);
          else url.searchParams.delete('commitsRef');
          if (commitsDrawerState.baseRef) url.searchParams.set('commitsBase', commitsDrawerState.baseRef);
          else url.searchParams.delete('commitsBase');
        } else {
          url.searchParams.delete('commits');
          url.searchParams.delete('commitsFull');
          url.searchParams.delete('commitsRef');
          url.searchParams.delete('commitsBase');
        }

        // MR 详情抽屉打开状态持久化：刷新/前进后退均可恢复
        if (mrDrawerState.isOpen && mrDrawerState.id != null) {
          url.searchParams.set('mr', mrDrawerState.id);
        } else {
          url.searchParams.delete('mr');
        }

        // 用户主动切换页面状态才新增历史项；恢复历史时保留浏览器正在访问的 URL。
        if (!isRestoringHistory) {
          if (pushHistory && url.toString() !== window.location.href) {
            window.history.pushState(null, '', url.toString());
          } else {
            window.history.replaceState(null, '', url.toString());
          }
        }

        // 同时写入当前 Tab 专属的 sessionStorage（base/target 存裸值 + 类型前缀，与 URL 语义一致）
        const storedBaseIdentity = document.getElementById('diffBaseSelect')?.value || currentDiffBase;
        const storedTargetIdentity = document.getElementById('diffTargetSelect')?.value || currentDiffTarget;
        sessionStorage.setItem(TAB_STATE_STORAGE_KEY, JSON.stringify({
          repo: currentRepo,
          tab: activeTab,
          q: searchKeyword,
          diffType: currentDiffType,
          uncommitted: currentUncommittedPath,
          base: splitRefIdentity(storedBaseIdentity).value,
          target: splitRefIdentity(storedTargetIdentity).value,
          baseType: splitRefIdentity(storedBaseIdentity).kind,
          targetType: splitRefIdentity(storedTargetIdentity).kind,
          mode: currentDiffMode,
          commits: commitsDrawerState.isOpen ? commitsDrawerState.worktreePath : '',
          commitsFull: commitsDrawerState.isOpen && commitsDrawerState.fullHistory,
          commitsRef: commitsDrawerState.isOpen ? (commitsDrawerState.ref || '') : '',
          commitsBase: commitsDrawerState.isOpen ? (commitsDrawerState.baseRef || '') : '',
          mr: mrDrawerState.isOpen && mrDrawerState.id != null ? mrDrawerState.id : ''
        }));
      } catch (e) {
        console.warn('syncStateToUrl error:', e);
      }
    }

    function toggleStarredOnlyFilter() {
      filterStarredOnly = !filterStarredOnly;
      const btn = document.getElementById('starredFilterBtn');
      if (filterStarredOnly) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
      renderRepoDropdownList();
    }

    function toggleRepoDropdown() {
      const dd = document.getElementById('repoDropdown');
      if (repoPickerState.open) {
        dd.classList.remove('show');
        repoPickerState.open = false;
        return;
      }
      // 每次展开都从完整列表开始，避免上次筛选条件造成误选。
      clearRepoFilter();
      dd.classList.add('show');
      repoPickerState.open = true;
      const inp = document.getElementById('repoFilterInput');
      setTimeout(() => inp.focus(), 50);
    }

    function applyRepoHighlightClasses() {
      repoPickerState.rowEls.forEach((el, i) => {
        el.classList.toggle('highlight', i === repoPickerState.highlight);
      });
      const el = repoPickerState.rowEls[repoPickerState.highlight];
      if (el) el.scrollIntoView({ block: 'nearest' });
    }

    function moveRepoHighlight(delta) {
      if (repoPickerState.visible.length === 0) return;
      const total = repoPickerState.visible.length;
      let idx = repoPickerState.highlight;
      if (idx < 0) idx = delta > 0 ? -1 : 0;
      repoPickerState.highlight = (idx + delta + total) % total;
      applyRepoHighlightClasses();
    }

    function clearRepoFilter(shouldFocus = false) {
      repoFilterKeyword = '';
      const input = document.getElementById('repoFilterInput');
      if (input) input.value = '';
      renderRepoDropdownList();
      if (shouldFocus && input) input.focus();
    }

    document.addEventListener('click', (e) => {
      const wrapper = document.getElementById('repoPickerWrapper');
      if (wrapper && !wrapper.contains(e.target)) {
        document.getElementById('repoDropdown').classList.remove('show');
        repoPickerState.open = false;
      }
    });

    // 点击外部时关闭所有可搜索选择器下拉（Diff 基准/对比、MR 弹层内的分支选择器）
    document.addEventListener('click', (e) => {
      searchablePickers.forEach(p => {
        if (p.wrapper && !p.wrapper.contains(e.target)) p.closeDropdown();
      });
    });

    // Stash 菜单是原生 details；点击其它区域时主动收起，避免弹层长时间遮挡 Diff。
    document.addEventListener('click', (e) => {
      document.querySelectorAll('.stash-menu[open]').forEach(menu => {
        if (!menu.contains(e.target)) menu.removeAttribute('open');
      });
    });

    /* 可搜索下拉选择器工厂（视觉与交互对齐仓库选择器 repoPickerWrapper）：
       触发器 + 搜索输入 + 分组列表，选中值写入隐藏 <select> 作为状态载体。
       cfg: {
         wrapperId/triggerId/triggerTextId/dropdownId/searchInputId/listId/selectId,
         getItems: () => [{ kind, value, identity, label, searchText, disabled }],
         groupTitles: { [kind]: 分组标题 }, emptyText: 无结果文案,
         placeholder: 未选中时触发器文案, onSelect: (identity) => void
       } */
    function createSearchablePicker(cfg) {
      const wrapper = document.getElementById(cfg.wrapperId);
      const trigger = document.getElementById(cfg.triggerId);
      const textEl = document.getElementById(cfg.triggerTextId);
      const dropdown = document.getElementById(cfg.dropdownId);
      const input = document.getElementById(cfg.searchInputId);
      const clearButton = input?.parentElement?.querySelector('.search-clear-btn');
      const listEl = document.getElementById(cfg.listId);
      const state = { open: false, keyword: '', visible: [], rowEls: [], highlight: -1 };

      function getSelectedIdentity() {
        return document.getElementById(cfg.selectId)?.value || '';
      }

      /* 以隐藏 select 里的身份串为准过滤选项元数据，保证下拉列表与状态载体一致 */
      function visibleSourceItems() {
        const identities = new Set([...(document.getElementById(cfg.selectId)?.options || [])].map(o => o.value));
        return cfg.getItems().filter(item => identities.has(item.identity));
      }

      /* 键盘高亮只切换类名并滚动到可见，不重建列表，避免滚动位置跳动 */
      function applyHighlightClasses() {
        state.rowEls.forEach((el, i) => {
          el.classList.toggle('highlight', i === state.highlight);
        });
        const el = state.rowEls[state.highlight];
        if (el) el.scrollIntoView({ block: 'nearest' });
      }

      function renderList() {
        const kw = state.keyword.trim().toLowerCase();
        // 大小写不敏感包含式搜索：匹配分支名/Worktree 路径/目录名
        const items = visibleSourceItems().filter(item => !kw
          || item.label.toLowerCase().includes(kw)
          || item.searchText.toLowerCase().includes(kw));
        state.visible = items;
        state.rowEls = [];
        // 初始高亮落在第一个可用选项上（跳过失联 Worktree 等禁用项）
        state.highlight = items.findIndex(item => !item.disabled);

        if (items.length === 0) {
          listEl.innerHTML = `<div class="loading" style="padding: 20px;">${escapeHtml(cfg.emptyText || '没有匹配的选项')}</div>`;
          return;
        }

        const fragment = document.createDocumentFragment();
        let lastKind = null;
        items.forEach((item) => {
          if (cfg.groupTitles && item.kind !== lastKind) {
            lastKind = item.kind;
            const title = document.createElement('div');
            title.className = 'repo-list-group-title';
            title.textContent = cfg.groupTitles[item.kind] || item.kind;
            fragment.appendChild(title);
          }
          const selected = item.identity === getSelectedIdentity();
          const row = document.createElement('div');
          row.className = 'repo-item'
            + (selected ? ' selected' : '')
            + (item.disabled ? ' disabled' : '');
          row.innerHTML = `
            <div class="repo-item-left">
              <span class="repo-item-name">${escapeHtml(item.label)}</span>
            </div>
            ${item.disabled ? '<span class="repo-item-group">已失联</span>' : (selected ? '<span class="repo-item-group">当前</span>' : '')}
          `;
          row.addEventListener('click', () => chooseItem(item));
          state.rowEls.push(row);
          fragment.appendChild(row);
        });
        listEl.innerHTML = '';
        listEl.appendChild(fragment);
        applyHighlightClasses();
      }

      function updateTriggerText() {
        const identity = getSelectedIdentity();
        if (!identity) {
          textEl.innerHTML = `<span style="color: var(--text-muted);">${escapeHtml(cfg.placeholder || '请选择')}</span>`;
          return;
        }
        // 选项元数据缺失（数据尚未刷新等）时直接展示身份串兜底
        const item = cfg.getItems().find(o => o.identity === identity);
        textEl.innerHTML = `<span style="font-weight: 600; color: var(--text-bright);">${escapeHtml(item ? item.label : identity)}</span>`;
      }

      function moveHighlight(delta) {
        if (state.visible.length === 0) return;
        let idx = state.highlight;
        for (let step = 0; step < state.visible.length; step++) {
          idx = (idx + delta + state.visible.length) % state.visible.length;
          if (!state.visible[idx].disabled) break;
        }
        state.highlight = idx;
        applyHighlightClasses();
      }

      function chooseItem(item) {
        if (!item || item.disabled) return;
        const sel = document.getElementById(cfg.selectId);
        if (sel) sel.value = item.identity;
        updateTriggerText();
        // 选择完成后清空筛选条件，下一次打开时始终展示完整候选列表。
        state.keyword = '';
        input.value = '';
        closeDropdown();
        if (cfg.onSelect) cfg.onSelect(item.identity);
      }

      function clearSearch() {
        state.keyword = '';
        input.value = '';
        renderList();
        input.focus();
      }

      function openDropdown() {
        state.keyword = '';
        input.value = '';
        renderList();
        dropdown.classList.add('show');
        state.open = true;
        setTimeout(() => input.focus(), 30);
      }

      function closeDropdown() {
        dropdown.classList.remove('show');
        state.open = false;
      }

      function toggleDropdown() {
        if (state.open) closeDropdown();
        else openDropdown();
      }

      input.addEventListener('input', () => {
        state.keyword = input.value;
        renderList();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          moveHighlight(1);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          moveHighlight(-1);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          const item = state.visible[state.highlight];
          if (item && !item.disabled) chooseItem(item);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          closeDropdown();
        }
      });
      clearButton?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        clearSearch();
      });
      trigger.addEventListener('click', toggleDropdown);

      const picker = {
        wrapper,
        openDropdown,
        closeDropdown,
        toggleDropdown,
        refresh: updateTriggerText, // 数据/选择变化后由外部调用，仅同步触发器文本
        /* 指定身份串写回隐藏 select；身份串不在选项集中时清空选择（回退占位文案） */
        setSelected(identity) {
          const sel = document.getElementById(cfg.selectId);
          if (sel) {
            sel.value = (identity && [...sel.options].some(o => o.value === identity)) ? identity : '';
          }
          updateTriggerText();
        }
      };
      searchablePickers.push(picker);
      updateTriggerText();
      return picker;
    }

    function renderRepoDropdownList() {
      const container = document.getElementById('repoDropdownList');
      const kw = repoFilterKeyword.trim().toLowerCase();
      const starred = getStarredRepos();
      const pinnedRepo = allRepos.find(r => r.path === currentRepo) || null;

      repoPickerState.visible = [];
      repoPickerState.rowEls = [];
      repoPickerState.highlight = -1;

      let filtered = allRepos.filter(r => {
        const matchesKw = !kw || r.name.toLowerCase().includes(kw) || r.path.toLowerCase().includes(kw) || (r.group && r.group.toLowerCase().includes(kw));
        const matchesStar = !filterStarredOnly || starred.includes(r.path);
        return matchesKw && matchesStar;
      });

      // 当前项目单独置顶，避免只看星标时当前项目被过滤掉，也避免在列表中重复出现。
      if (pinnedRepo) filtered = filtered.filter(r => r.path !== pinnedRepo.path);

      // 排序：已星标的置顶排前面，其余按拼音/字母排序
      filtered.sort((a, b) => {
        const aStar = starred.includes(a.path) ? 1 : 0;
        const bStar = starred.includes(b.path) ? 1 : 0;
        if (aStar !== bStar) return bStar - aStar;
        return a.name.localeCompare(b.name);
      });

      if (filtered.length === 0 && !pinnedRepo) {
        container.innerHTML = `<div class="loading" style="padding: 20px;">没有匹配的仓库</div>`;
        return;
      }

      container.innerHTML = '';

      if (pinnedRepo) {
        const gTitle = document.createElement('div');
        gTitle.className = 'repo-list-group-title';
        gTitle.textContent = '当前项目';
        container.appendChild(gTitle);
        container.appendChild(createRepoItemDom(pinnedRepo, starred.includes(pinnedRepo.path)));
      }

      // 分组渲染：星标仓库区 & 普通分组
      const starredItems = filtered.filter(r => starred.includes(r.path));
      const normalItems = filtered.filter(r => !starred.includes(r.path));

      if (starredItems.length > 0) {
        const gTitle = document.createElement('div');
        gTitle.className = 'repo-list-group-title';
        gTitle.textContent = `星标收藏 (${starredItems.length})`;
        container.appendChild(gTitle);

        starredItems.forEach(r => {
          container.appendChild(createRepoItemDom(r, true));
        });
      }

      // 其他仓库按 group 组织
      const groups = {};
      normalItems.forEach(r => {
        const g = r.group || '其他仓库';
        if (!groups[g]) groups[g] = [];
        groups[g].push(r);
      });

      Object.keys(groups).forEach(gName => {
        const gTitle = document.createElement('div');
        gTitle.className = 'repo-list-group-title';
        gTitle.textContent = `${gName} (${groups[gName].length})`;
        container.appendChild(gTitle);

        groups[gName].forEach(r => {
          container.appendChild(createRepoItemDom(r, false));
        });
      });

      repoPickerState.rowEls = [...container.querySelectorAll('.repo-item')];
      repoPickerState.visible = repoPickerState.rowEls
        .map(row => allRepos.find(repo => repo.path === row.dataset.repoPath))
        .filter(Boolean);
      repoPickerState.highlight = repoPickerState.visible.length > 0 ? 0 : -1;
      applyRepoHighlightClasses();
    }

    function createRepoItemDom(repo, isStarred) {
      const item = document.createElement('div');
      item.className = 'repo-item' + (repo.path === currentRepo ? ' selected' : '');
      item.dataset.repoPath = repo.path;
      item.onclick = () => {
        selectRepo(repo.path);
        clearRepoFilter();
        document.getElementById('repoDropdown').classList.remove('show');
        repoPickerState.open = false;
      };

      item.innerHTML = `
        <div class="repo-item-left">
          <span class="repo-item-name">${escapeHtml(repo.name)}</span>
          <span class="repo-item-group">${escapeHtml(repo.group || '')}</span>
        </div>
        <span class="star-icon ${isStarred ? 'starred' : ''}" title="${isStarred ? '取消收藏' : '加入星标'}" data-action="repo-star">
          ${isStarred ? '★' : '☆'}
        </span>
      `;
      // 星标按钮闭包直引 repo 对象；toggleStarRepo 内部自行 stopPropagation 防触发行选中
      bindActions(item, {
        'repo-star': (el, e) => toggleStarRepo(repo.path, e)
      });
      return item;
    }

    function updateRepoTriggerText() {
      const repo = allRepos.find(r => r.path === currentRepo);
      const textDom = document.getElementById('repoTriggerText');
      if (repo) {
        const starred = isRepoStarred(repo.path);
        textDom.innerHTML = `
          ${starred ? '<span style="color: var(--star-color);">★</span>' : ''}
          <span style="font-weight: 600; color: var(--text-bright);">${escapeHtml(repo.name)}</span>
          <span style="font-size: 12px; color: var(--text-muted);">[${escapeHtml(repo.group || '')}]</span>
        `;
      } else {
        textDom.innerHTML = `<span>未选择仓库</span>`;
      }
    }

    function selectRepo(repoPath) {
      if (!repoPath || repoPath === currentRepo) return;
      currentRepo = repoPath;
      // 切换仓库时重置 Diff 状态
      currentDiffType = null;
      currentUncommittedPath = '';
      currentDiffBase = '';
      currentDiffTarget = '';
      document.getElementById('repoSelect').value = repoPath;
      updateRepoTriggerText();
      renderRepoDropdownList();
      updateDocumentIdentity();
      syncStateToUrl(true);
      inspectRepo(repoPath);
    }

    function switchTab(tab, pushHistory = true) {
      activeTab = tab;
      updateDocumentIdentity();
      document.getElementById('tabOverview').className = tab === 'overview' ? 'tab-btn active' : 'tab-btn';
      document.getElementById('tabMr').className = tab === 'mr' ? 'tab-btn active' : 'tab-btn';
      document.getElementById('tabDiff').className = tab === 'diff' ? 'tab-btn active' : 'tab-btn';
      document.getElementById('tabRemote').className = tab === 'remote' ? 'tab-btn active' : 'tab-btn';

      document.getElementById('viewOverview').style.display = tab === 'overview' ? 'block' : 'none';
      document.getElementById('viewMr').style.display = tab === 'mr' ? 'block' : 'none';
      document.getElementById('viewDiff').style.display = tab === 'diff' ? 'block' : 'none';
      document.getElementById('viewRemote').style.display = tab === 'remote' ? 'block' : 'none';

      if (tab === 'diff') {
        populateDiffSelectors();
      }
      if (tab === 'mr') {
        // 进入 MR Tab 时重拉列表，避免仓库在其他 Tab 发生写操作后展示过期数据
        refreshMergeRequests();
      }
      if (tab === 'remote') {
        // 进入远端分支 Tab 时全量重拉：其他 Tab 的检出/合并会改变工作区分支与 merge 状态
        refreshRemoteTab();
      }
      syncStateToUrl(pushHistory);
    }

    /**
     * 仓库列表加载失败的错误态渲染：下拉列表、触发器与两个概览面板统一给出
     * 中文提示与重试入口，避免服务不可达时页面停留在“加载中”假死。
     * @param {string} message - 可展示的中文错误文案
     */
    function renderProjectsLoadError(message) {
      currentRepo = '';
      allRepos = [];
      const escaped = escapeHtml(message);
      const retryButton = '<button class="btn-outline" type="button" data-action="projects-retry">重试</button>';
      const bindRetry = (el) => {
        if (el) bindActions(el, { 'projects-retry': () => loadProjects() });
      };
      const dropdown = document.getElementById('repoDropdownList');
      if (dropdown) {
        dropdown.innerHTML = `<div class="loading" style="color: var(--danger);">仓库列表加载失败：${escaped}</div>${retryButton}`;
        bindRetry(dropdown);
      }
      document.getElementById('repoTriggerText').textContent = '仓库列表加载失败';
      document.getElementById('headerPath').textContent = '';
      const wtList = document.getElementById('wtList');
      wtList.innerHTML = `<div class="loading" style="color: var(--danger);">仓库列表加载失败：${escaped}</div>${retryButton}`;
      bindRetry(wtList);
      const brList = document.getElementById('brList');
      brList.innerHTML = `<div class="loading" style="color: var(--danger);">仓库列表加载失败：${escaped}</div>${retryButton}`;
      bindRetry(brList);
      updateMetrics();
    }

    async function loadProjects(useStoredState = true) {
      // 提取保存的状态（URL 参数优先，其次 sessionStorage）
      pendingRestoreState = useStoredState ? getStoredState() : getUrlState();
      isRestoringHistory = Boolean(pendingRestoreState);

      await loadScanDirectoryConfig();
      // 启动即拉取服务端星标（含旧 localStorage 一次性迁移），
      // 保证后续「星标仓库作为默认选中仓库」与渲染分组用到最新数据
      await loadStarredRepos();

      if (pendingRestoreState && pendingRestoreState.q) {
        searchKeyword = pendingRestoreState.q;
        const searchInputDom = document.getElementById('searchInput');
        if (searchInputDom) searchInputDom.value = searchKeyword;
      }

      let data;
      try {
        const res = await fetch('/api/projects');
        data = await res.json();
        if (!data.ok) throw new Error(data.error || '读取仓库列表失败');
      } catch (err) {
        // 服务不可达或响应异常：渲染中文错误态并提供重试，不中断后续交互
        renderProjectsLoadError(toDisplayErrorMessage(err, '无法连接本地服务，请确认服务已启动'));
        isRestoringHistory = false;
        return;
      }
      allRepos = data.repos || [];

      const sel = document.getElementById('repoSelect');
      sel.innerHTML = '';
      if (allRepos.length > 0) {
        allRepos.forEach(r => {
          const opt = document.createElement('option');
          opt.value = r.path;
          opt.textContent = `[${r.group}] ${r.name}`;
          sel.appendChild(opt);
        });

        // 恢复选中的仓库：优先匹配持久化状态中的 repo
        let targetRepo = null;
        if (pendingRestoreState && pendingRestoreState.repo) {
          targetRepo = allRepos.find(r => r.path === pendingRestoreState.repo);
        }
        if (!targetRepo) {
          const starred = getStarredRepos();
          targetRepo = allRepos.find(r => starred.includes(r.path)) || allRepos[0];
        }

        currentRepo = targetRepo.path;
        sel.value = currentRepo;
        updateRepoTriggerText();
        renderRepoDropdownList();
        updateDocumentIdentity();
        syncStateToUrl(false);

        await inspectRepo(currentRepo);

        if (!pendingRestoreState?.commits && commitsDrawerState.isOpen) {
          closeCommitsDrawer(false);
        }

        // 恢复 Tab 状态与 Diff 比对
        if (pendingRestoreState) {
          switchTab(['diff', 'mr', 'remote'].includes(pendingRestoreState.tab) ? pendingRestoreState.tab : 'overview', false);
          if (pendingRestoreState.tab === 'diff') {
            if (pendingRestoreState.diffType === 'uncommitted' && pendingRestoreState.uncommitted) {
              const baseSel = document.getElementById('diffBaseSelect');
              const targetSel = document.getElementById('diffTargetSelect');
              if (targetSel) targetSel.value = `worktree:${pendingRestoreState.uncommitted}`;
              if (baseSel && (!baseSel.value || baseSel.value === `worktree:${pendingRestoreState.uncommitted}`)) {
                const other = currentWorktrees.find(w => w.path !== pendingRestoreState.uncommitted);
                if (other) baseSel.value = `worktree:${other.path}`;
              }
              refreshDiffPickerTriggers();
              currentDiffType = 'ref';
              currentUncommittedPath = pendingRestoreState.uncommitted;
              currentDiffMode = 'uncommitted';
              fetchAndRenderRefDiff('uncommitted', false);
            } else if ((pendingRestoreState.diffType === 'ref' || pendingRestoreState.diffType === 'worktree')
              && pendingRestoreState.base && pendingRestoreState.target) {
              // diffType=ref 为新格式；旧链接 diffType=worktree 无类型前缀，base/target 按 worktree 兼容解析。
              // 恢复流程在 inspectRepo 之后，选项（含分支）已就绪，可直接应用身份串
              const baseIdentity = `${pendingRestoreState.baseType || 'worktree'}:${pendingRestoreState.base}`;
              const targetIdentity = `${pendingRestoreState.targetType || 'worktree'}:${pendingRestoreState.target}`;
              currentDiffMode = pendingRestoreState.mode || null;
              if (applyDiffIdentitiesOrReport(baseIdentity, targetIdentity)) {
                refreshDiffPickerTriggers();
                fetchAndRenderRefDiff(pendingRestoreState.mode, false);
              } else {
                currentDiffType = 'ref';
                currentDiffBase = baseIdentity;
                currentDiffTarget = targetIdentity;
                document.getElementById('diffResultsContainer').innerHTML = `
                  <div class="empty-diff-box" style="color: var(--warning);">
                    <div style="font-size: 15px; margin-bottom: 8px;">链接中的 Worktree 或分支已不存在，无法恢复原比对</div>
                    <div style="font-size: 13px;">请重新在上方选择基准与对比对象</div>
                  </div>`;
              }
            }
          }
          if (pendingRestoreState.commits) {
            await openCommitsDrawer(pendingRestoreState.commits, pendingRestoreState.commitsFull, false, pendingRestoreState.commitsRef || '', pendingRestoreState.commitsBase || '');
          }
          // 恢复 MR 详情抽屉（mr 记录不存在时抽屉内展示错误与重试入口）
          if (pendingRestoreState.mr) {
            await openMrDetail(pendingRestoreState.mr, false);
          }
          pendingRestoreState = null;
        }
        isRestoringHistory = false;
        syncStateToUrl(false);
      } else {
        currentRepo = '';
        currentWorktrees = [];
        currentBranches = [];
        currentMainBranch = '';
        currentDiffType = null;
        currentUncommittedPath = '';
        currentDiffBase = '';
        currentDiffTarget = '';
        mergeRequestsCache = [];
        renderMrList();
        if (mrDrawerState.isOpen) closeMrDrawer(false);
        // 远端分支 Tab 同步清空，避免展示上一个仓库的过期数据
        remoteState.targetWorktree = '';
        remoteState.branches = [];
        remoteState.mergeState = null;
        renderRemoteBranchList();
        renderRemoteMergePanel();
        document.getElementById('headerPath').textContent = '';
        sel.innerHTML = '<option value="">未扫描到仓库</option>';
        document.getElementById('repoTriggerText').textContent = scanDirectoryConfig.customDirectories.length > 0
          ? '未扫描到仓库'
          : '请先添加扫描目录';
        renderRepoDropdownList();
        updateMetrics();
        renderFilteredLists();
        populateDiffSelectors();
        document.getElementById('diffResultsContainer').innerHTML = `
          <div class="empty-diff-box">
            <div style="font-size: 16px; margin-bottom: 8px;">请先添加扫描目录</div>
            <div style="font-size: 13px;">添加目录后，Git Lens 会在这里展示可用仓库的 Worktree/分支差异。</div>
          </div>`;
        isRestoringHistory = false;
        syncStateToUrl();
      }

      // 只在当前浏览器首次打开且尚未配置目录时引导，用户跳过后仍可从顶部按钮进入。
      if (scanDirectoryConfig.customDirectories.length === 0 && !localStorage.getItem(SCAN_SETUP_PROMPTED_KEY)) {
        localStorage.setItem(SCAN_SETUP_PROMPTED_KEY, '1');
        openScanDirectoryModal(true);
      }
    }

    async function inspectRepo(repoPath) {
      if (!repoPath) return;
      currentRepo = repoPath;
      updateDocumentIdentity();
      document.getElementById('headerPath').textContent = repoPath;
      document.getElementById('wtList').innerHTML = '<div class="loading">正在分析 Worktrees...</div>';
      document.getElementById('brList').innerHTML = '<div class="loading">正在分析分支...</div>';

      try {
        const res = await fetch(`/api/inspect?path=${encodeURIComponent(repoPath)}`);
        const data = await res.json();
        if (!data.ok) throw new Error(data.error);

        currentWorktrees = data.worktrees || [];
        currentBranches = data.branches || [];
        currentMainBranch = data.mainBranch;

        updateMetrics();
        renderFilteredLists();
        populateDiffSelectors();
        refreshMergeRequests();
        // 远端分支 Tab 展示的是工作区级状态，仓库数据变化后需同步重拉
        if (activeTab === 'remote') refreshRemoteTab();
      } catch (err) {
        // 服务中断期间在途分析请求失败是常态，绝不能弹阻塞框冻结恢复遮罩（DEF-006）
        notifyRequestFailure(err, '分析失败: ' + toDisplayErrorMessage(err, '无法连接本地服务'));
      }
    }

    function updateMetrics() {
      const staleWt = currentWorktrees.filter(w => !w.isMain && (!w.existsOnDisk || w.isPrunable));
      const redundantBr = currentBranches.filter(b => b.redundancyReason);

      document.getElementById('mTotalWt').textContent = currentWorktrees.length;
      document.getElementById('mStaleWt').textContent = staleWt.length;
      document.getElementById('mTotalBr').textContent = currentBranches.length;
      document.getElementById('mRedundantBr').textContent = redundantBr.length;
    }

    function includesKeyword(values, keyword) {
      return values.filter(Boolean).join(' ').toLocaleLowerCase().includes(keyword);
    }

    function renderFilteredLists() {
      const keyword = searchKeyword.trim().toLocaleLowerCase();
      let worktrees = keyword
        ? currentWorktrees.filter(wt => includesKeyword([wt.path, wt.branch, wt.name, wt.lastCommit?.relativeTime, wt.lastCommit?.author, wt.lastCommit?.subject], keyword))
        : [...currentWorktrees];

      // 智能排序：Main 工作区永远置顶；有实际文件差异或本地未提交修改的 Worktree 优先。
      worktrees.sort((a, b) => {
        if (a.isMain && !b.isMain) return -1;
        if (!a.isMain && b.isMain) return 1;

        const aHasDiff = (a.hasDiff || a.isDirty || (a.aheadCount > 0)) ? 1 : 0;
        const bHasDiff = (b.hasDiff || b.isDirty || (b.aheadCount > 0)) ? 1 : 0;
        if (aHasDiff !== bHasDiff) {
          return bHasDiff - aHasDiff; // 有 diff 的优先排在前面
        }

        // 同为有 diff 时，优先排 dirty 数量多或 ahead 数量多的
        const aDiffWeight = (a.dirtyCount || 0) * 10 + (a.aheadCount || 0);
        const bDiffWeight = (b.dirtyCount || 0) * 10 + (b.aheadCount || 0);
        if (aDiffWeight !== bDiffWeight) {
          return bDiffWeight - aDiffWeight;
        }

        return 0;
      });
      const branches = keyword
        ? currentBranches.filter(b => includesKeyword([b.name, b.relativeTime, b.author, b.subject, b.redundancyReason], keyword))
        : currentBranches;

      updateListCountBadges(worktrees.length, branches.length, keyword);

      renderWorktrees(worktrees, keyword);
      renderBranches(branches, currentMainBranch, keyword);
    }

    function updateListCountBadges(worktreeCount = null, branchCount = null, keyword = searchKeyword.trim().toLocaleLowerCase()) {
      const visibleWorktrees = worktreeCount === null
        ? (keyword ? currentWorktrees.filter(wt => includesKeyword([wt.path, wt.branch, wt.name, wt.lastCommit?.relativeTime, wt.lastCommit?.author, wt.lastCommit?.subject], keyword)) : currentWorktrees)
        : null;
      const visibleBranches = branchCount === null
        ? (keyword ? currentBranches.filter(b => includesKeyword([b.name, b.relativeTime, b.author, b.subject, b.redundancyReason], keyword)) : currentBranches)
        : null;

      document.getElementById('wtCountBadge').textContent = keyword
        ? `${worktreeCount ?? visibleWorktrees.length} / ${currentWorktrees.length} 个`
        : `${currentWorktrees.length} 个`;
      document.getElementById('brCountBadge').textContent = keyword
        ? `${branchCount ?? visibleBranches.length} / ${currentBranches.length} 个`
        : `${currentBranches.length} 个`;
    }

    function renderWorktrees(worktrees, keyword) {
      const container = document.getElementById('wtList');
      if (!worktrees || worktrees.length === 0) {
        container.innerHTML = `<div class="loading">${keyword ? '没有匹配的 Worktree' : '无任何独立 Worktree'}</div>`;
        return;
      }
      container.innerHTML = '';
      worktrees.forEach(wt => {
        container.appendChild(createWorktreeItemDom(wt));
      });
    }

    /* 构建单个 Worktree 条目 DOM。独立成函数供「只刷新单条 item」的局部更新复用
       （上锁/别名编辑不再触发整页 inspect），结构与 createBranchItemDom 同款 */
    function createWorktreeItemDom(wt) {
      const div = document.createElement('div');
      div.className = 'list-item';
      div.id = 'wt-item-' + encodeURIComponent(wt.path).replace(/%/g, '_');

      const isSafeMain = wt.isMain;
      // 服务端数值字段统一收敛为数字后再进 HTML 插值，保证异常响应也不会注入标记
      const dirtyCount = Number(wt.dirtyCount) || 0;
      const aheadCount = Number(wt.aheadCount) || 0;
      const historyAheadCount = Number(wt.historyAheadCount) || 0;
      let tags = [];
      if (wt.isMain) tags.push('<span class="badge badge-success">Main 工作区</span>');
      if (wt.branch) tags.push(`<span class="badge" title="${escapeHtml(wt.branch)}">${escapeHtml(wt.branch)}</span>`);
      if (!wt.existsOnDisk) tags.push('<span class="badge badge-danger">磁盘已失联</span>');
      if (wt.isDirty) tags.push(`<span class="badge badge-warning">未提交修改 (${dirtyCount})</span>`);
      if (aheadCount > 0) {
        if (wt.deliveredViaBranch) {
          // 传递吸收判定命中：提交的机械领先是过时快照，成果已经由载体分支进入主干
          tags.push(`<span class="badge badge-success" title="提交历史领先 ${historyAheadCount || aheadCount} 个提交，但这些提交已全部包含在已合入主干的分支 ${escapeHtml(wt.deliveredViaBranch)} 中，成果已经交付。本 Worktree 为过时快照：合并会带回旧内容，确认后可直接移除">✓ 成果已经由 ${escapeHtml(wt.deliveredViaBranch)} 进入主干</span>`);
        } else {
          tags.push(`<span class="badge badge-success" title="分支文件内容相对 Main 仍有实际差异，提交历史领先 ${historyAheadCount || aheadCount} 个提交">领先 ${aheadCount} 提交</span>`);
        }
      } else if (wt.isContentEqualToMain && historyAheadCount > 0) {
        tags.push(`<span class="badge badge-success" title="提交历史领先 ${historyAheadCount} 个提交，但分支改动已被主干吸收（revert 抵消 / cherry-pick / squash 合入等），合入主干不会产生实际变化">内容已与主干同步</span>`);
      }
      // 上锁/编辑工具放在标题行内（与标题 y 轴居中）。
      // 主工作区不提供上锁入口；失联工作区无法执行 git 锁操作，退化为只读徽标；
      // 上锁徽标本身就是开关：已加锁点击解锁，未上锁点击上锁
      let lockTool = '';
      if (wt.isLocked) {
        lockTool = wt.existsOnDisk
          ? `<button class="wt-lock-btn locked" type="button" data-action="wt-lock-toggle" title="已加锁：git 拒绝对该工作区执行移除/清理。点击解锁"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> 已加锁</button>`
          : '<span class="badge" title="已加锁（工作区失联，请先恢复目录后再操作）"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> 已加锁</span>';
      } else if (wt.existsOnDisk && !wt.isPrunable) {
        lockTool = wt.isMain
          ? ''
          : `<button class="wt-lock-btn" type="button" data-action="wt-lock-toggle" title="点击上锁：上锁后 git 会拒绝移除/清理该工作区（保护现场）"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg> 未上锁</button>`;
      }
      const editTool = `<button class="wt-edit-btn" type="button" data-action="wt-edit-info" title="编辑工作区名称（应用内标识）"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg></button>`;

      const dirName = wt.path.split('/').filter(Boolean).pop() || wt.path;
      // 别名（应用内命名）存在时作为主标签展示，原目录名降级为徽标
      const displayName = wt.name || dirName;
      if (wt.name) tags.unshift(`<span class="badge wt-name-badge" title="目录名：${escapeHtml(dirName)}">${escapeHtml(dirName)}</span>`);
      // 提交人/提交说明是外部可控的 Git 元数据，必须逐字段转义后再进 HTML
      let lastInfo = wt.lastCommit
        ? `最新提交: ${escapeHtml(wt.lastCommit.relativeTime)} by ${escapeHtml(wt.lastCommit.author)} · "${escapeHtml(wt.lastCommit.subject)}"`
        : '';

      div.innerHTML = `
          <div class="item-main">
            <div class="item-header-row">
              <div class="item-name" title="${escapeHtml(wt.path)}">
                <span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></span>
                <span>${escapeHtml(displayName)}</span>
              </div>
              <div class="item-tags">${tags.join(' ')}</div>
              <div class="wt-title-tools">${lockTool}${editTool}</div>
            </div>
            <div class="item-path-box">
              <span class="item-path-text">${escapeHtml(wt.path)}</span>
              <button class="copy-path-btn" data-action="wt-copy-path" title="复制完整路径">复制</button>
            </div>
            ${lastInfo ? `<div class="item-desc">${lastInfo}</div>` : ''}
            ${!wt.existsOnDisk || wt.isPrunable ? '<div class="item-alert">该 Worktree 已损坏或可被安全 prune 清理</div>' : ''}
          </div>
          <div class="item-actions">
            <div class="item-actions-diff-group">
              ${wt.isDirty ? `<button class="btn-outline" data-action="wt-uncommitted-diff" style="color: var(--warning); border-color: rgba(210, 153, 34, 0.4);">未提交 Diff (${dirtyCount})</button>` : ''}
              ${wt.existsOnDisk ? `<button class="btn-outline" data-action="wt-open-commits" title="${wt.isMain ? '查看主干完整提交历史' : '查看该分支相对主干的提交记录'}">提交记录</button>` : ''}
              <button class="btn-outline" data-action="wt-diff-vs-main">与主干对比</button>
            </div>
            ${wt.isMain ? '<button class="btn-outline" data-action="wt-pull" title="从远程拉取当前分支最新提交（仅快进，分叉时不会自动合并）">Pull</button>' : ''}
            ${!isSafeMain ? `<button class="btn-danger btn-remove-wt" id="btn-rm-wt-${encodeURIComponent(wt.path).replace(/%/g, '_')}" data-action="wt-remove">移除</button>` : ''}
          </div>
        `;
      // 事件闭包直引 wt 对象，路径等含特殊字符的实参不再经内联字符串往返（CSP 迁移）
      bindActions(div, {
        'wt-copy-path': (el) => copyText(wt.path, el),
        'wt-uncommitted-diff': () => viewUncommittedDiff(wt.path),
        'wt-open-commits': () => openCommitsDrawer(wt.path),
        'wt-diff-vs-main': () => viewDiffAgainstMain(wt.path),
        'wt-pull': (el) => pullMainWorktree(el, wt.path),
        'wt-lock-toggle': () => toggleWorktreeLock(wt),
        'wt-edit-info': () => openEditWorktreeModal(wt),
        'wt-remove': () => removeWt(wt.path)
      });
      return div;
    }

    /* 就地刷新单个 Worktree 条目（锁状态/别名等纯展示字段变化时用，
       避免为展示层变化承担整页 inspect 的开销） */
    function refreshWorktreeItemInPlace(worktreePath) {
      const wt = currentWorktrees.find(w => w.path === worktreePath);
      if (!wt) return;
      const existing = document.getElementById('wt-item-' + encodeURIComponent(worktreePath).replace(/%/g, '_'));
      if (!existing) {
        renderFilteredLists();
        return;
      }
      existing.replaceWith(createWorktreeItemDom(wt));
    }

    function createBranchItemDom(b, mainBranch) {
      const div = document.createElement('div');
      div.className = 'list-item';
      div.id = 'br-item-' + encodeURIComponent(b.name).replace(/%/g, '_');

      let tags = [];
      if (b.isMain) tags.push('<span class="badge badge-success">主分支</span>');
      if (b.inUseByWorktree) tags.push('<span class="badge">Worktree 绑定中</span>');
      if (b.isMerged) {
        tags.push(`<span class="badge" title="${b.isDirectlyMerged ? '分支提交已直接进入主分支历史' : '分支改动已通过内容或协调分支进入主分支'}">${b.isDirectlyMerged ? '已合入主干' : '内容已合入主干'}</span>`);
      } else if (b.deliveredViaBranch) {
        // 传递吸收判定命中：原始提交不再是主干祖先（如 squash 合并后的开发分支快照），
        // 但成果已经由载体分支进入主干，展示交付事实并引导删除而非合并
        tags.push(`<span class="badge badge-success" title="分支提交已全部包含在已合入主干的分支 ${escapeHtml(b.deliveredViaBranch)} 中，成果已经交付。本分支为过时快照：合并会带回旧内容，建议直接删除">成果已经由 ${escapeHtml(b.deliveredViaBranch)} 合入主干（过时快照）</span>`);
      }

      div.innerHTML = `
        <div class="item-main">
          <div class="item-header-row">
            <div class="item-name">
              <span><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg></span>
              <span>${escapeHtml(b.name)}</span>
            </div>
            <div class="item-tags">${tags.join(' ')}</div>
          </div>
          <div class="item-desc">${escapeHtml(b.relativeTime)} 由 ${escapeHtml(b.author)} 提交: "${escapeHtml(b.subject || '-')}"</div>
          ${b.redundancyReason ? `<div class="item-alert">${escapeHtml(b.redundancyReason)}${b.isStaleOnly ? ' <span class="stale-delete-hint">（谨慎删除）</span>' : ''}</div>` : ''}
          ${b.historicalIntegration && b.historicalIntegration.currentDifferencePaths.length
            ? `<div class="item-desc" title="${escapeHtml(b.historicalIntegration.currentDifferencePaths.join('\n'))}">历史整合提交后仍有 ${b.historicalIntegration.currentDifferencePaths.length} 个差异文件，均可由后续主分支提交解释（悬停查看路径）。</div>`
            : ''}
          ${!b.isMain && !b.isMerged && b.contentComparison && b.contentComparison.changedCount > 0
            ? `<div class="item-desc" title="${escapeHtml(b.contentComparison.differentPaths.join('\n'))}">与 ${escapeHtml(mainBranch)} 比较：分支改动的 ${b.contentComparison.changedCount} 个文件中，${b.contentComparison.equalCount} 个当前内容一致，${b.contentComparison.differentPaths.length} 个仍有差异${b.contentComparison.differentPaths.length ? '（悬停查看路径）' : ''}。需核对后删除。</div>`
            : ''}
        </div>
        <div class="item-actions">
          <button class="btn-outline" data-action="br-open-commits" title="${b.isMain ? '查看主干完整提交历史' : '查看该分支相对主干的提交记录'}">提交记录</button>
          ${!b.isMain ? `<button class="btn-outline" data-action="br-diff-vs-main" title="以「仅已提交」模式对比该分支与主分支（仅比较已提交内容，无 Worktree 的分支也可用）">与主分支对比</button>` : ''}
          ${!b.isMain && !b.inUseByWorktree ? `<button class="btn-danger" id="btn-del-br-${encodeURIComponent(b.name).replace(/%/g, '_')}" data-action="br-del">删除</button>` : ''}
        </div>
      `;
      // 事件闭包直引 b 对象，分支名不再经内联字符串往返（CSP 迁移）
      bindActions(div, {
        'br-open-commits': () => openBranchCommitsDrawer(b.name),
        'br-diff-vs-main': () => viewBranchDiffAgainstMain(b.name),
        'br-del': () => delBranch(b.name, !(b.isMerged || b.deliveredViaBranch))
      });
      return div;
    }

    function renderBranches(branches, mainBranch, keyword) {
      const container = document.getElementById('brList');
      if (!branches || branches.length === 0) {
        container.innerHTML = `<div class="loading">${keyword ? '没有匹配的分支' : '无本地分支'}</div>`;
        return;
      }

      const sortedBranches = [...branches].sort((a, b) => {
        // 安全可删优先；陈旧但仍有未解释差异的分支放到末尾，避免误导用户先删它们。
        const priority = (branch) => branch.isSafeToDelete ? 0 : (branch.isStaleOnly ? 2 : 1);
        const aPriority = priority(a);
        const bPriority = priority(b);
        if (aPriority !== bPriority) return aPriority - bPriority;
        return b.daysOld - a.daysOld;
      });

      container.innerHTML = '';
      sortedBranches.forEach(b => {
        container.appendChild(createBranchItemDom(b, mainBranch));
      });
    }

    function updateBranchAfterWorktreeRemoval(branchName) {
      const branch = currentBranches.find(b => b.name === branchName);
      if (!branch) return;

      branch.inUseByWorktree = false;
      branch.isSafeToDelete = !branch.isMain && branch.isMerged;
      branch.isStaleOnly = !branch.isMain && branch.isStale && !branch.isSafeToDelete;
      if (branch.isSafeToDelete) {
        branch.redundancyReason = branch.isDirectlyMerged
          ? '已合并至主分支且无 Worktree 引用 (安全可删)'
          : '分支改动已合入主分支且无 Worktree 引用 (安全可删)';
      } else if (branch.isStaleOnly) {
        branch.redundancyReason = `超过 ${branch.daysOld} 天未活动陈旧分支`;
      } else {
        branch.redundancyReason = null;
      }

      const itemDom = document.getElementById(`br-item-${encodeURIComponent(branchName).replace(/%/g, '_')}`);
      if (itemDom) {
        // 仅替换解除绑定的分支条目，保留其他列表项和滚动位置。
        itemDom.replaceWith(createBranchItemDom(branch, currentMainBranch));
      }
    }

    /**
     * 主工作区 Pull 按钮（契约 §19）：对主工作区执行仅快进拉取并做非阻断反馈。
     * 反馈时序遵循 §17.2 教训：只有服务确认结果后才提示——changed 提示「已拉取最新」
     * 并复用 inspectRepo 刷新当前仓库，未变化提示「已是最新」，失败按输出末行的
     * 中文修复提示摘要提示；网络层异常走 notifyRequestFailure。按钮全程置忙，
     * finally 恢复（刷新重渲染后按钮已随 DOM 重建，恢复操作对游离节点无害）。
     * @param {HTMLButtonElement} btn - 触发本次拉取的 Pull 按钮
     * @param {string} worktreePath - 主工作区绝对路径
     */
    async function pullMainWorktree(btn, worktreePath) {
      if (!btn || btn.disabled) return;
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = '拉取中…';
      try {
        const res = await fetch('/api/worktree-pull', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ worktree: worktreePath })
        });
        const data = await res.json();
        if (!data.ok) {
          // 简要原因优先取输出末行（后端把中文修复提示固定追加在末尾），
          // 无 output 时（参数/边界类 400）退回 error 字段
          const reason = (typeof data.output === 'string' && data.output.trim())
            ? data.output.trim().split('\n').filter(Boolean).pop()
            : (data.error || 'git 命令执行失败');
          showToast('拉取失败：' + reason);
          return;
        }
        if (!data.changed) {
          showToast('已是最新');
          return;
        }
        showToast('已拉取最新');
        // 拉取到新提交后主工作区的 ahead/最新提交展示已过时，复用既有刷新入口全量刷新
        if (currentRepo) await inspectRepo(currentRepo);
      } catch (err) {
        notifyRequestFailure(err, '拉取失败：' + toDisplayErrorMessage(err, '无法连接本地服务'));
      } finally {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    }

    /* 优化 1：精细化单个 Worktree 移除判断与单项 DOM 剔除 */
    async function removeWt(worktreePath) {
      const worktree = currentWorktrees.find(w => w.path === worktreePath);
      const branchName = worktree?.branch || '';
      const removalOptions = await requestWorktreeRemoval(worktreePath, branchName);
      if (!removalOptions) return;

      const domKey = encodeURIComponent(worktreePath).replace(/%/g, '_');
      const btn = document.getElementById(`btn-rm-wt-${domKey}`);
      if (btn) {
        btn.disabled = true;
        btn.textContent = '移除中...';
      }

      try {
        const res = await fetch('/api/remove-worktree', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            repoPath: currentRepo,
            worktreePath,
            branchName,
            force: true,
            deleteBranch: removalOptions.deleteBranch
          })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error);

        const checkRes = await fetch(`/api/check-worktree?path=${encodeURIComponent(currentRepo)}&worktree=${encodeURIComponent(worktreePath)}`);
        const checkData = await checkRes.json();

        if (!checkData.exists) {
          const itemDom = document.getElementById(`wt-item-${domKey}`);
          if (itemDom) {
            itemDom.style.opacity = '0';
            itemDom.style.transform = 'translateX(20px)';
            await new Promise(resolve => setTimeout(resolve, 250));
            itemDom.remove();
          }

          currentWorktrees = currentWorktrees.filter(w => w.path !== worktreePath);
          if (branchName) {
            if (data.branchDeleted) {
              currentBranches = currentBranches.filter(b => b.name !== branchName);
              const branchDom = document.getElementById(`br-item-${encodeURIComponent(branchName).replace(/%/g, '_')}`);
              if (branchDom) {
                branchDom.style.opacity = '0';
                branchDom.style.transform = 'translateX(20px)';
                await new Promise(resolve => setTimeout(resolve, 250));
                branchDom.remove();
              }
            } else {
              // 分支保留或删除失败时，解除 Worktree 绑定并恢复分支操作按钮。
              updateBranchAfterWorktreeRemoval(branchName);
            }
          }

          updateMetrics();
          updateListCountBadges();
          populateDiffSelectors();
          if (data.branchDeleteError) {
            alert(`Worktree 已移除，但分支「${data.branchName || branchName}」删除失败：${data.branchDeleteError}`);
          }
        } else {
          alert('Worktree 尚未被完全移除，请重试或强制清理。');
          if (btn) {
            btn.disabled = false;
            btn.textContent = '移除';
          }
        }
      } catch (err) {
        notifyRequestFailure(err, '移除失败: ' + toDisplayErrorMessage(err, '无法连接本地服务'));
        if (btn) {
          btn.disabled = false;
          btn.textContent = '移除';
        }
      }
    }

    /* 优化 2：精细化单个分支删除判断与单项 DOM 剔除 */
    async function delBranch(branchName, force) {
      const mode = force ? '强制删除 (分支未完全合入)' : '安全删除';
      if (!confirm(`确认${mode}本地分支 [${branchName}]?`)) return;

      const domKey = encodeURIComponent(branchName).replace(/%/g, '_');
      const btn = document.getElementById(`btn-del-br-${domKey}`);
      if (btn) {
        btn.disabled = true;
        btn.textContent = '删除中...';
      }

      try {
        const res = await fetch('/api/delete-branch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoPath: currentRepo, branchName, force })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error);

        const checkRes = await fetch(`/api/check-branch?path=${encodeURIComponent(currentRepo)}&branch=${encodeURIComponent(branchName)}`);
        const checkData = await checkRes.json();

        if (!checkData.exists) {
          currentBranches = currentBranches.filter(b => b.name !== branchName);
          // 分支已删除，立即刷新指标与列表计数徽标，避免分支数显示滞后。
          updateMetrics();
          updateListCountBadges();

          const itemDom = document.getElementById(`br-item-${domKey}`);
          if (itemDom) {
            itemDom.style.opacity = '0';
            itemDom.style.transform = 'translateX(20px)';
            setTimeout(() => itemDom.remove(), 250);
          } else {
            renderFilteredLists();
          }
        } else {
          alert('分支未能成功删除，请确认是否有未提交冲突。');
          if (btn) {
            btn.disabled = false;
            btn.textContent = '删除';
          }
        }
      } catch (err) {
        notifyRequestFailure(err, '删除失败: ' + toDisplayErrorMessage(err, '无法连接本地服务'));
        if (btn) {
          btn.disabled = false;
          btn.textContent = '删除';
        }
      }
    }

    /* 优化 3：Diff 选择器更新与操作 */

    /* 汇总 Worktree 与本地分支为统一选项集合；identity = kind:value，
       worktree 的 value 是路径、branch 的 value 是分支名，kind 前缀保证同名不冲突 */
    function buildDiffRefOptions() {
      const options = [];
      currentWorktrees.forEach(w => {
        const broken = w.existsOnDisk === false || w.isPrunable;
        const dirName = w.path.split('/').filter(Boolean).pop() || w.path;
        options.push({
          kind: 'worktree',
          value: w.path,
          identity: `worktree:${w.path}`,
          label: `${w.isMain ? '[Main] ' : ''}${w.branch || 'HEAD'} (${dirName})${broken ? ' · 已失联' : ''}`,
          searchText: `${w.branch || ''} ${dirName} ${w.path}`,
          disabled: broken
        });
      });
      currentBranches.forEach(b => {
        options.push({
          kind: 'branch',
          value: b.name,
          identity: `branch:${b.name}`,
          label: `${b.name}`,
          searchText: b.name,
          disabled: false
        });
      });
      return options;
    }

    /* 默认基准：主 worktree 优先，其次第一个 worktree，无 worktree 时退回主分支/第一个分支 */
    function defaultDiffBaseIdentity(options) {
      const mainWt = currentWorktrees.find(w => w.isMain) || currentWorktrees[0];
      if (mainWt) return `worktree:${mainWt.path}`;
      const fallback = options.find(o => o.kind === 'branch' && o.value === currentMainBranch)
        || options.find(o => o.kind === 'branch');
      return fallback ? fallback.identity : '';
    }

    /* 默认对比对象：第一个非主 worktree，退回主 worktree，无 worktree 时退回分支 */
    function defaultDiffTargetIdentity(options) {
      const preferredWt = currentWorktrees.find(w => !w.isMain) || currentWorktrees[0];
      if (preferredWt) return `worktree:${preferredWt.path}`;
      const fallback = options.find(o => o.kind === 'branch' && o.value === currentMainBranch)
        || options.find(o => o.kind === 'branch');
      return fallback ? fallback.identity : '';
    }

    function populateDiffSelectors() {
      const baseSel = document.getElementById('diffBaseSelect');
      const targetSel = document.getElementById('diffTargetSelect');
      if (!baseSel || !targetSel) return;

      const options = buildDiffRefOptions();
      const rebuild = (sel, fallbackIdentity) => {
        // 刷新后保留当前有效选择；身份串已不在选项集中时回退默认值
        const kept = sel.value && options.some(o => o.identity === sel.value) ? sel.value : fallbackIdentity;
        sel.innerHTML = '';
        if (options.length === 0) {
          sel.innerHTML = '<option value="">无可用 Worktree 或分支</option>';
          return;
        }
        options.forEach(o => {
          const opt = document.createElement('option');
          opt.value = o.identity;
          opt.textContent = o.label;
          sel.appendChild(opt);
        });
        if (kept) sel.value = kept;
      };

      rebuild(baseSel, defaultDiffBaseIdentity(options));
      rebuild(targetSel, defaultDiffTargetIdentity(options));

      // 同步可搜索下拉的触发文本（列表在每次展开时按 select 选项重建）
      if (diffBasePicker) diffBasePicker.refresh();
      if (diffTargetPicker) diffTargetPicker.refresh();
    }

    /* 把 kind:value 身份串解析回类型与取值；无前缀的旧值一律按 worktree 兼容 */
    function splitRefIdentity(identity) {
      const str = identity || '';
      const idx = str.indexOf(':');
      if (idx <= 0) return { kind: 'worktree', value: str };
      return {
        kind: str.slice(0, idx) === 'branch' ? 'branch' : 'worktree',
        value: str.slice(idx + 1)
      };
    }

    /* 恢复场景：按身份串设置两个选择器；任一身份串不在选项集中返回 false，由调用方给出中文提示 */
    function applyDiffIdentitiesOrReport(baseIdentity, targetIdentity) {
      const baseSel = document.getElementById('diffBaseSelect');
      const targetSel = document.getElementById('diffTargetSelect');
      let ok = true;
      if (baseIdentity) {
        if ([...baseSel.options].some(o => o.value === baseIdentity)) baseSel.value = baseIdentity;
        else ok = false;
      }
      if (targetIdentity) {
        if ([...targetSel.options].some(o => o.value === targetIdentity)) targetSel.value = targetIdentity;
        else ok = false;
      }
      return ok;
    }

    /* 两个可搜索下拉触发器文本与选择状态同步（交换/程序化设置后调用） */
    function refreshDiffPickerTriggers() {
      if (diffBasePicker) diffBasePicker.refresh();
      if (diffTargetPicker) diffTargetPicker.refresh();
    }

    function swapDiffTargets() {
      const baseSel = document.getElementById('diffBaseSelect');
      const targetSel = document.getElementById('diffTargetSelect');
      // 身份串整体对调（kind 与 value 一起交换）
      const temp = baseSel.value;
      baseSel.value = targetSel.value;
      targetSel.value = temp;
      refreshDiffPickerTriggers();
      fetchAndRenderRefDiff(null, true);
    }

    // 落后状态默认隐藏主干独有文件；用户明确查看时，反向对比即可看到这些更新。
    function showBehindChanges() {
      const baseSel = document.getElementById('diffBaseSelect');
      const targetSel = document.getElementById('diffTargetSelect');
      if (!baseSel || !targetSel || baseSel.value === targetSel.value) return;

      const temp = baseSel.value;
      baseSel.value = targetSel.value;
      targetSel.value = temp;
      refreshDiffPickerTriggers();
      currentDiffType = 'ref';
      currentDiffBase = baseSel.value;
      currentDiffTarget = targetSel.value;
      currentDiffMode = 'committed';
      fetchAndRenderRefDiff('committed', true);
    }

    function viewDiffAgainstMain(targetWorktreePath) {
      // 与主干对比保持 Worktree 类型（包含目标 Worktree 未提交修改），基准固定为主 worktree
      const mainWt = currentWorktrees.find(w => w.isMain) || currentWorktrees[0];
      if (!mainWt) return;
      const baseSel = document.getElementById('diffBaseSelect');
      const targetSel = document.getElementById('diffTargetSelect');
      baseSel.value = `worktree:${mainWt.path}`;
      targetSel.value = `worktree:${targetWorktreePath}`;
      refreshDiffPickerTriggers();
      switchTab('diff', false);
      fetchAndRenderRefDiff(null, true);
    }

    /* 分支列表快捷入口：branch↔branch、仅已提交模式对比任意本地分支与主分支（无 Worktree 也可用） */
    function viewBranchDiffAgainstMain(branchName) {
      if (!currentMainBranch) {
        alert('未能识别当前仓库的主分支，无法对比');
        return;
      }
      if (currentMainBranch === branchName) {
        alert('该分支即为主分支，无需对比');
        return;
      }
      switchTab('diff', false); // 先触发 populateDiffSelectors，确保选项基于最新数据
      const baseIdentity = `branch:${currentMainBranch}`;
      const targetIdentity = `branch:${branchName}`;
      if (!applyDiffIdentitiesOrReport(baseIdentity, targetIdentity)) {
        document.getElementById('diffResultsContainer').innerHTML =
          `<div class="empty-diff-box" style="color: var(--warning);">分支 ${escapeHtml(branchName)} 或主分支 ${escapeHtml(currentMainBranch)} 已不存在，无法比对。</div>`;
        return;
      }
      refreshDiffPickerTriggers();
      fetchAndRenderRefDiff('committed', true);
    }

    /* 查看指定 Worktree 未提交修改 (Dirty Diff) */
    async function viewUncommittedDiff(worktreePath) {
      // 未提交代码只属于当前工作区；Base 与 Target 必须指向同一个 Worktree，才能进入自审模式。
      if (!worktreePath || !currentWorktrees.some(w => w.path === worktreePath)) return;

      // 先进入 Diff 标签页，让选择器完成初始化，再写入同一工作区值。
      switchTab('diff');
      const baseSel = document.getElementById('diffBaseSelect');
      const targetSel = document.getElementById('diffTargetSelect');

      // 合并语义：沿用 main 的自审事实认定（未提交代码只属于单一工作区，
      // Base 与 Target 必须同为该 Worktree），写入值采用本分支的 kind:value 身份串机制
      if (baseSel) baseSel.value = `worktree:${worktreePath}`;
      if (targetSel) targetSel.value = `worktree:${worktreePath}`;
      refreshDiffPickerTriggers();

      currentUncommittedPath = worktreePath;
      currentDiffMode = 'uncommitted';

      await fetchAndRenderRefDiff('uncommitted', false);
    }

    /* 统一 Diff 比对入口：读取两个选择器的 kind:value 身份串调用 /api/diff-refs，
       worktree↔worktree 组合也走该接口，与 worktree↔branch 语义一致 */
    async function fetchAndRenderRefDiff(requestedMode = null, pushHistory = false, modeOnly = false) {
      const baseSel = document.getElementById('diffBaseSelect');
      const targetSel = document.getElementById('diffTargetSelect');
      const container = document.getElementById('diffResultsContainer');
      const base = baseSel?.value || '';
      const target = targetSel?.value || '';

      if (!base || !target) {
        alert('请选择两个 Worktree 或分支进行对比');
        return;
      }

      const isSameRef = base === target;
      if (isSameRef) {
        // 同一 Worktree / 同一分支自比：自动锁定 uncommitted 自审模式（现有行为保持）
        currentDiffMode = 'uncommitted';
      }

      currentDiffType = 'ref';
      currentDiffBase = base;
      currentDiffTarget = target;
      if (requestedMode) {
        currentDiffMode = requestedMode;
      }
      syncStateToUrl(pushHistory);

      // 模式切换沿用现有摘要与 Stash 弹层，只等待文件列表及模式相关数字更新。
      const preserveShell = modeOnly && container.querySelector('#diffModeControl')
        && container.dataset.renderedRepo === currentRepo
        && container.dataset.renderedBase === base && container.dataset.renderedTarget === target;
      if (container.dataset.renderedRepo !== currentRepo
        || container.dataset.renderedBase !== base || container.dataset.renderedTarget !== target) {
        diffFindState.open = false;
        diffFindState.query = '';
      }
      clearDiffFindMatches();
      if (!preserveShell) container.innerHTML = '<div class="loading">正在比对代码差异...</div>';

      const seq = ++diffRequestSeq;
      const baseRef = splitRefIdentity(base);
      const targetRef = splitRefIdentity(target);
      const params = new URLSearchParams({
        path: currentRepo,
        sourceType: baseRef.kind,
        source: baseRef.value,
        targetType: targetRef.kind,
        target: targetRef.value
      });
      if (currentDiffMode) {
        params.set('mode', currentDiffMode);
      }

      try {
        const res = await fetch(`/api/diff-refs?${params}`);
        const data = await res.json();
        // 防竞态：响应返回时已有更新的比对请求在途，直接丢弃旧结果，避免覆盖新视图
        if (seq !== diffRequestSeq) return;
        if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);

        const diff = data.diff;
        currentDiffComparison = diff;
        if (diff.effectiveMode) {
          currentDiffMode = diff.effectiveMode;
        }
        renderDiffView(diff, preserveShell);
      } catch (err) {
        if (seq !== diffRequestSeq) return;
        const errorHtml = `<div class="empty-diff-box" style="color: var(--danger);">Diff 计算失败: ${escapeHtml(toDisplayErrorMessage(err, '无法连接本地服务'))}</div>`;
        if (preserveShell) container.querySelector('#diffFileListContent').innerHTML = errorHtml;
        else container.innerHTML = errorHtml;
      }
    }

    /* 兼容旧入口：历史调用点统一转发到 ref 比对流程 */
    async function fetchAndRenderDiff(requestedMode = null, pushHistory = false) {
      return fetchAndRenderRefDiff(requestedMode, pushHistory);
    }

    /* 拉取最新仓库分析数据并刷新外层列表/徽标。
       任何改变提交关系的写操作（cherry-pick/revert/stash 等）后都应调用，
       保证 worktree 列表的领先/同步徽标与提交抽屉徽章一致 */
    async function refreshRepoInspectData() {
      if (!currentRepo) return;
      const res = await fetch(`/api/inspect?path=${encodeURIComponent(currentRepo)}`);
      const data = await res.json();
      if (data.ok) {
        currentWorktrees = data.worktrees || [];
        currentBranches = data.branches || [];
        currentMainBranch = data.mainBranch;
        updateMetrics();
        renderFilteredLists();
        populateDiffSelectors();
      }
    }

    /* Diff Tab 内部专用：一键刷新当前 Diff 视图及仓库最新状态 */
    async function refreshCurrentDiff() {
      const btn = document.getElementById('diffRefreshBtn');
      if (btn) {
        btn.disabled = true;
        btn.textContent = '刷新中...';
      }

      try {
        // 先同步更新仓库分析数据（以防最新提交或分支发生变化）
        await refreshRepoInspectData();

        // 根据当前 Diff 模式重新比对刷新
        if (currentDiffType === 'uncommitted' && currentUncommittedPath) {
          await viewUncommittedDiff(currentUncommittedPath);
        } else if (currentDiffBase && currentDiffTarget) {
          await fetchAndRenderRefDiff();
        } else {
          // 如果尚未进行比对，触发一次当前所选选择器的比对
          const b = document.getElementById('diffBaseSelect')?.value;
          const t = document.getElementById('diffTargetSelect')?.value;
          if (b && t && b !== t) {
            await fetchAndRenderRefDiff();
          }
        }
      } catch (e) {
        console.error('refreshCurrentDiff error:', e);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.textContent = '刷新状态';
        }
      }
    }

    function escapeHtml(str) {
      return (str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    /**
     * 把 fetch 异常转成可展示的中文错误文案。
     * 网络层失败（服务未启动、连接被拒等）抛出的 TypeError 其 message 是浏览器英文原文，
     * 统一替换为中文兜底；API 业务错误沿用服务端返回的 message。
     * @param {unknown} err - catch 到的异常
     * @param {string} fallback - 网络层失败或异常无 message 时展示的中文文案
     * @returns {string}
     */
    function toDisplayErrorMessage(err, fallback) {
      if (err instanceof TypeError) return fallback; // fetch 网络层失败
      return (err && err.message) || fallback;
    }

    /**
     * 服务/网络原因导致的请求失败统一提示入口（DEF-006）。
     * 服务被 kill 的瞬间在途请求会失败，若此处弹阻塞式 alert，会挂起渲染层全部 JS，
     * 导致恢复遮罩、自动重载全部冻结，直到人工点掉弹框。因此按三条路径分流：
     * - 服务已知中断（serviceKnownDown）：恢复遮罩/提示条已在向用户传达中断，仅 console.warn，不弹任何框；
     * - fetch 网络层失败（TypeError，服务不可达）：用右上角自动消失的 toast 非阻断提示；
     * - 其余（服务正常响应后的业务错误）：沿用阻塞 alert，保持既有行为不变。
     * @param {unknown} err - catch 到的异常
     * @param {string} message - 已格式化的完整提示文案（通常为前缀 + toDisplayErrorMessage 结果）
     */
    function notifyRequestFailure(err, message) {
      if (serviceKnownDown) {
        console.warn('服务中断期间请求失败（由恢复遮罩/提示条承担提示）:', message);
        return;
      }
      if (err instanceof TypeError) {
        showToast(message);
        return;
      }
      alert(message);
    }

    /* toast 自动消失定时器；重复失败会重置定时并覆盖文案，reload 后自然重置无需额外清理 */
    let requestFailureToastTimer = null;

    /**
     * 右上角自动消失的非阻断失败提示（DEF-006）。
     * 用内联样式 + app.css 既有 CSS 变量实现，不新增样式表；pointer-events:none
     * 保证不拦截右上角按钮点击；z-index 1300 高于弹层(1150)但低于服务状态覆盖层(2000)。
     * @param {string} message - 要展示的完整提示文案
     */
    function showToast(message) {
      let toast = document.getElementById('requestFailureToast');
      if (!toast) {
        toast = document.createElement('div');
        toast.id = 'requestFailureToast';
        toast.style.cssText = [
          'position:fixed', 'top:16px', 'right:16px', 'z-index:1300',
          'max-width:360px', 'padding:10px 14px',
          'background:var(--card-bg)', 'color:var(--text-bright)',
          'border:1px solid var(--border)', 'border-left:3px solid var(--danger)',
          'border-radius:6px', 'font-size:13px', 'line-height:1.5',
          'word-break:break-all', 'box-shadow:0 4px 12px rgba(0,0,0,0.3)',
          'pointer-events:none', 'opacity:0', 'transition:opacity 0.2s'
        ].join(';');
        document.body.appendChild(toast);
      }
      toast.textContent = message;
      toast.style.opacity = '1';
      if (requestFailureToastTimer) clearTimeout(requestFailureToastTimer);
      requestFailureToastTimer = setTimeout(() => {
        toast.style.opacity = '0';
      }, 3000);
    }

    /**
     * CSP 迁移基础设施：在容器内为带 data-action 标记的元素绑定监听器。
     * CSP script-src 'self' 禁止内联事件处理器（契约 §14），动态 HTML 模板统一改为
     * data-action 标记 + innerHTML 写入后经本函数逐元素 addEventListener；
     * 处理器实参是元素与事件，闭包可直接引用外层数据对象，避免经字符串再解析。
     * @param {HTMLElement|Document} root - 查找范围（容器或 document）
     * @param {Record<string, (el: HTMLElement, event: Event) => void>} handlers - action 名到处理器的映射
     */
    function bindActions(root, handlers) {
      root.querySelectorAll('[data-action]').forEach((el) => {
        const handler = handlers[el.dataset.action];
        if (handler) el.addEventListener('click', (event) => handler(el, event));
      });
    }

    /**
     * 为一批提交卡片绑定事件（提交抽屉与 MR 提交列表共用同一卡片结构）：
     * 提交抽屉的卡片固定展示详情，点击切换 Diff；MR 列表仍保留点击切换详情的行为；SHA 点击复制完整哈希。
     * 卡片经 data-c-idx 携带本批次内的索引，与 commits 一一对齐；已绑定的
     * 元素以 data-bound 标记跳过，「加载更多」追加渲染时不重复绑定旧卡片。
     * @param {HTMLElement} rootEl - 卡片所在容器
     * @param {Array<{hash: string}>} commits - 本次渲染批次的提交数据
     * @param {boolean} [expandByDefault] - 是否默认展开本批次的新卡片
     * @param {boolean} [keepExpanded] - 是否固定展开详情，并将卡片点击用于切换 Diff
     */
    function bindCommitCards(rootEl, commits, expandByDefault = false, keepExpanded = false) {
      rootEl.querySelectorAll('[data-action="commit-toggle"]').forEach((card) => {
        if (card.dataset.bound) return;
        card.dataset.bound = '1';
        const commit = commits[Number(card.dataset.cIdx)];
        if (!commit) return;
        card.addEventListener('click', (event) => {
          if (!keepExpanded) {
            toggleCommitDetail(card, commit.hash);
            return;
          }
          // 卡片内的操作控件和 Diff 阅读区域各自处理点击，选中文字时也不切换面板。
          if (event.target.closest('button, select, input, a, .commit-diff-section') || window.getSelection()?.toString()) return;
          toggleCommitDiff(card.querySelector('.commit-detail'), commit.hash);
        });
        const hashEl = card.querySelector('[data-action="commit-copy-hash"]');
        if (hashEl) {
          hashEl.addEventListener('click', (event) => {
            event.stopPropagation();
            copyText(commit.hash, hashEl);
          });
        }
        if (expandByDefault) toggleCommitDetail(card, commit.hash);
      });
    }

    /* 格式化代码块 */
    function formatDiffLines(rawDiff) {
      if (!rawDiff) return '<div style="padding: 16px; color: var(--text-muted);">无代码差异或二进制文件变更</div>';
      const lines = rawDiff.split('\n');
      return lines.map(line => {
        const escaped = escapeHtml(line);
        if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git')) {
          return `<span class="diff-line line-file">${escaped}</span>`;
        } else if (line.startsWith('@@')) {
          return `<span class="diff-line line-hunk">${escaped}</span>`;
        } else if (line.startsWith('+')) {
          return `<span class="diff-line line-add">${escaped}</span>`;
        } else if (line.startsWith('-')) {
          return `<span class="diff-line line-del">${escaped}</span>`;
        } else {
          return `<span class="diff-line">${escaped || '&nbsp;'}</span>`;
        }
      }).join('');
    }

    /** 清理查找标记并合并文本，避免反复输入时堆叠高亮节点。 */
    function clearDiffFindMatches() {
      const lines = new Set(diffFindState.matches.map(mark => mark.parentElement));
      lines.forEach(line => { if (line) line.textContent = line.textContent; });
      diffFindState.matches = [];
      diffFindState.index = -1;
    }

    /** 同步查找计数与按钮状态；无匹配时同时向辅助技术暴露输入错误。 */
    function syncDiffFindControls() {
      const { query, matches, index } = diffFindState;
      const status = document.getElementById('diffFindStatus');
      if (!status) return;
      status.textContent = !query ? '输入关键词' : matches.length ? `${index + 1} / ${matches.length}` : '无匹配';
      document.getElementById('diffFindInput').setAttribute('aria-invalid', String(!!query && !matches.length));
      document.querySelectorAll('[data-action="diff-find-prev"], [data-action="diff-find-next"]')
        .forEach(button => { button.disabled = !matches.length; });
    }

    /**
     * 在当前差异的源码行内进行字面量查找，折叠文件同样参与匹配。
     * @param {boolean} [scroll] - 是否滚动到首个匹配位置
     */
    function updateDiffFind(scroll = true) {
      clearDiffFindMatches();
      const { open, query } = diffFindState;
      if (open && query) {
        // 转义正则元字符，仅借助 Unicode 正则保留忽略大小写后的准确原文偏移。
        const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
        document.querySelectorAll('#diffResultsContainer .file-body .diff-line:not(.line-file):not(.line-hunk)')
          .forEach(line => {
            const text = line.textContent;
            // Diff 标头、块说明和行首的 +/-/空格标记不属于源码，避免出现伪匹配。
            if (!/^[ +\-]/.test(text)) return;
            const fragment = document.createDocumentFragment();
            let offset = 0;
            for (const match of text.slice(1).matchAll(pattern)) {
              const start = match.index + 1;
              fragment.append(document.createTextNode(text.slice(offset, start)));
              const mark = document.createElement('mark');
              mark.className = 'diff-find-match';
              mark.textContent = match[0];
              fragment.append(mark);
              diffFindState.matches.push(mark);
              offset = start + match[0].length;
            }
            if (offset) {
              fragment.append(document.createTextNode(text.slice(offset)));
              line.replaceChildren(fragment);
            }
          });
      }
      if (diffFindState.matches.length) selectDiffFindMatch(0, scroll);
      else syncDiffFindControls();
    }

    /**
     * 循环选中匹配并展开所在文件，横向长行也滚动到命中文字。
     * @param {number} index - 匹配下标，越界时循环
     * @param {boolean} [scroll] - 是否滚动定位
     */
    function selectDiffFindMatch(index, scroll = true) {
      const { matches } = diffFindState;
      if (!matches.length) return;
      matches[diffFindState.index]?.classList.remove('active');
      diffFindState.index = (index + matches.length) % matches.length;
      const mark = matches[diffFindState.index];
      mark.classList.add('active');
      const card = mark.closest('.file-diff-card');
      const header = card.querySelector('.file-header');
      setDiffFileExpanded(card, header, true);
      syncDiffFindControls();
      if (scroll) {
        mark.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
        const toolbar = document.querySelector('#diffFileListContent > .diff-tools-bar');
        const visibleTop = toolbar.getBoundingClientRect().bottom + header.getBoundingClientRect().height + 8;
        const markTop = mark.getBoundingClientRect().top;
        // 小窗口下居中位置可能落在两层吸顶区域内，补偿后保证命中行可见。
        if (markTop < visibleTop) window.scrollBy({ top: markTop - visibleTop, behavior: 'instant' });
      }
    }

    /** 打开查找并选中关键词；选中的单行源码可直接作为首次查找内容。 */
    function openDiffFind() {
      const panel = document.getElementById('diffFindPanel');
      if (!panel) return;
      const selected = window.getSelection()?.toString();
      if (selected && !/[\r\n]/.test(selected)) diffFindState.query = selected;
      diffFindState.open = true;
      panel.hidden = false;
      document.getElementById('diffFindToggle').setAttribute('aria-expanded', 'true');
      const toolbar = panel.closest('.diff-tools-bar');
      document.getElementById('diffResultsContainer').style.setProperty('--diff-toolbar-height', `${toolbar.getBoundingClientRect().height}px`);
      const input = document.getElementById('diffFindInput');
      input.value = diffFindState.query;
      input.focus({ preventScroll: true });
      input.select();
      updateDiffFind();
    }

    /** 关闭查找并清理高亮，保留关键词以便再次打开。 */
    function closeDiffFind() {
      diffFindState.open = false;
      clearDiffFindMatches();
      document.getElementById('diffFindPanel').hidden = true;
      const toggle = document.getElementById('diffFindToggle');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.focus({ preventScroll: true });
    }

    /* 手风琴开关单个文件 Diff */
    function toggleFileDiff(cardId) {
      const card = document.getElementById(cardId);
      if (card) {
        setDiffFileExpanded(card, card.querySelector('.file-header'), !card.classList.contains('expanded'));
      }
    }

    /**
     * 统一文件展开状态；从吸顶标题收起长文件时保留标题的可见位置，避免跳到列表深处。
     * @param {HTMLElement} card - 文件卡片
     * @param {HTMLElement} header - 可点击的文件标题
     * @param {boolean} expanded - 目标展开状态
     */
    function setDiffFileExpanded(card, header, expanded) {
      const headerTop = header.getBoundingClientRect().top;
      const wasSticky = !expanded && card.getBoundingClientRect().top < headerTop - 1;
      card.classList.toggle('expanded', expanded);
      header.setAttribute('aria-expanded', String(expanded));
      if (wasSticky) {
        const delta = header.getBoundingClientRect().top - headerTop;
        const drawerBody = card.closest('.commits-drawer-body');
        if (drawerBody) drawerBody.scrollTop += delta;
        else window.scrollBy({ top: delta, behavior: 'instant' });
      }
    }

    /* 全部展开 / 全部收起控制 */
    function toggleAllDiffs(expand) {
      const cards = document.querySelectorAll('.file-diff-card');
      cards.forEach(card => {
        card.classList.toggle('expanded', expand);
        card.querySelector('.file-header')?.setAttribute('aria-expanded', String(expand));
      });
    }

    /* 判断常见媒体扩展名，资源类文件在变更列表中置底展示。 */
    function isMediaFile(pathStr) {
      if (!pathStr) return false;
      const lower = pathStr.toLowerCase();
      return /\.(png|jpg|jpeg|gif|webp|svg|bmp|ico|avif|mp4|mov|webm|mp3|wav|ogg|pdf|ttf|otf|woff|woff2)$/.test(lower);
    }

    function isImageFilePath(pathStr) {
      if (!pathStr) return false;
      const lower = pathStr.toLowerCase();
      return /\.(png|jpg|jpeg|gif|webp|svg|bmp|ico|avif)$/.test(lower);
    }

    /**
     * 统一状态徽标和排序依据；增删行数不能判定文件是否新增或删除，需读取 Diff 文件头。
     * @param {object} file - 差异文件
     * @returns {'added'|'modified'|'deleted'|'untracked'} 展示状态
     */
    function getDiffFileStatus(file) {
      if (file.status === '?') return 'untracked';
      if (file.status === 'A' || /^new file mode /m.test(file.diffChunk || '')) return 'added';
      if (file.status === 'D' || /^deleted file mode /m.test(file.diffChunk || '')) return 'deleted';
      return 'modified';
    }

    /**
     * 按源码、文档、资源分组，再按后缀、状态、路径稳定排序。
     * @param {object[]} files - 原始差异文件列表，不会被修改
     * @returns {object[]} 排序后的文件列表
     */
    function sortDiffFiles(files) {
      const statusOrder = { added: 0, modified: 1, deleted: 2, untracked: 3 };
      const keyed = files.map(file => {
        const name = file.filePath.split('/').pop().toLowerCase();
        const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
        const isDocument = /^(md|markdown|mdx|rst|txt|adoc|asciidoc|tex|pdf|doc|docx|odt|rtf|xls|xlsx|csv|tsv|ppt|pptx)$/.test(extension)
          || /^(readme|license|licence|changelog|authors|copying|notice)(\.|$)/.test(name);
        const isResource = file.isImage || file.isBinary || isMediaFile(file.filePath)
          || /^(aac|flac|m4a|mpg|mpeg|avi|mkv|mp4|webm|ogg|wav|zip|gz|bz2|xz|7z|rar|tar|wasm|bin|exe|dll|so|dylib|psd|ai|sketch|fig|obj|fbx|gltf|glb|blend)$/.test(extension);
        // PDF、Office 等文档通常是二进制，文档后缀应优先于二进制兜底分类。
        return { file, extension, category: isDocument ? 1 : isResource ? 2 : 0, status: statusOrder[getDiffFileStatus(file)] };
      });
      keyed.sort((a, b) => a.category - b.category
        || a.extension.localeCompare(b.extension, 'en')
        || a.status - b.status
        || a.file.filePath.localeCompare(b.file.filePath, 'zh-CN', { numeric: true }));
      return keyed.map(item => item.file);
    }

    /* 渲染单个文件的差异卡片内容：若是图片则渲染左右对比，否则渲染代码 diff */
    function renderFileBodyContent(file, sourceRef, targetRef, repoPath, worktreePath) {
      const isImg = file.isImage || isImageFilePath(file.filePath);
      if (isImg) {
        // 工作区模式即使有两侧提交 SHA，也必须读取磁盘，才能展示未提交及新增图片。
        const rawFileUrl = `/api/raw-file?repoPath=${encodeURIComponent(repoPath || worktreePath)}&filePath=${encodeURIComponent(file.filePath)}`;
        const baseImgUrl = `${rawFileUrl}&revision=${encodeURIComponent(sourceRef)}`;
        const targetImgUrl = worktreePath
          ? `${rawFileUrl}&revision=WORKTREE&worktreePath=${encodeURIComponent(worktreePath)}`
          : `${rawFileUrl}&revision=${encodeURIComponent(targetRef)}`;

        return `
          <div class="image-diff-container">
            <div class="image-diff-box">
              <div class="image-diff-title">
                <span>◀ 基准旧图 (Base / HEAD)</span>
              </div>
              <div class="image-diff-preview-wrapper">
                <img class="image-diff-preview-img" src="${baseImgUrl}" alt="原图 (若新增则无)">
                <span class="image-diff-empty" style="display: none;">（旧版本中无此图片 / 已新增）</span>
              </div>
            </div>

            <div class="image-diff-box">
              <div class="image-diff-title">
                <span>▶ 对比新图 (Target / 当前)</span>
              </div>
              <div class="image-diff-preview-wrapper">
                <img class="image-diff-preview-img" src="${targetImgUrl}" alt="新图 (若删除则无)">
                <span class="image-diff-empty" style="display: none;">（当前版本中无此图片 / 已删除）</span>
              </div>
            </div>
          </div>
        `;
      }

      const formattedCode = formatDiffLines(file.diffChunk);
      return `<pre class="diff-pre"><code>${formattedCode}</code></pre>`;
    }

    /* Diff 摘要里的基准/对比对象徽章：branch 类型无 path，用 kind 图标区分并容错缺字段 */
    function diffRefBadgeHtml(ref) {
      const icon = ref.kind === 'branch' ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>' : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
      const name = ref.branch || ref.head || '-';
      const title = ref.path
        ? ` title="${escapeHtml(ref.path)}"`
        : (ref.kind === 'branch' ? ' title="本地分支"' : '');
      const head = ref.head ? `<code>${escapeHtml(String(ref.head).slice(0, 8))}</code>` : '<code>-</code>';
      return `<span${title}>${icon} <span class="badge">${escapeHtml(name)}</span> ${head}</span>`;
    }

    /**
     * 打开当前 Diff 的提交抽屉，基准与目标沿用正在比对的两个引用。
     * 历史提交已被基准吸收时，默认列表为空；完整历史仍可在抽屉内切换。
     */
    async function openDiffCommitsDrawer() {
      const diff = currentDiffComparison;
      if (!diff || !currentRepo || !diff.source || !diff.target) return;
      const base = diff.source.branch && diff.source.branch !== 'HEAD'
        ? diff.source.branch
        : diff.source.head;
      const target = diff.target;
      const worktreePath = target.kind === 'worktree' ? target.path : currentRepo;
      const ref = target.kind === 'branch' ? target.branch : '';
      if (!base || !worktreePath) return;
      await openCommitsDrawer(worktreePath, false, true, ref, base);
    }

    /* 渲染两个 Worktree 或分支之间的 Diff 视图 */
    function renderDiffView(diff, preserveShell = false) {
      const container = document.getElementById('diffResultsContainer');
      const restoreFindFocus = document.activeElement?.id === 'diffFindInput';
      const files = diff.files || [];
      // 服务端数值字段统一收敛为数字后再进 HTML 插值，保证异常响应也不会注入标记
      const ahead = Number(diff.ahead) || 0;
      const behind = Number(diff.behind) || 0;
      const counts = diff.counts || {};
      const uncommittedCount = Number(counts.uncommitted) || 0;
      const allCount = Number(counts.all) || 0;
      const committedCount = Number(counts.committed) || 0;
      const effectiveMode = diff.effectiveMode || 'all';

      // Stash 属于目标 Worktree，已提交模式或干净工作区仍可还原历史记录。
      const stashWorktreePath = diff.target?.kind === 'worktree' ? diff.target.path || '' : '';
      currentUncommittedPath = stashWorktreePath;

      const isBehindOnly = !diff.isSameWorktree && ahead === 0 && behind > 0;

      let syncStatusBadge = '';
      if (diff.isSameWorktree) {
        // branch↔branch 同分支与同 Worktree 自审共用该徽章，按类型区分文案
        syncStatusBadge = diff.source?.kind === 'branch'
          ? '<span class="badge badge-success">同分支自审（内容一致）</span>'
          : '<span class="badge badge-success">本地工作区自审</span>';
      } else if (diff.contentEquivalent && (diff.historyAhead > 0 || diff.historyBehind > 0)) {
        syncStatusBadge = '<span class="badge badge-success">文件内容一致（提交历史已 squash 整合）</span>';
      } else if (diff.isCommittedContentEqual) {
        syncStatusBadge = '<span class="badge badge-success">提交内容完全同步</span>';
      } else if (ahead === 0 && behind === 0) {
        syncStatusBadge = '<span class="badge badge-success">两分支提交完全同步</span>';
      } else if (isBehindOnly) {
        syncStatusBadge = `<button type="button" class="badge badge-warning diff-sync-action" data-action="diff-show-behind" title="点击反向查看基准分支引入的文件变更">落后 ${behind} 个提交 · 点击查看主干变更</button>`;
      } else {
        const parts = [];
        if (ahead > 0) parts.push(`<span class="badge badge-success">领先 ${ahead} 个提交</span>`);
        if (behind > 0) parts.push(`<span class="badge badge-warning">落后 ${behind} 个提交</span>`);
        syncStatusBadge = parts.join(' ');
      }

      let modeTipText = '';
      const isSelfDiff = !!diff.isSameWorktree || currentDiffBase === currentDiffTarget;
      // branch 类型参与比对时后端会通过 modesAvailable 限制可用模式（如无 worktree 则无未提交可看），
      // 前端据此禁用不可用的模式按钮
      const modesAvailable = Array.isArray(diff.modesAvailable)
        ? diff.modesAvailable
        : (diff.modesAvailable && typeof diff.modesAvailable === 'object'
          ? Object.keys(diff.modesAvailable).filter(mode => diff.modesAvailable[mode])
          : null);
      const isModeDisabled = (m) => (isSelfDiff && m !== 'uncommitted')
        || (Boolean(modesAvailable) && !modesAvailable.includes(m));
      const modeDisabledTitle = (m) => (isSelfDiff && m !== 'uncommitted')
        ? '同分支对比不可用'
        : (modesAvailable && !modesAvailable.includes(m) ? '当前比对对象不支持该模式' : '');

      if (isSelfDiff) {
        modeTipText = '分支自审模式：Base 与 Target 为同一对象，已自动锁定为【仅未提交 & 未跟踪】模式';
      } else if (effectiveMode === 'uncommitted') {
        modeTipText = '仅展示 Target 本地未提交修改及 untracked 新增文件';
      } else if (effectiveMode === 'all') {
        modeTipText = '全量对比：含 Target 已提交文件差异 + 本地未提交修改 + untracked 新增';
      } else {
        modeTipText = '纯分支文件内容对比（已忽略本地未提交修改）';
      }

      const stashActionsHtml = stashWorktreePath ? `
        <div class="diff-stash-actions">
          ${uncommittedCount > 0 ? `
            <button class="btn-outline stash-action-button" title="将全部未提交修改（含未跟踪文件）存入暂存记录" data-action="stash-act" data-stash-action="push">暂存</button>
            <details class="stash-menu">
              <summary class="btn-outline stash-action-button">处理未提交</summary>
              <div class="stash-popover stash-cleanup-menu">
                <button class="btn-outline stash-action-button" data-action="stash-act" data-stash-action="restore">还原已跟踪</button>
                <button class="btn-outline stash-action-button" data-action="stash-act" data-stash-action="clean">删除未跟踪</button>
                <button class="btn-danger stash-action-button" data-action="stash-act" data-stash-action="discard">全部丢弃</button>
              </div>
            </details>` : ''}
          <details class="stash-menu">
            <summary class="btn-outline stash-action-button">历史暂存</summary>
            <div class="stash-popover" id="stashListContainer"><div class="loading">正在加载历史暂存...</div></div>
          </details>
        </div>
      ` : '';
      const modeControlHtml = `
        <div id="diffModeControl" class="diff-mode-control-row">
          <div class="diff-mode-segmented">
            <button class="diff-mode-btn ${effectiveMode === 'uncommitted' ? 'active' : ''} ${isModeDisabled('uncommitted') ? 'disabled' : ''}" ${isModeDisabled('uncommitted') ? 'disabled' : ''} data-action="diff-mode" data-mode="uncommitted" title="${isModeDisabled('uncommitted') ? modeDisabledTitle('uncommitted') : '仅查看当前工作区未提交和未跟踪的代码'}">
              <span>仅未提交 & 未跟踪</span>
              <span class="diff-mode-pill">${uncommittedCount}</span>
            </button>
            <button class="diff-mode-btn ${effectiveMode === 'all' ? 'active' : ''} ${isModeDisabled('all') ? 'disabled' : ''}" ${isModeDisabled('all') ? 'disabled' : ''} data-action="diff-mode" data-mode="all" title="${isModeDisabled('all') ? modeDisabledTitle('all') : '全量对比：已提交分支修改 + 本地未提交改动'}">
              <span>全量变更</span>
              <span class="diff-mode-pill">${allCount}</span>
            </button>
            <button class="diff-mode-btn ${effectiveMode === 'committed' ? 'active' : ''} ${isModeDisabled('committed') ? 'disabled' : ''}" ${isModeDisabled('committed') ? 'disabled' : ''} data-action="diff-mode" data-mode="committed" title="${isModeDisabled('committed') ? modeDisabledTitle('committed') : '仅查看已提交的代码修改，忽略未提交'}">
              <span>仅已提交</span>
              <span class="diff-mode-pill">${committedCount}</span>
            </button>
          </div>
          <div class="diff-mode-tip">${modeTipText}</div>
          ${!diff.isSameWorktree ? '<button class="btn-outline" data-action="open-diff-commits" title="查看目标相对基准的差异提交">差异提交</button>' : ''}
          ${stashActionsHtml}
        </div>
      `;

      const emptyDiffHtml = (() => {
        if (files.length !== 0) return '';
        let emptyDesc = '当前审查模式下无任何文件差异。';
        if (effectiveMode === 'uncommitted') {
          emptyDesc = 'Target 工作区干净，没有本地未提交修改。<br><span style="color: var(--text-muted); font-size: 13px;">如需审查已提交代码，请点击上方<b>【全量变更】</b>或<b>【仅已提交】</b>；历史暂存可通过上方入口还原或删除。</span>';
        } else if (diff.contentEquivalent && (diff.historyAhead > 0 || diff.historyBehind > 0)) {
          emptyDesc = '两个工作区的最终文件内容一致。<br><span style="color: var(--text-muted); font-size: 13px;">提交历史存在差异，但这通常是 squash 合入造成的历史差异，已从文件 Diff 中过滤。</span>';
        } else if (behind > 0 && ahead === 0) {
          emptyDesc = `ℹ <b>对比分支当前落后于基准分支（落后 ${behind} 个提交）</b>，且没有领先的独有代码修改。<br><span style="color: var(--text-muted); font-size: 13px;">已默认隐藏基准分支的更新；若需查看这些文件变更，可点击右上角<b>【落后 ${behind} 个提交】</b>状态。</span>`;
        }

        return `<div class="empty-diff-box" style="padding: 28px; border: none; background: transparent; line-height: 1.8;">${emptyDesc}</div>`;
      })();

      let totalAdd = 0;
      let totalDel = 0;
      files.forEach(f => {
        if (!f.isBinary) {
          totalAdd += f.added || 0;
          totalDel += f.deleted || 0;
        }
      });

      // 图片沿用文本 Diff 的实际基准；仅未提交比较 Target HEAD，全量/已提交可能比较共同祖先。
      const targetRef = diff.target.head || diff.target.branch || 'HEAD';
      const sourceRef = diff.baseRevision || (effectiveMode === 'uncommitted'
        ? targetRef
        : diff.source.head || diff.source.branch || 'HEAD');
      const imageWorktreePath = effectiveMode === 'committed' ? null : stashWorktreePath;

      const sortedDiffFiles = sortDiffFiles(files);

      const fileCardsHtml = sortedDiffFiles.map((f, idx) => {
        const cardId = `diff-card-${idx}`;
        const bodyContent = renderFileBodyContent(
          f,
          sourceRef,
          targetRef,
          currentRepo,
          imageWorktreePath
        );
        const isImg = f.isImage || isImageFilePath(f.filePath);

        const status = getDiffFileStatus(f);
        const statusClass = status === 'untracked' ? 'added' : status;
        const statusTag = `<span class="file-status-badge status-${statusClass}">${status.toUpperCase()}</span>`;

        let statTag = '';
        if (isImg) {
          statTag = '<span class="binary-file-tag">图片文件</span>';
        } else if (f.isBinary) {
          statTag = '<span class="binary-file-tag">二进制文件</span>';
        } else {
          statTag = `<span><span class="add-count">+${f.added}</span> <span class="del-count">-${f.deleted}</span></span>`;
        }

        return `
          <div id="${cardId}" class="file-diff-card">
            <div class="file-header" data-action="toggle-file-diff" role="button" tabindex="0" aria-expanded="false">
              <div class="file-title-left">
                <span class="file-arrow">▶</span>
                ${statusTag}
                <span class="file-path" title="${escapeHtml(f.filePath)}">${escapeHtml(f.filePath)}</span>
              </div>
              <div style="display: flex; gap: 12px; align-items: center; font-size: 12px;">
                ${statTag}
              </div>
            </div>
            <div class="file-body">
              ${bodyContent}
            </div>
          </div>
        `;
      }).join('');

      const statBarHtml = `
          <div id="diffStatBar" class="stat-bar">
            <div>基准 (Base): ${diffRefBadgeHtml(diff.source)}</div>
            <div>对比 (Target): ${diffRefBadgeHtml(diff.target)}</div>
            <div style="margin-left: auto; display: flex; align-items: center; gap: 8px;">
              ${syncStatusBadge}
              <span style="color: var(--text-muted);">|</span>
              <span>当前文件: <b>${files.length}</b> 个</span>
              <span>新增: <span class="add-count">+${totalAdd}</span> 行</span>
              <span>删除: <span class="del-count">-${totalDel}</span> 行</span>
            </div>
          </div>`;
      const fileListHtml = files.length === 0 ? emptyDiffHtml : `
        <div class="diff-tools-bar">
          <div class="diff-tools-left">
            <span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg> 变更文件列表 (${files.length})</span>
            <span style="font-size: 12px; color: var(--text-muted); font-weight: normal;">单击单个文件展开/收起详情</span>
          </div>
          <div class="diff-tools-right">
            <button id="diffFindToggle" type="button" class="btn-outline" data-action="diff-find-open" aria-controls="diffFindPanel" aria-expanded="${diffFindState.open}" title="查找当前差异中的源码（⌘/Ctrl+F）">查找源码</button>
            <button class="btn-outline" data-action="toggle-all-diffs" data-expand="1" style="font-size: 12px; padding: 4px 10px;">展开全部</button>
            <button class="btn-outline" data-action="toggle-all-diffs" data-expand="0" style="font-size: 12px; padding: 4px 10px;">收起全部</button>
          </div>
          <div id="diffFindPanel" class="diff-find-panel" role="search" aria-label="查找差异源码" ${diffFindState.open ? '' : 'hidden'}>
            <input id="diffFindInput" type="text" placeholder="查找源码，包含折叠文件" aria-label="查找差异源码" aria-describedby="diffFindStatus" autocomplete="off" spellcheck="false" title="不区分大小写；Enter 下一个，Shift+Enter 上一个，Esc 关闭">
            <span id="diffFindStatus" class="diff-find-status" role="status" aria-live="polite"></span>
            <button type="button" class="btn-outline" data-action="diff-find-prev" aria-label="上一个匹配" title="上一个匹配（Shift+Enter）">↑</button>
            <button type="button" class="btn-outline" data-action="diff-find-next" aria-label="下一个匹配" title="下一个匹配（Enter）">↓</button>
            <button type="button" class="btn-outline" data-action="diff-find-close" aria-label="关闭查找" title="关闭查找（Esc）">✕</button>
          </div>
        </div>

        <div style="margin-top: 8px;">
          ${fileCardsHtml}
        </div>
      `;
      if (preserveShell) {
        const statBar = container.querySelector('#diffStatBar');
        const modeControl = container.querySelector('#diffModeControl');
        const fileList = container.querySelector('#diffFileListContent');
        if (statBar) statBar.outerHTML = statBarHtml;
        if (modeControl) {
          // 保留模式行及 Stash 弹层本身，只替换模式按钮和说明文字，避免切换时关闭弹层。
          const modeTemplate = document.createElement('div');
          modeTemplate.innerHTML = modeControlHtml;
          const nextSegmented = modeTemplate.querySelector('.diff-mode-segmented');
          const nextTip = modeTemplate.querySelector('.diff-mode-tip');
          const currentSegmented = modeControl.querySelector('.diff-mode-segmented');
          const currentTip = modeControl.querySelector('.diff-mode-tip');
          if (currentSegmented && nextSegmented) currentSegmented.replaceWith(nextSegmented);
          if (currentTip && nextTip) currentTip.replaceWith(nextTip);
        }
        if (fileList) fileList.innerHTML = fileListHtml;
      } else {
        container.innerHTML = `<div class="diff-summary-card">${statBarHtml}${modeControlHtml}</div><div id="diffFileListContent">${fileListHtml}</div>`;
      }
      container.dataset.renderedRepo = currentRepo;
      container.dataset.renderedBase = currentDiffBase;
      container.dataset.renderedTarget = currentDiffTarget;
      bindDiffViewActions(container);
      const findInput = document.getElementById('diffFindInput');
      if (findInput) {
        findInput.value = diffFindState.query;
        if (restoreFindFocus && diffFindState.open) findInput.focus({ preventScroll: true });
      }
      updateDiffFind(false);
      // 工具栏在窄屏或缩放后可能换行，文件标题的吸顶偏移始终跟随其真实高度。
      diffToolbarResizeObserver?.disconnect();
      const toolbar = container.querySelector('#diffFileListContent > .diff-tools-bar');
      if (toolbar) {
        const updateOffset = () => container.style.setProperty('--diff-toolbar-height', `${toolbar.getBoundingClientRect().height}px`);
        updateOffset();
        diffToolbarResizeObserver = new ResizeObserver(updateOffset);
        diffToolbarResizeObserver.observe(toolbar);
      }
      if (stashWorktreePath) fetchAndRenderStashList(stashWorktreePath);
    }

    /* 绑定 Diff 视图内全部动态动作（模式切换、stash 快捷操作、文件卡片、图片占位）。
       每次渲染（全量重建或 preserveShell 局部替换）涉及的元素均为新建，无重复绑定风险 */
    function bindDiffViewActions(container) {
      bindActions(container, {
        'diff-show-behind': () => showBehindChanges(),
        'diff-mode': (el) => selectDiffMode(el.dataset.mode),
        'open-diff-commits': () => openDiffCommitsDrawer(),
        'stash-act': (el) => stashActionWithConfirm(el.dataset.stashAction, '', el),
        'toggle-file-diff': (el) => toggleFileDiff(el.closest('.file-diff-card').id),
        'toggle-all-diffs': (el) => toggleAllDiffs(el.dataset.expand === '1'),
        'diff-find-open': () => openDiffFind(),
        'diff-find-prev': () => selectDiffFindMatch(diffFindState.index - 1),
        'diff-find-next': () => selectDiffFindMatch(diffFindState.index + 1),
        'diff-find-close': () => closeDiffFind()
      });
      container.querySelector('#diffFindInput')?.addEventListener('input', (event) => {
        diffFindState.query = event.target.value;
        updateDiffFind();
      });
      container.querySelectorAll('[data-action="toggle-file-diff"]').forEach((header) => {
        header.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          toggleFileDiff(header.closest('.file-diff-card').id);
        });
      });
      // 图片加载失败时隐藏预览并显示占位说明（原内联 onerror 的等价迁移；
      // 绑定在同一同步任务内完成，早于任何 error 事件派发，无遗漏窗口）
      container.querySelectorAll('.image-diff-preview-img').forEach((img) => {
        img.addEventListener('error', () => {
          img.style.display = 'none';
          if (img.nextElementSibling) img.nextElementSibling.style.display = 'block';
        });
      });
    }

    /**
     * 拉取并渲染指定工作区的 stash 列表到未提交面板的 stash 区块；无条目时清空隐藏。
     * stash ref 只有匹配 stash@{n} 白名单格式才会进入内联 onclick，杜绝任意字符串注入。
     * @param {string} worktreePath - 工作区绝对路径
     */
    async function fetchAndRenderStashList(worktreePath) {
      const el = document.getElementById('stashListContainer');
      if (!el) return;
      try {
        const resp = await fetch(`/api/stash-list?worktree=${encodeURIComponent(worktreePath)}`);
        const data = await resp.json();
        if (!data.ok) throw new Error(data.error || `HTTP ${resp.status}`);
        const stashes = data.stashes || [];
        const targetOptions = [
          ...currentWorktrees.filter(w => w.existsOnDisk !== false && !w.isPrunable).map(w => ({
            value: `worktree:${w.path}`,
            label: `Worktree：${w.branch || 'HEAD'}（${w.path.split('/').filter(Boolean).pop() || w.path}）`
          })),
          ...currentBranches.map(b => ({ value: `branch:${b.name}`, label: `分支：${b.name}` }))
        ];
        const targetSelect = `<label style="font-size: 12px; color: var(--text-muted);">还原目标：</label>
          <select id="stashTargetWorktreeSelect" class="stash-target-select">
            ${targetOptions.map(option => `<option value="${escapeHtml(option.value)}" ${option.value === `worktree:${worktreePath}` ? 'selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}
          </select>
          <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 8px;">暂存记录属于当前仓库，可恢复到其他工作区或分支。</div>`;
        if (stashes.length === 0) {
          el.innerHTML = `${targetSelect}<div style="padding: 8px; color: var(--text-muted); font-size: 12px;">暂无历史 Stash</div>`;
          return;
        }
        const rows = stashes.map(s => {
          // ref 只有匹配 stash@{n} 白名单格式才渲染操作按钮，杜绝任意字符串进入动作链路
          const refOk = /^stash@\{\d+\}$/.test(s.ref || '');
          const actions = refOk
            ? `<button class="btn-outline" data-action="stash-pop">还原</button>` +
              `<button class="btn-danger" data-action="stash-drop">删除</button>`
            : '';
          return `<div class="stash-item">
            <span class="stash-ref">${escapeHtml(s.ref)}</span>
            <span style="color: var(--text-muted); font-size: 12px; white-space: nowrap;">${escapeHtml(s.relativeTime)}</span>
            <span class="stash-subject" title="${escapeHtml(s.subject)}">${escapeHtml(s.subject)}</span>
            <span style="display: flex; gap: 6px;">${actions}</span>
          </div>`;
        }).join('');
        el.innerHTML = `
          ${targetSelect}
          <div class="diff-tools-bar">
            <div class="diff-tools-left">
              <span>历史暂存 (${stashes.length})</span>
              <span style="font-size: 12px; color: var(--text-muted); font-weight: normal;">选择目标后还原，删除后不可恢复</span>
            </div>
          </div>
          ${rows}
        `;
        // 按行对齐 stash 记录绑定闭包，ref 不经字符串往返；按钮仅 refOk 行渲染，缺失时跳过
        el.querySelectorAll('.stash-item').forEach((row, index) => {
          const stash = stashes[index];
          if (!stash) return;
          const popBtn = row.querySelector('[data-action="stash-pop"]');
          const dropBtn = row.querySelector('[data-action="stash-drop"]');
          if (popBtn) popBtn.addEventListener('click', () => stashActionWithConfirm('pop', stash.ref, popBtn));
          if (dropBtn) dropBtn.addEventListener('click', () => stashActionWithConfirm('drop', stash.ref, dropBtn));
        });
      } catch (err) {
        el.innerHTML = `<div class="stash-item" style="color: var(--danger);">历史暂存加载失败：${escapeHtml(toDisplayErrorMessage(err, '无法连接本地服务'))}</div>`;
      }
    }

    /**
     * 未提交面板 stash 相关写操作统一入口：
     * push（prompt 可选备注）/ restore / clean / discard（按范围二次确认）/ pop / drop（各自中文确认）。
     * 成功后调 refreshCurrentDiff 统一刷新未提交面板、stash 列表与外层 worktree dirty 状态。
     * @param {string} action - 仅允许 'push' | 'pop' | 'drop' | 'discard' | 'restore' | 'clean'
     * @param {string} stashRef - pop/drop 的目标引用，已在渲染侧做过白名单校验
     * @param {HTMLElement} [btn] - 被点击的按钮，执行期间禁用以防重复提交
     */
    async function stashActionWithConfirm(action, stashRef, btn) {
      const worktreePath = currentUncommittedPath;
      if (!worktreePath) return;
      let targetWorktree;
      let targetBranch;
      let newWorktreePath;
      if (action === 'pop') {
        const targetIdentity = document.getElementById('stashTargetWorktreeSelect')?.value || `worktree:${worktreePath}`;
        const splitTarget = splitRefIdentity(targetIdentity);
        if (splitTarget.kind === 'worktree') {
          targetWorktree = splitTarget.value;
        } else {
          targetBranch = splitTarget.value;
          const targetWt = currentWorktrees.find(w => w.branch === targetBranch && w.existsOnDisk !== false && !w.isPrunable);
          if (!targetWt) {
            newWorktreePath = prompt(`分支「${targetBranch}」当前没有 Worktree，请输入新 Worktree 的绝对目录：`);
            if (newWorktreePath === null) return;
            if (!newWorktreePath.trim()) {
              alert('未填写新 Worktree 目录，已取消还原');
              return;
            }
          }
        }
      }
      let message;
      if (action === 'push') {
        message = prompt('暂存备注（可留空）：');
        if (message === null) return; // 用户取消
        if (!message.trim()) message = undefined; // 空备注不传，由 git 生成默认说明
      } else if (action === 'discard') {
        if (!confirm(`确认丢弃该工作区的全部未提交修改吗？\n将还原所有已跟踪文件的修改并删除未跟踪文件，此操作不可恢复！\n工作区：${worktreePath}`)) return;
      } else if (action === 'restore') {
        if (!confirm(`确认还原该工作区中所有已跟踪文件的未提交修改吗？\n未跟踪文件不会被删除。\n工作区：${worktreePath}`)) return;
      } else if (action === 'clean') {
        if (!confirm(`确认删除该工作区中的全部未跟踪文件吗？\n已跟踪文件的修改不会改变，此操作不可恢复！\n工作区：${worktreePath}`)) return;
      } else if (action === 'pop') {
        const targetLabel = targetWorktree || (targetBranch ? `分支 ${targetBranch}${newWorktreePath ? `（新建 Worktree：${newWorktreePath}）` : ''}` : worktreePath);
        if (!confirm(`确认将 ${stashRef} 还原到目标吗？\n目标：${targetLabel}`)) return;
      } else if (action === 'drop') {
        if (!confirm(`确认删除 ${stashRef} 吗？删除后无法恢复。`)) return;
      } else {
        return;
      }
      if (btn) btn.disabled = true;
      try {
        const resp = await fetch('/api/stash-action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ worktree: worktreePath, action, message, stashRef: stashRef || undefined, targetWorktree, targetBranch, newWorktreePath })
        });
        const data = await resp.json();
        if (!data.ok) throw new Error(data.error || `HTTP ${resp.status}`);
        await refreshCurrentDiff();
      } catch (err) {
        notifyRequestFailure(err, `操作失败：${toDisplayErrorMessage(err, '无法连接本地服务')}`);
        if (btn && btn.isConnected) btn.disabled = false;
      }
    }

    /**
     * 复制文本到剪贴板，且只在真实写入成功后才显示「已复制」按钮反馈（DEF-007）。
     * 时序契约（§17.2）：桌面壳放行 clipboard-sanitized-write 权限后，优先走
     * navigator.clipboard.writeText 并 await 其结果；API 不可用或写入被拒时
     * 回退 textarea + execCommand('copy') 路径并检查其返回值；两路都失败时给
     * 非阻断失败提示（与 DEF-006 的 notifyRequestFailure 同源的 toast 路径，
     * 不落入其 alert 分支——剪贴板失败与服务状态无关，阻塞弹框无必要），
     * 绝不显示「已复制」。
     * @param {string} text - 要复制的文本
     * @param {HTMLElement} [btn] - 触发复制的按钮；恢复原文案的定时器按按钮
     *   实例持有，多个按钮共用本函数时反馈互不串扰
     * @returns {Promise<void>}
     */
    async function copyText(text, btn) {
      let copied = false;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
          await navigator.clipboard.writeText(text);
          copied = true;
        } catch {
          // 权限被拒 / 写入失败：静默转入下方 execCommand 回退路径
        }
      }
      if (!copied) {
        // 回退路径：execCommand('copy') 虽已废弃，仍是剪贴板 API 不可用时的兜底；
        // textarea 移出视口而非 display:none——后者在部分内核下 select() 不生效
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try {
          copied = document.execCommand('copy');
        } catch {
          copied = false;
        } finally {
          document.body.removeChild(ta);
        }
      }
      if (!copied) {
        showToast('复制失败：文本未能写入剪贴板');
        return;
      }
      if (btn) {
        // 同一按钮快速重复点击时先清旧定时器，避免前一轮恢复文案覆盖本轮反馈
        if (btn.copyFeedbackTimer) clearTimeout(btn.copyFeedbackTimer);
        const orig = btn.textContent;
        btn.textContent = '已复制!';
        btn.style.color = 'var(--success)';
        btn.copyFeedbackTimer = setTimeout(() => {
          btn.textContent = orig;
          btn.style.color = '';
          btn.copyFeedbackTimer = null;
        }, 1500);
      }
    }

    /* ---- 提交记录抽屉 ---- */
    // filters 为当前提交过滤条件, 会随每个请求传给后端; 空字符串表示该维度不过滤
    let commitsDrawerState = {
      worktreePath: null,
      branch: null,
      base: null,
      baseAvailable: true,
      fullHistory: false,
      isFullHistory: false,
      isMainHistory: false,
      head: null,
      totalCommits: 0,
      loadedCount: 0,
      limit: 30,
      isOpen: false,
      isFullscreen: false,
      lastGroupLabel: null, // 上一个提交所属的日期分组标签, 「加载更多」追加时据此判断是否插入新组头
      filters: { author: '', grep: '', since: '', until: '' }
    };
    let commitsDrawerReqSeq = 0;
    // 领先/落后统计缓存：每次打开抽屉时重置；切换全量/领先视图时复用，避免重复请求
    let commitsDrawerAheadBehind = null;
    // 抽屉滚动锁引用计数：提交抽屉与 MR 详情抽屉可能同时打开（如 URL 恢复），需叠加计数
    let drawerPageScrollLockCount = 0;
    let drawerPageScrollLockY = 0;

    // 提交 Diff 支持多开，展开状态由各面板内的 Diff 区块自身表达；
    // 此集合仅记录「摘要加载中点击了查看 Diff」的面板，摘要渲染完成后自动打开，再次点击可取消
    const pendingCommitDiffPanels = new Set();

    // 提交详情缓存：同一提交内容不可变，收起再展开不重复请求。
    // 键为 `${worktreePath}::${sha}`，避免不同仓库对同一短 SHA 解析出不同提交的歧义。
    const commitDetailCache = new Map();
    const COMMIT_DETAIL_CACHE_MAX = 200;
    // 默认展开会一次加载整页摘要，限制并发以免长列表同时创建大量 git 子进程。
    const commitDetailLoadQueue = [];
    const COMMIT_DETAIL_LOAD_CONCURRENCY = 4;
    let activeCommitDetailLoads = 0;

    /**
     * 写入提交详情缓存，超过上限时按插入顺序淘汰最早的条目，防止长会话内存无限增长。
     */
    function setCommitDetailCache(key, value) {
      if (commitDetailCache.size >= COMMIT_DETAIL_CACHE_MAX) {
        commitDetailCache.delete(commitDetailCache.keys().next().value);
      }
      commitDetailCache.set(key, value);
    }

    // 抽屉打开期间固定主页面，触控板、滚轮和触摸滑动都只能作用于抽屉。
    // 提交抽屉与 MR 详情抽屉共用该锁，引用计数支持叠加：全部关闭后才恢复页面滚动。
    function setCommitsDrawerPageScrollLocked(locked) {
      if (locked) {
        drawerPageScrollLockCount++;
        if (drawerPageScrollLockCount === 1) {
          drawerPageScrollLockY = window.scrollY;
          document.body.style.position = 'fixed';
          document.body.style.top = `-${drawerPageScrollLockY}px`;
          document.body.style.width = '100%';
        }
      } else if (drawerPageScrollLockCount > 0) {
        drawerPageScrollLockCount--;
        if (drawerPageScrollLockCount === 0) {
          const scrollY = drawerPageScrollLockY;
          document.body.style.position = '';
          document.body.style.top = '';
          document.body.style.width = '';
          window.scrollTo(0, scrollY);
        }
      }
    }

    async function openCommitsDrawer(worktreePath, fullHistory = false, pushHistory = true, ref = '', baseRef = '') {
      closeAllCommitDiffs();
      commitsDrawerState = {
        worktreePath, branch: null, base: null, baseAvailable: true, fullHistory, isFullHistory: false, isMainHistory: false, head: null,
        totalCommits: 0, loadedCount: 0, limit: 30, isOpen: true, isFullscreen: false, lastGroupLabel: null,
        ref, // 分支查看模式：非空时以后端 options.ref 为提交顶点（分支列表入口）
        baseRef, // Diff 入口使用当前比对基准，避免抽屉退回默认主分支
        filters: { author: '', grep: '', since: '', until: '' } // 每次打开新 worktree 都重置过滤条件
      };
      commitsDrawerAheadBehind = null; // 新抽屉丢弃上一轮的领先/落后统计
      clearCommitsFilterInputs();

      const overlay = document.getElementById('commitsDrawerOverlay');
      const drawer = document.getElementById('commitsDrawer');
      drawer.classList.remove('fullscreen');
      updateCommitsDrawerFullscreenUi();
      setCommitsDrawerPageScrollLocked(true);
      document.getElementById('commitsDrawerMeta').innerHTML = '';
      document.getElementById('commitsDrawerFooter').style.display = 'none';
      overlay.style.display = 'block';
      drawer.style.display = 'flex';
      requestAnimationFrame(() => {
        overlay.classList.add('open');
        drawer.classList.add('open');
      });
      syncStateToUrl(pushHistory);
      document.getElementById('commitsDrawerBody').innerHTML =
        `<div class="loading">正在加载${fullHistory ? '完整历史' : '提交记录'}...</div>`;

      await fetchAndRenderCommits();
    }

    // 分支列表「提交记录」入口：以分支名为 ref 打开抽屉，worktreePath 传仓库主路径
    // （ref 为仓库级引用，主路径下 git 命令同样可解析；详情/Diff 接口也只要求仓库路径）
    async function openBranchCommitsDrawer(branchName) {
      if (!currentRepo || !branchName) return;
      await openCommitsDrawer(currentRepo, false, true, branchName);
    }

    function closeCommitsDrawer(pushHistory = true) {
      if (!commitsDrawerState.isOpen) return;
      closeAllCommitDiffs();
      commitsDrawerState.isOpen = false;
      commitsDrawerReqSeq++; // 使在途请求失效
      syncStateToUrl(pushHistory);
      setCommitsDrawerPageScrollLocked(false);
      const overlay = document.getElementById('commitsDrawerOverlay');
      const drawer = document.getElementById('commitsDrawer');
      overlay.classList.remove('open');
      drawer.classList.remove('open');
      setTimeout(() => {
        if (!commitsDrawerState.isOpen) {
          drawer.style.display = 'none';
          overlay.style.display = 'none';
        }
      }, 260);
    }

    /**
     * 同步提交抽屉全屏按钮与抽屉样式状态。
     */
    function updateCommitsDrawerFullscreenUi() {
      const drawer = document.getElementById('commitsDrawer');
      const btn = document.querySelector('[data-action="toggle-commits-fullscreen"]');
      if (!drawer || !btn) return;
      const isFullscreen = Boolean(commitsDrawerState.isFullscreen);
      drawer.classList.toggle('fullscreen', isFullscreen);
      btn.textContent = isFullscreen ? '退出全屏' : '全屏';
      btn.setAttribute('aria-pressed', String(isFullscreen));
      btn.setAttribute('aria-label', isFullscreen ? '退出提交记录全屏' : '全屏查看提交记录');
      btn.title = isFullscreen ? '退出提交记录全屏' : '全屏查看提交记录';
    }

    /**
     * 切换提交记录抽屉的全屏显示，不改变当前筛选、滚动位置和提交展开状态。
     */
    function toggleCommitsDrawerFullscreen() {
      if (!commitsDrawerState.isOpen) return;
      commitsDrawerState.isFullscreen = !commitsDrawerState.isFullscreen;
      updateCommitsDrawerFullscreenUi();
    }

    // 读取过滤输入区的当前值; 文本框去首尾空白, 日期控件值本身即为 YYYY-MM-DD
    function readCommitsFilterInputs() {
      return {
        author: document.getElementById('commitFilterAuthor').value.trim(),
        grep: document.getElementById('commitFilterGrep').value.trim(),
        since: document.getElementById('commitFilterSince').value,
        until: document.getElementById('commitFilterUntil').value
      };
    }

    // 清空过滤输入区
    function clearCommitsFilterInputs() {
      document.getElementById('commitFilterAuthor').value = '';
      document.getElementById('commitFilterGrep').value = '';
      document.getElementById('commitFilterSince').value = '';
      document.getElementById('commitFilterUntil').value = '';
    }

    // 判断 state 中是否存在任一生效的过滤条件
    function hasActiveCommitsFilters() {
      const f = commitsDrawerState.filters || {};
      return Boolean(f.author || f.grep || f.since || f.until);
    }

    // 应用过滤: 写回 state 并按首屏语义重载(清空列表、重置分页与 footer)
    function applyCommitsFilters() {
      if (!commitsDrawerState.isOpen) return;
      commitsDrawerState.filters = readCommitsFilterInputs();
      commitsDrawerState.loadedCount = 0;
      document.getElementById('commitsDrawerFooter').style.display = 'none';
      syncStateToUrl(true);
      document.getElementById('commitsDrawerBody').innerHTML =
        '<div class="loading">正在按过滤条件加载提交...</div>';
      fetchAndRenderCommits();
    }

    // 清空过滤输入与条件, 恢复全量列表
    function clearCommitsFilters() {
      if (!commitsDrawerState.isOpen) return;
      clearCommitsFilterInputs();
      applyCommitsFilters();
    }

    async function fetchAndRenderCommits() {
      const { worktreePath, loadedCount, limit } = commitsDrawerState;
      const seq = ++commitsDrawerReqSeq;
      const params = new URLSearchParams({
        worktree: worktreePath,
        limit: String(limit),
        offset: String(loadedCount)
      });
      if (commitsDrawerState.fullHistory) {
        params.set('fullHistory', '1');
      }
      // 分支查看模式：以后端 options.ref 指定的分支为提交顶点
      if (commitsDrawerState.ref) {
        params.set('ref', commitsDrawerState.ref);
      }
      if (commitsDrawerState.baseRef) {
        params.set('base', commitsDrawerState.baseRef);
      }
      // 追加过滤条件(仅非空项): 值只经 URLSearchParams 编码进请求, 不参与任何 HTML 拼接
      const filters = commitsDrawerState.filters || {};
      if (filters.author) params.set('author', filters.author);
      if (filters.grep) params.set('grep', filters.grep);
      if (filters.since) params.set('since', filters.since);
      if (filters.until) params.set('until', filters.until);

      try {
        const resp = await fetch(`/api/worktree-commits?${params}`);
        const data = await resp.json();
        if (seq !== commitsDrawerReqSeq) return; // 抽屉已关闭或已有更新的请求
        if (!data.ok) throw new Error(data.error || `HTTP ${resp.status}`);

        if (loadedCount === 0) {
          commitsDrawerState.branch = data.branch;
          commitsDrawerState.base = data.base;
          commitsDrawerState.baseAvailable = data.baseAvailable !== false;
          commitsDrawerState.fullHistory = Boolean(data.isFullHistory);
          commitsDrawerState.isFullHistory = Boolean(data.isFullHistory);
          commitsDrawerState.isMainHistory = Boolean(data.isMainHistory);
          commitsDrawerState.head = data.head;
          commitsDrawerState.totalCommits = data.totalCommits;
          renderCommitsMeta(data);
          // 异步补拉领先/落后统计，不阻塞提交列表渲染
          fetchCommitsAheadBehind(seq);
        }

        commitsDrawerState.loadedCount += data.commits.length;
        renderCommitsList(data.commits, loadedCount === 0);
        renderCommitsFooter(data);
      } catch (err) {
        if (seq !== commitsDrawerReqSeq) return;
        if (loadedCount > 0) {
          // 追加加载失败: 保留已有列表，在底部按钮上提示重试
          const btn = document.getElementById('loadMoreCommitsBtn');
          btn.textContent = '加载失败，点击重试';
          btn.disabled = false;
        } else {
          renderCommitsError(toDisplayErrorMessage(err, '无法连接本地服务'));
        }
      }
    }

    function renderCommitsMeta(data) {
      const scopeText = data.isFullHistory
        ? `${data.isMainHistory ? '主干' : '当前分支'}完整历史 · 共 ${data.totalCommits} 个提交`
        : data.baseAvailable === false
          ? `无法解析基准 ${escapeHtml(data.base)}，未加载提交`
        : `领先 ${escapeHtml(data.base)} ${data.totalCommits} 个提交`;
      const fullHistoryButton = data.isMainHistory
        ? ''
        : data.isFullHistory
          ? '<button type="button" class="btn-outline" style="padding: 3px 8px; font-size: 12px;" data-action="commits-history" data-full="0">返回领先提交</button>'
          : '<button type="button" class="btn-outline" style="padding: 3px 8px; font-size: 12px;" data-action="commits-history" data-full="1">查看全量历史</button>';
      const metaEl = document.getElementById('commitsDrawerMeta');
      metaEl.innerHTML = `
        <span class="badge" title="基准: ${escapeHtml(data.base)}">${escapeHtml(data.branch)}</span>
        <code style="color: var(--accent);">${escapeHtml((data.head || '').slice(0, 7))}</code>
        <span>${scopeText}</span>
        ${renderAheadBehindBadgeHtml()}
        ${fullHistoryButton}
        <button type="button" class="btn-outline commit-collapse-all-btn" data-action="commits-collapse-all" title="收起全部已展开的 Diff">折叠全部</button>
      `;
      bindActions(metaEl, {
        'commits-history': (el) => switchCommitsHistory(el.dataset.full === '1'),
        'commits-collapse-all': () => collapseAllCommitDiffs()
      });
    }

    // 根据领先/落后数据生成徽章 HTML；无数据或基准不可解析时返回空串（静默隐藏）。
    // 这是全项目唯一的领先/落后展示出口：提交抽屉与 MR 详情抽屉共用，
    // 内容等价判定来自 getBranchMergeStatus 四方判定（祖先/树一致/补丁等价/merge-tree），
    // 任何新场景都不得直接用机械计数渲染「领先 N」，必须经由本函数做事实认定
    function buildAheadBehindBadgeHtml(ab, idPrefix = 'commitsAheadBehind') {
      if (!ab || ab.baseAvailable === false) return '';
      // 数字统一转字符串后再转义，避免 escapeHtml 对数字入参报错
      const baseLabel = escapeHtml(ab.baseBranch);
      const aheadText = escapeHtml(String(ab.ahead));
      const behindText = escapeHtml(String(ab.behind));

      // 内容等价判定：revert 抵消、squash/cherry-pick 合入等场景机械计数会显示「领先 N」，
      // 但改动已被基准吸收，此时以绿色「无差异」徽章为主，原始计数降级为弱色小字供核查
      if (ab.contentEquivalent === true) {
        const mergeTypeNotes = {
          direct: '提交已在基准历史中',
          tree: '树内容一致（改动已被抵消，如 revert）',
          patch: '补丁已等价合入基准',
          'merge-tree': '合并结果与基准一致'
        };
        const note = mergeTypeNotes[ab.mergeType] || '改动已被基准吸收';
        const rawCounts = `提交计数：领先 ${aheadText} / 落后 ${behindText}`;
        if (ab.behind > 0) {
          // 自身无独有改动但落后于基准：仍提示需要同步主干
          return `<span id="${idPrefix}Badge" class="badge badge-warning" title="${note}">⇅ 落后 ${baseLabel} ${behindText}（无独有改动）</span>` +
            `<span id="${idPrefix}RawCounts" style="font-size: 11px; color: var(--text-muted);" title="机械提交计数，含 revert 等相互抵消的提交">${rawCounts}</span>`;
        }
        return `<span id="${idPrefix}Badge" class="badge badge-success" title="${note}">✓ 与 ${baseLabel} 无差异</span>` +
          `<span id="${idPrefix}RawCounts" style="font-size: 11px; color: var(--text-muted);" title="机械提交计数，含 revert 等相互抵消的提交">${rawCounts}</span>`;
      }

      const title = `相对基准分支 ${baseLabel} 的提交领先/落后统计`;
      let text;
      if (ab.ahead > 0 && ab.behind > 0) text = `⇅ 领先 ${aheadText} / 落后 ${behindText}`;
      else if (ab.ahead > 0) text = `⇅ 领先 ${aheadText}`;
      else if (ab.behind > 0) text = `⇅ 落后 ${behindText}`;
      else text = `与 ${baseLabel} 同步`;
      // 有落后时用警示色提醒需要同步主干，纯领先视为正常状态
      const cls = ab.behind > 0 ? 'badge badge-warning' : 'badge badge-success';
      return `<span id="${idPrefix}Badge" class="${cls}" title="${title}">${text}</span>`;
    }

    // 提交抽屉徽章：从抽屉缓存的领先/落后数据渲染（id 前缀保持原值，更新逻辑依赖它）
    function renderAheadBehindBadgeHtml() {
      return buildAheadBehindBadgeHtml(commitsDrawerAheadBehind);
    }

    // 把领先/落后徽章插入抽屉 meta 行（渲染在"查看全量历史"按钮之前），已存在时原地替换
    function updateAheadBehindBadgeInMeta() {
      const metaEl = document.getElementById('commitsDrawerMeta');
      if (!metaEl) return;
      // 徽章与附属的原始计数字段是兄弟节点，替换时两个都要移除
      const old = document.getElementById('commitsAheadBehindBadge');
      if (old) old.remove();
      const oldRaw = document.getElementById('commitsAheadBehindRawCounts');
      if (oldRaw) oldRaw.remove();
      const html = renderAheadBehindBadgeHtml();
      if (!html) return;
      // 徽章插在历史切换按钮之前；主干历史模式无该按钮时退而插在「折叠全部」之前，
      // 保证徽章永远不出现在最右侧的折叠全部按钮右边
      const btn = metaEl.querySelector('[data-action="commits-history"]')
        || metaEl.querySelector('.commit-collapse-all-btn');
      if (btn) btn.insertAdjacentHTML('beforebegin', html);
      else metaEl.insertAdjacentHTML('beforeend', html);
    }

    // 异步获取当前分支相对基准的领先/落后统计。主干看全量历史、或分支与基准同名时与自身比较无意义，直接跳过。
    async function fetchCommitsAheadBehind(seq) {
      if (commitsDrawerState.isMainHistory || commitsDrawerState.branch === commitsDrawerState.base) return;
      if (commitsDrawerAheadBehind) return; // 本轮抽屉已获取过，切换历史视图时复用缓存
      try {
        const params = new URLSearchParams({ worktree: commitsDrawerState.worktreePath });
        // 分支查看模式：统计该分支（而非 worktree 当前 HEAD）相对基准的领先/落后
        if (commitsDrawerState.ref) params.set('ref', commitsDrawerState.ref);
        if (commitsDrawerState.baseRef) params.set('base', commitsDrawerState.baseRef);
        const resp = await fetch(`/api/worktree-ahead-behind?${params}`);
        const data = await resp.json();
        // 抽屉已关闭或已切换到更新的请求时，丢弃旧响应避免污染 meta 行
        if (seq !== commitsDrawerReqSeq || !commitsDrawerState.isOpen) return;
        if (!data.ok) throw new Error(data.error || `HTTP ${resp.status}`);
        if (data.baseAvailable === false) {
          commitsDrawerAheadBehind = null; // 基准不可解析时保持空，徽章静默隐藏
        } else {
          commitsDrawerAheadBehind = data;
          updateAheadBehindBadgeInMeta();
        }
      } catch {
        // 接口失败时静默不显示徽章，不影响提交列表展示
      }
    }

    // 功能分支默认只看相对主干的领先提交，完整历史由用户手动切换。
    function switchCommitsHistory(fullHistory) {
      if (!commitsDrawerState.isOpen || commitsDrawerState.fullHistory === fullHistory) return;
      commitsDrawerState.fullHistory = fullHistory;
      commitsDrawerState.loadedCount = 0;
      document.getElementById('commitsDrawerFooter').style.display = 'none';
      syncStateToUrl(true);
      document.getElementById('commitsDrawerBody').innerHTML =
        `<div class="loading">正在加载${fullHistory ? '完整历史' : '领先提交'}...</div>`;
      fetchAndRenderCommits();
    }

    /**
     * 计算提交日期对应的时间线分组标签：今天/昨天用相对标签，更早用本地时区 YYYY-MM-DD。
     * date 为后端 git log %aI 输出的严格 ISO 8601 字符串（含时区偏移），new Date 可正确解析；
     * 按本地日历日归类，避免 UTC 深夜的提交在东八区被误分到相邻日期。
     * 解析失败（空值或非法日期）统一归入"未知日期"分组，不中断整段渲染。
     * @param {string} dateStr - 提交的 ISO 8601 日期字符串
     * @param {Date} [now] - 当前时间，默认取系统时间；单测可注入固定基准
     * @returns {string} 分组标签
     */
    function getCommitDateGroupLabel(dateStr, now = new Date()) {
      const d = new Date(dateStr);
      if (!dateStr || Number.isNaN(d.getTime())) return '未知日期';
      // 用「本地年-月-日」键比较日历日，屏蔽时分秒与时区偏移的干扰
      const dayKey = (x) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
      if (dayKey(d) === dayKey(now)) return '今天';
      const yesterday = new Date(now);
      // setDate 跨月/跨年由 Date 自动进位，无需手工处理边界
      yesterday.setDate(yesterday.getDate() - 1);
      if (dayKey(d) === dayKey(yesterday)) return '昨天';
      const pad = (n) => String(n).padStart(2, '0');
      // YYYY-MM-DD 本身自带年份，跨年提交天然展示为完整日期，无需特判
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }

    function renderCommitsList(commits, isFirstLoad) {
      const body = document.getElementById('commitsDrawerBody');

      // 首屏（打开抽屉、切换全量/领先视图、应用/清空过滤、重试）一律重置分组游标，从头分组
      if (isFirstLoad) {
        commitsDrawerState.lastGroupLabel = null;
        closeAllCommitDiffs();
      }

      if (isFirstLoad && commits.length === 0) {
        // 过滤生效时的空结果与"本来就没有提交"区分开, 并给出清空过滤入口
        if (hasActiveCommitsFilters()) {
          body.innerHTML = `
            <div class="empty-state">
              <div class="empty-state-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></div>
              <div>没有符合过滤条件的提交</div>
              <div style="font-size:12px">可调整过滤条件，或清空后查看全部提交</div>
              <button class="btn-outline" style="margin-top:8px" data-action="commits-clear-filters">清空过滤</button>
            </div>`;
          bindActions(body, {
            'commits-clear-filters': () => clearCommitsFilters()
          });
          return;
        }
        const emptyText = commitsDrawerState.isFullHistory
          ? (commitsDrawerState.isMainHistory ? '该主干暂无提交记录' : '该分支暂无提交记录')
          : commitsDrawerState.base && commitsDrawerState.baseAvailable === false
            ? '无法解析主干基准，暂未加载提交记录'
          : '该分支暂无额外提交';
        const emptyHint = commitsDrawerState.isFullHistory
          ? ''
          : commitsDrawerState.base && commitsDrawerState.baseAvailable === false
            ? '<div style="font-size:12px">请确认主干分支仍存在，或刷新仓库状态后重试</div>'
          : `<div style="font-size:12px">相对 ${escapeHtml(commitsDrawerState.base)} 没有领先提交</div>`;
        body.innerHTML = `
          <div class="empty-state">
            <div class="empty-state-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg></div>
            <div>${emptyText}</div>
            ${emptyHint}
          </div>`;
        return;
      }

      // 按遇到顺序分组：标签与上一条不同时插入组头（git log 新到旧有序，正常场景组头单调递减；
      // 若出现乱序输入，重复的标签会再次插入组头，仅影响观感不影响功能）
      const chunks = [];
      commits.forEach((c, batchIdx) => {
        const groupLabel = getCommitDateGroupLabel(c.date);
        if (groupLabel !== commitsDrawerState.lastGroupLabel) {
          commitsDrawerState.lastGroupLabel = groupLabel;
          chunks.push(`<div class="commit-date-group">${escapeHtml(groupLabel)}</div>`);
        }
        chunks.push(`
        <div class="commit-item clickable" data-action="commit-toggle" data-c-idx="${batchIdx}">
          <div class="commit-item-header">
            <span class="commit-hash" data-action="commit-copy-hash" title="点击复制完整 SHA">${escapeHtml(c.shortHash)}</span>
            <span class="commit-time">${escapeHtml(c.relativeTime)}</span>
          </div>
          <div class="commit-subject" title="${escapeHtml(c.subject)}">${escapeHtml(c.subject)}</div>
          <div class="commit-author">${escapeHtml(c.author)}</div>
        </div>
      `);
      });
      const html = chunks.join('');

      if (isFirstLoad) {
        body.innerHTML = html;
        body.scrollTop = 0;
      } else {
        body.insertAdjacentHTML('beforeend', html);
      }
      // 写入后按批次绑定闭包（hash 不经内联字符串往返）；追加加载时旧卡片已被 data-bound 跳过
      bindCommitCards(body, commits, true, true);
    }

    /**
     * 折叠全部：收起抽屉内所有已展开的提交 Diff（详情面板保留）。
     * 多个区块同时移除同样会使下方内容整体位移，锚定视口顶部可见卡片并补偿滚动。
     */
    function collapseAllCommitDiffs() {
      const body = document.getElementById('commitsDrawerBody');
      if (!body) return;
      const bodyTop = body.getBoundingClientRect().top;
      const anchor = [...body.querySelectorAll('.commit-item')]
        .find((item) => item.getBoundingClientRect().bottom > bodyTop + 1);
      const anchorTop = anchor ? anchor.getBoundingClientRect().top : 0;
      closeAllCommitDiffs();
      if (anchor) {
        const delta = anchor.getBoundingClientRect().top - anchorTop;
        if (delta !== 0) body.scrollTop += delta;
      }
    }

    /**
     * 切换提交卡片的详情面板展开/收起。首次展开时懒加载 GET /api/commit-detail，
     * 同一提交的结果写入模块级缓存，收起再展开不重复请求。
     * @param {HTMLElement} card - 被点击的提交卡片元素
     * @param {string} sha - 提交完整 SHA
     */
    /* 提交详情/Diff/写操作的上下文 worktree 解析：
       提交抽屉打开时用其正在查看的 worktree；否则若 MR 详情抽屉打开，退回当前仓库主路径，
       让 MR 领先提交也能就地展开详情、查看 Diff 与执行 Cherry-pick/Revert */
    function getCommitDetailContextPath() {
      if (commitsDrawerState.isOpen && commitsDrawerState.worktreePath) return commitsDrawerState.worktreePath;
      if (mrDrawerState.isOpen && currentRepo) return currentRepo;
      return commitsDrawerState.worktreePath || currentRepo || '';
    }

    function toggleCommitDetail(card, sha) {
      // 内联 onclick 参数只放行十六进制 SHA，杜绝任意字符串进入事件处理
      if (!/^[0-9a-fA-F]{7,40}$/.test(sha || '')) return;
      // 上下文 worktree 由抽屉状态统一解析，不通过内联字符串传递
      const worktreePath = getCommitDetailContextPath();
      if (!worktreePath) return;

      const existingPanel = card.querySelector('.commit-detail');
      if (existingPanel) {
        pendingCommitDiffPanels.delete(existingPanel);
        existingPanel.remove();
        return;
      }

      const panel = document.createElement('div');
      panel.className = 'commit-detail';
      panel.innerHTML = '<div class="commit-detail-loading">加载中...</div>';
      card.appendChild(panel);

      const cacheKey = `${worktreePath}::${sha}`;
      if (commitDetailCache.has(cacheKey)) {
        renderCommitDetail(panel, commitDetailCache.get(cacheKey), null);
        return;
      }

      commitDetailLoadQueue.push({ panel, worktreePath, sha });
      drainCommitDetailLoadQueue();
    }

    /**
     * 按并发上限加载摘要，过滤或切换历史后已移除的卡片不再发起请求。
     */
    function drainCommitDetailLoadQueue() {
      while (activeCommitDetailLoads < COMMIT_DETAIL_LOAD_CONCURRENCY && commitDetailLoadQueue.length > 0) {
        const { panel, worktreePath, sha } = commitDetailLoadQueue.shift();
        if (!panel.isConnected) continue;
        activeCommitDetailLoads++;
        loadCommitDetailPanel(panel, worktreePath, sha).finally(() => {
          activeCommitDetailLoads--;
          drainCommitDetailLoadQueue();
        });
      }
    }

    /**
     * 加载提交摘要并缓存结果，仅向仍在页面中的面板写入内容。
     * @param {HTMLElement} panel - 摘要面板
     * @param {string} worktreePath - 本次请求所属的工作区路径
     * @param {string} sha - 提交完整 SHA
     * @returns {Promise<void>} 请求与渲染完成后返回
     */
    async function loadCommitDetailPanel(panel, worktreePath, sha) {
      const cacheKey = `${worktreePath}::${sha}`;
      try {
        const params = new URLSearchParams({ worktree: worktreePath, sha });
        const resp = await fetch(`/api/commit-detail?${params}`);
        const data = await resp.json();
        if (!data.ok) throw new Error(data.error || `HTTP ${resp.status}`);
        setCommitDetailCache(cacheKey, data);
        // 请求期间用户可能已收起面板，此时不再渲染
        if (panel.isConnected) {
          renderCommitDetail(panel, data, null);
        }
      } catch (err) {
        if (panel.isConnected) {
          renderCommitDetail(panel, null, toDisplayErrorMessage(err, '无法连接本地服务'));
        }
      }
    }

    /**
     * 将提交详情渲染进展开面板：完整正文、父提交列表与文件变更摘要；逐文件内容交由 Diff 区块按需展开。
     * @param {HTMLElement} panel - 详情面板容器
     * @param {object|null} data - 接口返回的详情数据
     * @param {string|null} errorMessage - 请求失败时的错误信息
     */
    function renderCommitDetail(panel, data, errorMessage) {
      if (errorMessage) {
        pendingCommitDiffPanels.delete(panel);
        panel.innerHTML = `<div class="commit-detail-error">加载详情失败：${escapeHtml(errorMessage)}</div>`;
        return;
      }
      // 统计字段用 Number 收敛为数字后再插值，保证任何异常响应都不会注入标记
      const filesChanged = Number(data.filesChanged) || 0;
      const insertions = Number(data.insertions) || 0;
      const deletions = Number(data.deletions) || 0;
      // 父提交只放行十六进制 SHA 才会进入复制动作，展示时取短哈希、复制时给完整值
      const parents = (data.parents || []).filter(p => /^[0-9a-fA-F]{7,40}$/.test(p));
      const parentsHtml = parents.length === 0
        ? '<span>无（根提交）</span>'
        : parents.map(p => `<span class="commit-detail-parent" data-action="copy-parent" title="点击复制完整 SHA">${escapeHtml(p.slice(0, 7))}</span>`).join('');
      // 「查看 Diff」按钮：确有文件变更且响应里是合法十六进制 SHA 时才展示，动作只传 SHA
      const detailSha = /^[0-9a-fA-F]{7,40}$/.test(data.hash || '') ? data.hash : '';
      const diffToggleHtml = filesChanged > 0 && detailSha
        ? `<button type="button" class="btn-outline commit-diff-toggle-btn" data-action="commit-view-diff">查看 Diff</button>`
        : '';
      // Cherry-pick / Revert 按钮：仅在详情面板已拿到合法 SHA 时渲染，onclick 只传 action 名与 SHA
      // 目标工作区选择器：选项来自当前仓库的 worktree 列表，主工作区置顶；
      // 只对 Cherry-pick 生效（Revert 固定作用于当前查看的 worktree，与选择器解绑，
      // 见 commitActionWithConfirm）。默认选中主工作区（Cherry-pick 的语义默认目标就是它），
      // 与入口无关——branch 入口与 worktree 入口保持一致；
      // 无主工作区时回退到当前查看的 worktree，再退到列表首项
      const contextPath = getCommitDetailContextPath();
      const targetWts = (currentWorktrees || [])
        .filter(w => w && w.path && w.existsOnDisk !== false)
        .slice()
        .sort((a, b) => (b.isMain ? 1 : 0) - (a.isMain ? 1 : 0));
      const hasMain = targetWts.some(w => w.isMain);
      const hasContext = targetWts.some(w => w.path === contextPath);
      const targetSelectHtml = detailSha && targetWts.length > 0
        ? `<select class="commit-action-target" title="Cherry-pick 作用的目标工作区（Revert 固定作用于当前查看的 worktree，不受此选项影响）">` +
          targetWts.map((w, idx) => {
            const selected = hasMain ? w.isMain : (hasContext ? w.path === contextPath : idx === 0);
            const label = `${w.isMain ? '主工作区' : 'Worktree'} (${w.branch || 'detached'})`;
            return `<option value="${escapeHtml(w.path)}"${selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;
          }).join('') + `</select>`
        : '';
      const actionButtonsHtml = detailSha
        ? targetSelectHtml +
          `<button type="button" class="btn-outline commit-action-btn" data-action="commit-act" data-commit-action="cherry-pick">Cherry-pick</button>` +
          `<button type="button" class="btn-outline commit-action-btn" data-action="commit-act" data-commit-action="revert">↩ Revert</button>`
        : '';
      // 「查看 Diff」与写操作按钮统一放进一行操作区，两者皆空时不渲染容器
      const actionsHtml = (diffToggleHtml || actionButtonsHtml)
        ? `<div class="commit-detail-actions">${diffToggleHtml}${actionButtonsHtml}</div>`
        : '';
      panel.innerHTML = `
        ${data.body ? `<pre class="commit-detail-body">${escapeHtml(data.body)}</pre>` : ''}
        <div class="commit-detail-parents"><span>父提交：</span>${parentsHtml}</div>
        <div class="commit-detail-stats">${filesChanged} 个文件变更 · <span class="add-count">+${insertions}</span> / <span class="del-count">-${deletions}</span></div>
        ${actionsHtml}
      `;
      bindCommitDetailActions(panel, parents, detailSha);
      // 摘要加载期间点击过卡片：摘要就绪后自动打开 Diff；多个提交可各自持有该意图
      if (pendingCommitDiffPanels.has(panel)) {
        pendingCommitDiffPanels.delete(panel);
        if (diffToggleHtml) toggleCommitDiff(panel, detailSha);
      }
    }

    /* 绑定提交详情面板内的动态动作：父提交复制、查看 Diff、目标选择器、Cherry-pick/Revert。
       SHA 经白名单校验后由闭包直引，不再经内联字符串往返（CSP 迁移） */
    function bindCommitDetailActions(panel, parents, detailSha) {
      // 父提交复制：按渲染顺序与 parents 对齐取完整 SHA；阻止冒泡避免同时展开/收起详情
      panel.querySelectorAll('.commit-detail-parent').forEach((el, index) => {
        el.addEventListener('click', (event) => {
          event.stopPropagation();
          copyText(parents[index], el);
        });
      });
      const viewDiffBtn = panel.querySelector('[data-action="commit-view-diff"]');
      if (viewDiffBtn) {
        viewDiffBtn.addEventListener('click', (event) => {
          event.stopPropagation();
          toggleCommitDiff(panel, detailSha);
        });
      }
      panel.querySelectorAll('[data-action="commit-act"]').forEach((btn) => {
        btn.addEventListener('click', (event) => {
          event.stopPropagation();
          commitActionWithConfirm(btn.dataset.commitAction, detailSha, btn);
        });
      });
      // 选择器点击不冒泡到提交卡片（防止误触发展开/收起）；手动改动后标记 touched
      panel.querySelectorAll('.commit-action-target').forEach((sel) => {
        sel.addEventListener('click', (event) => event.stopPropagation());
        sel.addEventListener('change', () => { sel.dataset.touched = '1'; });
      });
    }

    /**
     * 详情面板内 Cherry-pick / Revert 写操作的统一入口，中文确认后
     * POST /api/commit-action。作用目标按动作解绑：Cherry-pick 从面板内
     * 「目标工作区」选择器读取（用户未手动选择时默认主工作区），Revert 固定
     * 作用于抽屉当前查看的 worktree（只能撤销本分支已有提交，选择器对其无效）。
     * 后端执行失败（含冲突）时会自动回滚仓库现场，
     * 这里只负责把成功结果或错误原因弹窗告知用户。
     * 成功后按首屏语义重载抽屉提交列表（loadedCount 归零），让新产生的提交出现在列表顶部。
     * @param {string} action - 仅允许 'cherry-pick' | 'revert'
     * @param {string} sha - 目标提交完整 SHA（内联 onclick 只传十六进制）
     * @param {HTMLElement} btn - 被点击的按钮，执行期间禁用以防重复提交
     */
    async function commitActionWithConfirm(action, sha, btn) {
      // 内联 onclick 参数只放行白名单 action 与十六进制 SHA，杜绝任意字符串进入事件处理
      if (action !== 'cherry-pick' && action !== 'revert') return;
      if (!/^[0-9a-fA-F]{7,40}$/.test(sha || '')) return;
      // Cherry-pick 的作用目标从详情面板的「目标工作区」选择器读取，不通过内联字符串传递；
      // 用户未手动改动选择器时默认取主工作区（典型意图是把别处分支的提交合入主干）。
      // Revert 与选择器完全解绑：固定作用于抽屉当前查看的 worktree，
      // 因为 Revert 只能撤销本分支上已存在的提交，跨 worktree 选择没有意义。
      const panel = btn ? btn.closest('.commit-detail') : null;
      const targetSel = panel ? panel.querySelector('.commit-action-target') : null;
      let worktreePath = '';
      if (action === 'cherry-pick') {
        if (targetSel && !targetSel.dataset.touched) {
          const mainWt = (currentWorktrees || []).find(w => w.isMain && w.path && w.existsOnDisk !== false);
          if (mainWt) targetSel.value = mainWt.path;
        }
        worktreePath = (targetSel && targetSel.value) || getCommitDetailContextPath();
      } else {
        worktreePath = getCommitDetailContextPath();
        // 选择器可能已被用户改动过，回显为实际作用目标，避免界面与行为不一致造成误解
        if (targetSel && [...targetSel.options].some(o => o.value === worktreePath)) {
          targetSel.value = worktreePath;
        }
      }
      if (!worktreePath) return;

      const actionLabel = action === 'cherry-pick' ? 'Cherry-pick' : 'Revert';
      const confirmText = action === 'cherry-pick'
        ? `确认将提交 ${sha.slice(0, 7)} Cherry-pick 到所选目标工作区的当前分支吗？\n作用对象：${worktreePath}`
        : `确认在当前工作区的当前分支上 Revert 提交 ${sha.slice(0, 7)} 吗？将生成一条内容相反的新提交。\n作用对象：${worktreePath}`;
      if (!confirm(confirmText)) return;

      // 用户停留在确认弹窗期间面板可能已被收起，isConnected=false 时不再发起写操作
      if (btn && !btn.isConnected) return;

      if (btn) btn.disabled = true;
      try {
        const resp = await fetch('/api/commit-action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ worktree: worktreePath, action, sha })
        });
        const data = await resp.json();
        if (!data.ok) throw new Error(data.error || `HTTP ${resp.status}`);
        const newHeadShort = (typeof data.newHead === 'string' && data.newHead)
          ? data.newHead.slice(0, 7)
          : '未知';
        alert(`${actionLabel} 成功！当前分支新 HEAD：${newHeadShort}`);
        // 首屏语义重载：loadedCount 归零后重新拉取首屏，cherry-pick 产生的新提交会出现在列表顶部。
        // 写操作改变了分支与基准的关系（cherry-pick 后补丁等价、revert 后树一致），
        // 领先/落后徽章缓存必须作废重拉，否则仍显示操作前的旧计数
        commitsDrawerState.loadedCount = 0;
        commitsDrawerAheadBehind = null;
        await fetchAndRenderCommits();
        // 外层 worktree 列表的领先/同步徽标同样受写操作影响，同步刷新保持两处一致
        await refreshRepoInspectData();
      } catch (err) {
        notifyRequestFailure(err, `${actionLabel} 失败：${toDisplayErrorMessage(err, '无法连接本地服务')}`);
      } finally {
        // 重载会整体重建列表 DOM，旧按钮多已离线；仅在按钮仍连着文档时恢复可点
        if (btn && btn.isConnected) btn.disabled = false;
      }
    }

    // 提交 Diff 缓存：与详情缓存同一键格式与淘汰策略，但独立存放（详情与 Diff 是两个接口）
    const commitDiffCache = new Map();
    const COMMIT_DIFF_CACHE_MAX = 200;

    /**
     * 写入提交 Diff 缓存，超过上限时按插入顺序淘汰最早的条目。
     */
    function setCommitDiffCache(key, value) {
      if (commitDiffCache.size >= COMMIT_DIFF_CACHE_MAX) {
        commitDiffCache.delete(commitDiffCache.keys().next().value);
      }
      commitDiffCache.set(key, value);
    }

    /**
     * 切换提交详情面板内「查看 Diff」区块的展开/收起。首次展开懒加载 GET /api/commit-diff，
     * 结果写入独立缓存避免重复请求。多个提交的 Diff 可同时展开互不影响；
     * 区块挂在卡片自身详情之下，开合都不改变卡片位置，无需滚动补偿。
     * @param {HTMLElement} panel - 提交详情面板容器
     * @param {string} sha - 提交完整 SHA（内联 onclick 只传十六进制）
     */
    async function toggleCommitDiff(panel, sha) {
      if (!panel) return;
      // 内联 onclick 参数只放行十六进制 SHA，杜绝任意字符串进入事件处理
      if (!/^[0-9a-fA-F]{7,40}$/.test(sha || '')) return;
      // 上下文 worktree 由抽屉状态统一解析，不通过内联字符串传递
      const worktreePath = getCommitDetailContextPath();
      if (!worktreePath) return;

      // 已展开的 Diff 原地收起
      const existing = panel.querySelector('.commit-diff-section');
      if (existing) {
        existing.remove();
        const btn = panel.querySelector('.commit-diff-toggle-btn');
        if (btn) btn.textContent = '查看 Diff';
        return;
      }
      // 摘要尚在加载：记录意图待摘要渲染完成后自动打开；再次点击取消意图
      if (panel.querySelector('.commit-detail-loading')) {
        if (pendingCommitDiffPanels.has(panel)) pendingCommitDiffPanels.delete(panel);
        else pendingCommitDiffPanels.add(panel);
        return;
      }
      const toggleBtn = panel.querySelector('.commit-diff-toggle-btn');
      // 无文件变更的提交没有 Diff 入口
      if (!toggleBtn) return;
      toggleBtn.textContent = '收起 Diff';

      const section = document.createElement('div');
      section.className = 'commit-diff-section';
      // 阻止区块内点击冒泡到提交卡片，避免阅读/选中 Diff 文本时面板被收起
      section.addEventListener('click', e => e.stopPropagation());
      section.innerHTML = '<div class="commit-detail-loading">正在加载 Diff...</div>';
      panel.appendChild(section);
      await loadCommitDiffSection(section, worktreePath, sha);
    }

    /**
     * 向 Diff 区块写入内容：命中缓存直接渲染，否则请求接口后渲染；
     * 请求期间面板可能已被收起（isConnected 为 false），此时不再写入。
     */
    async function loadCommitDiffSection(section, worktreePath, sha) {
      const cacheKey = `${worktreePath}::${sha}`;
      if (commitDiffCache.has(cacheKey)) {
        renderCommitDiffSection(section, commitDiffCache.get(cacheKey));
        return;
      }
      try {
        const params = new URLSearchParams({ worktree: worktreePath, sha });
        const resp = await fetch(`/api/commit-diff?${params}`);
        const data = await resp.json();
        if (!data.ok) throw new Error(data.error || `HTTP ${resp.status}`);
        setCommitDiffCache(cacheKey, data);
        if (section.isConnected) {
          renderCommitDiffSection(section, data);
        }
      } catch (err) {
        if (!section.isConnected) return;
        section.innerHTML = `
          <div class="commit-detail-error">加载 Diff 失败：${escapeHtml(toDisplayErrorMessage(err, '无法连接本地服务'))}</div>
          <button type="button" class="btn-outline commit-diff-toggle-btn" data-action="diff-retry">重试</button>`;
        section.querySelector('[data-action="diff-retry"]')?.addEventListener('click', () => retryCommitDiff(section, sha));
      }
    }

    /**
     * Diff 加载失败后的重试入口：复用原区块，避免在面板里堆叠多个 Diff 区块。
     */
    function retryCommitDiff(btn, sha) {
      // 内联 onclick 参数只放行十六进制 SHA
      if (!/^[0-9a-fA-F]{7,40}$/.test(sha || '')) return;
      const section = btn.closest('.commit-diff-section');
      const worktreePath = commitsDrawerState.worktreePath;
      if (!section || !worktreePath) return;
      section.innerHTML = '<div class="commit-detail-loading">正在加载 Diff...</div>';
      loadCommitDiffSection(section, worktreePath, sha);
    }

    /**
     * 渲染逐文件 Diff 小卡片：文件路径 + 行数统计 + 染色后的文本 Diff。
     * 二进制/图片/空 diff 分别给中文占位文案，动态文本全部经过 escapeHtml。
     */
    function renderCommitDiffSection(section, data) {
      const files = Array.isArray(data.files) ? data.files : [];
      if (files.length === 0) {
        section.innerHTML = '<div class="commit-diff-empty">无文本差异</div>';
        return;
      }
      const filesHtml = files.map(f => {
        const filePath = escapeHtml(f.filePath || '');
        // 统计字段一律 Number 收敛后再插值，防止异常响应注入标记
        const added = Number(f.added) || 0;
        const deleted = Number(f.deleted) || 0;
        let bodyHtml;
        if (f.isBinary) {
          bodyHtml = '<div class="commit-diff-empty">二进制文件变更，不展示文本 Diff</div>';
        } else if (f.isImage) {
          bodyHtml = '<div class="commit-diff-empty">图片文件变更，不展示文本 Diff</div>';
        } else if (!f.diffChunk) {
          bodyHtml = '<div class="commit-diff-empty">无文本差异</div>';
        } else {
          bodyHtml = `<pre class="diff-pre"><code>${formatDiffLines(f.diffChunk)}</code></pre>`;
        }
        return `
          <div class="commit-diff-file-card">
            <div class="commit-diff-file-header" data-action="toggle-commit-diff-file" role="button" tabindex="0" aria-expanded="false">
              <span class="commit-diff-file-arrow" aria-hidden="true">▸</span>
              <span class="commit-diff-file-path" title="${filePath}">${filePath}</span>
              <span class="commit-detail-file-stats"><span class="add-count">+${added}</span> / <span class="del-count">-${deleted}</span></span>
            </div>
            <div class="commit-diff-file-body">${bodyHtml}</div>
          </div>`;
      }).join('');
      section.innerHTML = filesHtml;
      section.querySelectorAll('[data-action="toggle-commit-diff-file"]').forEach((header) => {
        const toggle = () => toggleCommitDiffFile(header);
        header.addEventListener('click', (event) => {
          event.stopPropagation();
          toggle();
        });
        header.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          event.stopPropagation();
          toggle();
        });
      });
    }

    /**
     * 切换单个文件的代码 Diff；文件卡片首次出现时保持收起，只展示路径和增删统计。
     */
    function toggleCommitDiffFile(header) {
      const card = header?.closest('.commit-diff-file-card');
      if (!card) return;
      setDiffFileExpanded(card, header, !card.classList.contains('expanded'));
    }

    /**
     * 收起全部已展开的提交 Diff 并清空待打开意图，恢复各查看按钮文案。
     * 「折叠全部」按钮与抽屉关闭/重渲染共用；Diff 区块与按钮一一对应，逐对复位。
     */
    function closeAllCommitDiffs() {
      document.querySelectorAll('.commits-drawer-body .commit-diff-section').forEach((section) => section.remove());
      document.querySelectorAll('.commits-drawer-body .commit-diff-toggle-btn').forEach((btn) => {
        btn.textContent = '查看 Diff';
      });
      pendingCommitDiffPanels.clear();
    }

    function renderCommitsFooter(data) {
      const footer = document.getElementById('commitsDrawerFooter');
      const btn = document.getElementById('loadMoreCommitsBtn');
      // 服务端返回的总数收敛为数字后再参与插值，防止异常响应注入标记
      const loadedCount = Number(commitsDrawerState.loadedCount) || 0;
      const totalCommits = Number(commitsDrawerState.totalCommits) || 0;
      footer.style.display = 'block';
      if (data.hasMore) {
        btn.textContent = `加载更多 (剩余 ${totalCommits - loadedCount} 条)`;
        btn.disabled = false;
      } else {
        btn.textContent = loadedCount > 0 ? '已显示全部提交' : '';
        btn.disabled = true;
        if (loadedCount === 0) footer.style.display = 'none';
      }
    }

    function renderCommitsError(message) {
      const body = document.getElementById('commitsDrawerBody');
      body.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></div>
          <div>加载提交记录失败</div>
          <div style="font-size:12px">${escapeHtml(message)}</div>
          <button class="btn-outline" style="margin-top:8px" data-action="commits-retry">重试</button>
        </div>`;
      body.querySelector('[data-action="commits-retry"]')?.addEventListener('click', () => retryCommitsDrawer());
      document.getElementById('commitsDrawerFooter').style.display = 'none';
    }

    function retryCommitsDrawer() {
      commitsDrawerState.loadedCount = 0;
      document.getElementById('commitsDrawerBody').innerHTML =
        '<div class="loading">正在加载提交记录...</div>';
      fetchAndRenderCommits();
    }

    function loadMoreCommits() {
      const btn = document.getElementById('loadMoreCommitsBtn');
      btn.textContent = '加载中...';
      btn.disabled = true;
      fetchAndRenderCommits();
    }

    /* ---- 本地 Merge Request：列表 / 详情抽屉 / 新建弹层 ---- */

    const MR_STATUS_META = {
      open: { label: '开启', cls: '' }, // 默认蓝色 badge
      merged: { label: '已合并', cls: 'badge-success' },
      rejected: { label: '已拒绝', cls: 'badge-muted' },
      canceled: { label: '已取消', cls: 'badge-muted' }
    };
    // 键必须与后端 action 白名单一致（approve/request_changes/reject/cancel/merge）。
    // 此前误把 reviewStatus/status 的取值（changes_requested/rejected/canceled）当作 action
    // 发给服务端，导致「要求修改/拒绝/取消」按钮一律 400 失效（2026-09-25 用户回归反馈）
    const MR_ACTION_LABELS = {
      approve: '审阅通过',
      request_changes: '要求修改',
      reject: '拒绝',
      cancel: '取消',
      merge: '合并'
    };

    /* 把 ISO 时间转成中文相对时间（MR 面板/抽屉展示用），解析失败回退 '-' */
    function formatRelativeTimeCn(iso) {
      if (!iso) return '-';
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return '-';
      const diffMs = Date.now() - d.getTime();
      if (diffMs < 0) return '刚刚';
      const minutes = Math.floor(diffMs / 60000);
      if (minutes < 1) return '刚刚';
      if (minutes < 60) return `${minutes} 分钟前`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `${hours} 小时前`;
      const days = Math.floor(hours / 24);
      if (days < 30) return `${days} 天前`;
      const months = Math.floor(days / 30);
      if (months < 12) return `${months} 个月前`;
      return `${Math.floor(months / 12)} 年前`;
    }

    /* SHA 短码展示：空值兜底为 '-' */
    function shortSha(sha) {
      return sha ? String(sha).slice(0, 8) : '-';
    }

    function mrStatusBadgeHtml(mr) {
      const meta = MR_STATUS_META[mr.status] || { label: mr.status || '未知', cls: 'badge-muted' };
      return `<span class="badge ${meta.cls}">${escapeHtml(meta.label)}</span>`;
    }

    /* 审阅状态小徽章：仅在 MR 仍开启时有意义 */
    function mrReviewBadgeHtml(mr) {
      if (mr.status !== 'open') return '';
      const map = {
        approved: '<span class="badge badge-success">审阅已通过</span>',
        changes_requested: '<span class="badge badge-warning">要求修改</span>'
      };
      return map[mr.reviewStatus] || '';
    }

    function setMrStatusFilter(status) {
      mrStatusFilter = status;
      document.querySelectorAll('#mrStatusFilterGroup .diff-mode-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.status === status);
      });
      refreshMergeRequests();
    }

    /* 拉取 MR 列表（按当前筛选）并重渲染列表与计数徽章；带请求序列防竞态 */
    async function refreshMergeRequests() {
      if (!currentRepo) {
        mergeRequestsCache = [];
        renderMrList();
        return;
      }
      const seq = ++mrListReqSeq;
      try {
        const params = new URLSearchParams({ repoPath: currentRepo });
        if (mrStatusFilter !== 'all') params.set('status', mrStatusFilter);
        const res = await fetch(`/api/merge-requests?${params}`);
        const data = await res.json();
        if (seq !== mrListReqSeq) return; // 已有更新的列表请求，丢弃旧响应
        if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);
        mergeRequestsCache = data.mergeRequests || [];
        renderMrList();
      } catch (err) {
        if (seq !== mrListReqSeq) return;
        document.getElementById('mrList').innerHTML =
          `<div class="loading" style="color: var(--danger);">MR 列表加载失败：${escapeHtml(toDisplayErrorMessage(err, '无法连接本地服务'))}</div>`;
      }
    }

    function renderMrList() {
      const container = document.getElementById('mrList');
      const badge = document.getElementById('mrCountBadge');
      if (!container) return;
      if (badge) badge.textContent = `${mergeRequestsCache.length} 个`;
      if (!currentRepo) {
        container.innerHTML = '<div class="loading">未选择仓库</div>';
        return;
      }
      if (mergeRequestsCache.length === 0) {
        container.innerHTML = `<div class="loading">${mrStatusFilter === 'all' ? '当前仓库暂无 Merge Request' : '该筛选条件下暂无 Merge Request'}</div>`;
        return;
      }
      container.innerHTML = mergeRequestsCache.map(mr => `
        <div class="list-item" style="cursor: pointer;" data-action="mr-row-open">
          <div class="item-main">
            <div class="item-header-row">
              <div class="item-name"><span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/></svg></span><span>${escapeHtml(mr.title)}</span></div>
              <div class="item-tags">${mrStatusBadgeHtml(mr)}${mrReviewBadgeHtml(mr)}</div>
            </div>
            <div class="item-desc">
              <span class="mr-branch-flow"><span>${escapeHtml(mr.sourceBranch)}</span><span>→</span><span>${escapeHtml(mr.targetBranch)}</span></span>
              · 创建于 ${escapeHtml(formatRelativeTimeCn(mr.createdAt))}
            </div>
          </div>
          <div class="item-actions">
            <button class="btn-outline" data-action="mr-open-detail">查看详情</button>
          </div>
        </div>
      `).join('');
      // 行与按钮闭包直引 mr 记录，id 不经内联字符串往返（CSP 迁移）；行序与缓存严格对齐
      container.querySelectorAll('.list-item').forEach((row, index) => {
        const mr = mergeRequestsCache[index];
        if (!mr) return;
        row.addEventListener('click', () => openMrDetail(String(mr.id)));
        row.querySelector('[data-action="mr-open-detail"]')?.addEventListener('click', (event) => {
          event.stopPropagation(); // 与原内联一致：按钮点击不触发行点击
          openMrDetail(String(mr.id));
        });
      });
    }

    /* MR 弹层的分支选择器选项：仅本地分支 */
    function branchPickerItems() {
      return currentBranches.map(b => ({
        kind: 'branch',
        value: b.name,
        identity: `branch:${b.name}`,
        label: `${b.name}`,
        searchText: b.name,
        disabled: false
      }));
    }

    /* 用最新分支数据重建弹层内隐藏 select 的选项（触发器列表据此渲染） */
    function populateMrBranchSelect(sel) {
      sel.innerHTML = '';
      branchPickerItems().forEach(o => {
        const opt = document.createElement('option');
        opt.value = o.identity;
        opt.textContent = o.label;
        sel.appendChild(opt);
      });
    }

    /* 打开新建 MR 弹层（发起 MR 的唯一入口：顶部「新建 MR」按钮）；
       prefillSourceBranch 保留缺省参数供程序化调用预填源分支 */
    function openCreateMrModal(prefillSourceBranch = '') {
      if (!currentRepo) {
        alert('请先选择仓库');
        return;
      }
      const sourceSel = document.getElementById('mrSourceSelect');
      const targetSel = document.getElementById('mrTargetSelect');
      populateMrBranchSelect(sourceSel);
      populateMrBranchSelect(targetSel);

      // source 预填优先级：入口传参 > 当前 Diff 对比对象（若为分支）> 主 worktree 分支
      let source = prefillSourceBranch;
      if (!source) {
        const targetRef = splitRefIdentity(document.getElementById('diffTargetSelect')?.value || '');
        if (targetRef.kind === 'branch') source = targetRef.value;
      }
      if (!source) {
        const mainWt = currentWorktrees.find(w => w.isMain);
        if (mainWt?.branch) source = mainWt.branch;
      }

      document.getElementById('mrCreateTitle').value = '';
      document.getElementById('mrCreateDesc').value = '';
      document.getElementById('mrCreateError').textContent = '';
      createMrSourcePicker?.setSelected(source ? `branch:${source}` : '');
      createMrTargetPicker?.setSelected(currentMainBranch ? `branch:${currentMainBranch}` : '');
      document.getElementById('createMrModal').style.display = 'flex';
      setTimeout(() => document.getElementById('mrCreateTitle').focus(), 0);
    }

    function closeCreateMrModal() {
      document.getElementById('createMrModal').style.display = 'none';
    }

    /* 创建 MR：客户端先做基础校验，服务端错误（400/404/409）显示在弹层内且不关闭 */
    async function submitCreateMr() {
      const btn = document.getElementById('mrCreateSubmitBtn');
      const errEl = document.getElementById('mrCreateError');
      const title = document.getElementById('mrCreateTitle').value.trim();
      const description = document.getElementById('mrCreateDesc').value.trim();
      const source = splitRefIdentity(document.getElementById('mrSourceSelect').value).value;
      const target = splitRefIdentity(document.getElementById('mrTargetSelect').value).value;

      errEl.textContent = '';
      if (!source) { errEl.textContent = '请选择源分支 (Source)'; return; }
      if (!target) { errEl.textContent = '请选择目标分支 (Target)'; return; }
      if (source === target) { errEl.textContent = '源分支与目标分支不能相同'; return; }
      if (!title) { errEl.textContent = '请填写 MR 标题'; return; }

      btn.disabled = true; // 提交期间禁用防重复
      btn.textContent = '创建中...';
      try {
        const res = await fetch('/api/merge-requests', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            repoPath: currentRepo,
            sourceBranch: source,
            targetBranch: target,
            title,
            description
          })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);
        closeCreateMrModal();
        refreshMergeRequests(); // 刷新列表与计数徽章
        if (data.mergeRequest?.id != null) {
          openMrDetail(data.mergeRequest.id); // 直接打开新 MR 详情
        }
      } catch (err) {
        errEl.textContent = toDisplayErrorMessage(err, '无法连接本地服务，创建 MR 失败');
      } finally {
        btn.disabled = false;
        btn.textContent = '创建 Merge Request';
      }
    }

    /* 打开 MR 详情抽屉：先渲染加载态，再由 refreshMergeRequestDetail 拉取详情 */
    async function openMrDetail(mrId, pushHistory = true) {
      mrDrawerState = { isOpen: true, id: String(mrId) };
      currentMrDetail = null;
      const overlay = document.getElementById('mrDrawerOverlay');
      const drawer = document.getElementById('mrDrawer');
      setCommitsDrawerPageScrollLocked(true);
      document.getElementById('mrDrawerBody').innerHTML = '<div class="loading">正在加载 Merge Request 详情...</div>';
      overlay.style.display = 'block';
      drawer.style.display = 'flex';
      requestAnimationFrame(() => {
        overlay.classList.add('open');
        drawer.classList.add('open');
      });
      syncStateToUrl(pushHistory);
      await refreshMergeRequestDetail();
    }

    function closeMrDrawer(pushHistory = true) {
      if (!mrDrawerState.isOpen) return;
      mrDrawerState = { isOpen: false, id: null };
      mrDetailReqSeq++; // 使在途详情/提交请求失效
      mrCommitsReqSeq++;
      syncStateToUrl(pushHistory);
      setCommitsDrawerPageScrollLocked(false);
      const overlay = document.getElementById('mrDrawerOverlay');
      const drawer = document.getElementById('mrDrawer');
      overlay.classList.remove('open');
      drawer.classList.remove('open');
      setTimeout(() => {
        if (!mrDrawerState.isOpen) {
          drawer.style.display = 'none';
          overlay.style.display = 'none';
        }
      }, 260);
    }

    /* 重拉当前 MR 详情并重渲染抽屉内容（保留抽屉打开状态与滚动位置） */
    async function refreshMergeRequestDetail() {
      if (!mrDrawerState.isOpen || mrDrawerState.id == null) return;
      const seq = ++mrDetailReqSeq;
      try {
        const res = await fetch(`/api/merge-requests/${encodeURIComponent(mrDrawerState.id)}?repoPath=${encodeURIComponent(currentRepo)}`);
        const data = await res.json();
        if (seq !== mrDetailReqSeq) return;
        if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);
        currentMrDetail = data.mergeRequest;
        renderMrDetail(currentMrDetail, null, true);
        // 判定结果同时供徽章渲染与提交列表的吸收说明使用（两者并行请求）
        mrAheadBehindReady = loadMrAheadBehind();
        loadMrCommits();
      } catch (err) {
        if (seq !== mrDetailReqSeq) return;
        renderMrDetail(null, toDisplayErrorMessage(err, '无法连接本地服务'), true);
      }
    }

    /* 渲染 MR 详情抽屉内容；refreshMode 为真时保留滚动位置（操作后局部刷新） */
    function renderMrDetail(mr, errorMessage, refreshMode = false) {
      const body = document.getElementById('mrDrawerBody');
      const prevScrollTop = refreshMode ? body.scrollTop : 0;

      if (errorMessage || !mr) {
        body.innerHTML = `
          <div class="empty-state">
            <div class="empty-state-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></div>
            <div>加载 Merge Request 详情失败</div>
            <div style="font-size:12px">${escapeHtml(errorMessage || '未知错误')}</div>
            <button class="btn-outline" style="margin-top:8px" data-action="mr-retry">重试</button>
          </div>`;
        body.querySelector('[data-action="mr-retry"]')?.addEventListener('click', () => refreshMergeRequestDetail());
        body.scrollTop = prevScrollTop;
        return;
      }

      document.getElementById('mrDrawerTitle').textContent = `MR #${mr.id} · ${mr.title}`;
      const updatedAtText = mr.updatedAt && mr.updatedAt !== mr.createdAt
        ? ` · 更新于 ${escapeHtml(formatRelativeTimeCn(mr.updatedAt))}`
        : '';

      body.innerHTML = `
        <div class="mr-detail-section">
          <div class="item-tags">${mrStatusBadgeHtml(mr)}${mrReviewBadgeHtml(mr)}</div>
          <div class="item-header-row" style="margin-top: 8px;">
            <span class="mr-branch-flow">
              <span>${escapeHtml(mr.sourceBranch)}</span>
              <span>→</span>
              <span> ${escapeHtml(mr.targetBranch)}</span>
            </span>
            <span style="font-size: 12px; color: var(--text-muted);">
              创建时 HEAD：<code>${escapeHtml(shortSha(mr.sourceHeadAtCreate))}</code> / <code>${escapeHtml(shortSha(mr.targetHeadAtCreate))}</code>
            </span>
          </div>
          <div style="font-size: 12px; color: var(--text-muted); margin-top: 6px;">创建于 ${escapeHtml(formatRelativeTimeCn(mr.createdAt))}${updatedAtText}</div>
        </div>

        <div class="mr-detail-section">
          <div class="mr-detail-section-title">描述</div>
          ${mr.description
            ? `<div style="font-size: 13px; color: var(--text); white-space: pre-wrap; word-break: break-word;">${escapeHtml(mr.description)}</div>`
            : '<div style="font-size: 12px; color: var(--text-muted);">（无描述）</div>'}
        </div>

        <div class="mr-detail-section">${mrStatusExtraHtml(mr)}</div>

        <div class="mr-detail-section" id="mrAheadBehindLine">
          <span style="font-size: 12px; color: var(--text-muted);">正在统计提交差异...</span>
        </div>

        <div class="mr-detail-section">
          <div class="mr-detail-actions" id="mrActionButtons">${buildMrActionButtonsHtml(mr)}</div>
          <div id="mrDrawerActionError" class="mr-detail-error" role="alert"></div>
          <div class="mr-detail-hint">source Worktree 的未提交内容不参与合并；合并要求审阅通过，并会实际修改 target 分支绑定的 Worktree。</div>
        </div>

        <div class="mr-detail-section">
          <button type="button" class="btn-outline" style="width: 100%;" data-action="mr-open-diff">在 Diff 中查看 Branch Diff</button>
        </div>

        <div class="mr-detail-section">
          <div class="mr-detail-section-title">领先提交（source 相对 target，点击展开改动）</div>
          <div id="mrCommitsContainer"><div class="loading" style="padding: 12px;">正在加载提交列表...</div></div>
        </div>
      `;
      bindActions(body, {
        'mr-open-diff': () => openMrBranchDiff()
      });
      bindMrActionButtons();
      body.scrollTop = prevScrollTop;
    }

    /* merged / rejected / canceled 状态的附加信息行 */
    function mrStatusExtraHtml(mr) {
      if (mr.status === 'merged') {
        return `<span class="badge badge-success">已合并</span>
          <span style="font-size: 12px; color: var(--text-muted);">合并于 ${escapeHtml(formatRelativeTimeCn(mr.mergedAt))} · 合并提交 <code>${escapeHtml(shortSha(mr.mergedCommit))}</code></span>`;
      }
      if (mr.status === 'rejected' || mr.status === 'canceled') {
        const label = mr.status === 'rejected' ? '已拒绝' : '已取消';
        return `<span class="badge badge-muted">${label}</span>
          <span style="font-size: 12px; color: var(--text-muted);">原因：${escapeHtml(mr.decisionReason || '（未填写）')}</span>`;
      }
      return '';
    }

    /* 按 MR 状态与审阅状态渲染操作按钮区 */
    function buildMrActionButtonsHtml(mr) {
      if (mr.status !== 'open') {
        return '<span style="font-size: 12px; color: var(--text-muted);">该 MR 已结束，无可用操作。</span>';
      }
      const parts = [];
      if (mr.reviewStatus === 'approved') {
        parts.push('<button type="button" class="btn-primary" data-action="mr-act" data-mr-action="merge" data-need-confirm="1" title="将执行 --no-ff 合并到 target 分支的 Worktree">合并 (--no-ff)</button>');
      } else if (mr.reviewStatus === 'changes_requested') {
        parts.push('<button type="button" class="btn-outline" data-action="mr-act" data-mr-action="approve">重新通过（审阅通过）</button>');
        parts.push('<button type="button" class="btn-primary" disabled title="审阅通过后才能合并">合并</button>');
      } else {
        parts.push('<button type="button" class="btn-outline" data-action="mr-act" data-mr-action="approve">审阅通过</button>');
      }
      parts.push('<button type="button" class="btn-outline" data-action="mr-act" data-mr-action="request_changes">要求修改</button>');
      parts.push('<button type="button" class="btn-danger" data-action="mr-act" data-mr-action="reject">拒绝</button>');
      parts.push('<button type="button" class="btn-outline" data-action="mr-act" data-mr-action="cancel">取消</button>');
      return parts.join('');
    }

    /* 绑定 MR 操作按钮：action 名经 data-mr-action 白名单式标记传递，needConfirm 仅合并需要 */
    function bindMrActionButtons() {
      const holder = document.getElementById('mrActionButtons');
      if (!holder) return;
      bindActions(holder, {
        'mr-act': (el) => mrAction(el.dataset.mrAction, el, el.dataset.needConfirm === '1')
      });
    }

    /* 操作期间禁用全部操作按钮；恢复时按当前 MR 状态重建（保持「合并」的条件禁用态） */
    function setMrActionButtonsDisabled(disabled) {
      const holder = document.getElementById('mrActionButtons');
      if (!holder) return;
      if (disabled) {
        holder.querySelectorAll('button').forEach(b => { b.disabled = true; });
      } else if (currentMrDetail) {
        holder.innerHTML = buildMrActionButtonsHtml(currentMrDetail);
        bindMrActionButtons();
      }
    }

    /* MR 操作统一入口：需要原因的操作改为抽屉内行内输入（不依赖 window.prompt，
       内嵌/受限环境不支持 prompt 时依然可用）；合并保留 confirm 二次确认。
       实际请求统一在 doMrAction 完成，成功后局部刷新详情与列表；
       失败（含 Git 冲突 409）在抽屉内展示中文错误，MR 保持原状态，按钮恢复可用 */
    async function mrAction(action, btn, needConfirm = false) {
      const mr = currentMrDetail;
      if (!mr || !MR_ACTION_LABELS[action]) return;

      if (action === 'request_changes' || action === 'reject' || action === 'cancel') {
        showMrReasonInput(action);
        return;
      }
      if (action === 'merge' && needConfirm) {
        const targetWt = currentWorktrees.find(w => w.branch === mr.targetBranch);
        const targetHint = targetWt
          ? `\n目标 Worktree：${targetWt.path}`
          : '\n（未找到目标分支绑定的 Worktree，合并可能失败）';
        if (!confirm(`确认合并 MR「${mr.title}」吗？\n将执行 --no-ff 合并到 ${mr.targetBranch} 分支的 Worktree。${targetHint}`)) return;
      }
      await doMrAction(action, '');
    }

    /* 在操作按钮区展开行内原因输入行；「返回」按当前 MR 状态重建按钮区 */
    function showMrReasonInput(action) {
      const holder = document.getElementById('mrActionButtons');
      if (!holder) return;
      const label = MR_ACTION_LABELS[action] || '操作';
      holder.innerHTML = `
        <div class="mr-reason-row">
          <input type="text" id="mrReasonInput" class="mr-reason-input" placeholder="${label}原因（可留空）">
          <button type="button" class="btn-primary" data-action="mr-reason-submit">确认${label}</button>
          <button type="button" class="btn-outline" data-action="mr-reason-back">返回</button>
        </div>`;
      // action 与 label 均来自页面内白名单常量，闭包直引不再拼进事件属性（CSP 迁移）
      const input = document.getElementById('mrReasonInput');
      holder.querySelector('[data-action="mr-reason-submit"]')?.addEventListener('click', () => submitMrReason(action));
      holder.querySelector('[data-action="mr-reason-back"]')?.addEventListener('click', () => renderMrDetail(currentMrDetail, null, true));
      input?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          submitMrReason(action);
        }
      });
      if (input) input.focus();
    }

    /* 读取行内原因输入并提交动作 */
    async function submitMrReason(action) {
      const input = document.getElementById('mrReasonInput');
      await doMrAction(action, input ? input.value.trim() : '');
    }

    async function doMrAction(action, reason) {
      const mr = currentMrDetail;
      if (!mr || !MR_ACTION_LABELS[action]) return;
      setMrActionButtonsDisabled(true);
      try {
        const res = await fetch('/api/merge-requests/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoPath: currentRepo, id: mr.id, action, reason: reason || undefined })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);

        // 成功：重拉详情（保留滚动位置）并刷新列表/计数
        await refreshMergeRequestDetail();
        refreshMergeRequests();
        if (action === 'merge') {
          // 合并会实际修改 target 分支：联动刷新仓库分析数据与相关视图（均为局部刷新，不做全量 reload）
          await refreshRepoInspectData();
          refreshCommitsDrawerIfRelatedToBranches([mr.sourceBranch, mr.targetBranch]);
          refreshDiffViewIfRelatedToBranches([mr.sourceBranch, mr.targetBranch]);
        }
      } catch (err) {
        const errEl = document.getElementById('mrDrawerActionError');
        if (errEl) errEl.textContent = `操作失败：${toDisplayErrorMessage(err, '无法连接本地服务')}`;
        setMrActionButtonsDisabled(false);
        loadMrAheadBehind(); // 静默刷新一次 ahead/behind，冲突破坏提交关系时能及时反映
      }
    }

    /* MR 详情的 ahead/behind 统计：以 target 为基准、source 为 ref。
       事实认定复用 /api/worktree-ahead-behind 的四方判定结论（contentEquivalent/mergeType），
       徽章渲染复用 buildAheadBehindBadgeHtml——与提交抽屉同一套出口，禁止直接用机械计数；
       返回接口数据（失败时 null）供提交列表判断是否附加吸收说明 */
    async function loadMrAheadBehind() {
      const mr = currentMrDetail;
      const lineEl = document.getElementById('mrAheadBehindLine');
      if (!mr || !lineEl) return null;
      try {
        const params = new URLSearchParams({ worktree: currentRepo, base: mr.targetBranch, ref: mr.sourceBranch });
        const res = await fetch(`/api/worktree-ahead-behind?${params}`);
        const data = await res.json();
        if (!mrDrawerState.isOpen || mrDrawerState.id !== String(mr.id)) return null;
        if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);
        if (data.baseAvailable === false) throw new Error(`无法解析基准分支 ${mr.targetBranch}`);
        lineEl.innerHTML = buildAheadBehindBadgeHtml(data, 'mrAheadBehind');
        return data;
      } catch (err) {
        if (!mrDrawerState.isOpen || mrDrawerState.id !== String(mr.id)) return null;
        lineEl.innerHTML = `<span style="font-size: 12px; color: var(--text-muted);">提交差异统计不可用：${escapeHtml(toDisplayErrorMessage(err, '无法连接本地服务'))}</span>`;
        return null;
      }
    }

    /* MR 详情的提交列表：仅展示 source 相对 target 的领先提交（base..ref 范围，
       不传 fullHistory），卡片可点击展开单提交详情与逐文件 Diff，无需跳转 Diff 页。
       渲染前等待 mrAheadBehindReady 的四方判定结果：内容已被目标吸收时附加事实说明，
       避免用户把「机械领先计数」误解为存在真实差异 */
    async function loadMrCommits() {
      const mr = currentMrDetail;
      const container = document.getElementById('mrCommitsContainer');
      if (!mr || !container) return;
      const seq = ++mrCommitsReqSeq;
      try {
        const params = new URLSearchParams({
          worktree: currentRepo,
          base: mr.targetBranch,
          ref: mr.sourceBranch,
          limit: '50'
        });
        const res = await fetch(`/api/worktree-commits?${params}`);
        const data = await res.json();
        if (seq !== mrCommitsReqSeq) return;
        if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);
        // 与 ahead/behind 请求并行，这里等它的四方判定结论（失败不影响列表本身）
        const abData = await mrAheadBehindReady;
        if (seq !== mrCommitsReqSeq) return;
        const commits = data.commits || [];
        if (commits.length === 0) {
          container.innerHTML = '<div class="commit-diff-empty">source 相对 target 没有领先的提交。</div>';
          return;
        }
        // 卡片结构与提交抽屉一致：点击展开详情，点击 SHA 复制完整哈希（阻止冒泡）
        let html = commits.map((c, batchIdx) => `
          <div class="commit-item clickable" data-action="commit-toggle" data-c-idx="${batchIdx}">
            <div class="commit-item-header">
              <span class="commit-hash" data-action="commit-copy-hash" title="点击复制完整 SHA">${escapeHtml(c.shortHash)}</span>
              <span class="commit-time">${escapeHtml(c.relativeTime)}</span>
            </div>
            <div class="commit-subject" title="${escapeHtml(c.subject)}">${escapeHtml(c.subject)}</div>
            <div class="commit-author">${escapeHtml(c.author)}</div>
          </div>
        `).join('');
        if (abData && abData.contentEquivalent === true) {
          html = `<div class="commit-diff-empty" style="color: var(--warning);">这些提交的内容已被 ${escapeHtml(mr.targetBranch)} 吸收（cherry-pick / squash / revert 抵消等），合并不会产生实际文件变化。</div>` + html;
        }
        container.innerHTML = html;
        // 与提交抽屉同一批次绑定逻辑（闭包直引 commits，hash 不经字符串往返）
        bindCommitCards(container, commits);
      } catch (err) {
        if (seq !== mrCommitsReqSeq) return;
        container.innerHTML = `<div class="commit-detail-error">提交列表加载失败：${escapeHtml(toDisplayErrorMessage(err, '无法连接本地服务'))}</div>`;
      }
    }

    /* ================= 远端分支管理 Tab =================
       覆盖三类能力：基于远端分支创建远端分支（纯远端操作）、
       目标工作区分支切换/检出远端分支（可重命名）、合并远端分支 +
       冲突快捷处理（ours/theirs）与自定义编辑冲突区域。 */

    /* 当前选中的目标工作区；未选择时回退主工作区（getWorktrees 首条） */
    function getRemoteTargetWorktree() {
      const select = document.getElementById('remoteWorktreeSelect');
      const selected = select ? select.value : '';
      if (selected) return selected;
      const main = currentWorktrees.find(w => w.isMain && w.existsOnDisk !== false);
      return main ? main.path : (currentWorktrees[0] ? currentWorktrees[0].path : '');
    }

    /* 重建目标工作区下拉：保留仍然有效的既有选择，否则回退主工作区 */
    function populateRemoteWorktreeSelect() {
      const select = document.getElementById('remoteWorktreeSelect');
      if (!select) return;
      select.innerHTML = '';
      currentWorktrees
        .filter(w => w.existsOnDisk !== false)
        .forEach(w => {
          const opt = document.createElement('option');
          opt.value = w.path;
          opt.textContent = w.isMain ? `主工作区 · ${w.branch || w.head || '(bare)'} · ${w.path}` : `${w.branch || w.head || '(detached)'} · ${w.path}`;
          select.appendChild(opt);
        });
      // 目标失效（被移除等）时回退主工作区；否则保留用户选择
      const valid = [...select.options].some(o => o.value === remoteState.targetWorktree);
      if (!valid) remoteState.targetWorktree = getRemoteTargetWorktree();
      select.value = remoteState.targetWorktree;
    }

    /* ================= 通用确认弹层与分支名预校验（分支管理 Tab 二次确认统一入口） ================= */

    /* 自定义确认弹层，返回 Promise<'confirm' | 'alt' | 'cancel'>：
       - altText 提供可选第三选项（如「用当前快照直接合并」），解决原生 confirm 只有两键、
         「取消」被迫承担「继续执行」语义的陷阱；
       - danger=true 时确认按钮转危险色；requireText 非空时需输入完全一致文本才能确认（删除远端分支防误触）；
       - 同一时间只允许一个确认弹层：新弹层打开时未决的旧弹层按 'cancel' 结算，避免 Promise 悬挂 */
    let appConfirmResolve = null;

    function appConfirmDialog({ title = '确认操作', message = '', confirmText = '确定', cancelText = '取消',
      altText = '', altPrimary = false, danger = false, requireText = '' } = {}) {
      settleAppConfirm('cancel');
      return new Promise((resolve) => {
        appConfirmResolve = resolve;
        document.getElementById('appConfirmTitle').textContent = title;
        document.getElementById('appConfirmMessage').innerHTML = escapeHtml(message).replace(/\n/g, '<br>');
        const okBtn = document.getElementById('appConfirmOkBtn');
        const altBtn = document.getElementById('appConfirmAltBtn');
        const cancelBtn = document.getElementById('appConfirmCancelBtn');
        cancelBtn.textContent = cancelText;
        okBtn.textContent = confirmText;
        okBtn.className = danger ? 'btn-danger' : 'btn-primary';
        altBtn.style.display = altText ? '' : 'none';
        altBtn.textContent = altText;
        altBtn.className = altPrimary ? 'btn-primary' : 'btn-outline';
        const requireGroup = document.getElementById('appConfirmRequireGroup');
        const requireInput = document.getElementById('appConfirmRequireInput');
        if (requireText) {
          requireGroup.style.display = '';
          document.getElementById('appConfirmRequireEcho').textContent = requireText;
          requireInput.value = '';
          okBtn.disabled = true;
        } else {
          requireGroup.style.display = 'none';
          okBtn.disabled = false;
        }
        document.getElementById('appConfirmModal').style.display = 'flex';
        if (requireText) requireInput.focus();
      });
    }

    /* 结算并收起确认弹层，把结果透传给等待方 */
    function settleAppConfirm(result) {
      const modal = document.getElementById('appConfirmModal');
      if (modal) modal.style.display = 'none';
      if (appConfirmResolve) {
        const resolve = appConfirmResolve;
        appConfirmResolve = null;
        resolve(result);
      }
    }

    /* 分支名客户端预校验：镜像后端 validateRefFormat 中可同步判定的子集，
       让弹层在提交前就给出提示；最终仍以后端 git check-ref-format 为准 */
    function validateBranchNameClient(name) {
      if (!name) return '分支名不能为空';
      if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/')) return '分支名不能以 - 或 / 开头，也不能以 / 结尾';
      if (/[\s\0]/.test(name)) return '分支名不能包含空白或控制字符';
      if (name.includes('..')) return '分支名不能包含连续的两个点（..）';
      if (name.length > 250) return '分支名长度不能超过 250 个字符';
      if (/[~^:?*\\[]/.test(name)) return '分支名不能包含 ~ ^ : ? * [ \\ 这些字符';
      if (name.endsWith('.lock')) return '分支名不能以 .lock 结尾';
      if (name.includes('@{')) return '分支名不能包含 @{';
      return '';
    }

    /* 按所选口径排序列表：在过滤结果副本上排序，不改后端返回的原顺序（recent 即保持原序） */
    function sortBranchEntries(entries, mode) {
      if (mode === 'name') {
        return [...entries].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
      }
      if (mode === 'ahead') {
        // ahead 未知（无法与主干比对）时排到最后
        return [...entries].sort((a, b) => ((b.ahead ?? -1) - (a.ahead ?? -1)));
      }
      return entries;
    }

    /* 过滤输入防抖：分支数大时整列表重绘开销明显，输入停顿后再渲染 */
    function debounceFn(fn, wait) {
      let timer = null;
      return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), wait);
      };
    }

    /* 进入 Tab / 仓库数据变化后的入口：重拉目标工作区、本地/远端分支清单与 merge 状态 */
    function refreshRemoteTab() {
      populateRemoteWorktreeSelect();
      refreshRemoteBranches();
      refreshLocalBranches();
      refreshMergeState();
    }

    /* 拉取远端分支清单并渲染（请求序列防竞态：仅最后一次响应上屏） */
    async function refreshRemoteBranches() {
      const container = document.getElementById('remoteBranchList');
      if (!currentRepo) {
        container.innerHTML = '<div class="loading">请先选择仓库</div>';
        document.getElementById('remoteBranchCount').textContent = '0 个';
        return;
      }
      const seq = ++remoteState.branchesReqSeq;
      container.classList.add('is-loading');
      try {
        const res = await fetch(`/api/remote-branches?path=${encodeURIComponent(currentRepo)}`);
        const data = await res.json();
        if (seq !== remoteState.branchesReqSeq) return;
        if (!data.ok) throw new Error(data.error || '读取远端分支失败');
        remoteState.branches = data.branches || [];
        remoteState.lastFetchAt = data.lastFetchAt || null;
        renderRemoteBranchList();
      } catch (err) {
        if (seq !== remoteState.branchesReqSeq) return;
        container.innerHTML = `<div class="loading" style="color: var(--danger);">远端分支加载失败：${escapeHtml(toDisplayErrorMessage(err, '无法连接本地服务'))}</div>`;
      } finally {
        // 已被更新的请求接管时不摘除标记，由接管方管理
        if (seq === remoteState.branchesReqSeq) container.classList.remove('is-loading');
      }
    }

    /* 拉取本地分支清单并渲染（请求序列防竞态：仅最后一次响应上屏） */
    async function refreshLocalBranches() {
      const container = document.getElementById('localBranchList');
      if (!currentRepo) {
        container.innerHTML = '<div class="loading">请先选择仓库</div>';
        document.getElementById('localBranchCount').textContent = '0 个';
        return;
      }
      const seq = ++remoteState.localBranchesReqSeq;
      container.classList.add('is-loading');
      try {
        const res = await fetch(`/api/local-branches?path=${encodeURIComponent(currentRepo)}`);
        const data = await res.json();
        if (seq !== remoteState.localBranchesReqSeq) return;
        if (!data.ok) throw new Error(data.error || '读取本地分支失败');
        remoteState.localBranches = data.branches || [];
        renderLocalBranchList();
      } catch (err) {
        if (seq !== remoteState.localBranchesReqSeq) return;
        container.innerHTML = `<div class="loading" style="color: var(--danger);">本地分支加载失败：${escapeHtml(toDisplayErrorMessage(err, '无法连接本地服务'))}</div>`;
      } finally {
        if (seq === remoteState.localBranchesReqSeq) container.classList.remove('is-loading');
      }
    }

    /* 单条本地分支的状态徽标：主分支 / 检出绑定 / 相对主干领先落后与合入状态 */
    function localBranchBadgesHtml(b) {
      const badges = [];
      if (b.isMain) badges.push('<span class="badge badge-success">主分支</span>');
      if (b.worktree) {
        const wtName = (currentWorktrees.find(w => w.path === b.worktree.path) || {}).name;
        const wtLabel = wtName || b.worktree.path.split('/').filter(Boolean).pop() || b.worktree.path;
        badges.push(`<span class="badge" title="正被工作区检出：${escapeHtml(b.worktree.path)}">${b.worktree.isMain ? '主工作区检出' : escapeHtml(wtLabel)} 检出中</span>`);
      }
      if (b.ahead !== null && b.behind !== null) {
        if (b.ahead === 0 && b.behind === 0) {
          badges.push('<span class="badge">与主干同步</span>');
        } else {
          if (b.ahead > 0) badges.push(`<span class="badge badge-success">领先主干 ${b.ahead}</span>`);
          if (b.behind > 0) badges.push(`<span class="badge badge-warning">落后主干 ${b.behind}</span>`);
        }
      }
      if (!b.isMain && b.mergedIntoMain) badges.push('<span class="badge badge-success">已合入主干</span>');
      return badges.join('');
    }

    /* 渲染本地分支列表（含客户端过滤与排序切换），逐行绑定检出与删除入口 */
    function renderLocalBranchList() {
      const container = document.getElementById('localBranchList');
      const filterInput = document.getElementById('localBranchFilterInput');
      const keyword = (filterInput ? filterInput.value : '').trim().toLowerCase();
      const all = remoteState.localBranches;
      const filtered = keyword ? all.filter(b => b.name.toLowerCase().includes(keyword)) : all;
      const sorted = sortBranchEntries(filtered, remoteState.localBranchSort);

      document.getElementById('localBranchCount').textContent = `${all.length} 个`;
      if (!currentRepo) {
        container.innerHTML = '<div class="loading">请先选择仓库</div>';
        return;
      }
      if (all.length === 0) {
        container.innerHTML = '<div class="loading">没有本地分支</div>';
        return;
      }
      if (filtered.length === 0) {
        container.innerHTML = '<div class="loading">没有匹配的本地分支</div>';
        return;
      }

      container.innerHTML = sorted.map(b => `
        <div class="list-item" data-local-branch="${escapeHtml(b.name)}">
          <div class="item-main">
            <div class="item-header-row">
              <span class="item-name">${escapeHtml(b.name)}</span>
              <span class="item-tags">${localBranchBadgesHtml(b)}</span>
            </div>
            <div class="item-desc">
              ${escapeHtml(shortSha(b.sha))} · ${escapeHtml(b.author || '-')} ·
              ${escapeHtml(formatRelativeTimeCn(b.committerDate) || b.committerDate || '-')} ·
              ${escapeHtml(b.subject || '')}
            </div>
          </div>
          <div class="item-actions">
            ${b.worktree ? '' : '<button class="btn-outline" type="button" data-lb-action="checkout" title="把该分支检出到任选工作区">检出到工作区</button>'}
            ${!b.isMain && !b.worktree ? `<button class="btn-outline branch-delete-btn" type="button" data-lb-action="delete" title="${b.mergedIntoMain ? '删除该分支（已合入主干，安全删除）' : '强制删除该分支（有未合入主干的提交，删除后不可恢复）'}">删除</button>` : ''}
          </div>
        </div>
      `).join('');

      container.querySelectorAll('[data-lb-action]').forEach(btn => {
        btn.addEventListener('click', (event) => {
          event.stopPropagation();
          const row = btn.closest('[data-local-branch]');
          const branch = remoteState.localBranches.find(b => b.name === row.dataset.localBranch);
          if (!branch) return;
          if (btn.dataset.lbAction === 'checkout') openCheckoutLocalModal(branch);
          else if (btn.dataset.lbAction === 'delete') deleteLocalBranchAction(branch);
        });
      });
    }

    /* 检出本地分支弹层：目标工作区可下拉选择，默认当前工具栏目标 */
    function openCheckoutLocalModal(branch) {
      remoteState.checkoutLocalModalBranch = branch.name;
      document.getElementById('checkoutLocalModalSource').textContent = branch.name;
      populateWorktreeSelectOptions(document.getElementById('checkoutLocalWorktreeSelect'), remoteState.targetWorktree);
      document.getElementById('checkoutLocalModalError').textContent = '';
      document.getElementById('checkoutLocalBranchModal').style.display = 'flex';
    }

    function closeCheckoutLocalModal() {
      document.getElementById('checkoutLocalBranchModal').style.display = 'none';
      remoteState.checkoutLocalModalBranch = null;
    }

    async function submitCheckoutLocalBranch() {
      const branchName = remoteState.checkoutLocalModalBranch;
      if (!branchName) return;
      const worktree = document.getElementById('checkoutLocalWorktreeSelect').value || remoteState.targetWorktree;
      const errorEl = document.getElementById('checkoutLocalModalError');
      const submitBtn = document.getElementById('checkoutLocalSubmitBtn');
      errorEl.textContent = '';
      submitBtn.disabled = true;
      try {
        const res = await fetch('/api/checkout-branch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoPath: currentRepo, worktree, refType: 'local', ref: branchName })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || '检出失败');
        closeCheckoutLocalModal();
        syncTargetWorktreeAfterModal(worktree);
        showToast(`已把「${branchName}」检出到所选工作区`);
        // 检出会切换工作区分支：总览、检出绑定与 merge 状态都需刷新
        inspectRepo(currentRepo);
        refreshLocalBranches();
        refreshMergeState();
      } catch (err) {
        errorEl.textContent = toDisplayErrorMessage(err, '检出失败');
      } finally {
        submitBtn.disabled = false;
      }
    }

    /* 删除本地分支：已合入走安全删除确认；有未合入提交（或合入状态未知）时
       要求输入分支名二次确认后强制删除，避免误触丢失提交 */
    async function deleteLocalBranchAction(branch) {
      const force = !branch.mergedIntoMain;
      let message;
      if (force) {
        message = typeof branch.ahead === 'number'
          ? `分支「${branch.name}」有 ${branch.ahead} 个未合入主干的提交，强制删除后这些提交将丢失且不可恢复。`
          : `分支「${branch.name}」的合入状态未能确认（无法与主干比对），强制删除可能丢失未合入的提交。`;
        message += `\n\n如确认要删除，请在下方输入分支名以确认。`;
      } else {
        message = `确定删除本地分支「${branch.name}」？\n该分支已合入主干，删除安全。`;
      }
      const result = await appConfirmDialog({
        title: force ? '强制删除本地分支' : '删除本地分支',
        message,
        confirmText: force ? '强制删除' : '删除',
        danger: true,
        requireText: force ? branch.name : ''
      });
      if (result !== 'confirm') return;
      try {
        const res = await fetch('/api/delete-local-branch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoPath: currentRepo, branch: branch.name, force })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || '删除分支失败');
        showToast(`本地分支「${branch.name}」已删除`);
        refreshLocalBranches();
      } catch (err) {
        showToast(`删除失败：${toDisplayErrorMessage(err, '无法连接本地服务')}`);
      }
    }

    /* 删除远端分支：服务端拒绝保护分支（远端默认分支）。
       远端删除影响所有协作者，要求输入完整分支名防误触 */
    async function deleteRemoteBranchAction(branch) {
      const result = await appConfirmDialog({
        title: '删除远端分支',
        message: `即将删除远端上的分支「${branch.name}」。\n\n该操作会影响所有协作者；已检出该分支的工作区不受影响，但之后无法再从远端拉取它。\n\n为防误触，请输入完整分支名以确认。`,
        confirmText: '删除远端分支',
        danger: true,
        requireText: branch.name
      });
      if (result !== 'confirm') return;
      try {
        const res = await fetch('/api/delete-remote-branch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoPath: currentRepo, ref: branch.name })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || '删除远端分支失败');
        showToast(`远端分支「${branch.name}」已删除`);
        refreshRemoteBranches();
        refreshLocalBranches();
      } catch (err) {
        showToast(`删除失败：${toDisplayErrorMessage(err, '无法连接本地服务')}`);
      }
    }

    /* 单条远端分支的状态徽标：相对主干领先/落后 + 本地同名分支同步状态 */
    function remoteBranchBadgesHtml(b) {
      const badges = [];
      if (b.ahead !== null && b.behind !== null) {
        if (b.ahead === 0 && b.behind === 0) {
          badges.push('<span class="badge">与主干同步</span>');
        } else {
          if (b.ahead > 0) badges.push(`<span class="badge badge-success">领先主干 ${b.ahead}</span>`);
          if (b.behind > 0) badges.push(`<span class="badge badge-warning">落后主干 ${b.behind}</span>`);
        }
      }
      if (b.local) {
        if (b.local.ahead === 0 && b.local.behind === 0) {
          badges.push('<span class="badge">本地已同步</span>');
        } else if (b.local.ahead > 0) {
          badges.push(`<span class="badge badge-warning">本地领先 ${b.local.ahead}</span>`);
        } else if (b.local.behind > 0) {
          badges.push(`<span class="badge badge-warning">本地落后 ${b.local.behind}</span>`);
        }
        const boundWt = currentWorktrees.find(w => w.branch === b.branch);
        if (boundWt) badges.push('<span class="badge">已检出</span>');
      } else {
        badges.push('<span class="badge badge-muted" title="本地尚无同名跟踪分支；可点行内「检出」创建">未检出</span>');
      }
      return badges.join('');
    }

    /* 渲染远端分支列表（含客户端过滤与排序切换），并逐行绑定操作入口 */
    function renderRemoteBranchList() {
      const container = document.getElementById('remoteBranchList');
      const filterInput = document.getElementById('remoteBranchFilterInput');
      const keyword = (filterInput ? filterInput.value : '').trim().toLowerCase();
      const all = remoteState.branches;
      const filtered = keyword ? all.filter(b => b.name.toLowerCase().includes(keyword)) : all;
      const sorted = sortBranchEntries(filtered, remoteState.remoteBranchSort);

      document.getElementById('remoteBranchCount').textContent = `${all.length} 个`;
      if (!currentRepo) {
        container.innerHTML = '<div class="loading">请先选择仓库</div>';
        return;
      }
      if (all.length === 0) {
        container.innerHTML = '<div class="loading">没有远端分支。可点击上方「刷新远端 (fetch)」同步远端状态。</div>';
        return;
      }
      if (filtered.length === 0) {
        container.innerHTML = '<div class="loading">没有匹配的远端分支</div>';
        return;
      }

      container.innerHTML = sorted.map(b => `
        <div class="list-item" data-remote-branch="${escapeHtml(b.name)}">
          <div class="item-main">
            <div class="item-header-row">
              <span class="item-name">${escapeHtml(b.name)}</span>
              <span class="item-tags">${remoteBranchBadgesHtml(b)}</span>
            </div>
            <div class="item-desc">
              ${escapeHtml(shortSha(b.sha))} · ${escapeHtml(b.author || '-')} ·
              ${escapeHtml(formatRelativeTimeCn(b.committerDate) || b.committerDate || '-')} ·
              ${escapeHtml(b.subject || '')}
            </div>
          </div>
          <div class="item-actions">
            <button class="btn-outline" type="button" data-rb-action="checkout" title="检出为本地跟踪分支（可重命名）到目标工作区">检出</button>
            <button class="btn-outline" type="button" data-rb-action="merge" title="合并该远端分支到目标工作区当前分支">合并到工作区</button>
            <button class="btn-outline" type="button" data-rb-action="create" title="以该远端分支为基准创建新的远端分支（纯远端操作）">建远端分支</button>
            ${b.isProtected ? '' : '<button class="btn-outline branch-delete-btn" type="button" data-rb-action="delete" title="直接删除远端上的该分支（不可恢复）">删除</button>'}
          </div>
        </div>
      `).join('');

      container.querySelectorAll('[data-rb-action]').forEach(btn => {
        btn.addEventListener('click', (event) => {
          event.stopPropagation();
          const row = btn.closest('[data-remote-branch]');
          const branch = remoteState.branches.find(b => b.name === row.dataset.remoteBranch);
          if (!branch) return;
          if (btn.dataset.rbAction === 'checkout') openCheckoutModal(branch);
          else if (btn.dataset.rbAction === 'merge') mergeRemoteRef(branch);
          else if (btn.dataset.rbAction === 'create') openCreateRemoteModal(branch);
          else if (btn.dataset.rbAction === 'delete') deleteRemoteBranchAction(branch);
        });
      });
    }

    /* 拉取目标工作区的合并进行状态并渲染冲突处理面板 */
    async function refreshMergeState() {
      const worktree = remoteState.targetWorktree;
      if (!worktree) {
        remoteState.mergeState = null;
        renderRemoteMergePanel();
        return;
      }
      const seq = ++remoteState.mergeStateReqSeq;
      try {
        const res = await fetch(`/api/merge-state?worktree=${encodeURIComponent(worktree)}`);
        const data = await res.json();
        if (seq !== remoteState.mergeStateReqSeq) return;
        if (!data.ok) throw new Error(data.error || '读取合并状态失败');
        remoteState.mergeState = data;
        renderRemoteMergePanel();
        renderRemoteTargetInfo();
      } catch (err) {
        if (seq !== remoteState.mergeStateReqSeq) return;
        remoteState.mergeState = null;
        renderRemoteMergePanel();
        console.warn('读取合并状态失败:', err.message);
      }
    }

    /* 目标工作区信息行：当前分支 + 未提交修改提示 */
    function renderRemoteTargetInfo() {
      const el = document.getElementById('remoteTargetInfo');
      const wt = currentWorktrees.find(w => w.path === remoteState.targetWorktree);
      if (!wt) {
        el.innerHTML = '<span style="color: var(--text-muted);">未选择目标工作区</span>';
        return;
      }
      const dirty = wt.isDirty
        ? `<span style="color: var(--warning);">${wt.dirtyCount || 0} 个未提交修改</span>`
        : '<span style="color: var(--success);">工作区干净</span>';
      el.innerHTML = `当前分支：<strong>${escapeHtml(wt.branch || wt.head || '(detached)')}</strong> · ${dirty}`;
    }

    /* 渲染合并进行中面板：冲突清单 + 快捷处理按钮 + 完成/放弃合并入口 */
    function renderRemoteMergePanel() {
      const panel = document.getElementById('remoteMergePanel');
      const state = remoteState.mergeState;
      if (!state || !state.inMerge) {
        panel.style.display = 'none';
        return;
      }
      panel.style.display = 'block';
      document.getElementById('remoteMergeLabels').textContent =
        `${state.oursLabel || '当前分支'} ← ${state.theirsLabel || '来源分支'}`;

      const conflicts = state.conflictFiles || [];
      const summary = document.getElementById('remoteMergeSummary');
      if (conflicts.length === 0) {
        summary.textContent = '冲突已全部处理，可点击「完成合并」生成合并提交。';
        summary.className = 'remote-merge-summary done';
      } else {
        summary.textContent = `共 ${conflicts.length} 个冲突文件待处理。可逐文件快捷采用某一侧，或进入编辑器自定义修改冲突区域。`;
        summary.className = 'remote-merge-summary';
      }
      document.getElementById('mergeCommitBtn').disabled = conflicts.length > 0;
      // 禁用原因就地可见：避免「按钮点不动但不知道为什么」的盲区
      document.getElementById('mergeCommitHint').textContent = conflicts.length > 0 ? `剩余 ${conflicts.length} 个冲突未解决` : '';
      document.getElementById('mergeCommitBtn').title = conflicts.length > 0
        ? `还有 ${conflicts.length} 个冲突文件未处理，全部处理后方可完成合并`
        : '冲突全部处理后生成合并提交';

      const list = document.getElementById('remoteConflictList');
      list.innerHTML = conflicts.map(f => {
        // 该侧缺少 stage 时「采用」的语义是删除（服务端按 stage 判定，UI 不自行猜冲突码），
        // 文案必须点明，避免用户以为会恢复内容
        const code = String(f.code || 'UU');
        const oursLabel = f.oursDeleted ? '采用当前分支（删除文件）' : '采用当前分支';
        const theirsLabel = f.theirsDeleted ? '采用来源分支（删除文件）' : '采用来源分支';
        return `
        <div class="conflict-item" data-conflict-path="${escapeHtml(f.path)}">
          <div class="conflict-item-main">
            <div class="conflict-item-path">${escapeHtml(f.path)}</div>
            <div class="item-tags"><span class="badge badge-warning">${escapeHtml(code)} · ${escapeHtml(f.label)}</span></div>
          </div>
          <div class="conflict-item-actions">
            <button class="btn-outline" type="button" data-cf-action="ours" title="采用当前分支（ours）版本；该侧已删除文件时执行删除">${oursLabel}</button>
            <button class="btn-outline" type="button" data-cf-action="theirs" title="采用合并来源（theirs）版本；该侧已删除文件时执行删除">${theirsLabel}</button>
            <button class="btn-danger" type="button" data-cf-action="delete" title="删除该文件并标记冲突已解决">删除文件</button>
            <button class="btn-primary" type="button" data-cf-action="edit" title="打开编辑器自定义修改冲突区域">编辑</button>
          </div>
        </div>
      `;
      }).join('');

      list.querySelectorAll('[data-cf-action]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const row = btn.closest('[data-conflict-path]');
          const filePath = row.dataset.conflictPath;
          const action = btn.dataset.cfAction;
          if (action === 'edit') {
            openConflictDrawer(filePath);
            return;
          }
          // 删除按钮，以及「采用」的是已删除该文件的一侧，都会落成删除，统一二次确认
          const conflict = (remoteState.mergeState?.conflictFiles || []).find(item => item.path === filePath);
          const willDelete = action === 'delete'
            || (action === 'ours' && conflict?.oursDeleted)
            || (action === 'theirs' && conflict?.theirsDeleted);
          if (willDelete) {
            const del = await appConfirmDialog({
              title: '删除冲突文件',
              message: `确定删除冲突文件「${filePath}」并标记为已解决吗？`,
              confirmText: '删除',
              danger: true
            });
            if (del !== 'confirm') return;
          }
          resolveConflictFileAction(filePath, action);
        });
      });
    }

    /* 快捷处理单个冲突文件（ours/theirs），成功后刷新面板与剩余计数 */
    async function resolveConflictFileAction(filePath, resolution) {
      const worktree = remoteState.targetWorktree;
      if (!worktree) return;
      try {
        const res = await fetch('/api/merge-resolve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ worktree, filePath, resolution })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || '处理冲突失败');
        if (data.deleted) {
          showToast(`已删除冲突文件：${filePath}`);
        } else {
          showToast(resolution === 'ours' ? `已采用当前分支版本：${filePath}` : `已采用来源分支版本：${filePath}`);
        }
        refreshMergeState();
      } catch (err) {
        notifyRequestFailure(err, '处理冲突失败：' + toDisplayErrorMessage(err, '无法连接本地服务'));
      }
    }

    /* 发起合并：先做远端新鲜度检查（久未 fetch 提示，三选项），确认后调用 merge-ref；
       干净合并直接完成，冲突时面板自动接管 */
    async function mergeRemoteRef(branch) {
      const worktree = remoteState.targetWorktree;
      if (!worktree) {
        alert('没有可用的目标工作区');
        return;
      }
      const fresh = await ensureFreshRemoteBeforeMerge();
      if (fresh === 'cancel') return;
      const wt = currentWorktrees.find(w => w.path === worktree);
      const currentBranch = wt ? (wt.branch || '(detached)') : '?';
      const ok = await appConfirmDialog({
        title: '确认合并',
        message: `确定把远端分支「${branch.name}」合并进工作区「${currentBranch}」吗？\n\n发生冲突时会保留现场，可在下方逐个处理。`,
        confirmText: '合并'
      });
      if (ok !== 'confirm') return;
      try {
        const res = await fetch('/api/merge-ref', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoPath: currentRepo, worktree, ref: branch.name, refType: 'remote' })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || '合并失败');
        if (data.status === 'merged') {
          showToast(data.fastForward
            ? `已快进合并 ${branch.name}（HEAD → ${shortSha(data.head)}）`
            : `合并完成：${branch.name} → ${currentBranch}（${shortSha(data.head)}）`);
        } else if (data.status === 'conflict') {
          showToast(`合并存在 ${data.conflictFiles.length} 个冲突文件，请在下方处理`);
        }
        // 合并会改变工作区内容与分支头，全量刷新保持各面板一致
        inspectRepo(currentRepo);
        refreshMergeState();
      } catch (err) {
        notifyRequestFailure(err, '合并失败：' + toDisplayErrorMessage(err, '无法连接本地服务'));
      }
    }

    /* 完成/放弃合并动作（面板按钮） */
    async function completeMerge() {
      const worktree = remoteState.targetWorktree;
      if (!worktree) return;
      const ok = await appConfirmDialog({
        title: '完成合并',
        message: '确定完成合并并生成合并提交吗？',
        confirmText: '完成合并'
      });
      if (ok !== 'confirm') return;
      try {
        const res = await fetch('/api/merge-commit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ worktree })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || '完成合并失败');
        showToast(`合并提交完成（${shortSha(data.head)}）`);
        inspectRepo(currentRepo);
        // 合并提交改变本地分支历史：本地清单的合入状态需同步刷新
        refreshLocalBranches();
        refreshMergeState();
      } catch (err) {
        notifyRequestFailure(err, '完成合并失败：' + toDisplayErrorMessage(err, '无法连接本地服务'));
      }
    }

    async function abortMergeAction() {
      const worktree = remoteState.targetWorktree;
      if (!worktree) return;
      const ok = await appConfirmDialog({
        title: '放弃合并',
        message: '确定放弃本次合并吗？\n工作区将恢复到合并前的状态，已做过的冲突处理会一并丢弃。',
        confirmText: '放弃合并',
        danger: true
      });
      if (ok !== 'confirm') return;
      try {
        const res = await fetch('/api/merge-abort', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ worktree })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || '放弃合并失败');
        showToast('已放弃合并，现场已恢复');
        inspectRepo(currentRepo);
        refreshMergeState();
      } catch (err) {
        notifyRequestFailure(err, '放弃合并失败：' + toDisplayErrorMessage(err, '无法连接本地服务'));
      }
    }

    /* 自动刷新远端：按所选频率链式排队；远端 Tab 激活且选中仓库时静默 fetch 并重拉清单。
       Tab 未激活时跳过本 tick（不 fetch 但保持队列），保证切回 Tab 后的下一个周期恢复工作 */
    function scheduleRemoteAutoFetch() {
      if (remoteAutoFetchTimer) {
        clearTimeout(remoteAutoFetchTimer);
        remoteAutoFetchTimer = null;
      }
      const mode = localStorage.getItem(REMOTE_AUTO_FETCH_STORAGE_KEY) || 'off';
      const interval = REMOTE_AUTO_FETCH_INTERVALS[mode];
      if (!interval) return;
      remoteAutoFetchTimer = setTimeout(async () => {
        remoteAutoFetchTimer = null;
        if (activeTab === 'remote' && currentRepo && !remoteAutoFetching && !document.hidden) {
          remoteAutoFetching = true;
          try {
            const res = await fetch('/api/fetch-remotes', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ repoPath: currentRepo })
            });
            const data = await res.json();
            if (data.ok) {
              refreshRemoteBranches();
            }
          } catch {
            // 网络层失败保持静默：自动刷新不打断用户，状态由手动刷新或下次 tick 修正
          } finally {
            remoteAutoFetching = false;
          }
        }
        scheduleRemoteAutoFetch();
      }, interval);
    }

    /* 读取自动刷新档位（初始化下拉与恢复持久化值） */
    function initRemoteAutoFetchControl() {
      const select = document.getElementById('remoteAutoFetchSelect');
      if (!select) return;
      const saved = localStorage.getItem(REMOTE_AUTO_FETCH_STORAGE_KEY);
      select.value = REMOTE_AUTO_FETCH_INTERVALS[saved] ? saved : 'off';
      select.addEventListener('change', () => {
        localStorage.setItem(REMOTE_AUTO_FETCH_STORAGE_KEY, select.value);
        scheduleRemoteAutoFetch();
      });
      scheduleRemoteAutoFetch();
    }

    /* 合并前的新鲜度检查：距上次 fetch 超过阈值（或从未 fetch）时给出三选项——
       先刷新再合并（主按钮）/ 用当前快照直接合并（第三按钮）/ 取消合并。
       返回 'refresh'（已刷新可继续）| 'continue'（直接合并）| 'cancel'（中止本次操作）。
       三选项是有意的：原生 confirm 两键时「取消」只能被迫承担「继续执行」的语义 */
    async function ensureFreshRemoteBeforeMerge() {
      const lastFetchAt = remoteState.lastFetchAt;
      let staleHint;
      if (!lastFetchAt) {
        staleHint = '本仓库尚未刷新过远端（fetch）';
      } else {
        const age = Date.now() - new Date(lastFetchAt).getTime();
        if (!(age >= REMOTE_FETCH_STALE_MS)) return 'continue';
        staleHint = `距上次刷新远端已约 ${Math.max(1, Math.round(age / 60000))} 分钟`;
      }
      const choice = await appConfirmDialog({
        title: '远端信息可能过期',
        message: `${staleHint}，合并依据的远端分支快照可能不是最新。\n\n建议先刷新远端（fetch）再合并；也可以用当前快照直接合并，或取消本次操作。`,
        confirmText: '先刷新再合并',
        altText: '用当前快照直接合并',
        cancelText: '取消合并'
      });
      if (choice === 'cancel') return 'cancel';
      if (choice !== 'confirm') return 'continue';
      try {
        const res = await fetch('/api/fetch-remotes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoPath: currentRepo })
        });
        const data = await res.json();
        if (data.ok) {
          await refreshRemoteBranches();
          showToast('远端已刷新，继续合并');
          return 'refresh';
        }
        showToast(`刷新远端失败：${String(data.output || data.error || '未知原因').split('\n').pop()}（将用当前快照合并）`);
        return 'continue';
      } catch (err) {
        notifyRequestFailure(err, '刷新远端失败：' + toDisplayErrorMessage(err, '无法连接本地服务'));
        return 'continue';
      }
    }

    /* 刷新远端（fetch --prune --all）：网络失败按后端 ok:false 展示原始输出摘要 */
    async function fetchRemotesAction(btn) {
      if (!currentRepo) return;
      if (btn) { btn.disabled = true; btn.textContent = '刷新中…'; }
      try {
        const res = await fetch('/api/fetch-remotes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoPath: currentRepo })
        });
        const data = await res.json();
        if (!data.ok) {
          // ok:false 为 git 层失败（网络/凭据/超时），取末行原始输出做摘要
          showToast(`刷新远端失败：${String(data.output || data.error || '未知原因').split('\n').pop()}`);
        } else {
          showToast('远端刷新完成');
        }
        refreshRemoteBranches();
      } catch (err) {
        notifyRequestFailure(err, '刷新远端失败：' + toDisplayErrorMessage(err, '无法连接本地服务'));
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = '刷新远端 (fetch)'; }
      }
    }

    /* ================= Worktree 管理扩展：上锁/解锁、别名编辑、创建工作区 ================= */

    /* 上锁/解锁（git worktree lock/unlock）：上锁后 git 拒绝对该工作区的移除与清理 */
    async function toggleWorktreeLock(wt) {
      const locking = !wt.isLocked;
      if (!window.confirm(locking
        ? `确定锁定工作区「${wt.name || wt.path}」吗？\n上锁后 git 会拒绝移除/清理该工作区（保护现场）。`
        : `确定解锁工作区「${wt.name || wt.path}」吗？\n解锁后该工作区可被移除与清理。`)) {
        return;
      }
      try {
        const res = await fetch('/api/worktree-lock', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoPath: currentRepo, worktreePath: wt.path, lock: locking })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || (locking ? '上锁失败' : '解锁失败'));
        showToast(locking ? '已上锁：该工作区受 git 保护' : '已解锁');
        // 纯展示字段变化：只就地刷新该条目，不做整页 inspect
        wt.isLocked = locking;
        refreshWorktreeItemInPlace(wt.path);
      } catch (err) {
        notifyRequestFailure(err, (locking ? '上锁' : '解锁') + '失败：' + toDisplayErrorMessage(err, '无法连接本地服务'));
      }
    }

    /* 编辑 Worktree 信息（别名）：别名仅本应用内展示，git 本身无 worktree 命名概念 */
    function openEditWorktreeModal(wt) {
      remoteState.editWorktreePath = wt.path;
      document.getElementById('editWtPath').textContent = wt.path;
      document.getElementById('editWtNameInput').value = wt.name || '';
      document.getElementById('editWtError').textContent = '';
      document.getElementById('editWorktreeModal').style.display = 'flex';
      document.getElementById('editWtNameInput').focus();
    }

    function closeEditWorktreeModal() {
      document.getElementById('editWorktreeModal').style.display = 'none';
      remoteState.editWorktreePath = '';
    }

    async function submitEditWorktree() {
      const worktreePath = remoteState.editWorktreePath;
      if (!worktreePath) return;
      const target = currentWorktrees.find(w => w.path === worktreePath);
      const name = document.getElementById('editWtNameInput').value.trim();
      const errorEl = document.getElementById('editWtError');
      const submitBtn = document.getElementById('editWtSubmitBtn');
      errorEl.textContent = '';
      if (!name && !(target && target.isMain)) {
        // 非主工作区的名称即目录名，不允许为空；主工作区仅改别名，允许清除
        errorEl.textContent = '名称不能为空（它会同步作为工作区目录名）';
        return;
      }
      submitBtn.disabled = true;
      try {
        let data;
        if (target && !target.isMain) {
          // 非主工作区：名称同步作为根目录名（git worktree move + 别名随目录迁移）
          const res = await fetch('/api/worktree-rename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ repoPath: currentRepo, worktreePath, name })
          });
          data = await res.json();
          if (!data.ok) throw new Error(data.error || '重命名失败');
          closeEditWorktreeModal();
          showToast(`目录与名称已同步为「${data.name}」`);
          // 就地刷新该条目并同步远端 Tab 的目标工作区引用（路径变了，不整页重分析）
          const oldNodeId = 'wt-item-' + encodeURIComponent(worktreePath).replace(/%/g, '_');
          target.path = data.worktreePath;
          target.name = data.name;
          const oldNode = document.getElementById(oldNodeId);
          if (oldNode) oldNode.replaceWith(createWorktreeItemDom(target));
          if (remoteState.targetWorktree === worktreePath) {
            remoteState.targetWorktree = data.worktreePath;
            const select = document.getElementById('remoteWorktreeSelect');
            if (select) select.value = data.worktreePath;
            renderRemoteTargetInfo();
          }
        } else {
          // 主工作区：目录承载共享 .git 不重命名，仅更新应用内别名
          const res = await fetch('/api/worktree-meta', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ repoPath: currentRepo, worktreePath, name })
          });
          data = await res.json();
          if (!data.ok) throw new Error(data.error || '保存失败');
          closeEditWorktreeModal();
          showToast(data.name ? `工作区名称已设为「${data.name}」` : '工作区名称已清除');
          if (target) {
            if (data.name) target.name = data.name;
            else delete target.name;
            refreshWorktreeItemInPlace(worktreePath);
          }
        }
      } catch (err) {
        errorEl.textContent = toDisplayErrorMessage(err, '保存失败');
      } finally {
        submitBtn.disabled = false;
      }
    }

    /* 打开创建 Worktree 弹层：填充「未绑定分支」候选与「新建分支起点」候选，
       并按所选分支预填默认目录（仓库同级）与默认工作区名称 */
    function openCreateWorktreeModal() {
      if (!currentRepo) {
        alert('请先选择仓库');
        return;
      }
      createWtDirTouched = false;
      createWtNameTouched = false;
      document.getElementById('createWtNameInput').value = '';
      document.getElementById('createWtPathInput').value = '';
      document.getElementById('createWtNewBranchInput').value = '';
      document.getElementById('createWtError').textContent = '';
      setCreateWtBranchMode('existing');

      // 已有分支候选：未被任何 worktree 检出（git 不允许两个工作区共享同一分支）
      const boundBranches = new Set(currentWorktrees.map(w => w.branch).filter(Boolean));
      const existingSelect = document.getElementById('createWtExistingSelect');
      existingSelect.innerHTML = '';
      const freeBranches = currentBranches.filter(b => !b.isMain && !boundBranches.has(b.name));
      if (freeBranches.length === 0) {
        existingSelect.innerHTML = '<option value="">（没有未绑定的本地分支，可改用「新建分支」）</option>';
      } else {
        freeBranches.forEach(b => {
          const opt = document.createElement('option');
          opt.value = b.name;
          opt.textContent = `${b.name}`;
          existingSelect.appendChild(opt);
        });
      }

      // 新建分支起点候选：本地分支 + 远端分支（identity 前缀区分），默认空 = HEAD
      const startPointSelect = document.getElementById('createWtStartPointSelect');
      startPointSelect.innerHTML = '<option value="">（当前 HEAD）</option>';
      currentBranches.forEach(b => {
        const opt = document.createElement('option');
        opt.value = `branch:${b.name}`;
        opt.textContent = `${b.name}`;
        startPointSelect.appendChild(opt);
      });
      remoteState.branches.forEach(b => {
        const opt = document.createElement('option');
        opt.value = `remote:${b.name}`;
        opt.textContent = `${b.name}`;
        startPointSelect.appendChild(opt);
      });

      updateCreateWtDefaults();
      document.getElementById('createWorktreeModal').style.display = 'flex';
      document.getElementById('createWtNameInput').focus();
    }

    /* 从分支名推导默认目录名/工作区名：取末段并替换路径非法字符 */
    function wtDefaultSegment(raw) {
      const segment = String(raw || '').split('/').filter(Boolean).pop() || '';
      return segment.replace(/[\s\\:*\?"<>|]/g, '-');
    }

    /* 当前分支选择对应的默认名（末段）；无法推导时回退 new-worktree */
    function createWtCurrentSegment() {
      const raw = createWtBranchMode === 'existing'
        ? document.getElementById('createWtExistingSelect').value
        : document.getElementById('createWtNewBranchInput').value.trim();
      return wtDefaultSegment(raw) || 'new-worktree';
    }

    /* 仓库同级目录 + 默认名 组成默认目标目录 */
    function wtDefaultDirectory(segment) {
      const repoParent = currentRepo.split('/').slice(0, -1).join('/') || '/';
      return `${repoParent}/${segment}`;
    }

    /* 分支选择/输入变化时重算默认目录与默认名称；用户手动改过的字段不覆盖 */
    function updateCreateWtDefaults() {
      const segment = createWtCurrentSegment();
      if (!createWtDirTouched) {
        document.getElementById('createWtPathInput').value = wtDefaultDirectory(segment);
      }
      if (!createWtNameTouched) {
        document.getElementById('createWtNameInput').value = segment;
      }
    }

    /* 调起系统目录选择对话框：桌面走 preload 直连，浏览器走服务端系统选择器。
       返回所选目录绝对路径；取消或失败返回 null（与扫描目录弹窗的处理器独立，
       那个函数会把结果写进扫描草稿且恒返回 undefined，不能复用） */
    async function pickDirectoryDialog() {
      if (isDesktop && typeof window.gitLens?.chooseDirectory === 'function') {
        try {
          return await window.gitLens.chooseDirectory();
        } catch {
          return null;
        }
      }
      try {
        const res = await fetch('/api/choose-scan-directory', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        const data = await res.json();
        return data.ok ? (data.directory || null) : null;
      } catch {
        return null;
      }
    }

    /* 系统文件夹选择器挑选父目录：替换目录的父级部分，目录名保持不变 */
    async function chooseCreateWtParent() {
      const directory = await pickDirectoryDialog();
      if (!directory) return;
      const pathInput = document.getElementById('createWtPathInput');
      const current = pathInput.value.trim();
      const parent = directory.replace(/[/\\]+$/, '');
      // 当前目录为空时用默认目录名兜底，否则保留用户已填的目录名
      const baseName = current
        ? (current.split('/').filter(Boolean).pop() || current.split('\\').filter(Boolean).pop() || '')
        : createWtCurrentSegment();
      pathInput.value = baseName ? `${parent}/${baseName}` : parent;
      createWtDirTouched = true;
    }

    function closeCreateWorktreeModal() {
      document.getElementById('createWorktreeModal').style.display = 'none';
    }

    /* 切换分支来源模式：已有分支 / 以起点新建分支 */
    function setCreateWtBranchMode(mode) {
      createWtBranchMode = mode === 'new' ? 'new' : 'existing';
      document.querySelectorAll('#createWtBranchModeGroup .diff-mode-btn').forEach(btn => {
        btn.className = btn.dataset.mode === createWtBranchMode ? 'diff-mode-btn active' : 'diff-mode-btn';
      });
      document.getElementById('createWtExistingGroup').style.display = createWtBranchMode === 'existing' ? 'block' : 'none';
      document.getElementById('createWtNewGroup').style.display = createWtBranchMode === 'new' ? 'block' : 'none';
      updateCreateWtDefaults();
    }

    async function submitCreateWorktree() {
      const worktreePath = document.getElementById('createWtPathInput').value.trim();
      const name = document.getElementById('createWtNameInput').value.trim();
      const errorEl = document.getElementById('createWtError');
      const submitBtn = document.getElementById('createWtSubmitBtn');
      errorEl.textContent = '';
      if (!worktreePath) {
        errorEl.textContent = '目标目录不能为空';
        return;
      }
      // 绝对路径粗校验（POSIX 以 / 开头；Windows 接受盘符或 UNC），权威校验由服务端完成
      if (!/^(\/|[a-zA-Z]:[\\/]|\\\\)/.test(worktreePath)) {
        errorEl.textContent = '目标目录必须为绝对路径';
        return;
      }
      let branchMode = createWtBranchMode;
      let branchName = '';
      let startPoint = '';
      if (createWtBranchMode === 'existing') {
        branchName = document.getElementById('createWtExistingSelect').value;
        if (!branchName) {
          errorEl.textContent = '请选择要检出的本地分支，或改用「新建分支」模式';
          return;
        }
      } else {
        branchName = document.getElementById('createWtNewBranchInput').value.trim();
        const startIdentity = document.getElementById('createWtStartPointSelect').value;
        if (!branchName) {
          errorEl.textContent = '新建分支名不能为空';
          return;
        }
        if (startIdentity) {
          // identity 形如 branch:main / remote:origin/x；两者去掉前缀后即是合法起点引用
          startPoint = startIdentity.slice(startIdentity.indexOf(':') + 1);
        }
      }
      submitBtn.disabled = true;
      const seq = ++worktreeCreateSubmitSeq;
      try {
        const res = await fetch('/api/create-worktree', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoPath: currentRepo, worktreePath, branchMode, branchName, startPoint, name })
        });
        const data = await res.json();
        if (seq !== worktreeCreateSubmitSeq) return;
        if (!data.ok) throw new Error(data.error || '创建失败');
        closeCreateWorktreeModal();
        showToast(`Worktree 已创建：${data.branch} → ${data.path}`);
        if (data.nameError) showToast(`${data.nameError}`);
        inspectRepo(currentRepo);
      } catch (err) {
        if (seq !== worktreeCreateSubmitSeq) return;
        errorEl.textContent = toDisplayErrorMessage(err, '创建失败');
      } finally {
        if (seq === worktreeCreateSubmitSeq) submitBtn.disabled = false;
      }
    }

    /* ================= Worktree 管理扩展结束 ================= */

    /* 填充弹层内的「目标工作区」下拉（全部在盘工作区），并选中默认值 */
    function populateWorktreeSelectOptions(selectEl, selectedPath) {
      if (!selectEl) return;
      selectEl.innerHTML = '';
      currentWorktrees
        .filter(w => w.existsOnDisk !== false)
        .forEach(w => {
          const opt = document.createElement('option');
          opt.value = w.path;
          opt.textContent = w.isMain ? `主工作区 · ${w.branch || '(detached)'} · ${w.path}` : `${w.branch || '(detached)'} · ${w.path}`;
          selectEl.appendChild(opt);
        });
      const valid = [...selectEl.options].some(o => o.value === selectedPath);
      selectEl.value = valid ? selectedPath : (selectEl.options[0] ? selectEl.options[0].value : '');
    }

    /* 检出远端分支弹层：可重命名本地分支名（默认远端分支短名），目标工作区可下拉选择 */
    function openCheckoutModal(branch) {
      const worktree = remoteState.targetWorktree;
      if (!worktree) {
        alert('没有可用的目标工作区');
        return;
      }
      remoteState.checkoutModalBranch = branch;
      document.getElementById('checkoutModalSource').textContent = branch.name;
      populateWorktreeSelectOptions(document.getElementById('checkoutWorktreeSelect'), worktree);
      const nameInput = document.getElementById('checkoutLocalNameInput');
      nameInput.value = branch.branch;
      document.getElementById('checkoutModalError').textContent = '';
      document.getElementById('checkoutBranchModal').style.display = 'flex';
      validateCheckoutLocalName();
      nameInput.focus();
    }

    function closeCheckoutModal() {
      document.getElementById('checkoutBranchModal').style.display = 'none';
      remoteState.checkoutModalBranch = null;
    }

    /* 检出弹层本地分支名实时校验：格式预检 + 与现有本地分支重名预检，
       让问题在提交前暴露，而不是等后端 409 */
    function validateCheckoutLocalName() {
      const input = document.getElementById('checkoutLocalNameInput');
      const hintEl = document.getElementById('checkoutNameValidation');
      const submitBtn = document.getElementById('checkoutSubmitBtn');
      const name = input.value.trim();
      let error = validateBranchNameClient(name);
      if (!error && remoteState.localBranches.some(b => b.name === name)) {
        error = `本地分支「${name}」已存在：可直接在列表中检出它，或换个名称`;
      }
      hintEl.textContent = error;
      hintEl.style.display = error ? '' : 'none';
      submitBtn.disabled = !!error;
    }

    async function submitCheckoutBranch() {
      const branch = remoteState.checkoutModalBranch;
      if (!branch) return;
      // 目标工作区以弹层下拉为准；所选与工具栏不同时同步工具栏上下文
      const worktree = document.getElementById('checkoutWorktreeSelect').value || remoteState.targetWorktree;
      const localName = document.getElementById('checkoutLocalNameInput').value.trim();
      const errorEl = document.getElementById('checkoutModalError');
      const submitBtn = document.getElementById('checkoutSubmitBtn');
      errorEl.textContent = '';
      if (!localName) {
        errorEl.textContent = '本地分支名不能为空';
        return;
      }
      submitBtn.disabled = true;
      try {
        const res = await fetch('/api/checkout-branch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoPath: currentRepo, worktree, refType: 'remote', ref: branch.name, localName })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || '检出失败');
        closeCheckoutModal();
        syncTargetWorktreeAfterModal(worktree);
        showToast(`已检出 ${branch.name} 为本地分支「${data.branch}」`);
        // 检出会切换工作区分支：总览面板、目标信息与 merge 状态都需要刷新
        inspectRepo(currentRepo);
        refreshMergeState();
      } catch (err) {
        errorEl.textContent = toDisplayErrorMessage(err, '检出失败');
      } finally {
        // 按当前输入重新计算按钮态，避免请求失败的 finally 一刀切开锁
        validateCheckoutLocalName();
      }
    }

    /* 弹层里选过目标工作区后，把工具栏上下文同步到同一工作区，保持后续操作一致 */
    function syncTargetWorktreeAfterModal(worktree) {
      if (!worktree || remoteState.targetWorktree === worktree) return;
      remoteState.targetWorktree = worktree;
      const select = document.getElementById('remoteWorktreeSelect');
      if (select) select.value = worktree;
      renderRemoteTargetInfo();
    }

    /* 创建远端分支弹层：以选中远端分支为基准直接 push 新远端分支 */
    function openCreateRemoteModal(branch) {
      remoteState.createRemoteModalBranch = branch;
      document.getElementById('createRemoteModalSource').textContent = branch.name;
      const nameInput = document.getElementById('createRemoteBranchNameInput');
      // 预填建议名：基准名追加 -copy 后缀（远端重名时后端会拒绝并提示）
      nameInput.value = `${branch.branch}-copy`;
      document.getElementById('createRemoteModalError').textContent = '';
      document.getElementById('createRemoteBranchModal').style.display = 'flex';
      validateCreateRemoteName();
      nameInput.focus();
    }

    function closeCreateRemoteModal() {
      document.getElementById('createRemoteBranchModal').style.display = 'none';
      remoteState.createRemoteModalBranch = null;
    }

    /* 建远端分支弹层实时校验：格式预检 + 与现有远端分支重名预检（push 必然会被拒） */
    function validateCreateRemoteName() {
      const input = document.getElementById('createRemoteBranchNameInput');
      const hintEl = document.getElementById('createRemoteNameValidation');
      const submitBtn = document.getElementById('createRemoteSubmitBtn');
      const name = input.value.trim();
      let error = validateBranchNameClient(name);
      if (!error && remoteState.branches.some(b => b.branch === name)) {
        error = `远端已存在名为「${name}」的分支，请换一个名称`;
      }
      hintEl.textContent = error;
      hintEl.style.display = error ? '' : 'none';
      submitBtn.disabled = !!error;
    }

    async function submitCreateRemoteBranch() {
      const branch = remoteState.createRemoteModalBranch;
      if (!branch) return;
      const newBranchName = document.getElementById('createRemoteBranchNameInput').value.trim();
      const errorEl = document.getElementById('createRemoteModalError');
      const submitBtn = document.getElementById('createRemoteSubmitBtn');
      errorEl.textContent = '';
      if (!newBranchName) {
        errorEl.textContent = '新远端分支名不能为空';
        return;
      }
      submitBtn.disabled = true;
      try {
        const res = await fetch('/api/create-remote-branch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoPath: currentRepo, sourceRef: branch.name, newBranchName })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || '创建远端分支失败');
        closeCreateRemoteModal();
        showToast(`远端分支「${data.remote}/${data.branch}」创建成功`);
        refreshRemoteBranches();
      } catch (err) {
        errorEl.textContent = toDisplayErrorMessage(err, '创建远端分支失败');
      } finally {
        validateCreateRemoteName();
      }
    }

    /* 切换/检出分支弹层的候选项：本地分支（直接切换）+ 远端分支（新建跟踪分支检出） */
    function switchBranchPickerItems() {
      const localItems = currentBranches.map(b => ({
        kind: 'branch',
        value: b.name,
        identity: `branch:${b.name}`,
        label: `${b.name}`,
        searchText: b.name,
        disabled: false
      }));
      const remoteItems = remoteState.branches.map(b => ({
        kind: 'remote',
        value: b.name,
        identity: `remote:${b.name}`,
        label: `${b.name}`,
        searchText: b.name,
        disabled: false
      }));
      return [...localItems, ...remoteItems];
    }

    /* 切换弹层的即时反馈：所选工作区是否干净（脏工作区切换必被拒）、
       所选分支类型对应的行为语义说明；未选分支时提交按钮保持禁用 */
    function updateSwitchDirtyHint() {
      const hintEl = document.getElementById('switchBranchDirtyHint');
      const select = document.getElementById('switchWorktreeSelect');
      const wt = currentWorktrees.find(w => w.path === (select ? select.value : ''));
      if (!wt) {
        hintEl.textContent = '';
        return;
      }
      if (wt.isDirty) {
        hintEl.textContent = `所选工作区有 ${wt.dirtyCount || 0} 个未提交修改，切换/检出会被拒绝`;
        hintEl.className = 'remote-modal-hint error';
      } else {
        hintEl.textContent = '✓ 所选工作区当前干净，可执行切换';
        hintEl.className = 'remote-modal-hint ok';
      }
    }

    function updateSwitchBranchModalState(identity) {
      document.getElementById('switchBranchSubmitBtn').disabled = !identity;
      const kindHint = document.getElementById('switchBranchKindHint');
      if (!identity) {
        kindHint.textContent = '选择本地分支为直接切换；选择远端分支会以同名新建本地跟踪分支并检出。';
        return;
      }
      kindHint.textContent = identity.startsWith('remote:')
        ? '将检出该远端分支为同名本地跟踪分支并自动建立 upstream；若本地已有同名分支会被拒绝。'
        : '将把所选工作区直接切换到该本地分支；工作区有未提交修改时会被拒绝。';
    }

    function openSwitchBranchModal() {
      const worktree = remoteState.targetWorktree;
      if (!worktree) {
        alert('没有可用的目标工作区');
        return;
      }
      // 远端分支清单可能尚未拉取（直接点按钮的场景），先同步一次再渲染候选
      const renderPicker = () => {
        const sel = document.getElementById('switchBranchSelect');
        sel.innerHTML = '';
        switchBranchPickerItems().forEach(o => {
          const opt = document.createElement('option');
          opt.value = o.identity;
          opt.textContent = o.label;
          sel.appendChild(opt);
        });
        // 默认不预选（空值提交时提示必须选择）
        sel.value = '';
        updateSwitchBranchModalState('');
        switchBranchPicker.refresh();
      };
      populateWorktreeSelectOptions(document.getElementById('switchWorktreeSelect'), worktree);
      document.getElementById('switchBranchModalError').textContent = '';
      document.getElementById('switchBranchModal').style.display = 'flex';
      updateSwitchDirtyHint();
      if (remoteState.branches.length === 0) {
        refreshRemoteBranches().then(renderPicker);
      } else {
        renderPicker();
      }
    }

    function closeSwitchBranchModal() {
      document.getElementById('switchBranchModal').style.display = 'none';
    }

    async function submitSwitchBranch() {
      const identity = document.getElementById('switchBranchSelect').value;
      const errorEl = document.getElementById('switchBranchModalError');
      errorEl.textContent = '';
      if (!identity) {
        errorEl.textContent = '请先选择要切换到的分支';
        return;
      }
      const colonIdx = identity.indexOf(':');
      const refType = identity.slice(0, colonIdx);
      const ref = identity.slice(colonIdx + 1);
      // 目标工作区以弹层下拉为准；所选与工具栏不同时同步工具栏上下文
      const worktree = document.getElementById('switchWorktreeSelect').value || remoteState.targetWorktree;
      const submitBtn = document.getElementById('switchBranchSubmitBtn');
      submitBtn.disabled = true;
      try {
        const res = await fetch('/api/checkout-branch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoPath: currentRepo, worktree, refType, ref })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || '切换失败');
        closeSwitchBranchModal();
        syncTargetWorktreeAfterModal(worktree);
        showToast(refType === 'remote' ? `已检出 ${ref} 为本地分支「${data.branch}」` : `已切换到「${data.branch}」`);
        inspectRepo(currentRepo);
        // 检出/切换改变本地分支的检出绑定：本地清单需同步刷新
        refreshLocalBranches();
        refreshMergeState();
      } catch (err) {
        errorEl.textContent = toDisplayErrorMessage(err, '切换失败');
      } finally {
        submitBtn.disabled = false;
      }
    }

    /* ---- 冲突文件编辑抽屉 ---- */

    /* 打开抽屉并加载冲突文件三方内容；二进制文件只允许 ours/theirs 快捷处理 */
    async function openConflictDrawer(filePath) {
      const worktree = remoteState.targetWorktree;
      if (!worktree) return;
      let data;
      try {
        const res = await fetch(`/api/merge-conflict-file?worktree=${encodeURIComponent(worktree)}&filePath=${encodeURIComponent(filePath)}`);
        data = await res.json();
        if (!data.ok) throw new Error(data.error || '读取冲突文件失败');
      } catch (err) {
        notifyRequestFailure(err, '读取冲突文件失败：' + toDisplayErrorMessage(err, '无法连接本地服务'));
        return;
      }
      remoteState.editingConflictPath = filePath;
      document.getElementById('conflictDrawerTitle').textContent = `编辑冲突文件 · ${filePath}`;
      const textarea = document.getElementById('conflictEditorTextarea');
      document.getElementById('conflictDrawerError').textContent = '';
      if (data.isBinary) {
        textarea.value = '';
        textarea.disabled = true;
        document.getElementById('conflictDrawerHint').textContent = '该文件是二进制文件，不支持文本编辑，请在冲突清单中使用「采用当前分支 / 采用来源分支 / 删除文件」。';
        document.getElementById('conflictHunkTools').innerHTML = '';
        document.getElementById('conflictSaveBtn').disabled = true;
      } else {
        textarea.disabled = false;
        textarea.value = data.raw || '';
        document.getElementById('conflictDrawerHint').textContent =
          '可直接编辑下方完整内容；也可使用上方每个冲突块的快捷按钮按侧采用。保存后文件会写入工作区并标记为已解决。';
        document.getElementById('conflictSaveBtn').disabled = false;
        renderConflictHunkTools();
      }
      renderConflictEditorHighlight();
      document.getElementById('conflictDrawerOverlay').style.display = 'block';
      document.getElementById('conflictDrawer').style.display = 'flex';
      // 与 MR 详情抽屉同一滑入机制：先显示再下一帧加 .open 触发 transform 过渡
      requestAnimationFrame(() => {
        document.getElementById('conflictDrawerOverlay').classList.add('open');
        document.getElementById('conflictDrawer').classList.add('open');
      });
      setCommitsDrawerPageScrollLocked(true);
    }

    function closeConflictDrawer() {
      if (!remoteState.editingConflictPath) return;
      remoteState.editingConflictPath = '';
      setCommitsDrawerPageScrollLocked(false);
      const overlay = document.getElementById('conflictDrawerOverlay');
      const drawer = document.getElementById('conflictDrawer');
      overlay.classList.remove('open');
      drawer.classList.remove('open');
      setTimeout(() => {
        if (!remoteState.editingConflictPath) {
          drawer.style.display = 'none';
          overlay.style.display = 'none';
        }
      }, 260);
    }

    /* 解析文本中的冲突标记块，记录各侧行内容与行号区间，供快捷按钮重写内容。
       兼容 diff3 的 ||||||| 基线段；行号基于按 \n 拆分后的数组下标 */
    function parseConflictHunks(content) {
      const lines = content.split('\n');
      const hunks = [];
      let current = null;
      lines.forEach((line, idx) => {
        if (/^<{7}($|\s)/.test(line)) {
          current = { startIdx: idx, oursLines: [], baseLines: [], theirsLines: [], phase: 'ours' };
        } else if (current && current.phase === 'ours' && /^={7}$/.test(line)) {
          current.midIdx = idx;
          current.phase = 'theirs';
        } else if (current && current.phase === 'ours' && /^\|{7}($|\s)/.test(line)) {
          current.midIdx = idx;
          current.phase = 'base';
        } else if (current && current.phase === 'base' && /^={7}$/.test(line)) {
          current.midIdx = idx;
          current.phase = 'theirs';
        } else if (current && current.phase === 'theirs' && /^>{7}($|\s)/.test(line)) {
          current.endIdx = idx;
          hunks.push(current);
          current = null;
        } else if (current) {
          if (current.phase === 'ours') current.oursLines.push(line);
          else if (current.phase === 'base') current.baseLines.push(line);
          else current.theirsLines.push(line);
        }
      });
      return hunks;
    }

    /* 渲染编辑区的冲突高亮层：与 textarea 同度量叠放的只读着色层。
       逐行状态机判定归属（标记行 / ours / theirs / base / 普通行），行结构
       与 wrap="off" 的 textarea 逐行对位；滚动偏移由 scroll 监听同步 */
    function renderConflictEditorHighlight() {
      const textarea = document.getElementById('conflictEditorTextarea');
      const highlight = document.getElementById('conflictEditorHighlight');
      if (!textarea || !highlight) return;
      if (textarea.disabled) {
        highlight.innerHTML = '';
        return;
      }
      const lines = textarea.value.split('\n');
      let phase = 'out';
      const html = lines.map((line) => {
        let cls = '';
        if (/^<{7}($|\s)/.test(line) && phase === 'out') {
          cls = 'cel-marker';
          phase = 'ours';
        } else if (/^\|{7}($|\s)/.test(line) && phase === 'ours') {
          cls = 'cel-marker';
          phase = 'base';
        } else if (/^={7}$/.test(line) && (phase === 'ours' || phase === 'base')) {
          cls = 'cel-marker';
          phase = 'theirs';
        } else if (/^>{7}($|\s)/.test(line) && phase === 'theirs') {
          cls = 'cel-marker';
          phase = 'out';
        } else if (phase !== 'out') {
          cls = `cel-${phase}`;
        }
        return `<div class="cel-line ${cls}">${escapeHtml(line) || '&nbsp;'}</div>`;
      }).join('');
      highlight.innerHTML = html;
      highlight.scrollTop = textarea.scrollTop;
      highlight.scrollLeft = textarea.scrollLeft;
    }

    /* 渲染冲突块快捷工具：每块展示 ours/theirs 内容与三个采用按钮 */
    function renderConflictHunkTools() {
      const holder = document.getElementById('conflictHunkTools');
      const content = document.getElementById('conflictEditorTextarea').value;
      const hunks = parseConflictHunks(content);
      if (hunks.length === 0) {
        holder.innerHTML = '<div class="remote-modal-hint">内容中已无冲突标记，可直接保存。</div>';
        return;
      }
      holder.innerHTML = hunks.map((hunk, idx) => `
        <div class="conflict-hunk-card">
          <div class="conflict-hunk-header">
            <span>冲突块 #${idx + 1}（当前 ${hunk.oursLines.length} 行 / 来源 ${hunk.theirsLines.length} 行）</span>
            <div class="conflict-hunk-actions">
              <button class="btn-outline" type="button" data-hunk-idx="${idx}" data-hunk-choice="ours">采用当前分支</button>
              <button class="btn-outline" type="button" data-hunk-idx="${idx}" data-hunk-choice="theirs">采用来源分支</button>
              <button class="btn-outline" type="button" data-hunk-idx="${idx}" data-hunk-choice="both">保留两者</button>
            </div>
          </div>
          <div class="conflict-side conflict-side-ours"><span class="conflict-side-label">当前分支</span>${escapeHtml(hunk.oursLines.join('\n')) || '&lt;空&gt;'}</div>
          ${hunk.baseLines.length ? `<div class="conflict-side conflict-side-base"><span class="conflict-side-label">共同基线</span>${escapeHtml(hunk.baseLines.join('\n'))}</div>` : ''}
          <div class="conflict-side conflict-side-theirs"><span class="conflict-side-label">来源分支</span>${escapeHtml(hunk.theirsLines.join('\n')) || '&lt;空&gt;'}</div>
        </div>
      `).join('');
      holder.querySelectorAll('[data-hunk-choice]').forEach(btn => {
        btn.addEventListener('click', () => {
          applyConflictHunkChoice(Number(btn.dataset.hunkIdx), btn.dataset.hunkChoice);
        });
      });
    }

    /* 按选择重写编辑区内容：替换指定冲突块的行区间后重新解析渲染（下标随之刷新） */
    function applyConflictHunkChoice(hunkIdx, choice) {
      const textarea = document.getElementById('conflictEditorTextarea');
      const lines = textarea.value.split('\n');
      const hunks = parseConflictHunks(textarea.value);
      const hunk = hunks[hunkIdx];
      if (!hunk) return;
      let mid;
      if (choice === 'ours') mid = hunk.oursLines;
      else if (choice === 'theirs') mid = hunk.theirsLines;
      else mid = [...hunk.oursLines, ...hunk.theirsLines];
      const next = [...lines.slice(0, hunk.startIdx), ...mid, ...lines.slice(hunk.endIdx + 1)];
      textarea.value = next.join('\n');
      renderConflictHunkTools();
      renderConflictEditorHighlight();
    }

    /* 保存编辑内容：写入工作区 + git add 标记已解决 */
    async function saveConflictContent() {
      const filePath = remoteState.editingConflictPath;
      const worktree = remoteState.targetWorktree;
      if (!filePath || !worktree) return;
      const content = document.getElementById('conflictEditorTextarea').value;
      const errorEl = document.getElementById('conflictDrawerError');
      const saveBtn = document.getElementById('conflictSaveBtn');
      errorEl.textContent = '';
      saveBtn.disabled = true;
      try {
        const res = await fetch('/api/merge-resolve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ worktree, filePath, resolution: 'content', content })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || '保存冲突文件失败');
        closeConflictDrawer();
        showToast(`已解决：${filePath}${data.remaining > 0 ? `（剩余 ${data.remaining} 个冲突）` : '（全部冲突已处理）'}`);
        refreshMergeState();
      } catch (err) {
        errorEl.textContent = toDisplayErrorMessage(err, '保存冲突文件失败');
      } finally {
        saveBtn.disabled = false;
      }
    }

    /* 合并落库后联动刷新：提交抽屉若正查看相关分支的提交，按首屏语义重载。
       刷新做法与 commitAction 成功后一致：loadedCount 归零重拉首屏，并作废 ahead/behind 缓存 */
    function refreshCommitsDrawerIfRelatedToBranches(branchNames) {
      if (!commitsDrawerState.isOpen) return;
      const related = branchNames.some(name => commitsDrawerState.branch === name
        || (commitsDrawerState.ref || '') === name
        || currentWorktrees.some(w => w.branch === name && w.path === commitsDrawerState.worktreePath));
      if (!related) return;
      commitsDrawerState.loadedCount = 0;
      commitsDrawerAheadBehind = null;
      fetchAndRenderCommits();
    }

    /* 合并落库后联动刷新：Diff 结果区若正展示相关分支的 branch↔branch 对比，重拉当前 Diff */
    function refreshDiffViewIfRelatedToBranches(branchNames) {
      if (currentDiffType !== 'ref') return;
      const refs = [splitRefIdentity(currentDiffBase), splitRefIdentity(currentDiffTarget)];
      const related = refs.some(r => r.kind === 'branch' && branchNames.includes(r.value));
      if (related) refreshCurrentDiff();
    }

    /* 从 MR 详情跳转 Diff Tab：branch↔branch、仅已提交模式（Base=target，Target=source） */
    function openMrBranchDiff() {
      const mr = currentMrDetail;
      if (!mr) return;
      closeMrDrawer(false); // 关闭抽屉让出可视区域查看 Diff
      switchTab('diff', false);
      const baseIdentity = `branch:${mr.targetBranch}`;
      const targetIdentity = `branch:${mr.sourceBranch}`;
      if (!applyDiffIdentitiesOrReport(baseIdentity, targetIdentity)) {
        document.getElementById('diffResultsContainer').innerHTML =
          '<div class="empty-diff-box" style="color: var(--warning);">该 MR 的分支已不存在，无法展示 Branch Diff。</div>';
        return;
      }
      refreshDiffPickerTriggers();
      fetchAndRenderRefDiff('committed', true);
    }

    async function restoreCurrentRepoHistoryState(state) {
      isRestoringHistory = true;
      try {
        searchKeyword = state.q || '';
        document.getElementById('searchInput').value = searchKeyword;
        renderFilteredLists();

        switchTab(['diff', 'mr', 'remote'].includes(state.tab) ? state.tab : 'overview', false);
        if (state.tab === 'diff' && (state.diffType === 'ref' || state.diffType === 'worktree') && state.base && state.target) {
          // diffType=ref 为新格式；旧链接 diffType=worktree 无类型前缀，base/target 按 worktree 兼容解析
          const baseIdentity = `${state.baseType || 'worktree'}:${state.base}`;
          const targetIdentity = `${state.targetType || 'worktree'}:${state.target}`;
          currentDiffMode = state.mode || null;
          if (applyDiffIdentitiesOrReport(baseIdentity, targetIdentity)) {
            refreshDiffPickerTriggers();
            await fetchAndRenderRefDiff(currentDiffMode, false);
          } else {
            currentDiffType = 'ref';
            currentDiffBase = baseIdentity;
            currentDiffTarget = targetIdentity;
            document.getElementById('diffResultsContainer').innerHTML = `
              <div class="empty-diff-box" style="color: var(--warning);">
                <div style="font-size: 15px; margin-bottom: 8px;">链接中的 Worktree 或分支已不存在，无法恢复原比对</div>
                <div style="font-size: 13px;">请重新在上方选择基准与对比对象</div>
              </div>`;
          }
        } else if (state.tab === 'diff' && state.diffType === 'uncommitted' && state.uncommitted) {
          currentUncommittedPath = state.uncommitted;
          currentDiffMode = 'uncommitted';
          applyDiffIdentitiesOrReport('', `worktree:${state.uncommitted}`);
          refreshDiffPickerTriggers();
          await fetchAndRenderRefDiff('uncommitted', false);
        } else if (state.tab === 'diff') {
          currentDiffType = null;
          currentDiffMode = null;
          document.getElementById('diffResultsContainer').innerHTML = '';
        }

        if (state.commits) {
          if (!commitsDrawerState.isOpen
            || commitsDrawerState.worktreePath !== state.commits
            || commitsDrawerState.fullHistory !== state.commitsFull
            || (commitsDrawerState.ref || '') !== (state.commitsRef || '')
            || (commitsDrawerState.baseRef || '') !== (state.commitsBase || '')) {
            await openCommitsDrawer(state.commits, state.commitsFull, false, state.commitsRef || '', state.commitsBase || '');
          }
        } else if (commitsDrawerState.isOpen) {
          closeCommitsDrawer(false);
        }

        // 恢复/关闭 MR 详情抽屉，保证与浏览器当前 URL 一致
        if (state.mr) {
          if (!mrDrawerState.isOpen || mrDrawerState.id !== String(state.mr)) {
            await openMrDetail(state.mr, false);
          }
        } else if (mrDrawerState.isOpen) {
          closeMrDrawer(false);
        }
      } finally {
        isRestoringHistory = false;
        syncStateToUrl(false);
      }
    }

    // 抽屉滚动到边界时拦截继续滚动，避免滚动链传递到后面的主页面。
    function setupCommitsDrawerScrollGuard() {
      const body = document.getElementById('commitsDrawerBody');
      if (!body) return;

      body.addEventListener('wheel', (event) => {
        const atTop = body.scrollTop <= 0;
        const atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 1;
        const tryingPastTop = event.deltaY < 0 && atTop;
        const tryingPastBottom = event.deltaY > 0 && atBottom;
        event.stopPropagation();
        if (tryingPastTop || tryingPastBottom) event.preventDefault();
      }, { passive: false });

      let lastTouchY = null;
      body.addEventListener('touchstart', (event) => {
        lastTouchY = event.touches[0]?.clientY ?? null;
      }, { passive: true });
      body.addEventListener('touchmove', (event) => {
        const currentTouchY = event.touches[0]?.clientY;
        if (lastTouchY === null || currentTouchY === undefined) return;

        const scrollDirection = lastTouchY - currentTouchY;
        const atTop = body.scrollTop <= 0;
        const atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 1;
        const tryingPastTop = scrollDirection < 0 && atTop;
        const tryingPastBottom = scrollDirection > 0 && atBottom;
        event.stopPropagation();
        if (tryingPastTop || tryingPastBottom) event.preventDefault();
        lastTouchY = currentTouchY;
      }, { passive: false });
      body.addEventListener('touchend', () => {
        lastTouchY = null;
      }, { passive: true });
    }

    // 浏览器前进/后退只恢复应用状态，不把抽屉当成独立页面导航。
    window.addEventListener('popstate', () => {
      historyRestoreQueue = historyRestoreQueue
        .then(() => {
          const state = getUrlState();
          if (state?.repo && state.repo === currentRepo) {
            return restoreCurrentRepoHistoryState(state);
          }
          return loadProjects(false);
        })
        .catch((err) => console.warn('恢复页面历史状态失败:', err.message));
    });

    /* 静态 DOM 的内联事件迁移（CSP script-src 'self' 禁止 onclick 等内联处理器）：
       原 HTML 内联 onclick 统一改为 data-action 标记，由 document 级 click 委托按下表分发。
       采用委托的原因：脚本位于 body 末尾时部分静态元素（回到顶部按钮、提交抽屉等）尚未解析，
       逐点绑定会漏绑，而委托与原 onclick 同处冒泡阶段、天然与解析时序无关，语义逐点等价。
       静态区不存在嵌套 data-action 元素，closest 命中最内层标记即原事件目标；
       分发表内硬编码原内联处理器的固定实参。动态渲染元素虽有同名标记机制（bindActions），
       但 action 命名与本表不重叠，不会被误分发 */
    const STATIC_CLICK_ACTIONS = {
      'tab-overview': () => switchTab('overview'),
      'tab-diff': () => switchTab('diff'),
      'tab-mr': () => switchTab('mr'),
      'open-create-mr': () => openCreateMrModal(),
      'toggle-repo-dropdown': () => toggleRepoDropdown(),
      'toggle-starred-filter': () => toggleStarredOnlyFilter(),
      'open-scan-modal': () => openScanDirectoryModal(),
      'cleanup-worktrees': () => runBulkCleanup('worktrees'),
      'cleanup-branches': () => runBulkCleanup('branches'),
      'mr-filter': (el) => setMrStatusFilter(el.dataset.status),
      'swap-diff-targets': () => swapDiffTargets(),
      'run-ref-diff': () => fetchAndRenderRefDiff(null, true),
      'refresh-current-diff': () => refreshCurrentDiff(),
      'close-scan-modal': () => closeScanDirectoryModal(),
      'choose-scan-directory': () => chooseScanDirectory(),
      'add-scan-directory': () => addScanDirectory(),
      'save-scan-directories': () => saveScanDirectories(),
      'remove-modal-cancel': () => closeWorktreeRemoveModal(false),
      'remove-modal-confirm': () => closeWorktreeRemoveModal(true),
      'close-create-mr': () => closeCreateMrModal(),
      'submit-create-mr': () => submitCreateMr(),
      'close-mr-drawer': () => closeMrDrawer(),
      'close-commits-drawer': () => closeCommitsDrawer(),
      'toggle-commits-fullscreen': () => toggleCommitsDrawerFullscreen(),
      'apply-commits-filters': () => applyCommitsFilters(),
      'clear-commits-filters': () => clearCommitsFilters(),
      'load-more-commits': () => loadMoreCommits(),
      'scroll-to-top': () => scrollToTop(),
      'commits-back-to-top': (el) => scrollCommitsDrawerToTop(el),
      /* 分支管理 Tab：工具栏、弹层与冲突抽屉的动作入口 */
      'tab-remote': () => switchTab('remote'),
      'remote-fetch': (el) => fetchRemotesAction(el),
      'open-switch-branch': () => openSwitchBranchModal(),
      'merge-abort': () => abortMergeAction(),
      'merge-commit': () => completeMerge(),
      'close-checkout-modal': () => closeCheckoutModal(),
      'submit-checkout-branch': () => submitCheckoutBranch(),
      'close-checkout-local-modal': () => closeCheckoutLocalModal(),
      'submit-checkout-local-branch': () => submitCheckoutLocalBranch(),
      'close-create-remote-modal': () => closeCreateRemoteModal(),
      'submit-create-remote-branch': () => submitCreateRemoteBranch(),
      'close-switch-branch-modal': () => closeSwitchBranchModal(),
      'submit-switch-branch': () => submitSwitchBranch(),
      'close-conflict-drawer': () => closeConflictDrawer(),
      'save-conflict-content': () => saveConflictContent(),
      /* 通用确认弹层：按钮/关闭动作统一结算 */
      'app-confirm-confirm': () => settleAppConfirm('confirm'),
      'app-confirm-cancel': () => settleAppConfirm('cancel'),
      'app-confirm-alt': () => settleAppConfirm('alt'),
      'app-confirm-dismiss': () => settleAppConfirm('cancel'),
      /* Worktree 管理扩展：创建工作区弹层与别名编辑 */
      'open-create-worktree': () => openCreateWorktreeModal(),
      'close-create-worktree-modal': () => closeCreateWorktreeModal(),
      'submit-create-worktree': () => submitCreateWorktree(),
      'create-wt-branch-mode': (el) => setCreateWtBranchMode(el.dataset.mode),
      'close-edit-worktree-modal': () => closeEditWorktreeModal(),
      'submit-edit-worktree': () => submitEditWorktree(),
      'choose-create-wt-parent': () => chooseCreateWtParent()
    };
    document.addEventListener('click', (e) => {
      const el = e.target instanceof Element ? e.target.closest('[data-action]') : null;
      if (!el) return;
      const handler = STATIC_CLICK_ACTIONS[el.dataset.action];
      if (handler) handler(el, e);
    });

    /* 页面事件监听 */
    document.getElementById('repoFilterInput').addEventListener('input', (e) => {
      repoFilterKeyword = e.target.value;
      renderRepoDropdownList();
    });
    document.getElementById('repoFilterInput').addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveRepoHighlight(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveRepoHighlight(-1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const repo = repoPickerState.visible[repoPickerState.highlight];
        if (repo) {
          selectRepo(repo.path);
          clearRepoFilter();
          document.getElementById('repoDropdown').classList.remove('show');
          repoPickerState.open = false;
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        document.getElementById('repoDropdown').classList.remove('show');
        repoPickerState.open = false;
      }
    });
    document.getElementById('repoFilterClearBtn').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      clearRepoFilter(true);
    });
    document.getElementById('scanDirectoryInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addScanDirectory();
      }
    });
    // 提交过滤输入框回车即应用, 与「应用」按钮同语义。
    // 这些输入框位于脚本文档流之后的抽屉 DOM 中，脚本解析到此处时它们尚不存在，
    // 必须等 DOMContentLoaded 再绑定；否则顶层 TypeError 会中断整个脚本，
    // 导致后面的 loadProjects() 等初始化语句全部不执行（表现为页面永远停在加载中）。
    document.addEventListener('DOMContentLoaded', () => {
      for (const filterInputId of ['commitFilterAuthor', 'commitFilterGrep', 'commitFilterSince', 'commitFilterUntil']) {
        document.getElementById(filterInputId).addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            applyCommitsFilters();
          }
        });
      }
    });
    document.getElementById('scanDirectoryModal').addEventListener('click', (e) => {
      if (e.target.id === 'scanDirectoryModal') closeScanDirectoryModal();
    });
    document.getElementById('worktreeRemoveModal').addEventListener('click', (e) => {
      if (e.target.id === 'worktreeRemoveModal') closeWorktreeRemoveModal(false);
    });
    // 点击新建 MR 弹层遮罩区域关闭弹层（与扫描目录弹窗一致）
    document.getElementById('createMrModal').addEventListener('click', (e) => {
      if (e.target.id === 'createMrModal') closeCreateMrModal();
    });
    // 远端分支 Tab 三个弹层的遮罩关闭，与既有弹窗行为一致
    document.getElementById('checkoutBranchModal').addEventListener('click', (e) => {
      if (e.target.id === 'checkoutBranchModal') closeCheckoutModal();
    });
    document.getElementById('createRemoteBranchModal').addEventListener('click', (e) => {
      if (e.target.id === 'createRemoteBranchModal') closeCreateRemoteModal();
    });
    document.getElementById('switchBranchModal').addEventListener('click', (e) => {
      if (e.target.id === 'switchBranchModal') closeSwitchBranchModal();
    });
    document.getElementById('createWorktreeModal').addEventListener('click', (e) => {
      if (e.target.id === 'createWorktreeModal') closeCreateWorktreeModal();
    });
    document.getElementById('editWorktreeModal').addEventListener('click', (e) => {
      if (e.target.id === 'editWorktreeModal') closeEditWorktreeModal();
    });
    document.addEventListener('DOMContentLoaded', setupCommitsDrawerScrollGuard);
    document.getElementById('refreshBtn').addEventListener('click', () => {
      loadProjects();
    });
    document.getElementById('searchInput').addEventListener('input', (e) => {
      searchKeyword = e.target.value;
      renderFilteredLists();
      syncStateToUrl();
    });
    document.getElementById('pruneBtn').addEventListener('click', async () => {
      try {
        const res = await fetch('/api/prune-worktrees', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoPath: currentRepo })
        });
        const data = await res.json();
        if (data.ok) {
          alert('Worktrees prune 执行成功！');
          inspectRepo(currentRepo);
        } else {
          alert('Prune 失败: ' + data.error);
        }
      } catch (err) {
        // 网络层失败（服务不可达）走非阻断提示，避免按钮点击后无任何反馈（DEF-006）
        notifyRequestFailure(err, 'Prune 失败: ' + toDisplayErrorMessage(err, '无法连接本地服务'));
      }
    });

    /* 初始化新建 MR 弹层内的两个分支搜索选择器（仅分支模式） */
    createMrSourcePicker = createSearchablePicker({
      wrapperId: 'mrSourcePickerWrapper',
      triggerId: 'mrSourcePickerTrigger',
      triggerTextId: 'mrSourcePickerText',
      dropdownId: 'mrSourcePickerDropdown',
      searchInputId: 'mrSourcePickerSearch',
      listId: 'mrSourcePickerList',
      selectId: 'mrSourceSelect',
      getItems: branchPickerItems,
      groupTitles: { branch: '本地分支' },
      emptyText: '没有匹配的分支',
      placeholder: '选择源分支'
    });
    createMrTargetPicker = createSearchablePicker({
      wrapperId: 'mrTargetPickerWrapper',
      triggerId: 'mrTargetPickerTrigger',
      triggerTextId: 'mrTargetPickerText',
      dropdownId: 'mrTargetPickerDropdown',
      searchInputId: 'mrTargetPickerSearch',
      listId: 'mrTargetPickerList',
      selectId: 'mrTargetSelect',
      getItems: branchPickerItems,
      groupTitles: { branch: '本地分支' },
      emptyText: '没有匹配的分支',
      placeholder: '选择目标分支'
    });

    /* 初始化 Diff Tab 的两个可搜索选择器：选项来自 Worktree 与本地分支，
       选中变化后自动触发比对（同时保留「比对 Diff」按钮可手动重拉） */
    diffBasePicker = createSearchablePicker({
      wrapperId: 'diffBasePickerWrapper',
      triggerId: 'diffBasePickerTrigger',
      triggerTextId: 'diffBasePickerText',
      dropdownId: 'diffBasePickerDropdown',
      searchInputId: 'diffBasePickerSearch',
      listId: 'diffBasePickerList',
      selectId: 'diffBaseSelect',
      getItems: buildDiffRefOptions,
      groupTitles: { worktree: 'Worktree', branch: '本地分支' },
      emptyText: '没有匹配的 Worktree 或分支',
      placeholder: '请选择基准',
      onSelect: () => fetchAndRenderRefDiff(null, true)
    });
    diffTargetPicker = createSearchablePicker({
      wrapperId: 'diffTargetPickerWrapper',
      triggerId: 'diffTargetPickerTrigger',
      triggerTextId: 'diffTargetPickerText',
      dropdownId: 'diffTargetPickerDropdown',
      searchInputId: 'diffTargetPickerSearch',
      listId: 'diffTargetPickerList',
      selectId: 'diffTargetSelect',
      getItems: buildDiffRefOptions,
      groupTitles: { worktree: 'Worktree', branch: '本地分支' },
      emptyText: '没有匹配的 Worktree 或分支',
      placeholder: '请选择对比对象',
      onSelect: () => fetchAndRenderRefDiff(null, true)
    });

    /* 初始化远端分支 Tab「切换/检出分支」弹层的可搜索选择器：
       候选 = 本地分支 + 远端分支（identity 前缀区分 refType），选项在打开弹层时重建 */
    switchBranchPicker = createSearchablePicker({
      wrapperId: 'switchBranchPickerWrapper',
      triggerId: 'switchBranchPickerTrigger',
      triggerTextId: 'switchBranchPickerText',
      dropdownId: 'switchBranchPickerDropdown',
      searchInputId: 'switchBranchPickerSearch',
      listId: 'switchBranchPickerList',
      selectId: 'switchBranchSelect',
      getItems: switchBranchPickerItems,
      groupTitles: { branch: '本地分支', remote: '远端分支' },
      emptyText: '没有匹配的分支',
      placeholder: '选择本地或远端分支',
      onSelect: (identity) => updateSwitchBranchModalState(identity)
    });

    /* 远端分支 Tab 的本页事件：目标工作区切换、列表过滤与排序、自动刷新档位、弹层实时校验 */
    document.getElementById('remoteWorktreeSelect').addEventListener('change', (e) => {
      remoteState.targetWorktree = e.target.value;
      renderRemoteTargetInfo();
      refreshMergeState();
    });
    // 过滤走防抖：分支数大时整列表重绘开销明显，输入停顿后再渲染
    document.getElementById('remoteBranchFilterInput').addEventListener('input', debounceFn(() => {
      renderRemoteBranchList();
    }, 180));
    document.getElementById('localBranchFilterInput').addEventListener('input', debounceFn(() => {
      renderLocalBranchList();
    }, 180));
    document.getElementById('remoteBranchSortSelect').addEventListener('change', (e) => {
      remoteState.remoteBranchSort = e.target.value;
      renderRemoteBranchList();
    });
    document.getElementById('localBranchSortSelect').addEventListener('change', (e) => {
      remoteState.localBranchSort = e.target.value;
      renderLocalBranchList();
    });
    // 弹层输入实时校验：非法名/重名在提交前就给出提示并锁住提交按钮
    document.getElementById('checkoutLocalNameInput').addEventListener('input', validateCheckoutLocalName);
    document.getElementById('createRemoteBranchNameInput').addEventListener('input', validateCreateRemoteName);
    document.getElementById('switchWorktreeSelect').addEventListener('change', updateSwitchDirtyHint);
    // 确认弹层的防误触输入：与期望文本完全一致才放开确认按钮；Esc 等同取消
    document.getElementById('appConfirmRequireInput').addEventListener('input', (e) => {
      const echo = document.getElementById('appConfirmRequireEcho').textContent;
      document.getElementById('appConfirmOkBtn').disabled = e.target.value !== echo;
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.getElementById('appConfirmModal').style.display !== 'none') {
        settleAppConfirm('cancel');
      }
    });
    // 冲突编辑区：输入即时重绘高亮层；快捷按钮卡片防抖跟随（下标随编辑失效）；
    // 滚动偏移同步到高亮层，保证逐行对位
    const conflictEditorTextarea = document.getElementById('conflictEditorTextarea');
    const conflictEditorHighlight = document.getElementById('conflictEditorHighlight');
    const scheduleConflictHunkToolsRefresh = debounceFn(() => renderConflictHunkTools(), 250);
    conflictEditorTextarea.addEventListener('input', () => {
      renderConflictEditorHighlight();
      scheduleConflictHunkToolsRefresh();
    });
    conflictEditorTextarea.addEventListener('scroll', () => {
      conflictEditorHighlight.scrollTop = conflictEditorTextarea.scrollTop;
      conflictEditorHighlight.scrollLeft = conflictEditorTextarea.scrollLeft;
    });
    initRemoteAutoFetchControl();

    /* 创建 Worktree 弹层：分支变化重算默认目录/名称；目录/名称被手动修改后不再自动覆盖 */
    document.getElementById('createWtExistingSelect').addEventListener('change', updateCreateWtDefaults);
    document.getElementById('createWtNewBranchInput').addEventListener('input', updateCreateWtDefaults);
    document.getElementById('createWtPathInput').addEventListener('input', () => { createWtDirTouched = true; });
    document.getElementById('createWtNameInput').addEventListener('input', () => { createWtNameTouched = true; });

    /* ---- 桌面运行时适配层（契约 §6；浏览器模式以下逻辑全部不生效） ---- */

    // 外链统一出口：桌面模式下页面内 http/https 链接一律交系统浏览器打开，
    // 并阻止窗口内导航（契约 §6 openExternal，仅 http/https 由主进程校验）；
    // 浏览器模式保持默认跳转行为
    document.addEventListener('click', (e) => {
      if (!isDesktop) return;
      const anchor = e.target instanceof Element ? e.target.closest('a[href]') : null;
      if (!anchor) return;
      const url = anchor.getAttribute('href') || '';
      if (!/^https?:\/\//i.test(url)) return;
      e.preventDefault();
      window.gitLens.openExternal(url).catch((err) => console.warn('打开外部链接失败:', err && err.message));
    });

    // 桌面模式在页脚展示运行时版本信息（appVersion/electronVersion/platform/arch）；
    // 浏览器模式元素保持隐藏，避免暴露无意义的 Node 运行时细节
    let desktopRuntimeInfo = null;
    if (isDesktop && typeof window.gitLens.getRuntimeInfo === 'function') {
      window.gitLens.getRuntimeInfo().then((info) => {
        desktopRuntimeInfo = info || null;
        const el = document.getElementById('desktopRuntimeInfo');
        if (el) {
          el.textContent = `v${info.appVersion || '-'} · Electron ${info.electronVersion || '-'} · ${info.platform || '-'} / ${info.arch || '-'}`;
          el.style.display = '';
        }
      }).catch((err) => console.warn('读取桌面运行时信息失败:', err && err.message));
    }

    /* ---- 桌面模式服务状态覆盖层（契约 §6 onServiceState；浏览器模式全部不生效） ---- */
    let lastServiceState = null;     // 最近一次收到的服务状态；重复事件不重复处理
    let serviceRestartTimer = null;  // 「正在重启」已等待秒数计时器
    let serviceOverlayShown = false; // 覆盖层当前是否可见（区分首启 ready 与恢复 ready）
    // DEF-006：服务已知中断标志。restarting/crashed/stopped 置真、ready 置假；
    // 浏览器模式不订阅 onServiceState，恒为 false。为真时请求失败提示全部静默，
    // 由恢复遮罩/提示条承担告知职责（见 notifyRequestFailure）
    let serviceKnownDown = false;

    function setServiceOverlay(visible) {
      document.getElementById('serviceStateOverlay').style.display = visible ? 'flex' : 'none';
      serviceOverlayShown = visible;
    }

    /* 覆盖层文案与动作按钮统一入口；actionsHtml 为页面自身的静态按钮串，不含任何外部数据 */
    function setServiceOverlayContent(title, desc, showSpinner, actionsHtml) {
      document.getElementById('serviceStateTitle').textContent = title;
      document.getElementById('serviceStateDesc').textContent = desc;
      document.getElementById('serviceStateSpinner').dataset.hidden = showSpinner ? '' : '1';
      document.getElementById('serviceStateActions').innerHTML = actionsHtml || '';
    }

    function startServiceRestartTimer() {
      stopServiceRestartTimer();
      const descEl = document.getElementById('serviceStateDesc');
      const startedAt = Date.now();
      descEl.textContent = '已等待 0 秒…';
      serviceRestartTimer = setInterval(() => {
        descEl.textContent = `已等待 ${Math.floor((Date.now() - startedAt) / 1000)} 秒…`;
      }, 1000);
    }

    function stopServiceRestartTimer() {
      if (serviceRestartTimer) {
        clearInterval(serviceRestartTimer);
        serviceRestartTimer = null;
      }
    }

    function hideServiceStoppedBar() {
      document.getElementById('serviceStoppedBar').style.display = 'none';
    }

    /* crashed 态「复制诊断信息」：写入运行时信息与时间戳，便于用户粘贴反馈。
       时序与 copyText 的 DEF-007 修复同款：writeText await 成功才提示成功；
       失败回退 textarea + execCommand('copy') 并检查返回值；两路都失败走
       非阻断 toast（复用 showToast，不走 alert）。剪贴板失败与服务状态无关，
       即使恢复遮罩场景 serviceKnownDown 为真也直接提示，不走静默分支 */
    async function copyServiceDiagnostics(btn) {
      const payload = JSON.stringify({
        state: 'crashed',
        time: new Date().toISOString(),
        href: window.location.href,
        userAgent: navigator.userAgent,
        runtime: desktopRuntimeInfo || null
      }, null, 2);
      let copied = false;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
          await navigator.clipboard.writeText(payload);
          copied = true;
        } catch {
          // 权限被拒 / 写入失败：静默转入下方 execCommand 回退路径
        }
      }
      if (!copied) {
        // 回退路径与 copyText 一致：textarea 移出视口而非 display:none——
        // 后者在部分内核下 select() 不生效；execCommand 返回值必须检查，
        // 不检查会把回退失败误报成「已复制」（本缺陷的同型根源）
        const ta = document.createElement('textarea');
        ta.value = payload;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try {
          copied = document.execCommand('copy');
        } catch {
          copied = false;
        } finally {
          document.body.removeChild(ta);
        }
      }
      if (!copied) {
        showToast('复制失败：诊断信息未能写入剪贴板');
        return;
      }
      if (btn) {
        // 同一按钮快速重复点击时先清旧定时器，避免前一轮恢复文案覆盖本轮反馈
        if (btn.copyFeedbackTimer) clearTimeout(btn.copyFeedbackTimer);
        btn.textContent = '已复制诊断信息';
        btn.copyFeedbackTimer = setTimeout(() => {
          btn.textContent = '复制诊断信息';
          btn.copyFeedbackTimer = null;
        }, 1500);
      }
    }

    function handleServiceState(state) {
      if (state === lastServiceState) return; // 重复的同状态事件不重复处理
      lastServiceState = state;
      // DEF-006：中断态置真抑制请求失败弹框；ready 清标志解除抑制，恢复常规提示路径
      serviceKnownDown = state === 'restarting' || state === 'crashed' || state === 'stopped';
      switch (state) {
        case 'restarting':
          hideServiceStoppedBar();
          setServiceOverlayContent('服务正在重启…', '', true, '');
          setServiceOverlay(true);
          startServiceRestartTimer();
          break;
        case 'ready': {
          stopServiceRestartTimer();
          hideServiceStoppedBar();
          const wasShown = serviceOverlayShown;
          setServiceOverlay(false);
          // 只有经历过 restarting/crashed 的 ready 才重拉数据，避免与页面首次加载竞态
          if (wasShown) loadProjects();
          break;
        }
        case 'crashed':
          stopServiceRestartTimer();
          hideServiceStoppedBar();
          // 重连由 Shell 的自动重启完成；「重试」仅重新加载页面恢复视图
          setServiceOverlayContent(
            '本地服务意外退出',
            '后台服务进程已退出，通常会由桌面端自动重启；稍候可点击「重试」重新加载页面。',
            false,
            '<button type="button" class="btn-primary" data-action="service-retry">重试</button>' +
            '<button type="button" class="btn-outline" data-action="service-copy-diagnostics">复制诊断信息</button>'
          );
          setServiceOverlay(true);
          bindActions(document.getElementById('serviceStateActions'), {
            'service-retry': () => location.reload(),
            'service-copy-diagnostics': (el) => copyServiceDiagnostics(el)
          });
          break;
        case 'stopped':
          stopServiceRestartTimer();
          setServiceOverlay(false);
          document.getElementById('serviceStoppedBar').style.display = 'block';
          break;
        default:
          break;
      }
    }

    // 仅桌面模式订阅服务状态；浏览器模式无 window.gitLens，覆盖层与提示条永不出现
    if (isDesktop && typeof window.gitLens?.onServiceState === 'function') {
      window.gitLens.onServiceState(handleServiceState);
    }

    loadProjects();
    // 回到顶部逻辑
    function scrollToTop() {
      window.scrollTo({
        top: 0,
        behavior: 'smooth'
      });
    }

    window.addEventListener('scroll', () => {
      const btn = document.getElementById('backToTopBtn');
      if (!btn) return;
      if (window.scrollY > 240) {
        btn.classList.add('show');
      } else {
        btn.classList.remove('show');
      }
    }, { passive: true });

    // 抽屉内回到顶部：滚动区超过同一阈值时显示右下角悬浮按钮，点击平滑滚回顶部。
    // 提交记录抽屉与 MR 详情抽屉共用 .commits-drawer 结构。
    // 抽屉标记位于脚本之后，初始化时 DOM 尚未解析，故 scroll 用 document 捕获委托
    // （scroll 事件不冒泡但可捕获），与上方点击委托同一模式
    function scrollCommitsDrawerToTop(el) {
      el.closest('.commits-drawer')?.querySelector('.commits-drawer-body')
        ?.scrollTo({ top: 0, behavior: 'smooth' });
    }

    document.addEventListener('scroll', (e) => {
      const body = e.target instanceof Element ? e.target.closest('.commits-drawer-body') : null;
      if (!body) return;
      const btn = body.closest('.commits-drawer')?.querySelector('.commits-back-to-top-btn');
      if (!btn) return;
      btn.classList.toggle('show', body.scrollTop > 240);
    }, { capture: true, passive: true });

    document.addEventListener('keydown', (e) => {
      // 抽屉和模态框优先处理自己的快捷键，避免查找触发背后页面的滚动。
      const diffFindAvailable = activeTab === 'diff' && !commitsDrawerState.isOpen && !mrDrawerState.isOpen
        && ![...document.querySelectorAll('[aria-modal="true"]')].some(modal => modal.style.display !== 'none')
        && document.getElementById('diffFindPanel');
      if (!e.defaultPrevented && !e.isComposing && diffFindAvailable) {
        if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f') {
          e.preventDefault();
          openDiffFind();
          return;
        }
        if (diffFindState.open && e.key === 'Escape') {
          e.preventDefault();
          closeDiffFind();
          return;
        }
        if (diffFindState.open && e.target.id === 'diffFindInput' && e.key === 'Enter') {
          e.preventDefault();
          selectDiffFindMatch(diffFindState.index + (e.shiftKey ? -1 : 1));
          return;
        }
      }
      // Escape 优先关闭可搜索选择器的下拉面板
      if (e.key === 'Escape') {
        searchablePickers.forEach(p => p.closeDropdown());
      }
      if (e.key === 'Escape' && commitsDrawerState.isOpen) {
        closeCommitsDrawer();
      }
      if (e.key === 'Escape' && mrDrawerState.isOpen) {
        closeMrDrawer();
      }
      // 冲突文件编辑抽屉：编辑区聚焦时 Esc 也直接关闭（抽屉级优先于页面级）
      if (e.key === 'Escape' && remoteState.editingConflictPath) {
        closeConflictDrawer();
      }
      if (e.key === 'Escape' && document.getElementById('checkoutBranchModal').style.display !== 'none') {
        closeCheckoutModal();
      }
      if (e.key === 'Escape' && document.getElementById('createRemoteBranchModal').style.display !== 'none') {
        closeCreateRemoteModal();
      }
      if (e.key === 'Escape' && document.getElementById('switchBranchModal').style.display !== 'none') {
        closeSwitchBranchModal();
      }
      if (e.key === 'Escape' && document.getElementById('createWorktreeModal').style.display !== 'none') {
        closeCreateWorktreeModal();
      }
      if (e.key === 'Escape' && document.getElementById('editWorktreeModal').style.display !== 'none') {
        closeEditWorktreeModal();
      }
      if (e.key === 'Escape' && document.getElementById('createMrModal').style.display !== 'none') {
        closeCreateMrModal();
      }
      if (e.key === 'Escape' && document.getElementById('scanDirectoryModal').style.display !== 'none') {
        closeScanDirectoryModal();
      }
      if (e.key === 'Escape' && document.getElementById('worktreeRemoveModal').style.display !== 'none') {
        closeWorktreeRemoveModal(false);
      }
    });

    /* ⌘←/→ 切换页面主视图（契约 §17.1.2）：窗口标签循环保留在 Ctrl±Tab，⌘←/→ 改为
       切换页面主视图 tab（仓库总览与管理 → Worktree 差异对比 → Merge Requests 循环），
       复用既有 switchTab 入口（内含 URL 状态同步），浏览器/桌面两模式一致。桩测试按
       下方起止标记截取本段源码在沙箱内验证。 */
    /* §17.1.2-CMD-ARROW-START */
    const TAB_CYCLE_ORDER = ['overview', 'diff', 'mr', 'remote']; // 循环顺序与顶栏 tab 按钮排列一致：⌘→ 依次前进
    // 非 mac 用 Ctrl 兜底（Windows/Linux 上 Ctrl+←/→ 无浏览器默认行为，不冲突）；
    // mac 上 Ctrl+←/→ 属系统空间切换，页面通常收不到，故 mac 仅认 ⌘
    const CMD_ARROW_IS_MAC = /Mac/i.test(navigator.platform);
    document.addEventListener('keydown', (e) => {
      // 输入守卫（契约硬性）：焦点在输入类元素时直接放行，保留 ⌘←/→ 的行首/行尾光标跳转
      const target = e.target;
      if (target && (target.isContentEditable || (target.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)))) return;
      // 修饰键匹配：mac 只认 ⌘；非 mac ⌘/Ctrl 皆可（Windows 的 ⌘ 位是 Win 键，系统窗口吸附优先）
      if (!(e.metaKey || (!CMD_ARROW_IS_MAC && e.ctrlKey))) return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      // 拦截浏览器默认行为：Chrome 下 ⌘←/→ 是历史前进/后退快捷键，不拦截会与视图切换叠加
      e.preventDefault();
      const delta = e.key === 'ArrowRight' ? 1 : -1;
      const nextTab = TAB_CYCLE_ORDER[(TAB_CYCLE_ORDER.indexOf(activeTab) + delta + TAB_CYCLE_ORDER.length) % TAB_CYCLE_ORDER.length];
      switchTab(nextTab);
    });
    /* §17.1.2-CMD-ARROW-END */

    /* 触摸板双指滑动历史导航（契约 §18 第二次修订）：双指右滑=返回、左滑=前进，与 Chrome
       双指滑动一致。识别做在页面层（主进程不注入），浏览器/桌面模式行为一致、模式无关；
       全程只监听不 preventDefault，滚动行为本身零影响。桩测试按下方起止标记截取本段源码
       在沙箱内验证。 */
    /* §18-SWIPE-NAV-START */
    const SWIPE_NAV_THRESHOLD = 80;     // 触发阈值：累计横向位移绝对值（像素），可按手感微调
    const SWIPE_NAV_COOLDOWN_MS = 200;  // 触发后冷却：wheel 事件流静默此时长才复位，防长滑连发
    const SWIPE_GUARD_DEPTH = 5;        // 目标级守卫向上遍历祖先的最大层数（同时控制热路径开销）
    // 方向符号：累计 deltaX 与 SWIPE_BACK_SIGN 同号 ⇒ 返回，异号 ⇒ 前进。
    // 为什么是 -1：macOS 默认开启"自然滚动"（内容随手走），手指右滑 ⇒ 内容右移 ⇒ 视口相对
    // 内容左移 ⇒ deltaX 为负，故右滑=返回取 -1；已用 CDP Input.dispatchMouseEvent
    // {type:'mouseWheel', deltaX:-100} 实测确认该符号触发 history.back()（校准见交付报告）。
    // 用户关闭自然滚动时手指方向与 deltaX 符号整体反转，行为随 Chrome 一并反转，无需改码。
    const SWIPE_BACK_SIGN = -1;

    const swipeNavState = { accum: 0, cooled: true, quietTimer: null };

    // 事件流静默计时：每个到达本监听的 wheel 事件都重排；到点说明事件流已停 200ms，
    // 统一清掉残余累积并结束冷却（冷却期与普通累积期共用一套静默复位）
    function scheduleSwipeNavQuietReset() {
      if (swipeNavState.quietTimer) clearTimeout(swipeNavState.quietTimer);
      swipeNavState.quietTimer = setTimeout(() => {
        swipeNavState.quietTimer = null;
        swipeNavState.accum = 0;
        swipeNavState.cooled = true;
      }, SWIPE_NAV_COOLDOWN_MS);
    }

    // 元素是否横向可滚：先比尺寸再取样式，让大多数不溢出的元素免走 getComputedStyle
    function isHorizontallyScrollable(el) {
      if (!el || el.scrollWidth <= el.clientWidth + 1) return false;
      const overflowX = window.getComputedStyle(el).overflowX;
      return overflowX === 'auto' || overflowX === 'scroll' || overflowX === 'overlay';
    }

    // 横向滚动守卫（优先级最高）：文档级或目标祖先级任一命中，横向滑动归滚动所有，不做导航
    function isSwipeNavBlocked(event) {
      // 文档级：页面本身有横向滚动空间时，横向滑动语义属于页面滚动（含 documentElement 自身）
      const doc = document.documentElement;
      if (doc.scrollWidth > doc.clientWidth + 1) return true;
      // 目标级：从事件目标向上有限层检查（Diff 代码块等可横向滚动容器内不劫持）
      let el = event.target instanceof Element ? event.target : null;
      for (let depth = 0; el && depth < SWIPE_GUARD_DEPTH; depth += 1, el = el.parentElement) {
        if (isHorizontallyScrollable(el)) return true;
      }
      return false;
    }

    function handleSwipeNavWheel(event) {
      // 任何 wheel 事件都证明手势流仍在延续，先重排静默计时（见 scheduleSwipeNavQuietReset）
      scheduleSwipeNavQuietReset();
      // 冷却期：当次触摸相位已触发过，只维持计时直到事件流停止，不累积不触发（单相位单触发）
      if (!swipeNavState.cooled) return;
      // 横向意图：横向分量存在且不小于纵向分量才进入累积；纯纵向滚动完全不经过后续分支
      if (event.deltaX === 0 || Math.abs(event.deltaX) < Math.abs(event.deltaY)) return;
      // 守卫命中即作废当次累积：累积过程中持续校验，覆盖滑入 Diff 代码块等中途进入滚动态的场景
      if (isSwipeNavBlocked(event)) {
        swipeNavState.accum = 0;
        return;
      }
      swipeNavState.accum += event.deltaX;
      const signed = swipeNavState.accum * SWIPE_BACK_SIGN; // 乘符号后：正=返回方向，负=前进方向
      if (Math.abs(signed) >= SWIPE_NAV_THRESHOLD) {
        swipeNavState.accum = 0;   // 立即清零，防止同相位残余直接凑满下一次触发
        swipeNavState.cooled = false;
        if (signed > 0) window.history.back();
        else window.history.forward();
      }
    }

    // popstate 兜底：历史切换（含 Cmd+[、Cmd+]、抽屉恢复与本手势自身触发）后清空累积，
    // 避免未完成的旧位移污染下一次手势
    window.addEventListener('popstate', () => {
      swipeNavState.accum = 0;
    });
    // 捕获阶段监听（第二次修订）：提交抽屉等容器对 wheel 做 stopPropagation（滚动链拦截），
    // 冒泡阶段监听会在光标停于抽屉上时收不到事件、手势失效；capture 使本监听先于一切目标级
    // 处理执行。e.target 在捕获阶段仍是事件真实目标，目标级横向滚动守卫语义不变。
    window.addEventListener('wheel', handleSwipeNavWheel, { capture: true, passive: true });
    /* §18-SWIPE-NAV-END */
