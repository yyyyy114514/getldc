// ==UserScript==
// @name         Linux.do 自动浏览助手
// @namespace    https://linux.do/
// @version      2.6.7
// @description  自动浏览帖子、滚动查看所有回复、随机点赞、避免重复浏览、可限定每帖浏览楼层数、支持所选分区轮换、每日定时自动开始与浏览/点赞/时长目标与浮窗时钟；高级设置可调翻页/阅读/点赞速率与概率，内置反检测随机节奏
// @author       yyyy114514
// @match        https://linux.do/*
// @downloadURL  https://raw.githubusercontent.com/yyyyy114514/getldc/master/src/linuxdo-automation.user.js
// @updateURL    https://raw.githubusercontent.com/yyyyy114514/getldc/master/src/linuxdo-automation.user.js
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(function() {
  'use strict';

  // 为当前标签页生成唯一ID（用于防多开检测）
  // 必须按“浏览器标签页”稳定，不能每次页面加载都随机：脚本靠整页跳转翻话题，
  // 若跳转后 ID 变了，锁里存的旧 ID 永远对不上自己，会被误判成“其他标签页在运行”而拒绝自启。
  // sessionStorage 恰好按标签页隔离且整页跳转后保留：同一标签页翻页 ID 不变，新开标签页 ID 必然不同
  const TAB_ID = (() => {
    try {
      let id = sessionStorage.getItem('linuxdo_tab_id');
      if (!id) {
        id = Math.random().toString(36).slice(2, 11);
        sessionStorage.setItem('linuxdo_tab_id', id);
      }
      return id;
    } catch (e) {
      // sessionStorage 不可用时退回随机 ID（仅影响防多开的准确性，不影响功能）
      return Math.random().toString(36).slice(2, 11);
    }
  })();

  // ==================== 配置参数 ====================

  // 速度预设（进一步调整避免429错误）
  const SPEED_PRESETS = {
    slow: {
      name: '慢速',
      scrollStep: 300,
      scrollInterval: 2500,
      loadWaitTime: 4000,
      minReadTime: 2000,
      maxReadTime: 4000,
      noNewContentRetry: 4
    },
    normal: {
      name: '正常',
      scrollStep: 400,
      scrollInterval: 1500,
      loadWaitTime: 2500,
      minReadTime: 800,
      maxReadTime: 1500,
      noNewContentRetry: 3
    },
    fast: {
      name: '快速',
      scrollStep: 500,
      scrollInterval: 800,
      loadWaitTime: 1500,
      minReadTime: 300,
      maxReadTime: 800,
      noNewContentRetry: 3
    },
    turbo: {
      name: '极速',
      scrollStep: 600,
      scrollInterval: 400,
      loadWaitTime: 1000,
      minReadTime: 100,
      maxReadTime: 300,
      noNewContentRetry: 2
    }
  };

  // 当前速度设置（延迟初始化，等Storage类定义后再读取）
  let currentSpeed = 'normal';

  // 列表选择设置
  const LIST_OPTIONS = {
    latest: { name: '最新', path: '/latest' },
    new: { name: '新帖', path: '/new' },
    unread: { name: '未读', path: '/unread' }
  };
  let currentList = 'latest';

  // 列表轮换顺序：未读内容最先（最可能含新帖），三个列表都扫完即本轮结束
  const LIST_ORDER = ['unread', 'new', 'latest'];

  // ==================== 分区（板块） ====================
  // 与 dosss (linuxdosss/bot_core.py CATEGORIES) 保持一致：名称 / 路径 / 默认启用
  const CATEGORY_LIST = [
    { name: '开发调优', url: '/c/develop/4', enabled: true },
    { name: '国产替代', url: '/c/domestic/98', enabled: true },
    { name: '资源荟萃', url: '/c/resource/14', enabled: true },
    { name: '网盘资源', url: '/c/resource/cloud-asset/94', enabled: true },
    { name: '文档共建', url: '/c/wiki/42', enabled: true },
    { name: '非我莫属', url: '/c/job/27', enabled: true },
    { name: '读书成诗', url: '/c/reading/32', enabled: true },
    { name: '前沿快讯', url: '/c/news/34', enabled: true },
    { name: '网络记忆', url: '/c/feeds/92', enabled: true },
    { name: '福利羊毛', url: '/c/welfare/36', enabled: true },
    { name: '搞七捻三', url: '/c/gossip/11', enabled: true },
    { name: '虫洞广场', url: '/c/square/110', enabled: true },
    { name: '积分乐园', url: '/c/credit/106', enabled: false },
    { name: '扬帆起航', url: '/c/startup/46', enabled: false },
    { name: '社区孵化', url: '/c/incubator/102', enabled: false },
    { name: '运营反馈', url: '/c/feedback/2', enabled: false }
  ];
  // 分区选择：'all' = 不限分区（浏览全站未读/新帖/最新）；
  // 数组 = 只浏览这些分区（默认与 dosss 一致：CATEGORY_LIST 中 enabled 的 12 个）
  const DEFAULT_SELECTED_CATEGORIES = CATEGORY_LIST.filter(c => c.enabled).map(c => c.url);
  // 注意：Storage 类在文件靠后位置才定义（class 声明不提升），
  // 此处只能先声明变量，实际读取推迟到 loadSelectedCategories()（Storage 定义完成后调用）
  let selectedCategories = null;

  // 从存储加载分区选择（'all' 或所选分区 url 数组），在 Storage 类定义后调用
  function loadSelectedCategories() {
    let stored = Storage.get('selected_categories', null);
    if (stored === null) stored = DEFAULT_SELECTED_CATEGORIES.slice();
    else if (stored !== 'all') {
      // 容错：剔除已不存在的分区路径，防止过期配置让轮换目标悬空
      stored = (Array.isArray(stored) ? stored : []).filter(u =>
        CATEGORY_LIST.some(c => c.url === u));
    }
    selectedCategories = stored;
  }

  function isCategoryMode() {
    return Array.isArray(selectedCategories) && selectedCategories.length > 0;
  }

  // 当前浏览目标列表（分区模式下是所选分区页，否则是全站三个列表）
  function getBrowseTargets() {
    if (isCategoryMode()) {
      return selectedCategories.map(url => {
        const cat = CATEGORY_LIST.find(c => c.url === url);
        return { key: url, name: cat ? cat.name : url, path: url };
      });
    }
    return LIST_ORDER.map(key => ({ key, name: LIST_OPTIONS[key].name, path: LIST_OPTIONS[key].path }));
  }

  // 默认跳转目标（兜底/首趟）：分区模式随机挑一个所选分区（与 dosss 一致，避免每次固定从第一个分区开始），
  // 否则维持面板当前列表选择
  function getDefaultBrowsePath() {
    const targets = getBrowseTargets();
    if (isCategoryMode() && targets.length > 1) {
      const pick = targets[Math.floor(Math.random() * targets.length)];
      return pick.path;
    }
    return (targets[0] && targets[0].path) || LIST_OPTIONS[currentList]?.path || '/latest';
  }

  // 从当前路径反推实际所在的浏览目标 key（currentList 只是面板选中值，换列表跳转后 URL 才是真相），
  // 供「扫完换目标」轮换去重，避免跳回当前所在列表造成原地打转
  function getCurrentListFromPath() {
    const p = window.location.pathname;
    if (isCategoryMode()) {
      // 分区 URL 可能存在 /c/xxx/N/l/latest 之类的子路径变体，前缀匹配兼容
      const target = getBrowseTargets().find(t => p === t.path || p.startsWith(t.path + '/'));
      return target ? target.key : null;
    }
    for (const key of LIST_ORDER) {
      if (LIST_OPTIONS[key].path === p) return key;
    }
    return 'latest';
  }

  // 点赞开关
  let enableLike = true;
  // 只给主帖（楼主帖）点赞，不给回复楼层点赞
  let likeMainOnly = false;
  // 半透明信息浮窗：开启后面板不再显示统计信息，改为页面左上角半透明浮窗显示
  let floatingStats = false;

  // 点赞概率预设
  const LIKE_CHANCE_PRESETS = {
    low: { name: '低', value: 0.05 },      // 5%
    medium: { name: '中', value: 0.15 },   // 15%
    high: { name: '高', value: 0.25 },     // 25%
    veryHigh: { name: '极高', value: 0.40 } // 40%
  };
  let currentLikeChance = 'medium';

  // 楼层限制：每帖只浏览前 N 楼就换下一帖，0 表示不限
  let floorLimit = 0;
  // 楼层限制的计数口径：开启后已读楼层滚过不计数，只数上次阅读位置之后的新楼层
  let floorLimitUnreadOnly = false;

  // 每日定时自动开始：到设定时刻自动启动浏览（同一天只触发一次，错过时间启动后不补跑）
  let scheduleEnabled = false;
  let scheduleTime = '09:00'; // 'HH:MM'

  // 会话目标：本次浏览满 N 帖或点满 M 赞即自动停止；0 表示该项不限
  let topicTarget = 20;
  let likeTarget = 10;
  // 单次运行时长上限（分钟）：0 表示不限
  let maxMinutes = 0;

  const CONFIG = {
    // 动态从速度预设获取；高级设置里的数值优先（>0 覆盖预设，0/留空跟随预设）
    get scrollStep() { return Storage.get('adv_scroll_step', 0) || SPEED_PRESETS[currentSpeed].scrollStep; },
    get scrollInterval() { return Storage.get('adv_scroll_interval', 0) || SPEED_PRESETS[currentSpeed].scrollInterval; },
    get loadWaitTime() { return Storage.get('adv_load_wait', 0) || SPEED_PRESETS[currentSpeed].loadWaitTime; },
    get minReadTime() { return Storage.get('adv_min_read', 0) || SPEED_PRESETS[currentSpeed].minReadTime; },
    get maxReadTime() { return Storage.get('adv_max_read', 0) || SPEED_PRESETS[currentSpeed].maxReadTime; },
    get noNewContentRetry() { return SPEED_PRESETS[currentSpeed].noNewContentRetry; },

    // 点赞设置（动态从预设获取；高级设置百分比 >0 覆盖，上限 50%）
    get likeChance() {
      const adv = Storage.get('adv_like_chance', 0);
      return adv > 0 ? Math.min(50, adv) / 100 : LIKE_CHANCE_PRESETS[currentLikeChance].value;
    },
    get minLikeInterval() { return Storage.get('adv_like_interval', 0) || 2000; },  // 最小点赞间隔 (ms)

    // 会话设置（动态从目标配置读取，达到即自动停止）
    get maxLikesPerSession() { return likeTarget; },
    get maxTopicsPerSession() { return topicTarget; },

    // 返回列表设置（高级设置可覆盖）
    get returnToListDelay() { return Storage.get('adv_return_delay', 0) || 1000; },

    // 反检测：滚动步长随机抖动范围 (px)
    get scrollJitter() { return Storage.get('adv_scroll_jitter', 0) || 60; },

    // 时间线「返回」按钮的最长等待时间 (ms)，等不到就留在原地读
    backButtonWaitTime: 2500,

    // 调试（默认关闭，避免给所有用户刷 console；需要时用 GM_setValue('debug', true) 开启）
    debug: false
  };

  function setSpeed(preset) {
    if (SPEED_PRESETS[preset]) {
      currentSpeed = preset;
      Storage.set('speed_preset', preset);
      log(`速度设置为: ${SPEED_PRESETS[preset].name}`);
    }
  }

  function setList(listType) {
    if (LIST_OPTIONS[listType]) {
      currentList = listType;
      Storage.set('list_type', listType);
      log(`列表设置为: ${LIST_OPTIONS[listType].name}`);
    }
  }

  function setEnableLike(enabled, updateUI = true) {
    enableLike = enabled;
    Storage.set('enable_like', enabled);
    log(`随机点赞: ${enabled ? '已开启' : '已关闭'}`);

    // 更新UI按钮状态
    if (updateUI) {
      document.querySelectorAll('.like-btn[data-like]').forEach(btn => {
        btn.classList.remove('active');
        if ((btn.dataset.like === 'true') === enabled) {
          btn.classList.add('active');
        }
      });
      // 点赞关闭时概率选项没有意义，整行收起
      const chanceRow = document.getElementById('like-chance-row');
      if (chanceRow) chanceRow.classList.toggle('hidden', !enabled);
    }
  }

  // 只赞主帖：开启后仅给楼主帖点赞，跳过所有回复楼层
  function setLikeMainOnly(enabled) {
    likeMainOnly = enabled;
    Storage.set('like_main_only', enabled);
    log(enabled ? '只赞主帖：仅给楼主帖点赞' : '点赞范围：帖子与回复楼层都点赞');
  }

  // 处理点赞限制：点赞走 API 直连（sendLikeRequest），命中 429/rate_limit 时调用，
  // 直接关掉点赞开关避免继续触发风控（API 点赞不弹 UI 对话框，故无需检测或关闭弹窗）
  function handleLikeLimit() {
    log('已达到点赞上限，自动关闭点赞功能');
    setEnableLike(false, true);
  }

  function setLikeChance(preset) {
    if (LIKE_CHANCE_PRESETS[preset]) {
      currentLikeChance = preset;
      Storage.set('like_chance', preset);
      const percent = Math.round(LIKE_CHANCE_PRESETS[preset].value * 100);
      log(`点赞概率设置为: ${LIKE_CHANCE_PRESETS[preset].name} (${percent}%)`);
    }
  }

  function setFloorLimit(value) {
    const n = Math.max(0, Math.floor(Number(value) || 0));
    floorLimit = n;
    Storage.set('floor_limit', n);
    log(`楼层限制设置为: ${n > 0 ? `前 ${n} 楼` : '不限'}`);
  }

  function setFloorLimitUnreadOnly(enabled) {
    floorLimitUnreadOnly = enabled;
    Storage.set('floor_limit_unread_only', enabled);
    log(`楼层限制口径: ${enabled ? '只计未读楼层' : '按楼层号'}`);
  }

  // 单次运行时长上限（分钟）：0 表示不限
  function setMaxMinutes(value) {
    const n = Math.max(0, Math.floor(Number(value) || 0));
    maxMinutes = n;
    Storage.set('max_minutes', n);
    log(`单次时长上限设置为: ${n > 0 ? `${n} 分钟` : '不限'}`);
  }

  // 每日定时设置：时间格式 HH:MM，非法输入回落 09:00
  function setSchedule(enabled, time) {
    scheduleEnabled = !!enabled;
    let t = '09:00';
    const m = String(time || '').match(/^(\d{1,2}):(\d{2})$/);
    if (m) {
      const h = Math.min(23, Math.max(0, parseInt(m[1], 10)));
      const mm = Math.min(59, Math.max(0, parseInt(m[2], 10)));
      t = `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    }
    scheduleTime = t;
    Storage.set('sched_enabled', scheduleEnabled);
    Storage.set('sched_time', scheduleTime);
    // 用户重新设置定时后开放新的触发窗口：清掉「今日已运行」标记，
    // 否则同一天之前触发过的话，新设的时间会被一次/天守卫吞掉，到点不启动
    Storage.set('sched_last_run_date', '');
    log(`每日定时: ${scheduleEnabled ? `每天 ${scheduleTime} 自动开始浏览` : '已关闭'}`);
  }

  // 高级设置：数值覆盖速度/点赞预设，0 或留空 = 恢复跟随预设
  function setAdvanced(key, value) {
    const n = Math.max(0, Math.floor(Number(value) || 0));
    if (n > 0) Storage.set(key, n);
    else Storage.remove(key);
    log(`高级设置 ${key}: ${n > 0 ? n : '跟随预设'}`);
  }

  // 会话目标设置：浏览满 N 帖或点满 M 赞自动停止，0 表示不限
  function setTargets(topics, likes) {
    topicTarget = Math.max(0, Math.floor(Number(topics) || 0));
    likeTarget = Math.max(0, Math.floor(Number(likes) || 0));
    Storage.set('topic_target', topicTarget);
    Storage.set('like_target', likeTarget);
    log(`会话目标: 浏览 ${topicTarget || '不限'} 帖 / 点赞 ${likeTarget || '不限'} 个`);
  }

  // ==================== 工具函数 ====================

  function log(...args) {
    if (CONFIG.debug) {
      console.log(`[LinuxDo自动化|${TAB_ID}]`, new Date().toLocaleTimeString(), ...args);
    }
  }

  function randomDelay(min, max) {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    return new Promise(resolve => setTimeout(resolve, delay));
  }

  function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  // 登录状态三态检测：true=已登录，false=未登录，null=无法判定（页面未就绪或 Cloudflare 挑战页）
  // 优先读取 #data-preloaded（服务端直出，脚本注入时必然存在），
  // 避免与 Ember 渲染 #current-user 竞速导致误判（脚本注入时 header 尚未渲染）
  function getLoginState() {
    const preloaded = document.querySelector('#data-preloaded');
    if (preloaded) {
      // 新版 Discourse 把预加载数据放进 <script id="data-preloaded" type="application/json"> 的文本内容里；
      // 旧版是 <div id="data-preloaded" data-preloaded="{...}">。先取 textContent，再回退 dataset 兼容旧版
      const raw = preloaded.textContent || preloaded.dataset.preloaded;
      if (raw) {
        try {
          return 'currentUser' in JSON.parse(raw);
        } catch (e) {
          // 解析失败，回退到 DOM 检测
        }
      }
    }
    return document.querySelector('#current-user') !== null ? true : null;
  }

  function getPageTypeFromPath(path) {
    if (path.match(/^\/t\/topic\/\d+/)) return 'topic';
    if (path === '/latest' || path === '/new' || path === '/unread' ||
        path === '/' || path === '/top' || path === '/hot' ||
        path.startsWith('/c/')) return 'list';
    return 'other';
  }

  function getPageType() {
    return getPageTypeFromPath(window.location.pathname);
  }

  function getTopicIdFromUrl(url) {
    const match = url?.match(/\/t\/topic\/(\d+)/);
    return match ? match[1] : null;
  }

  function getCurrentTopicId() {
    return getTopicIdFromUrl(window.location.pathname);
  }

  // 读取当前话题「上次读到第几楼」（Discourse 的 last_read_post_number）
  // 数据取自服务端直出的 #data-preloaded：它是 <script type="application/json">，
  // 数据在 textContent 里，且话题对象被二次 JSON 编码（顶层 value 本身是字符串）
  // 未登录、非话题页或该帖从未读过时返回 0
  function getLastReadPostNumber(topicId) {
    try {
      const el = document.querySelector('#data-preloaded');
      if (!el) return 0;
      const raw = JSON.parse(el.textContent)[`topic_${topicId}`];
      if (!raw) return 0;
      const topic = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return Number(topic.last_read_post_number) || 0;
    } catch (e) {
      return 0;
    }
  }

  // 读取当前话题「实际总楼层数」（楼主帖算 1 楼，一条回复 = 一楼）。
  // 同样取自 #data-preloaded 的 topic 对象：posts_count 含楼主帖；highest_post_number 兜底。
  // 用真实楼数做硬上限：帖子实际只有 2 楼时，读完 2 楼即收工，
  // 不再继续滚动等「永远等不到的新楼」，也避免浮窗楼层数虚高
  function getTopicTotalPosts(topicId) {
    try {
      const el = document.querySelector('#data-preloaded');
      if (!el) return 0;
      const raw = JSON.parse(el.textContent)[`topic_${topicId}`];
      if (!raw) return 0;
      const topic = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return Number(topic.posts_count) || Number(topic.highest_post_number) || 0;
    } catch (e) {
      return 0;
    }
  }

  // Discourse 的「返回」按钮（i18n 键 topic.timeline.back，悬浮提示「返回上一个未读帖子」），
  // 点击等价于 jumpToPost(topic.last_read_post_number)，即跳回上次读到的楼层。
  // 宽屏渲染在右侧时间线的 scroller 内 (button.back-button)，
  // 窄屏/移动端渲染在底部进度条上 (button.progress-back)，两处都兜住
  const BACK_BUTTON_SELECTOR = [
    '.topic-timeline button.back-button',
    '.timeline-container button.back-button',
    '#topic-progress-wrapper button.progress-back',
    '.progress-back-container button.progress-back'
  ].join(', ');

  // 时间线由 Ember 异步渲染，且「返回」只在当前位置落后于上次阅读位置时才出现，
  // 所以轮询等待而不是取一次就走；超时返回 null，由调用方决定退路
  async function waitForBackButton(timeout) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const btn = document.querySelector(BACK_BUTTON_SELECTOR);
      if (btn && btn.offsetParent !== null) return btn;
      await randomDelay(200, 350);
    }
    return null;
  }

  // ==================== 存储管理 ====================

  class Storage {
    static get(key, defaultValue = null) {
      try {
        if (typeof GM_getValue !== 'undefined') {
          const val = GM_getValue(key, null);
          return val !== null ? val : defaultValue;
        }
        const value = localStorage.getItem(`linuxdo_${key}`);
        return value ? JSON.parse(value) : defaultValue;
      } catch (e) {
        return defaultValue;
      }
    }

    static set(key, value) {
      try {
        if (typeof GM_setValue !== 'undefined') {
          GM_setValue(key, value);
        } else {
          localStorage.setItem(`linuxdo_${key}`, JSON.stringify(value));
        }
      } catch (e) {
        log('存储失败:', e);
      }
    }

    static remove(key) {
      try {
        if (typeof GM_deleteValue !== 'undefined') {
          GM_deleteValue(key);
        } else {
          localStorage.removeItem(`linuxdo_${key}`);
        }
      } catch (e) {
        /* 忽略删除失败 */
      }
    }
  }

  // 初始化设置
  currentSpeed = Storage.get('speed_preset', 'normal');
  currentList = Storage.get('list_type', 'latest');
  enableLike = Storage.get('enable_like', true);
  likeMainOnly = Storage.get('like_main_only', false);
  currentLikeChance = Storage.get('like_chance', 'medium');
  floorLimit = Storage.get('floor_limit', 0);
  floorLimitUnreadOnly = Storage.get('floor_limit_unread_only', false);
  topicTarget = Storage.get('topic_target', 20);
  likeTarget = Storage.get('like_target', 10);
  maxMinutes = Storage.get('max_minutes', 0);
  floatingStats = Storage.get('floating_stats', false);
  scheduleEnabled = Storage.get('sched_enabled', false);
  scheduleTime = Storage.get('sched_time', '09:00');
  CONFIG.debug = Storage.get('debug', false);
  loadSelectedCategories();

  // 数据迁移：v2.1.1 起 liked_posts 的键从话题内楼层序号改为全局 post id，
  // 旧键在新逻辑下全部失配（脏数据），一次性清空，避免重访旧话题时把已点赞的帖子误 toggle 取消
  // （viewed_topics 存的一直是话题 id，语义未变，保留不动）
  const STORAGE_VERSION = 2;
  if (Storage.get('storage_version', 1) < STORAGE_VERSION) {
    Storage.set('liked_posts', []);
    Storage.set('storage_version', STORAGE_VERSION);
    log('存储迁移：已重置 liked_posts (点赞去重键格式变更为全局 post id)');
  }

  // ==================== 浏览记录管理 ====================

  // 浏览/点赞记录的最大保留条数，超出后按插入顺序淘汰最旧的，避免长期运行无限膨胀
  const MAX_HISTORY = 5000;

  // 将 Set 裁剪到不超过 max 条：Set 迭代按插入顺序，从头部删除即淘汰最旧的
  function trimSet(set, max) {
    while (set.size > max) {
      set.delete(set.values().next().value);
    }
  }

  class BrowsingHistory {
    constructor() {
      this.viewed = new Set(Storage.get('viewed_topics', []));
      this.liked = new Set(Storage.get('liked_posts', []));
      // 会话计数持久化（按 epoch 区分「新一轮」）：整页跳转会重载脚本，若只存内存，
      // 每次翻页都会清零，导致「浏览满 N 帖自动停止」的目标永远达不到。
      // epoch 只在手动/定时开始时更新，翻页不清——与阅读量的处理方式一致
      this.sessionEpoch = Storage.get('session_epoch', 0);
      this.sessionViewed = Storage.get('session_viewed', 0);
      this.sessionLiked = Storage.get('session_liked', 0);
      this.sessionReplies = Storage.get('session_replies', 0);
      this.totalReplies = Storage.get('total_replies', 0);
      // 本会话已计入「浏览帖数」的话题集合：会话内去重（同一话题本会话只计一次），
      // 跨整页跳转持久化、resetSession 时清空。与全局 viewed 历史解耦——之前会话读过的话题
      // 本会话再读也计入，不再被跨会话持久化的 viewed 集合吞掉计数
      this.sessionSeenTopics = new Set(Storage.get('session_seen_topics', []));
      // 节流写入的定时器句柄，避免每标记一条就全量序列化落盘
      this.saveTimer = null;
    }

    isTopicViewed(topicId) {
      return this.viewed.has(String(topicId));
    }

    markTopicViewed(topicId) {
      const id = String(topicId);
      // 会话级去重：同一话题本会话只计一次，不再受跨会话持久化的 viewed 集合限制。
      // 全局 viewed 仍照常更新（列表标记/跳过已读话题用），但计数只看本会话首见
      if (!this.sessionSeenTopics.has(id)) {
        this.sessionSeenTopics.add(id);
        trimSet(this.sessionSeenTopics, MAX_HISTORY);
        this.sessionViewed++;
        Storage.set('session_viewed', this.sessionViewed);
        Storage.set('session_seen_topics', [...this.sessionSeenTopics]);
        this.scheduleSave();
        log(`标记话题 ${id} 为已浏览，本次会话已浏览 ${this.sessionViewed} 个`);
      }
      if (!this.viewed.has(id)) {
        this.viewed.add(id);
        trimSet(this.viewed, MAX_HISTORY);
        this.scheduleSave();
      }
    }

    isPostLiked(postId) {
      return this.liked.has(String(postId));
    }

    markPostLiked(postId) {
      const id = String(postId);
      if (!this.liked.has(id)) {
        this.liked.add(id);
        trimSet(this.liked, MAX_HISTORY);
        this.sessionLiked++;
        Storage.set('session_liked', this.sessionLiked);
        this.scheduleSave();
      }
    }

    addReplyViewed() {
      this.sessionReplies++;
      Storage.set('session_replies', this.sessionReplies);
      this.totalReplies++;
      if (this.sessionReplies % 10 === 0) {
        this.scheduleSave();
      }
    }

    // 新一轮开始：清零会话计数并记录新 epoch（翻页不清零，只在这里重置）
    resetSession() {
      this.sessionEpoch = Date.now();
      this.sessionViewed = 0;
      this.sessionLiked = 0;
      this.sessionReplies = 0;
      this.sessionSeenTopics.clear();
      Storage.set('session_epoch', this.sessionEpoch);
      Storage.set('session_viewed', 0);
      Storage.set('session_liked', 0);
      Storage.set('session_replies', 0);
      Storage.set('session_seen_topics', []);
      log('新一轮会话开始（计数已清零）');
    }

    // 节流写入：合并短时间内的多次变更，最多延迟 2 秒统一落盘
    // 页面卸载时由 beforeunload 调用 save() 兜底 flush，避免翻页丢失最后的记录
    scheduleSave() {
      if (this.saveTimer) return;
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null;
        this.save();
      }, 2000);
    }

    save() {
      if (this.saveTimer) {
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
      }
      Storage.set('viewed_topics', [...this.viewed]);
      Storage.set('liked_posts', [...this.liked]);
      Storage.set('total_replies', this.totalReplies);
    }

    // 仅在有节流待写数据时落盘，供 beforeunload 兜底 flush
    // 无变更的页面（未启动/未登录/路过） saveTimer 为 null，不写，避免用可能读空的数据覆盖已有历史
    flushPending() {
      if (this.saveTimer) this.save();
    }

    clearHistory() {
      this.viewed.clear();
      this.liked.clear();
      this.totalReplies = 0;
      this.save();
      log('已清除所有浏览历史');
    }

    getStats() {
      return {
        totalViewed: this.viewed.size,
        totalLiked: this.liked.size,
        sessionViewed: this.sessionViewed,
        sessionLiked: this.sessionLiked,
        sessionReplies: this.sessionReplies,
        totalReplies: this.totalReplies
      };
    }

    // 全部目标达成才停：浏览帖数与点赞数二者都达标（0=不限 的项不设门槛）
    canContinue() {
      const maxTopics = CONFIG.maxTopicsPerSession;
      const maxLikes = CONFIG.maxLikesPerSession;
      const anyGoal = maxTopics > 0 || maxLikes > 0;
      if (!anyGoal) return true; // 全不限：一直刷到列表扫完
      const topicsDone = maxTopics <= 0 || this.sessionViewed >= maxTopics;
      const likesDone = maxLikes <= 0 || this.sessionLiked >= maxLikes;
      return !(topicsDone && likesDone);
    }
  }

  // ==================== 阅读量统计 ====================

  // 监听 Discourse 的 /topics/timings 阅读上报接口，请求成功即计入阅读量。
  // 上报体格式：timings[楼层号]=毫秒&...&topic_time=毫秒&topic_id=话题ID。
  // 同一楼层长时间停留会被 Discourse 分多次重复上报，因此按「话题ID:楼层号」
  // 去重累计，与 linux.do 个人资料页「阅读的帖子数」口径一致。
  // 计数持久化存储，页面刷新/跳转后延续；仅在手动点击「开始」时清零。
  // 存储跨标签页共享：写回前先与存储对齐（见 syncFromStorage），避免本页
  // 旧快照覆盖其他标签页的新增，或清零后被其他标签页的旧数据写回
  class ReadingTracker {
    constructor() {
      this.epoch = Storage.get('session_read_epoch', 0);
      this.readKeys = new Set(Storage.get('session_read_keys', []));
      this.onUpdate = null;
    }

    get count() {
      return this.readKeys.size;
    }

    addFromBody(body) {
      try {
        const params = new URLSearchParams(body);
        const topicId = params.get('topic_id');
        if (!topicId) return;

        const newKeys = [];
        for (const [key, value] of params.entries()) {
          // 校验条目格式：楼层号与阅读毫秒数都必须是纯数字，异常条目不计入
          const match = key.match(/^timings\[(\d+)\]$/);
          if (!match || !/^\d+$/.test(value)) continue;
          const floor = Number(match[1]);
          // 楼层上限检查：上报可能包含超出话题实际楼数的伪楼层（如被删帖留下的编号空洞），
          // 超过实际总楼数的条目直接丢弃，浮窗/统计才不会被虚高楼层误导（实际 2 楼就不会数出 17 楼）
          const totalPosts = getTopicTotalPosts(topicId);
          if (totalPosts > 0 && floor > totalPosts) continue;
          newKeys.push(`${topicId}:${floor}`);
        }
        if (newKeys.length === 0) return;

        this.syncFromStorage();
        let added = 0;
        for (const readKey of newKeys) {
          if (!this.readKeys.has(readKey)) {
            this.readKeys.add(readKey);
            added++;
          }
        }
        if (added > 0) {
          // 阅读量去重键会随会话持续增长，设上限防长期运行无限膨胀（超限淘汰最旧）
          trimSet(this.readKeys, 20000);
          Storage.set('session_read_keys', [...this.readKeys]);
          log(`阅读上报成功，新增 ${added} 条，本次总阅读量 ${this.count}`);
        }
        this.onUpdate?.();
      } catch (e) {
        log('解析 timings 上报数据失败:', e);
      }
    }

    // 与存储对齐：epoch 变化说明其他标签页清零过，丢弃本页内存中的旧数据；
    // 同一 epoch 则与存储做并集，防止用本页旧快照覆盖其他标签页写入的新增
    syncFromStorage() {
      const storedEpoch = Storage.get('session_read_epoch', 0);
      const storedKeys = Storage.get('session_read_keys', []);
      if (storedEpoch !== this.epoch) {
        this.epoch = storedEpoch;
        this.readKeys = new Set(storedKeys);
      } else {
        for (const key of storedKeys) this.readKeys.add(key);
      }
    }

    reset() {
      this.epoch = Date.now();
      this.readKeys.clear();
      Storage.set('session_read_epoch', this.epoch);
      Storage.set('session_read_keys', []);
      this.onUpdate?.();
      log('本次总阅读量已清零');
    }
  }

  const readingTracker = new ReadingTracker();

  // 拦截 XHR 与 fetch 两条通道的 /topics/timings 上报，响应 2xx 才计数。
  // hook 必须装在页面真实 window（unsafeWindow）上：带 @grant 的脚本运行在
  // 脚本管理器沙箱中，改写沙箱自己的 XMLHttpRequest/fetch 拦截不到页面请求
  function installTimingsHook() {
    const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const TIMINGS_PATH = '/topics/timings';
    const isTimingsUrl = (url) => String(url).includes(TIMINGS_PATH);
    // 沙箱与页面可能不同 realm，不能用 instanceof Request，按结构判断
    const isRequestLike = (v) => !!v && typeof v === 'object' &&
      typeof v.url === 'string' && typeof v.clone === 'function';

    const xhrProto = pageWindow.XMLHttpRequest.prototype;
    const originalOpen = xhrProto.open;
    const originalSend = xhrProto.send;

    xhrProto.open = function(method, url) {
      this._isTimingsRequest = isTimingsUrl(url);
      return originalOpen.apply(this, arguments);
    };

    xhrProto.send = function(body) {
      if (this._isTimingsRequest) {
        this.addEventListener('load', function() {
          if (this.status >= 200 && this.status < 300) {
            readingTracker.addFromBody(body);
          }
        });
      }
      return originalSend.apply(this, arguments);
    };

    const originalFetch = pageWindow.fetch;
    pageWindow.fetch = function(input, init) {
      const url = isRequestLike(input) ? input.url : input;
      if (!isTimingsUrl(url)) {
        return originalFetch.apply(this, arguments);
      }

      // body 可能在 init 上，也可能包在 Request 对象里（后者需 clone 读取）
      const bodyPromise = init?.body !== undefined && init?.body !== null
        ? Promise.resolve(init.body)
        : (isRequestLike(input) ? input.clone().text().catch(() => null) : Promise.resolve(null));

      return originalFetch.apply(this, arguments).then(response => {
        if (response.ok) {
          bodyPromise.then(body => {
            if (body) readingTracker.addFromBody(body);
          });
        }
        return response;
      });
    };
  }

  // ==================== 滚动控制器 ====================

  class ScrollController {
    constructor() {
      this.lastScrollHeight = 0;
      this.noNewContentCount = 0;
    }

    getScrollInfo() {
      return {
        scrollTop: window.pageYOffset || document.documentElement.scrollTop,
        scrollHeight: document.documentElement.scrollHeight,
        clientHeight: document.documentElement.clientHeight
      };
    }

    isAtBottom() {
      const { scrollTop, scrollHeight, clientHeight } = this.getScrollInfo();
      return scrollTop + clientHeight >= scrollHeight - 100;
    }

    isAtTop() {
      return this.getScrollInfo().scrollTop < 100;
    }

    async scrollDown() {
      // 反卡顿+反检测：整段位移拆成 2~4 段小步连续滚动（段间 90-220ms 随机停顿），
      // 视觉上是「连续匀速下滑」而不是「一跳一跳」；步长仍带 ±scrollJitter 抖动
      const jitter = CONFIG.scrollJitter;
      const total = CONFIG.scrollStep + randomInt(-jitter, jitter);
      if (total <= 0) return;
      const steps = randomInt(2, 4);
      let done = 0;
      for (let i = 0; i < steps && done < total; i++) {
        const remaining = total - done;
        // 前几段每次只滚掉 45%~65%，最后一段吃掉剩余部分，保证总位移一致
        const seg = (i === steps - 1) ? remaining : Math.round(remaining * (0.45 + Math.random() * 0.2));
        if (seg <= 0) break;
        window.scrollBy({ top: seg, behavior: 'auto' });
        done += seg;
        if (i < steps - 1) await randomDelay(90, 220);
      }
    }

    async scrollToTop() {
      window.scrollTo({ top: 0, behavior: 'auto' });
      await randomDelay(200, 400);
    }

    hasNewContent() {
      const currentHeight = document.documentElement.scrollHeight;
      if (currentHeight > this.lastScrollHeight) {
        this.lastScrollHeight = currentHeight;
        this.noNewContentCount = 0;
        return true;
      }
      this.noNewContentCount++;
      return false;
    }

    // 只探测页面是否长高（不累计计数），供等待新内容的轮询使用
    checkHeightChanged() {
      return document.documentElement.scrollHeight > this.lastScrollHeight;
    }

    isContentFullyLoaded() {
      return this.noNewContentCount >= CONFIG.noNewContentRetry;
    }

    reset() {
      this.lastScrollHeight = document.documentElement.scrollHeight;
      this.noNewContentCount = 0;
    }
  }

  // ==================== 帖子详情页浏览器 ====================

  class TopicBrowser {
    constructor(history, onStatsUpdate, onFinished) {
      this.history = history;
      this.onStatsUpdate = onStatsUpdate;
      // 目标达成时回调，让主控彻底结束本轮（dosss 式：每帖/每赞后即时查目标）
      this.onFinished = onFinished;
      this.scrollController = new ScrollController();
      this.isRunning = false;
      this.viewedPosts = new Set();
      this.lastLikeTime = 0;
      // 进入本帖时的已读楼层号，「只计未读」时以它为计数起点
      this.floorBaseline = 0;
      this.unreadFloorsRead = 0;
      this.floorLimitReached = false;
      // 本帖已浏览到的最高楼层号（用于「实际总楼数」硬上限判断）
      this.maxFloorSeen = 0;
    }

    async start() {
      if (this.isRunning) return;
      this.isRunning = true;

      const topicId = getCurrentTopicId();
      if (!topicId) {
        log('无法获取话题ID');
        this.stop();
        return;
      }

      log(`开始浏览话题 ${topicId}...`);
      this.history.markTopicViewed(topicId);
      this.onStatsUpdate?.();

      // 该帖实际总楼层数：用作滚动/等待的硬上限，帖子只有 2 楼就不会白等到「不存在的第 3 楼」
      this.topicTotalPosts = getTopicTotalPosts(topicId);
      if (this.topicTotalPosts > 0) {
        log(`话题共 ${this.topicTotalPosts} 楼${floorLimit > 0 && this.topicTotalPosts < floorLimit ? `（小于楼层上限 ${floorLimit}，读完即换帖）` : ''}`);
      }

      // 进入时先取已读位置快照：它既是「只计未读」的计数起点，也用来判断该续读还是从头读
      this.floorBaseline = getLastReadPostNumber(topicId);
      this.unreadFloorsRead = 0;
      this.floorLimitReached = false;

      if (this.floorBaseline > 0) {
        // 读过一部分的帖子：点时间线上的「返回」回到上次位置续读，不再从第一楼重刷
        await this.resumeFromLastRead();
      } else {
        await this.goToFirstPost(topicId);
        await this.scrollController.scrollToTop();
      }
      this.scrollController.reset();
      await this.browseAllReplies();

      if (this.isRunning) {
        // dosss 式：每帖浏览完即时查目标，达标直接收工，不再返回列表
        if (!this.history.canContinue()) {
          log('全部目标达成，本轮结束');
          this.stop();
          this.onFinished?.('全部目标达成');
          return;
        }
        await this.returnToList();
      }
    }

    stop() {
      this.isRunning = false;
      log('停止浏览');
    }

    async goToFirstPost(topicId) {
      const currentPath = window.location.pathname;
      const firstPostPath = `/t/topic/${topicId}/1`;

      if (currentPath === firstPostPath || currentPath === `/t/topic/${topicId}`) {
        return;
      }

      log('跳转到帖子第一楼...');
      const jumpToFirstBtn = document.querySelector('a[href*="/1"][title*="第一"], a[href*="/1"][title*="first" i], a.jump-to-first');
      if (jumpToFirstBtn) {
        jumpToFirstBtn.click();
        await randomDelay(1500, 2000);
        return;
      }

      window.location.href = firstPostPath;
      await randomDelay(2000, 2500);
    }

    // 时间线上出现「返回」就点它，跳回上次读到的楼层继续。
    // 等不到按钮（进度条尚未渲染，或当前位置本就在上次阅读处）就留在原地读
    // —— 此时 Discourse 进入话题时已自动定位到上次位置，强行跳第一楼只会重刷已读楼层
    async resumeFromLastRead() {
      const btn = await waitForBackButton(CONFIG.backButtonWaitTime);
      if (!btn) {
        log(`未出现「返回」按钮，从当前位置继续 (上次读到第 ${this.floorBaseline} 楼)`);
        return false;
      }

      log(`点击时间线「返回」，回到第 ${this.floorBaseline} 楼继续阅读`);
      btn.click();
      await randomDelay(CONFIG.loadWaitTime, CONFIG.loadWaitTime * 1.3);
      return true;
    }

    async browseAllReplies() {
      log('开始滚动浏览所有回复...');

      while (this.isRunning) {
        try {
          await this.processVisiblePosts();
          this.onStatsUpdate?.();

          if (this.floorLimitReached) break;

          // 帖子实际楼层数硬上限：已知总楼数且已读到最高楼 → 立即收工，
          // 不再滚动等「永远等不到的新楼」（如设置 3 楼但帖子只有 2 楼）
          if (this.topicTotalPosts > 0 && this.maxFloorSeen >= this.topicTotalPosts) {
            log(`已读完全部 ${this.topicTotalPosts} 楼，提前结束本帖`);
            break;
          }

          if (this.scrollController.isAtBottom()) {
            log('到达页面底部，等待加载新内容...');
            // 反卡顿：不再干等满 loadWaitTime，改为轮询页面高度（约每 1s 一次），
            // 新内容一加载就立即继续滚动；等待结束后统一结算一次 noNewContentRetry（保持原有判定语义）
            const waitDeadline = Date.now() + CONFIG.loadWaitTime;
            while (Date.now() < waitDeadline && this.isRunning) {
              await randomDelay(900, 1300);
              if (this.scrollController.checkHeightChanged()) break;
            }
            if (!this.scrollController.hasNewContent()) {
              if (this.scrollController.isContentFullyLoaded()) {
                log('所有回复已浏览完成');
                break;
              }
            }
          }

          await this.scrollController.scrollDown();
          await randomDelay(CONFIG.scrollInterval, CONFIG.scrollInterval * 1.3);
        } catch (error) {
          log('浏览回复出错:', error.message);
          await randomDelay(2000, 3000);
        }
      }
    }

    async processVisiblePosts() {
      const posts = document.querySelectorAll('article[id^="post_"]');
      const viewportHeight = window.innerHeight;
      let newPostFound = false;

      for (const post of posts) {
        if (!this.isRunning) break;

        const postId = post.id.replace('post_', '');
        // 已处理过的楼层直接跳过，避免对全部楼层反复调用 getBoundingClientRect 触发强制回流
        if (this.viewedPosts.has(postId)) continue;

        const rect = post.getBoundingClientRect();
        if (rect.top < viewportHeight * 0.9 && rect.bottom > viewportHeight * 0.1) {
          // article 的 id 编号就是话题内楼层序号（post_12 即第 12 楼），到限额就收工换下一帖
          const floor = Number(postId);
          if (this.isOverFloorLimit(floor)) {
            this.floorLimitReached = true;
            log(`已达楼层限制，本帖浏览到第 ${floor - 1} 楼为止`);
            break;
          }

          this.viewedPosts.add(postId);
          newPostFound = true;
          if (floor > this.maxFloorSeen) this.maxFloorSeen = floor;
          if (floor > this.floorBaseline) this.unreadFloorsRead++;
          this.history.addReplyViewed();
          this.onStatsUpdate?.();

          if (CONFIG.minReadTime > 0) {
            await randomDelay(CONFIG.minReadTime, CONFIG.maxReadTime);
          }

          if (this.shouldLike(post)) {
            await this.tryLikePost(post, postId);
          }
        }
      }
      return newPostFound;
    }

    // 楼层限额判定：默认按绝对楼层号卡（只看前 N 楼）；
    // 开启「只计未读」后改按实际浏览到的未读楼层个数卡，已读楼层滚过不计数
    isOverFloorLimit(floor) {
      if (floorLimit <= 0) return false;
      if (floorLimitUnreadOnly) return this.unreadFloorsRead >= floorLimit;
      return Number.isFinite(floor) && floor > floorLimit;
    }

    shouldLike(postElement) {
      if (!enableLike) return false;
      // 只赞主帖：跳过回复楼层（Discourse 楼主帖的 article id 恒为 post_1）
      if (likeMainOnly && postElement && postElement.id !== 'post_1') return false;
      if (this.history.sessionLiked >= CONFIG.maxLikesPerSession) return false;
      const now = Date.now();
      if (now - this.lastLikeTime < CONFIG.minLikeInterval) return false;
      return Math.random() < CONFIG.likeChance;
    }

    async tryLikePost(postElement, postId) {
      // 去重键必须用全局唯一的 data-post-id：post.id 里的编号是话题内楼层序号，
      // 跨话题会碰撞（话题 A 的 3 楼与话题 B 的 3 楼同号），用它会误判为已点赞而漏赞
      const actualPostId = postElement.dataset.postId;
      if (!actualPostId) return false;

      if (this.history.isPostLiked(actualPostId)) return false;

      // 已反应检测（关键防线）：discourse-reactions 插件把已反应状态 (has-reacted /
      // has-used-main-reaction) 加在外层 .discourse-reactions-actions 容器上、而非按钮本身。
      // 只要该帖已有任意反应就跳过——否则对已点赞的帖子再 toggle 会取消掉赞，或覆盖用户已选的其它表情
      const reactionActions = postElement.querySelector('.discourse-reactions-actions');
      if (reactionActions && /reacted/i.test(reactionActions.className)) {
        return false;
      }

      // 兜底：非 reactions 插件的标准 Discourse 点赞按钮，已赞时按钮带 has-like 等 class
      const likeBtn = postElement.querySelector(
        'button[title="点赞此帖子"], button[title="Like this post"], button.btn-toggle-reaction-like'
      );
      if (likeBtn && (likeBtn.classList.contains('has-like') ||
          likeBtn.classList.contains('my-likes') ||
          likeBtn.classList.contains('liked'))) {
        return false;
      }

      try {
        await randomDelay(300, 900);  // 反检测：点赞前随机「思考」停顿
        const result = await this.sendLikeRequest(actualPostId);

        if (result.success) {
          this.history.markPostLiked(actualPostId);
          this.lastLikeTime = Date.now();
          this.onStatsUpdate?.();
          log(`点赞帖子 #${postId} (id=${actualPostId})`);
          // dosss 式：点赞后即时查目标，赞满立即收工，不再继续爬楼/返回列表
          if (!this.history.canContinue()) {
            log('全部目标达成，本轮结束');
            this.stop();
            this.onFinished?.('全部目标达成');
          }
          return true;
        } else if (result.rateLimited) {
          handleLikeLimit();
          return false;
        }
        return false;
      } catch (e) {
        return false;
      }
    }

    async sendLikeRequest(postId) {
      try {
        const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
        if (!csrfToken) return { success: false };

        const response = await fetch(`/discourse-reactions/posts/${postId}/custom-reactions/heart/toggle.json`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken
          }
        });

        if (response.ok) return { success: true };

        const data = await response.json().catch(() => ({}));
        if (response.status === 429 || data.error_type === 'rate_limit') {
          return { success: false, rateLimited: true };
        }
        return { success: false };
      } catch (e) {
        return { success: false };
      }
    }

    async returnToList() {
      log('准备返回话题列表...');
      await randomDelay(CONFIG.returnToListDelay, CONFIG.returnToListDelay * 1.5);
      // 回到进入话题前的浏览目标（分区页或全站列表）：列表浏览器跳转前已把来源路径存进 Storage
      const returnUrl = Storage.get('session_return_path', '') || getDefaultBrowsePath();
      window.location.href = returnUrl;
    }
  }

  // ==================== 话题列表浏览器 ====================

  class TopicListBrowser {
    constructor(history, onStatsUpdate, onFinished) {
      this.history = history;
      this.onStatsUpdate = onStatsUpdate;
      // 会话目标达成 / 所有列表扫完时回调，让主控彻底结束本轮（不能只 stop 列表浏览器，
      // 否则自动化仍处于「运行中」，卡死检测会在 30 秒后反复重启空转）
      this.onFinished = onFinished;
      this.scrollController = new ScrollController();
      this.isRunning = false;
      this.scannedTopics = new Set();
      // 已扫过的列表集合：从实际路径推导（当前页）并叠加本会话早前扫过的列表。
      // 集合跨整页跳转持久化（键带会话 epoch），否则每跳转一次就丢，轮换会退化成
      // latest↔unread 交替空转，永远扫不到中间的 new
      const currentListKey = getCurrentListFromPath();
      const savedEpoch = Storage.get('session_scanned_lists_epoch', 0);
      this.scannedLists = new Set(
        savedEpoch === this.history.sessionEpoch ? Storage.get('session_scanned_lists', []) : []
      );
      this.scannedLists.add(currentListKey);
    }

    async start() {
      if (this.isRunning) return;
      this.isRunning = true;

      log('开始在列表中查找未浏览的话题...');
      this.scrollController.reset();

      let found = await this.findAndEnterUnviewedTopic();

      while (this.isRunning && !found) {
        try {
          this.onStatsUpdate?.();

          if (this.scrollController.isAtBottom()) {
            await randomDelay(CONFIG.loadWaitTime, CONFIG.loadWaitTime * 1.2);
            if (!this.scrollController.hasNewContent()) {
              if (this.scrollController.isContentFullyLoaded()) {
                await this.switchToAnotherList();
                return;
              }
            }
          }

          await this.scrollController.scrollDown();
          await randomDelay(CONFIG.scrollInterval, CONFIG.scrollInterval * 1.2);
          found = await this.findAndEnterUnviewedTopic();
        } catch (error) {
          await randomDelay(2000, 3000);
        }
      }
    }

    stop() {
      this.isRunning = false;
      log('停止列表浏览');
    }

    // dosss 式选帖：收集本页全部话题 → 跳过置顶与已浏览 → 未读优先、同级随机 → 进入
    async findAndEnterUnviewedTopic() {
      // 目标即时检查（dosss 式：进任何话题前先查目标，达标直接收工）
      if (!this.history.canContinue()) {
        log('全部目标达成，本轮结束');
        this.stop();
        this.onFinished?.('全部目标达成');
        return false;
      }

      const topicRows = document.querySelectorAll('.topic-list-item, tr[data-topic-id], .topic-list tr');
      const candidates = [];

      for (const row of topicRows) {
        if (!this.isRunning) return false;

        // 跳过置顶帖（dosss 同款判定：行或标题链接带 pinned 类）
        if (row.classList.contains('pinned')) continue;

        const titleLink = row.querySelector('.title a[href*="/t/topic/"], .link-top-line a[href*="/t/topic/"], a.title[href*="/t/topic/"]');
        if (!titleLink) continue;
        if (titleLink.classList.contains('pinned')) continue;

        const topicId = getTopicIdFromUrl(titleLink.href);
        if (!topicId) continue;

        if (this.scannedTopics.has(topicId)) continue;
        this.scannedTopics.add(topicId);

        if (this.history.isTopicViewed(topicId)) {
          this.markAsViewed(row);
          continue;
        }

        // 未读徽章判定（dosss 同款：.badge.badge-notification.new-topic）
        const unread = !!row.querySelector('.badge.badge-notification.new-topic');
        candidates.push({ row, titleLink, topicId, unread });
      }

      if (candidates.length === 0) return false;

      // 未读优先、同级随机：先乱序，再按未读做稳定排序（同未读状态保持乱序后的随机次序）
      for (let i = candidates.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
      }
      candidates.sort((a, b) => Number(b.unread) - Number(a.unread));

      const pick = candidates[0];
      pick.titleLink.scrollIntoView({ behavior: 'auto', block: 'center' });
      await randomDelay(300, 600);

      log(`进入话题: ${pick.topicId}${pick.unread ? '（未读）' : ''}`);
      // 记住来源列表页（分区页或全站列表），话题页读完返回时跳回这里
      Storage.set('session_return_path', window.location.pathname);
      // 直接改 location 强制当前页跳转（不点击链接，因此无需理会其 target 属性）
      window.location.href = pick.titleLink.href;
      return true;
    }

    markAsViewed(row) {
      if (!row.classList.contains('auto-viewed')) {
        row.classList.add('auto-viewed');
        row.style.opacity = '0.6';
        const badge = document.createElement('span');
        badge.textContent = '✓';
        badge.style.cssText = 'color: #4CAF50; margin-left: 5px; font-weight: bold;';
        badge.className = 'viewed-badge';
        const title = row.querySelector('.title, .link-top-line');
        if (title && !title.querySelector('.viewed-badge')) {
          title.appendChild(badge);
        }
      }
    }

    // 当前浏览目标扫完且无新内容：换下一个目标（已选分区间轮换，或未读→新帖→最新），全部扫过即本轮结束
    async switchToAnotherList() {
      // 目标达成时不再换列表（dosss 式：换分区前先查目标）
      if (!this.history.canContinue()) {
        log('全部目标达成，本轮结束');
        this.stop();
        this.onFinished?.('全部目标达成');
        return;
      }
      const targets = getBrowseTargets();
      const next = targets.find(t => !this.scannedLists.has(t.key));
      if (!next) {
        log('所有浏览目标已浏览完，本轮结束');
        this.stop();
        this.onFinished?.('列表已尽');
        return;
      }
      this.scannedLists.add(next.key);
      // 跳转前落盘：目的页脚本重新注入后靠 epoch 恢复集合，继续轮换
      Storage.set('session_scanned_lists', [...this.scannedLists]);
      Storage.set('session_scanned_lists_epoch', this.history.sessionEpoch);
      log(`切换到列表: ${next.name}`);
      await randomDelay(1000, 2000);
      window.location.href = next.path;
    }
  }

  // ==================== 主控制器 ====================

  class LinuxDoAutomation {
    constructor() {
      this.history = new BrowsingHistory();
      this.topicBrowser = null;
      this.listBrowser = null;
      this.isEnabled = false;
      this.panel = null;
      this.lastActivityTime = Date.now();
      this.stuckCheckInterval = null;
      this.stuckTimeout = 30000;
      this.lastUrl = window.location.href;
      this.urlCheckInterval = null;
      this.schedTimer = null;
    }

    // 附带防多开心跳记录
    heartbeat() {
      this.lastActivityTime = Date.now();
      if (this.isEnabled) {
        Storage.set('linuxdo_active_tab_id', TAB_ID);
        Storage.set('linuxdo_active_tab_time', this.lastActivityTime);
      }
    }

    checkStuck() {
      if (!this.isEnabled) return;
      // 单次时长上限：跑满设定分钟数就收工（0=不限）
      if (maxMinutes > 0) {
        const elapsedMin = (Date.now() - this.startTime) / 60000;
        if (elapsedMin >= maxMinutes) {
          log(`达到单次时长上限（${maxMinutes} 分钟），本轮结束`);
          this.finishRun('超时');
          return;
        }
      }
      const now = Date.now();
      const elapsed = now - this.lastActivityTime;

      if (elapsed > this.stuckTimeout) {
        log(`检测到卡住 (${Math.round(elapsed/1000)}秒无活动)，自动重启...`);
        this.restartBrowsing();
      }
    }

    // 根据页面类型创建对应浏览器并启动；非目标页则跳回列表
    async runBrowserFor(pageType) {
      const onUpdate = () => {
        this.updateStats();
        this.heartbeat();
      };
      if (pageType === 'topic') {
        this.topicBrowser = new TopicBrowser(this.history, onUpdate, (reason) => this.finishRun(reason));
        await this.topicBrowser.start();
      } else if (pageType === 'list') {
        // 分区模式下必须在所选分区页内找帖：当前页不是所选分区（如还停在 /latest）时，
        // 先跳到第一个所选分区页，否则会在全站列表里找帖，分区选择形同虚设
        if (isCategoryMode()) {
          const p = window.location.pathname;
          const onSelected = getBrowseTargets().some(t => p === t.path || p.startsWith(t.path + '/'));
          if (!onSelected) {
            window.location.href = getDefaultBrowsePath();
            return;
          }
        }
        this.listBrowser = new TopicListBrowser(this.history, onUpdate, (reason) => this.finishRun(reason));
        await this.listBrowser.start();
      } else {
        window.location.href = getDefaultBrowsePath();
      }
    }

    async restartBrowsing() {
      this.topicBrowser?.stop();
      this.listBrowser?.stop();
      this.heartbeat();

      try {
        await this.runBrowserFor(getPageType());
      } catch (error) {
        await randomDelay(3000, 5000);
        window.location.href = getDefaultBrowsePath();
      }
    }

    startStuckDetection() {
      if (this.stuckCheckInterval) clearInterval(this.stuckCheckInterval);
      this.heartbeat();
      this.stuckCheckInterval = setInterval(() => this.checkStuck(), 10000);
    }

    stopStuckDetection() {
      if (this.stuckCheckInterval) {
        clearInterval(this.stuckCheckInterval);
        this.stuckCheckInterval = null;
      }
    }

    startUrlWatcher() {
      if (this.urlCheckInterval) clearInterval(this.urlCheckInterval);
      this.lastUrl = window.location.href;
      this.urlCheckInterval = setInterval(() => this.checkUrlChange(), 500);
    }

    stopUrlWatcher() {
      if (this.urlCheckInterval) {
        clearInterval(this.urlCheckInterval);
        this.urlCheckInterval = null;
      }
    }

    checkUrlChange() {
      const currentUrl = window.location.href;
      if (currentUrl !== this.lastUrl) {
        const oldPageType = this.getPageTypeFromUrl(this.lastUrl);
        const newPageType = getPageType();
        this.lastUrl = currentUrl;

        const pageTypeEl = document.getElementById('page-type');
        if (pageTypeEl) pageTypeEl.textContent = newPageType;

        if (this.isEnabled && oldPageType !== newPageType) {
          this.handlePageTypeChange(newPageType);
        }
      }
    }

    getPageTypeFromUrl(url) {
      try {
        return getPageTypeFromPath(new URL(url).pathname);
      } catch (e) {
        return 'other';
      }
    }

    async handlePageTypeChange(newPageType) {
      this.topicBrowser?.stop();
      this.listBrowser?.stop();
      await randomDelay(1000, 1500);
      this.heartbeat();

      try {
        await this.runBrowserFor(newPageType);
      } catch (error) {
        await randomDelay(2000, 3000);
        this.restartBrowsing();
      }
    }

    init() {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => this.setup());
      } else {
        this.setup();
      }
    }

    setup(retryCount = 0) {
      const loginState = getLoginState();

      // 无法判定登录状态（Ember 未渲染完成或 Cloudflare 挑战页）：轮询等待，最多 10 秒
      // 挑战页通过后会整页跳转、脚本重新注入，因此超时放弃是安全的
      if (loginState === null) {
        if (retryCount < 20) {
          setTimeout(() => this.setup(retryCount + 1), 500);
        } else {
          log('无法检测登录状态，跳过初始化');
        }
        return;
      }

      if (loginState === false) {
        log('请先登录 Linux.do');
        return;
      }

      this.createControlPanel();
      readingTracker.onUpdate = () => this.updateStats();
      // 面板就绪后启动每日定时检查（stopScheduler 里清理，重建面板不会重复开）
      this.startScheduler();

      // 展示上次自动结束的原因（手动停止不记录，重启脚本后仍在）
      const lastFinishReason = Storage.get('auto_finish_reason', '');
      if (lastFinishReason) {
        document.getElementById('auto-status').textContent = `上次结束：${lastFinishReason}`;
      }

      const autoResume = Storage.get('auto_running', false);

      if (autoResume) {
        // --- 核心修复：防止多开无限自启动 ---
        const lastActiveTime = Storage.get('linuxdo_active_tab_time', 0);
        const activeTabId = Storage.get('linuxdo_active_tab_id', null);

        // 如果在15秒内有其他标签页活动，且不是当前标签页，放弃自启
        if (Date.now() - lastActiveTime < 15000 && activeTabId !== TAB_ID) {
            log('🚫 检测到其他标签页正在运行自动浏览，当前页面取消自动恢复');
            this.updateStats();
            document.getElementById('auto-status').textContent = '多开限制，未自启';
            return;
        }

        log('检测到自动运行状态，恢复运行...');
        // 立即把按钮翻到「停止」态，避免整页跳转后按钮长时间停在「开始」
        document.getElementById('btn-auto-start').style.display = 'none';
        document.getElementById('btn-auto-stop').style.display = 'block';
        document.getElementById('auto-status').textContent = '恢复中...';
        document.getElementById('status-dot').className = 'status-indicator running';
        setTimeout(() => {
          this.start();
        }, 800);
      }

      // 手动打开话题页也计入浏览计数：TopicBrowser 只在自动运行时才标记，
      // 用户自己点开的话题页不经过它，这里补记（自动时 TopicBrowser 的重复调用
      // 会被 sessionSeenTopics 会话去重吞掉，不会双计）
      if (getPageType() === 'topic') {
        const currentTopicId = getCurrentTopicId();
        if (currentTopicId) {
          this.history.markTopicViewed(currentTopicId);
        }
        // 手动点赞也计入计数：监听页面内帖子反应状态的实时变化
        this.watchManualLikes();
      }
      this.updateStats();
    }

    createControlPanel() {
      const style = document.createElement('style');
      style.textContent = `
        #linuxdo-auto-panel {
          position: fixed; right: 20px; bottom: 20px; z-index: 99999;
          width: 500px; max-width: calc(100vw - 40px); box-sizing: border-box;
          background: linear-gradient(160deg, #6d5bf0 0%, #7c4ddb 55%, #8b5cf6 100%);
          border: 1px solid rgba(255,255,255,0.14); border-radius: 16px;
          box-shadow: 0 12px 32px rgba(60,25,120,0.32), 0 2px 8px rgba(0,0,0,0.14);
          color: #fff; font-size: 13px; line-height: 1.4;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
          user-select: none; -webkit-user-select: none;
          /* 尺寸是瞬变的，圆角必须跟着瞬变：否则 50% 圆角会短暂作用在展开后的矩形上，闪出一个大椭圆 */
          transition: box-shadow .2s ease;
        }
        #linuxdo-auto-panel.dragging { box-shadow: 0 18px 44px rgba(60,25,120,0.45); }
        /* Discourse 全局样式会命中 svg 与盒模型，这里用 id 特异性顶回去 */
        #linuxdo-auto-panel, #linuxdo-auto-panel * { box-sizing: border-box; }
        #linuxdo-auto-panel svg { display: block; fill: none; stroke: currentColor; }

        /* 收起态：只留一个悬浮球 */
        #linuxdo-auto-panel.minimized { width: 56px; height: 56px; border-radius: 50%; }
        #linuxdo-auto-panel.minimized .panel-content,
        #linuxdo-auto-panel.minimized .panel-title,
        #linuxdo-auto-panel.minimized .btn-minimize { display: none; }
        #linuxdo-auto-panel.minimized .panel-header { width: 100%; height: 100%; padding: 0; justify-content: center; cursor: pointer; }
        #linuxdo-auto-panel.minimized .fab-icon { display: flex; }
        #linuxdo-auto-panel.minimized:hover { box-shadow: 0 12px 30px rgba(60,25,120,0.5); }
        /* 悬浮球上的运行指示：绿点 + 呼吸光环 */
        #linuxdo-auto-panel.minimized.running::before {
          content: ''; position: absolute; top: 3px; right: 3px; width: 10px; height: 10px;
          border-radius: 50%; background: #22c55e; border: 2px solid rgba(255,255,255,0.92);
          pointer-events: none;
        }
        #linuxdo-auto-panel.minimized.running::after {
          content: ''; position: absolute; inset: -3px; border-radius: 50%;
          border: 2px solid rgba(74,222,128,0.7); animation: fab-pulse 1.8s ease-out infinite;
          pointer-events: none;
        }
        @keyframes fab-pulse {
          0% { transform: scale(1); opacity: .8; }
          100% { transform: scale(1.35); opacity: 0; }
        }

        /* 标题栏同时是拖动手柄 */
        #linuxdo-auto-panel .panel-header {
          display: flex; align-items: center; gap: 8px; padding: 12px 12px 8px 14px;
          cursor: grab; touch-action: none;
        }
        #linuxdo-auto-panel.dragging .panel-header { cursor: grabbing; }
        #linuxdo-auto-panel .panel-title { flex: 1; font-size: 14px; font-weight: 600; letter-spacing: .2px; }
        #linuxdo-auto-panel .fab-icon { display: none; align-items: center; justify-content: center; }
        #linuxdo-auto-panel .btn-minimize {
          display: flex; align-items: center; justify-content: center; flex: none;
          width: 22px; height: 22px; padding: 0; border: 0; border-radius: 7px;
          background: rgba(255,255,255,0.16); color: #fff; cursor: pointer; transition: background .15s;
        }
        #linuxdo-auto-panel .btn-minimize:hover { background: rgba(255,255,255,0.3); }

        #linuxdo-auto-panel .panel-content { padding: 0 14px 14px; animation: panel-in .18s ease; }
        #linuxdo-auto-panel.closing .panel-content { animation: panel-out .16s ease forwards; }
        @keyframes panel-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
        @keyframes panel-out { from { opacity: 1; transform: none; } to { opacity: 0; transform: translateY(-4px); } }

        /* 分段选择器 */
        #linuxdo-auto-panel .row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
        #linuxdo-auto-panel .row.hidden { display: none; }
        #linuxdo-auto-panel .row-label { flex: none; width: 28px; font-size: 12px; color: rgba(255,255,255,0.72); }
        #linuxdo-auto-panel .seg { display: flex; flex: 1; gap: 2px; padding: 2px; background: rgba(0,0,0,0.16); border-radius: 9px; }
        #linuxdo-auto-panel .speed-btn {
          flex: 1 1 0; padding: 5px 0; border: 0; border-radius: 7px; background: transparent;
          color: rgba(255,255,255,0.78); font-size: 11px; font-family: inherit; cursor: pointer;
          transition: background .15s, color .15s;
        }
        #linuxdo-auto-panel .speed-btn:hover { background: rgba(255,255,255,0.14); color: #fff; }
        #linuxdo-auto-panel .speed-btn.active { background: #fff; color: #5b3bc4; font-weight: 600; box-shadow: 0 1px 3px rgba(0,0,0,0.18); }

        /* 楼层限制：数字输入框 + 勾选框 */
        #linuxdo-auto-panel .floor-input {
          flex: 1; min-width: 0; height: 27px; padding: 0 8px;
          border: 1px solid rgba(255,255,255,0.24); border-radius: 8px;
          background: rgba(0,0,0,0.16); color: #fff;
          font-size: 12px; font-family: inherit; text-align: center;
          /* 面板整体禁选，输入框要单独放开才能编辑 */
          user-select: text; -webkit-user-select: text;
        }
        #linuxdo-auto-panel .floor-input::placeholder { color: rgba(255,255,255,0.5); }
        #linuxdo-auto-panel .floor-input:focus {
          outline: none; border-color: rgba(255,255,255,0.62); background: rgba(0,0,0,0.24);
        }
        /* 数字框自带的步进箭头在窄面板里挤版，隐掉 */
        #linuxdo-auto-panel .floor-input::-webkit-inner-spin-button,
        #linuxdo-auto-panel .floor-input::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
        #linuxdo-auto-panel .floor-check {
          display: flex; align-items: center; gap: 6px; flex: 1;
          font-size: 11px; color: rgba(255,255,255,0.76); cursor: pointer;
        }
        /* 与楼层输入同排的紧凑版勾选（只计未读） */
        #linuxdo-auto-panel .floor-check-inline { flex: none; margin-left: 6px; }
        #linuxdo-auto-panel .floor-check input {
          width: 13px; height: 13px; margin: 0; flex: none;
          accent-color: #fff; cursor: pointer;
        }
        /* 控件下方的说明文字，左边距对齐控件（标签 28px + 间距 10px） */
        #linuxdo-auto-panel .row-hint {
          margin: -4px 0 8px 38px; font-size: 10px; line-height: 1.5;
          color: rgba(255,255,255,0.58);
        }
        /* 定时时间输入：与分段选择器同排，固定窄宽 */
        #linuxdo-auto-panel .sched-time { flex: none; width: 92px; }
        /* 原生时间控件会挤一个时钟小图标，把「09:00」文字挤没（显示不全的根因）：去掉图标并收紧内部留白 */
        #linuxdo-auto-panel input[type="time"]::-webkit-calendar-picker-indicator { display: none; -webkit-appearance: none; }
        #linuxdo-auto-panel input[type="time"]::-webkit-datetime-edit { padding: 0; }
        /* Firefox 数字框自带步进箭头，隐掉保持与 Chrome 一致 */
        #linuxdo-auto-panel .floor-input { -moz-appearance: textfield; }
        /* 目标数字输入：两个并排平分 */
        #linuxdo-auto-panel .target-input { flex: 1 1 0; min-width: 0; }

        /* 双列布局：设置项两列排布，说明文字横跨整行 */
        #linuxdo-auto-panel .settings-grid { display: grid; grid-template-columns: 1fr 1fr; column-gap: 14px; }
        #linuxdo-auto-panel .settings-grid .row-hint { grid-column: 1 / -1; }
        #linuxdo-auto-panel .settings-grid .row { min-width: 0; }
        /* 目标行内容多（3 个输入+说明），占满整行 */
        #linuxdo-auto-panel .settings-grid .row-goal { grid-column: 1 / -1; }
        /* 输入框旁边的文字说明（浏览帖数/点赞数/时长上限） */
        #linuxdo-auto-panel .goal-unit { flex: none; font-size: 11px; color: rgba(255,255,255,0.68); margin: 0 8px 0 2px; white-space: nowrap; }

        /* 高级设置面板：同样两列，边框与上文分隔 */
        #linuxdo-auto-panel .adv-box {
          display: grid; grid-template-columns: 1fr 1fr; column-gap: 14px;
          border-top: 1px solid rgba(255,255,255,0.14); margin: 2px 0 6px; padding-top: 6px;
        }
        #linuxdo-auto-panel .adv-box .row-hint { grid-column: 1 / -1; }
        /* 高级设置的 4 字标签放不进 28px 标签列（会被截断），改成「标签在上、输入框在下」的卡片式 */
        #linuxdo-auto-panel .adv-box .row { flex-direction: column; align-items: stretch; gap: 3px; margin-bottom: 7px; }
        #linuxdo-auto-panel .adv-box .row-label { width: auto; font-size: 11px; color: rgba(255,255,255,0.68); }
        #linuxdo-auto-panel .adv-box .floor-input { text-align: left; }
        #linuxdo-auto-panel .btn-advanced {
          border: 1px solid rgba(255,255,255,0.3); background: rgba(255,255,255,0.1); color: #fff;
        }
        /* 面板内容超高时内部滚动，避免整块超出屏幕显示不全 */
        #linuxdo-auto-panel .panel-content { max-height: 74vh; overflow-y: auto; }
        #linuxdo-auto-panel .panel-content::-webkit-scrollbar { width: 6px; }
        #linuxdo-auto-panel .panel-content::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.25); border-radius: 3px; }

        /* 动作按钮 */
        #linuxdo-auto-panel .action-btn {
          width: 100%; margin-top: 8px; padding: 9px; border: 0; border-radius: 10px;
          font-size: 13px; font-weight: 600; font-family: inherit; cursor: pointer; transition: filter .15s, background .15s;
        }
        #linuxdo-auto-panel .action-btn:hover { filter: brightness(1.08); }
        #linuxdo-auto-panel .btn-start { background: #22c55e; color: #fff; box-shadow: 0 2px 10px rgba(34,197,94,0.32); }
        #linuxdo-auto-panel .btn-stop { background: #ef4444; color: #fff; box-shadow: 0 2px 10px rgba(239,68,68,0.32); }
        #linuxdo-auto-panel .btn-clear {
          padding: 7px; background: transparent; border: 1px solid rgba(255,255,255,0.26);
          color: rgba(255,255,255,0.82); font-size: 12px; font-weight: 500;
        }
        #linuxdo-auto-panel .btn-clear:hover { background: rgba(255,255,255,0.12); }

        /* 统计区 */
        #linuxdo-auto-panel .stats { margin-top: 10px; padding: 9px 12px; background: rgba(0,0,0,0.14); border-radius: 10px; }
        #linuxdo-auto-panel .stats-row { display: flex; justify-content: space-between; align-items: center; margin: 4px 0; font-size: 12px; }
        #linuxdo-auto-panel .stats-label { color: rgba(255,255,255,0.68); }
        #linuxdo-auto-panel .stats-value { font-weight: 600; font-variant-numeric: tabular-nums; }
        #linuxdo-auto-panel .status-indicator { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
        #linuxdo-auto-panel .status-indicator.running { background: #22c55e; animation: pulse 1.5s infinite; }
        #linuxdo-auto-panel .status-indicator.stopped { background: #f87171; }

        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        .auto-viewed { opacity: 0.6; }

        /* 半透明信息浮窗：面板统计区的镜像，显示在页面左上角（可拖动） */
        #linuxdo-stats-float {
          position: fixed; top: 10px; left: 10px; z-index: 2147483647;
          display: flex; flex-direction: column; gap: 4px;
          padding: 10px 14px; min-width: 170px;
          background: rgba(16, 12, 34, 0.30);
          border: 1px solid rgba(255,255,255,0.14);
          border-radius: 12px;
          box-shadow: 0 4px 14px rgba(0,0,0,0.16);
          backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
          font-size: 12px; line-height: 1.6; color: #fff;
          cursor: grab; touch-action: none;
          user-select: none; -webkit-user-select: none;
        }
        #linuxdo-stats-float.dragging { cursor: grabbing; }
        #linuxdo-stats-float.hidden { display: none; }
        #linuxdo-stats-float .stats-row { display: flex; justify-content: space-between; align-items: center; margin: 0; white-space: nowrap; }
        #linuxdo-stats-float .stats-label { color: rgba(255,255,255,0.6); margin-right: 14px; }
        #linuxdo-stats-float .stats-value { font-weight: 600; font-variant-numeric: tabular-nums; }
        #linuxdo-stats-float .status-indicator { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
        #linuxdo-stats-float .status-indicator.running { background: #22c55e; animation: float-pulse 1.5s infinite; }
        #linuxdo-stats-float .status-indicator.stopped { background: #f87171; }
        @keyframes float-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

        /* 分区行 */
        #linuxdo-auto-panel .cat-btn { flex: none; width: auto; padding: 5px 12px; }
        #linuxdo-auto-panel .cat-summary { flex: 1; min-width: 0; font-size: 11px; color: rgba(255,255,255,0.72); margin-left: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

        /* 分区选择弹窗（独立覆盖层，不在面板内） */
        #linuxdo-cat-overlay {
          position: fixed; inset: 0; z-index: 2147483646;
          display: flex; align-items: center; justify-content: center;
          background: rgba(8, 6, 20, 0.55);
        }
        #linuxdo-cat-overlay.hidden { display: none; }
        #linuxdo-cat-modal {
          width: min(560px, calc(100vw - 40px)); max-height: 80vh;
          display: flex; flex-direction: column;
          padding: 16px 18px; border-radius: 14px;
          background: #fff; color: #1f2937;
          box-shadow: 0 12px 40px rgba(0,0,0,0.35);
          font-size: 13px; line-height: 1.5;
          user-select: text; -webkit-user-select: text;
        }
        #linuxdo-cat-modal .cat-modal-title { font-size: 15px; font-weight: 700; display: flex; justify-content: space-between; align-items: center; }
        #linuxdo-cat-modal .cat-close { cursor: pointer; border: 0; background: none; font-size: 16px; color: #9ca3af; line-height: 1; padding: 2px 4px; }
        #linuxdo-cat-modal .cat-close:hover { color: #374151; }
        #linuxdo-cat-modal .cat-modal-hint { margin-top: 6px; font-size: 12px; color: #6b7280; }
        #linuxdo-cat-modal .cat-all { display: flex; align-items: center; gap: 6px; margin-top: 12px; padding: 8px 10px; border-radius: 8px; background: #f3f4f6; font-weight: 600; cursor: pointer; }
        #linuxdo-cat-modal .cat-all input { width: 15px; height: 15px; accent-color: #5b3bc4; cursor: pointer; }
        #linuxdo-cat-modal .cat-grid {
          margin-top: 10px; overflow-y: auto; display: grid; grid-template-columns: 1fr 1fr; gap: 4px 10px;
          padding-right: 6px; max-height: 42vh;
        }
        #linuxdo-cat-modal .cat-grid::-webkit-scrollbar { width: 6px; }
        #linuxdo-cat-modal .cat-grid::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 3px; }
        #linuxdo-cat-modal .cat-item { display: flex; align-items: center; gap: 7px; padding: 5px 6px; border-radius: 6px; cursor: pointer; font-size: 12px; }
        #linuxdo-cat-modal .cat-item:hover { background: #f3f4f6; }
        #linuxdo-cat-modal .cat-item input { width: 14px; height: 14px; accent-color: #5b3bc4; cursor: pointer; }
        #linuxdo-cat-modal .cat-item.disabled { opacity: 0.5; pointer-events: none; }
        #linuxdo-cat-modal .cat-item .cat-count { margin-left: auto; font-size: 10px; color: #9ca3af; }
        #linuxdo-cat-modal .cat-modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
        #linuxdo-cat-modal .cat-modal-actions button {
          padding: 7px 18px; border: 0; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; font-family: inherit;
        }
        #linuxdo-cat-modal .btn-cat-save { background: #5b3bc4; color: #fff; }
        #linuxdo-cat-modal .btn-cat-save:hover { filter: brightness(1.1); }
        #linuxdo-cat-modal .btn-cat-cancel { background: #f3f4f6; color: #374151; }
        #linuxdo-cat-modal .btn-cat-cancel:hover { background: #e5e7eb; }
      `;
      document.head.appendChild(style);

      const panel = document.createElement('div');
      panel.id = 'linuxdo-auto-panel';
      panel.innerHTML = `
        <div class="panel-header">
          <span class="fab-icon">
            <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 7v14"/>
              <path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>
            </svg>
          </span>
          <span class="panel-title">Linux.do 自动助手</span>
          <button class="btn-minimize" id="btn-minimize" title="收起">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M5 12h14"/></svg>
          </button>
        </div>
        <div class="panel-content">
          <div class="settings-grid">
            <div class="row"><span class="row-label">速度</span><div class="seg">
              <button class="speed-btn ${currentSpeed==='slow'?'active':''}" data-speed="slow">慢</button>
              <button class="speed-btn ${currentSpeed==='normal'?'active':''}" data-speed="normal">正常</button>
              <button class="speed-btn ${currentSpeed==='fast'?'active':''}" data-speed="fast">快</button>
              <button class="speed-btn ${currentSpeed==='turbo'?'active':''}" data-speed="turbo">极速</button>
            </div></div>
            <div class="row"><span class="row-label">分区</span>
              <button class="speed-btn cat-btn" id="btn-cat-picker" title="弹窗选择只浏览哪些分区，内容较多故不在面板里显示">选分区…</button>
              <span class="cat-summary" id="cat-summary"></span>
            </div>
            <div class="row-hint">勾选分区后只轮换浏览所选分区；不限分区 = 按未读/新帖/最新全站轮换</div>
            <div class="row"><span class="row-label">点赞</span><div class="seg">
              <button class="speed-btn like-btn ${enableLike?'active':''}" data-like="true">开启</button>
              <button class="speed-btn like-btn ${!enableLike?'active':''}" data-like="false">关闭</button>
            </div>
              <label class="floor-check floor-check-inline" title="只给楼主帖（话题首帖）点赞，不给回复楼层点赞">
                <input type="checkbox" id="like-main-only">只赞主帖
              </label>
            </div>
            <div class="row${enableLike?'':' hidden'}" id="like-chance-row"><span class="row-label">概率</span><div class="seg">
              <button class="speed-btn chance-btn ${currentLikeChance==='low'?'active':''}" data-chance="low" title="约 5% 概率点赞">低</button>
              <button class="speed-btn chance-btn ${currentLikeChance==='medium'?'active':''}" data-chance="medium" title="约 15% 概率点赞">中</button>
              <button class="speed-btn chance-btn ${currentLikeChance==='high'?'active':''}" data-chance="high" title="约 25% 概率点赞">高</button>
              <button class="speed-btn chance-btn ${currentLikeChance==='veryHigh'?'active':''}" data-chance="veryHigh" title="约 40% 概率点赞">极高</button>
            </div></div>
            <div class="row"><span class="row-label">楼层</span>
              <input type="number" class="floor-input" id="floor-limit-input" min="0" step="1"
                placeholder="不限" title="每帖只浏览前 N 楼后换下一帖，留空或 0 表示不限">
              <label class="floor-check floor-check-inline" title="开启后已读楼层滚过不计数，只数上次阅读位置之后的新楼层">
                <input type="checkbox" id="floor-unread-only">只计未读
              </label>
            </div>
            <div class="row-hint">填 N 则每帖读到第 N 楼就换下一帖，留空或 0 表示整帖读完；勾选只计未读则不重复数已读楼层</div>
            <div class="row"><span class="row-label">定时</span><div class="seg">
              <button class="speed-btn sched-btn ${scheduleEnabled?'active':''}" data-sched="true">开启</button>
              <button class="speed-btn sched-btn ${!scheduleEnabled?'active':''}" data-sched="false">关闭</button>
            </div>
              <input type="time" class="floor-input sched-time" id="sched-time-input" step="60"
                title="每天到这个时间自动开始新一轮浏览；修改时间即自动开启定时">
            </div>
            <div class="row row-goal"><span class="row-label">目标</span>
              <input type="number" class="floor-input target-input" id="target-topics-input" min="0" step="1"
                placeholder="0" title="本轮浏览满 N 帖自动停止，0 表示不限">
              <span class="goal-unit">浏览帖数</span>
              <input type="number" class="floor-input target-input" id="target-likes-input" min="0" step="1"
                placeholder="0" title="本轮点满 N 个赞自动停止，0 表示不限">
              <span class="goal-unit">点赞数</span>
              <input type="number" class="floor-input target-input" id="max-minutes-input" min="0" step="1"
                placeholder="0" title="本轮最多运行 N 分钟自动停止，0 表示不限">
              <span class="goal-unit">时长上限(分)</span>
            </div>
            <div class="row-hint">目标按「刷帖数」计（浏览的话题个数），翻楼/阅读楼层不计入；浏览与点赞都达标才自动停止（0 为不限），超时也会自动停</div>
            <div class="row"><span class="row-label">浮窗</span>
              <label class="floor-check" title="面板内不再显示统计信息；勾选后改为页面左上角半透明浮窗实时显示（可拖动到任意位置），取消勾选则任何位置都不显示统计信息">
                <input type="checkbox" id="floating-stats">半透明信息浮窗
              </label>
            </div>
          </div>
          <button class="action-btn btn-advanced" id="btn-advanced">⚙ 高级设置</button>
          <div class="adv-box hidden" id="adv-box">
            <div class="row"><span class="row-label">翻页步长</span><input type="number" class="floor-input adv-input" id="adv-scroll-step" min="200" max="1000" step="50" placeholder="跟随速度(px)"></div>
            <div class="row"><span class="row-label">翻页间隔</span><input type="number" class="floor-input adv-input" id="adv-scroll-interval" min="300" max="5000" step="100" placeholder="跟随速度(ms)"></div>
            <div class="row"><span class="row-label">加载等待</span><input type="number" class="floor-input adv-input" id="adv-load-wait" min="500" max="8000" step="100" placeholder="跟随速度(ms)"></div>
            <div class="row"><span class="row-label">最短阅读</span><input type="number" class="floor-input adv-input" id="adv-min-read" min="0" max="5000" step="100" placeholder="跟随速度(ms)"></div>
            <div class="row"><span class="row-label">最长阅读</span><input type="number" class="floor-input adv-input" id="adv-max-read" min="0" max="8000" step="100" placeholder="跟随速度(ms)"></div>
            <div class="row"><span class="row-label">点赞概率</span><input type="number" class="floor-input adv-input" id="adv-like-chance" min="0" max="50" step="1" placeholder="跟随预设(%)"></div>
            <div class="row"><span class="row-label">点赞间隔</span><input type="number" class="floor-input adv-input" id="adv-like-interval" min="1000" max="15000" step="500" placeholder="默认2000(ms)"></div>
            <div class="row"><span class="row-label">返回延迟</span><input type="number" class="floor-input adv-input" id="adv-return-delay" min="0" max="8000" step="100" placeholder="默认1000(ms)"></div>
            <div class="row"><span class="row-label">滚动抖动</span><input type="number" class="floor-input adv-input" id="adv-scroll-jitter" min="0" max="300" step="10" placeholder="默认60(px)"></div>
            <div class="row-hint">留空或 0 = 跟随当前速度/概率预设；填数值立即生效并记忆，反检测随机性更强</div>
          </div>
          <button class="action-btn btn-start" id="btn-auto-start">开始自动浏览</button>
          <button class="action-btn btn-stop" id="btn-auto-stop" style="display:none;">停止运行</button>
          <button class="action-btn btn-clear" id="btn-clear-history">清除浏览记录</button>
          <div class="stats">
            <div class="stats-row"><span class="stats-label">状态</span><span class="stats-value"><span class="status-indicator stopped" id="status-dot"></span><span id="auto-status">未启动</span></span></div>
            <div class="stats-row"><span class="stats-label">页面类型</span><span class="stats-value" id="page-type">-</span></div>
            <div class="stats-row"><span class="stats-label">本次帖子/回复</span><span class="stats-value"><span id="session-viewed">0</span> / <span id="session-replies">0</span></span></div>
            <div class="stats-row"><span class="stats-label">本次点赞</span><span class="stats-value" id="session-liked">0</span></div>
            <div class="stats-row"><span class="stats-label">本次阅读楼层</span><span class="stats-value" id="session-read-count">0</span></div>
            <div class="stats-row"><span class="stats-label">目标进度</span><span class="stats-value" id="goal-progress">-</span></div>
            <div class="stats-row"><span class="stats-label">限时剩余</span><span class="stats-value" id="countdown-remain">-</span></div>
            <div class="stats-row"><span class="stats-label">当前时间</span><span class="stats-value" id="float-clock">-</span></div>
            <div class="stats-row"><span class="stats-label">每日定时</span><span class="stats-value" id="sched-status">-</span></div>
          </div>
        </div>
      `;
      document.body.appendChild(panel);
      this.panel = panel;

      // 默认收起成悬浮球，只在用户展开过后才记住展开态
      if (Storage.get('panel_minimized', true)) {
        panel.classList.add('minimized');
      }
      this.restorePosition();
      this.initDrag();

      document.getElementById('btn-auto-start').addEventListener('click', () => this.start(true));
      document.getElementById('btn-auto-stop').addEventListener('click', () => this.stop());
      document.getElementById('btn-minimize').addEventListener('click', () => this.toggleMinimize());
      document.getElementById('btn-clear-history').addEventListener('click', () => this.clearHistory());

      document.querySelectorAll('.speed-btn[data-speed]').forEach(btn => btn.addEventListener('click', (e) => {
        setSpeed(e.target.dataset.speed);
        document.querySelectorAll('.speed-btn[data-speed]').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
      }));
      document.querySelectorAll('.list-btn[data-list]').forEach(btn => btn.addEventListener('click', (e) => {
        setList(e.target.dataset.list);
        document.querySelectorAll('.list-btn[data-list]').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
      }));
      document.querySelectorAll('.like-btn[data-like]').forEach(btn => btn.addEventListener('click', (e) => {
        setEnableLike(e.target.dataset.like === 'true');
        document.querySelectorAll('.like-btn[data-like]').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
      }));
      document.querySelectorAll('.chance-btn[data-chance]').forEach(btn => btn.addEventListener('click', (e) => {
        setLikeChance(e.target.dataset.chance);
        document.querySelectorAll('.chance-btn[data-chance]').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
      }));

      const likeMainOnlyCheck = document.getElementById('like-main-only');
      likeMainOnlyCheck.checked = likeMainOnly;
      likeMainOnlyCheck.addEventListener('change', (e) => setLikeMainOnly(e.target.checked));

      const floorInput = document.getElementById('floor-limit-input');
      floorInput.value = floorLimit > 0 ? floorLimit : '';
      // Discourse 绑了一堆单键快捷键（j/k 翻楼等），输入框里的按键不能冒泡出去
      floorInput.addEventListener('keydown', (e) => e.stopPropagation());
      floorInput.addEventListener('change', (e) => {
        setFloorLimit(e.target.value);
        // 回写规范化后的值：负数、小数、非法输入统一显示成实际生效的值
        e.target.value = floorLimit > 0 ? floorLimit : '';
      });

      const floorCheck = document.getElementById('floor-unread-only');
      floorCheck.checked = floorLimitUnreadOnly;
      floorCheck.addEventListener('change', (e) => setFloorLimitUnreadOnly(e.target.checked));

      // 每日定时：开关分段 + 时间输入
      document.querySelectorAll('.sched-btn[data-sched]').forEach(btn => btn.addEventListener('click', (e) => {
        setSchedule(e.target.dataset.sched === 'true', document.getElementById('sched-time-input').value);
        document.querySelectorAll('.sched-btn[data-sched]').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        document.getElementById('sched-time-input').value = scheduleTime;
        this.updateSchedStatus();
      }));

      const schedTimeInput = document.getElementById('sched-time-input');
      schedTimeInput.value = scheduleTime;
      schedTimeInput.addEventListener('keydown', (e) => e.stopPropagation());
      schedTimeInput.addEventListener('change', (e) => {
        // 改时间即视为要启用定时：避免只改了时间却忘了点「开启」而到点不启动
        setSchedule(true, e.target.value);
        document.querySelectorAll('.sched-btn[data-sched="true"]').forEach(b => b.classList.add('active'));
        document.querySelectorAll('.sched-btn[data-sched="false"]').forEach(b => b.classList.remove('active'));
        e.target.value = scheduleTime;
        this.updateSchedStatus();
      });

      // 会话目标：浏览帖数 / 点赞数（0 = 不限，留空或输入 0 后显示空、露出 placeholder「0」）
      const bindTargetInput = (input, applyTargets, getTarget) => {
        input.addEventListener('keydown', (e) => e.stopPropagation());
        input.addEventListener('change', (e) => {
          applyTargets(e.target.value);
          // 与时长上限一致：目标为 0（不限）时清空输入框，露出灰色 placeholder「0」
          e.target.value = getTarget() > 0 ? String(getTarget()) : '';
          this.updateSchedStatus();
        });
      };
      const topicsInput = document.getElementById('target-topics-input');
      topicsInput.value = topicTarget > 0 ? String(topicTarget) : '';
      bindTargetInput(topicsInput, (v) => setTargets(v, likeTarget), () => topicTarget);
      const likesInput = document.getElementById('target-likes-input');
      likesInput.value = likeTarget > 0 ? String(likeTarget) : '';
      bindTargetInput(likesInput, (v) => setTargets(topicTarget, v), () => likeTarget);

      // 单次运行时长上限（分钟）
      const maxMinutesInput = document.getElementById('max-minutes-input');
      maxMinutesInput.value = maxMinutes > 0 ? maxMinutes : '';
      maxMinutesInput.addEventListener('keydown', (e) => e.stopPropagation());
      maxMinutesInput.addEventListener('change', (e) => {
        setMaxMinutes(e.target.value);
        e.target.value = maxMinutes > 0 ? maxMinutes : '';
      });

      // 高级设置面板：展开/收起 + 9 项数值输入（0/留空=跟随预设）
      const btnAdvanced = document.getElementById('btn-advanced');
      const advBox = document.getElementById('adv-box');
      btnAdvanced.addEventListener('click', () => {
        advBox.classList.toggle('hidden');
      });
      const ADV_FIELDS = [
        ['adv-scroll-step', 'adv_scroll_step'],
        ['adv-scroll-interval', 'adv_scroll_interval'],
        ['adv-load-wait', 'adv_load_wait'],
        ['adv-min-read', 'adv_min_read'],
        ['adv-max-read', 'adv_max_read'],
        ['adv-like-chance', 'adv_like_chance'],
        ['adv-like-interval', 'adv_like_interval'],
        ['adv-return-delay', 'adv_return_delay'],
        ['adv-scroll-jitter', 'adv_scroll_jitter'],
      ];
      ADV_FIELDS.forEach(([id, key]) => {
        const input = document.getElementById(id);
        const saved = Storage.get(key, 0);
        input.value = saved > 0 ? saved : '';
        input.addEventListener('keydown', (e) => e.stopPropagation());
        input.addEventListener('change', () => {
          setAdvanced(key, input.value);
          const n = Storage.get(key, 0);
          input.value = n > 0 ? input.value : '';
          log('高级设置已更新，下一轮浏览生效');
        });
      });

      // 半透明信息浮窗：面板统计区的镜像。开启时隐藏面板统计区、浮窗显示；
      // 统计内容用 MutationObserver 实时同步，任何函数改面板统计都会被镜像到浮窗
      const statsBlock = panel.querySelector('.stats');
      const floatBox = document.createElement('div');
      floatBox.id = 'linuxdo-stats-float';
      floatBox.classList.add('hidden');
      document.body.appendChild(floatBox);
      const syncFloat = () => { if (statsBlock) floatBox.innerHTML = statsBlock.innerHTML; };
      syncFloat();
      if (statsBlock) {
        new MutationObserver(syncFloat).observe(statsBlock, {
          childList: true, subtree: true, characterData: true, attributes: true
        });
      }
      // 面板内统计区永远不再显示（用户要求），统计信息只通过浮窗展示
      statsBlock.style.display = 'none';
      const applyStatsDisplay = () => {
        floatBox.classList.toggle('hidden', !floatingStats);
      };
      const floatingStatsCheck = document.getElementById('floating-stats');
      floatingStatsCheck.checked = floatingStats;
      floatingStatsCheck.addEventListener('change', (e) => {
        floatingStats = e.target.checked;
        Storage.set('floating_stats', floatingStats);
        applyStatsDisplay();
        log(floatingStats
          ? '已开启半透明信息浮窗（左上角，可拖动）'
          : '已关闭浮窗，统计信息不再显示');
      });
      applyStatsDisplay();

      // 浮窗可拖动：按住整个浮窗拖到任意位置，松手记住位置（限制在视口内）
      const floatPos = Storage.get('float_pos', null);
      if (floatPos && Number.isFinite(floatPos.left) && Number.isFinite(floatPos.top)) {
        floatBox.style.left = `${Math.round(floatPos.left)}px`;
        floatBox.style.top = `${Math.round(floatPos.top)}px`;
      }
      const clampFloat = () => {
        if (!floatBox.style.left) return; // 没拖过就保持默认位置
        const margin = 4;
        const rect = floatBox.getBoundingClientRect();
        const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
        const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
        floatBox.style.left = `${Math.round(Math.min(Math.max(rect.left, margin), maxLeft))}px`;
        floatBox.style.top = `${Math.round(Math.min(Math.max(rect.top, margin), maxTop))}px`;
      };
      window.addEventListener('resize', clampFloat);
      let floatPointerId = null, floatMoved = false;
      let floatStartX = 0, floatStartY = 0, floatOriginLeft = 0, floatOriginTop = 0;
      const onFloatMove = (e) => {
        if (e.pointerId !== floatPointerId) return;
        const dx = e.clientX - floatStartX;
        const dy = e.clientY - floatStartY;
        if (!floatMoved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
        floatMoved = true;
        floatBox.classList.add('dragging');
        floatBox.style.left = `${floatOriginLeft + dx}px`;
        floatBox.style.top = `${floatOriginTop + dy}px`;
      };
      const onFloatUp = (e) => {
        if (e.pointerId !== floatPointerId) return;
        try { floatBox.releasePointerCapture(floatPointerId); } catch (err) { /* 忽略 */ }
        floatPointerId = null;
        floatBox.classList.remove('dragging');
        window.removeEventListener('pointermove', onFloatMove);
        window.removeEventListener('pointerup', onFloatUp);
        window.removeEventListener('pointercancel', onFloatUp);
        if (floatMoved) {
          clampFloat();
          const rect = floatBox.getBoundingClientRect();
          Storage.set('float_pos', { left: rect.left, top: rect.top });
        }
      };
      floatBox.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || floatPointerId !== null) return;
        const rect = floatBox.getBoundingClientRect();
        floatOriginLeft = rect.left;
        floatOriginTop = rect.top;
        floatStartX = e.clientX;
        floatStartY = e.clientY;
        floatMoved = false;
        floatPointerId = e.pointerId;
        try { floatBox.setPointerCapture(floatPointerId); } catch (err) { /* 忽略 */ }
        window.addEventListener('pointermove', onFloatMove);
        window.addEventListener('pointerup', onFloatUp);
        window.addEventListener('pointercancel', onFloatUp);
      });

      document.getElementById('page-type').textContent = getPageType();

      // ==================== 浮窗走秒时钟 ====================
      // 限时剩余：>1h 显示 hh:mm:ss，否则 mm:ss；未设置时长显示“不限”
      const formatRemain = (ms) => {
        const totalSeconds = Math.max(0, Math.floor(ms / 1000));
        const h = Math.floor(totalSeconds / 3600);
        const m = Math.floor((totalSeconds % 3600) / 60);
        const s = totalSeconds % 60;
        const pad = (n) => String(n).padStart(2, '0');
        return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
      };
      const tickClock = () => {
        const remainEl = document.getElementById('countdown-remain');
        const clockEl = document.getElementById('float-clock');
        if (remainEl) {
          if (maxMinutes <= 0) {
            remainEl.textContent = '不限';
          } else if (this.isEnabled && this.startTime) {
            const remainMs = maxMinutes * 60000 - (Date.now() - this.startTime);
            remainEl.textContent = formatRemain(remainMs);
          } else {
            remainEl.textContent = formatRemain(maxMinutes * 60000);
          }
        }
        if (clockEl) {
          const now = new Date();
          const pad = (n) => String(n).padStart(2, '0');
          clockEl.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
        }
      };
      tickClock();
      // 每秒刷新：面板统计区虽然 display:none，MutationObserver 仍会把变化镜像到浮窗
      setInterval(tickClock, 1000);

      // ==================== 分区选择弹窗 ====================
      const catSummaryEl = document.getElementById('cat-summary');
      const renderCatSummary = () => {
        if (!catSummaryEl) return;
        catSummaryEl.textContent = isCategoryMode()
          ? `已选 ${selectedCategories.length} 个分区`
          : selectedCategories === 'all' ? '不限分区' : '默认分区';
      };
      renderCatSummary();
      document.getElementById('btn-cat-picker').addEventListener('click', () => this.openCategoryPicker(renderCatSummary));
    }

    // 分区选择弹窗：独立覆盖层窗口（不在面板内），列出全部板块供勾选，
    // 顶部「不限分区」= 全站轮换。保存结果写入 Storage('selected_categories'):
    // 'all' 或所选分区 url 数组，应用后通过 onChanged 刷新面板摘要
    openCategoryPicker(onChanged) {
      let overlay = document.getElementById('linuxdo-cat-overlay');
      const close = () => overlay.classList.add('hidden');
      const rebuild = () => {
        const allCheck = overlay.querySelector('.cat-all input');
        const items = [...overlay.querySelectorAll('.cat-item')];
        if (selectedCategories === 'all') {
          allCheck.checked = true;
          items.forEach(item => {
            item.classList.add('disabled');
            item.querySelector('input').checked = false;
          });
        } else {
          allCheck.checked = false;
          items.forEach(item => {
            item.classList.remove('disabled');
            const box = item.querySelector('input');
            box.checked = selectedCategories.includes(box.getAttribute('data-url'));
          });
        }
      };

      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'linuxdo-cat-overlay';
        overlay.classList.add('hidden');
        overlay.innerHTML = `
          <div class="cat-modal" id="linuxdo-cat-modal">
            <div class="cat-modal-title">选择浏览分区
              <button class="cat-close" id="cat-close" title="关闭">✕</button>
            </div>
            <div class="cat-modal-hint">勾选后只轮换浏览所选分区；不勾选任何分区则必须打开「不限分区」（= 按未读/新帖/最新全站轮换）。默认与 dosss 一致：前 12 个常用分区。</div>
            <label class="cat-all"><input type="checkbox" id="cat-all"> 不限分区（全站轮换）</label>
            <div class="cat-grid">
              ${CATEGORY_LIST.map(c => `
                <label class="cat-item"><input type="checkbox" data-url="${c.url}">
                  <span>${c.name}</span>
                </label>`).join('')}
            </div>
            <div class="cat-modal-actions">
              <button class="btn-cat-cancel" id="cat-cancel">取消</button>
              <button class="btn-cat-save" id="cat-save">保存</button>
            </div>
          </div>`;
        document.body.appendChild(overlay);

        overlay.querySelector('.cat-all input').addEventListener('change', (e) => {
          const items = [...overlay.querySelectorAll('.cat-item')];
          items.forEach(item => {
            item.classList.toggle('disabled', e.target.checked);
            if (e.target.checked) item.querySelector('input').checked = false;
          });
        });
        overlay.querySelector('#cat-close').addEventListener('click', close);
        overlay.querySelector('#cat-cancel').addEventListener('click', close);
        overlay.addEventListener('click', (e) => {
          if (e.target === overlay) close();
        });
        overlay.querySelector('#cat-save').addEventListener('click', () => {
          const allCheck = overlay.querySelector('.cat-all input');
          if (allCheck.checked) {
            selectedCategories = 'all';
            Storage.set('selected_categories', 'all');
          } else {
            const chosen = [...overlay.querySelectorAll('.cat-item input')]
              .filter(box => box.checked)
              .map(box => box.getAttribute('data-url'));
            if (chosen.length === 0) {
              alert('请至少勾选一个分区，或勾选「不限分区」');
              return;
            }
            selectedCategories = chosen;
            Storage.set('selected_categories', chosen);
          }
          Storage.set('session_scanned_lists', []); // 分区选择变更后重新按新集合轮换
          onChanged?.();
          log(selectedCategories === 'all'
            ? '浏览范围：不限分区（全站轮换）'
            : `浏览范围：${selectedCategories.length} 个分区`);
          close();
        });
      }
      rebuild();
      overlay.classList.remove('hidden');
    }

    // 拖动：手柄是标题栏（收起态下它就是整个悬浮球），松手后记住位置
    // 位移不超过阈值视为点击，收起态下即展开面板
    initDrag() {
      const panel = this.panel;
      const handle = panel.querySelector('.panel-header');
      const DRAG_THRESHOLD = 4;

      let pointerId = null;
      let startX = 0, startY = 0, originLeft = 0, originTop = 0, moved = false;

      const onMove = (e) => {
        if (e.pointerId !== pointerId) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (!moved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
        if (!moved) {
          moved = true;
          panel.classList.add('dragging');
        }
        this.setPosition(originLeft + dx, originTop + dy);
      };

      const onUp = (e) => {
        if (e.pointerId !== pointerId) return;
        try { handle.releasePointerCapture(pointerId); } catch (err) { /* 捕获可能已自动释放 */ }
        pointerId = null;
        panel.classList.remove('dragging');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);

        if (moved) {
          this.savePosition();
        } else if (panel.classList.contains('minimized')) {
          this.toggleMinimize();
        }
      };

      handle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || pointerId !== null) return;
        if (e.target.closest('button')) return; // 收起按钮走自己的 click

        const rect = panel.getBoundingClientRect();
        originLeft = rect.left;
        originTop = rect.top;
        startX = e.clientX;
        startY = e.clientY;
        moved = false;
        pointerId = e.pointerId;

        try { handle.setPointerCapture(e.pointerId); } catch (err) { /* 部分环境不支持指针捕获 */ }
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
        e.preventDefault();
      });

      window.addEventListener('resize', () => this.clampPosition());
    }

    // 改用视口左上角定位，并把面板钳制在可视范围内
    setPosition(left, top) {
      const panel = this.panel;
      const margin = 8;
      const maxLeft = Math.max(margin, window.innerWidth - panel.offsetWidth - margin);
      const maxTop = Math.max(margin, window.innerHeight - panel.offsetHeight - margin);
      panel.style.left = `${Math.round(Math.min(Math.max(left, margin), maxLeft))}px`;
      panel.style.top = `${Math.round(Math.min(Math.max(top, margin), maxTop))}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    }

    clampPosition() {
      if (!this.panel.style.left) return; // 没拖动过，保持默认右下角锚定
      const rect = this.panel.getBoundingClientRect();
      this.setPosition(rect.left, rect.top);
    }

    savePosition() {
      const rect = this.panel.getBoundingClientRect();
      Storage.set('panel_pos', {
        left: rect.left,
        top: rect.top,
        right: window.innerWidth - rect.right,
        alignRight: rect.left + rect.width / 2 > window.innerWidth / 2
      });
    }

    restorePosition() {
      const pos = Storage.get('panel_pos', null);
      if (!pos || !Number.isFinite(pos.top)) return;
      const left = pos.alignRight && Number.isFinite(pos.right)
        ? window.innerWidth - pos.right - this.panel.offsetWidth
        : pos.left;
      if (Number.isFinite(left)) this.setPosition(left, pos.top);
    }

    // 展开由 CSS 的 panel-in 负责淡入；收起要先把内容淡出再变回悬浮球，两边动画才对称
    toggleMinimize() {
      const panel = this.panel;
      if (panel.classList.contains('minimized')) {
        this.setMinimized(false);
        return;
      }
      if (panel.classList.contains('closing')) return;

      panel.classList.add('closing');
      const content = panel.querySelector('.panel-content');
      const done = () => {
        clearTimeout(timer);
        content.removeEventListener('animationend', done);
        // 先切成悬浮球把内容藏起来，再摘 closing，否则会闪一下入场动画
        this.setMinimized(true);
        panel.classList.remove('closing');
      };
      content.addEventListener('animationend', done);
      // 标签页切到后台时 animationend 不一定触发，兜底收尾
      const timer = setTimeout(done, 400);
    }

    setMinimized(minimized) {
      const panel = this.panel;
      const before = panel.getBoundingClientRect();
      // 面板在屏幕右半边时保持右边缘不动，展开才不会往视口外顶
      const keepRight = before.left + before.width / 2 > window.innerWidth / 2;

      panel.classList.toggle('minimized', minimized);
      Storage.set('panel_minimized', minimized);

      if (panel.style.left) {
        this.setPosition(keepRight ? before.right - panel.offsetWidth : before.left, before.top);
      } else if (panel.getBoundingClientRect().top < 0) {
        // 默认锚在右下角，视口太矮时展开会顶出屏幕，转为绝对定位兜底
        const rect = panel.getBoundingClientRect();
        this.setPosition(rect.left, 8);
      }
    }

    updateStats() {
      const stats = this.history.getStats();
      document.getElementById('session-viewed').textContent = stats.sessionViewed;
      document.getElementById('session-replies').textContent = stats.sessionReplies;
      document.getElementById('session-liked').textContent = stats.sessionLiked;
      document.getElementById('session-read-count').textContent = readingTracker.count;
      // 目标进度：刷帖数 = 浏览的话题个数（翻楼/阅读楼层不计入目标）
      const gp = document.getElementById('goal-progress');
      if (gp) {
        const t = topicTarget > 0 ? `${stats.sessionViewed}/${topicTarget} 帖` : `已刷 ${stats.sessionViewed} 帖`;
        const l = likeTarget > 0 ? `${stats.sessionLiked}/${likeTarget} 赞` : `已赞 ${stats.sessionLiked}`;
        gp.textContent = `${t} · ${l}`;
      }
      this.updateSchedStatus();
    }

    // 手动点赞也计入本次点赞数：用户自己点掉的赞（或取消后重赞）实时反映到会话计数。
    // 只监听 class 变化（已反应状态由 discourse-reactions 插件加在 .discourse-reactions-actions
    // 容器上，类名含 reacted），不扫初始状态——避免把历史已点赞的帖子误计为本会话新赞。
    // 机器人自动点赞走 tryLikePost 成功后 markPostLiked，天然去重，不会与这里重复计数。
    watchManualLikes() {
      if (typeof MutationObserver === 'undefined') return;
      this._manualLikeObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.type !== 'attributes' || mutation.attributeName !== 'class') continue;
          const target = mutation.target;
          if (!target || target.nodeType !== 1) continue;
          const cls = typeof target.className === 'string' ? target.className : '';
          if (!cls.includes('discourse-reactions-actions') || !/reacted/i.test(cls)) continue;
          const article = target.closest ? target.closest('article[id^="post_"]') : null;
          if (!article || !article.dataset || !article.dataset.postId) continue;
          const actualPostId = article.dataset.postId;
          if (this.history.isPostLiked(actualPostId)) continue;
          this.history.markPostLiked(actualPostId);
          log(`检测到手动点赞帖子 (id=${actualPostId})`);
        }
      });
      this._manualLikeObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ['class'],
        subtree: true
      });
    }

    async start(isManual = false, resetSessionFlag = false) {
      // 全部目标都为 0（浏览/点赞/时长全不限）= 无法判定的无限目标：禁止开始，强制至少设一个目标
      if (topicTarget <= 0 && likeTarget <= 0 && maxMinutes <= 0) {
        const msg = '请至少设置一个目标（浏览帖数/点赞数/时长上限任选其一），全部为 0 时无法开始本轮浏览';
        if (isManual) {
          alert(`⚠️ ${msg}`);
        } else {
          log(`跳过自动开始：${msg}`);
        }
        return;
      }

      // 手动开始或定时触发都视为新一轮会话：清零浏览/点赞/回复的会话计数与阅读量
      // （自动恢复运行时不清零，保证刷新/跳转后延续）
      if (isManual || resetSessionFlag) {
        this.history.resetSession();
        readingTracker.reset();
      }

      // 如果是手动启动，检查是否有其他正在运行的进程
      if (isManual) {
        const lastActiveTime = Storage.get('linuxdo_active_tab_time', 0);
        const activeTabId = Storage.get('linuxdo_active_tab_id', null);
        if (Date.now() - lastActiveTime < 15000 && activeTabId !== TAB_ID && Storage.get('auto_running', false)) {
            if (!confirm('⚠️ 警告：检测到后台已有其他页面正在自动浏览。\\n\\n如果在多页同时运行可能会导致浏览器卡死。强制接管此页码？')) {
                return;
            }
        }
      }

      this.isEnabled = true;
      Storage.set('auto_running', true);
      this.heartbeat();
      this.startTime = Date.now();

      document.getElementById('btn-auto-start').style.display = 'none';
      document.getElementById('btn-auto-stop').style.display = 'block';
      document.getElementById('auto-status').textContent = '运行中';
      document.getElementById('status-dot').className = 'status-indicator running';
      this.panel.classList.add('running');

      this.startStuckDetection();
      this.startUrlWatcher();

      try {
        await this.runBrowserFor(getPageType());
      } catch (error) {
        if (this.isEnabled) {
          document.getElementById('auto-status').textContent = '出错，重试中...';
          await randomDelay(5000, 8000);
          if (this.isEnabled) this.restartBrowsing();
        }
      }
    }

    stop() {
      this.isEnabled = false;
      Storage.set('auto_running', false);
      Storage.set('linuxdo_active_tab_time', 0); // 释放占用锁

      this.stopStuckDetection();
      this.stopUrlWatcher();
      this.topicBrowser?.stop();
      this.listBrowser?.stop();

      document.getElementById('btn-auto-start').style.display = 'block';
      document.getElementById('btn-auto-stop').style.display = 'none';
      document.getElementById('auto-status').textContent = '已停止';
      document.getElementById('status-dot').className = 'status-indicator stopped';
      this.panel.classList.remove('running');
    }

    // ==================== 每日定时 ====================

    // 启动定时轮询：每 30 秒检查一次是否到了设定时刻；已启动则跳过，防止重复 setInterval
    startScheduler() {
      if (this.schedTimer) return;
      this.schedTimer = setInterval(() => this.checkSchedule(), 30000);
      this.checkSchedule();
      log('每日定时检查已启动（每 30 秒一次）');
    }

    stopScheduler() {
      if (this.schedTimer) {
        clearInterval(this.schedTimer);
        this.schedTimer = null;
      }
    }

    todayKey() {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    // 到点自动开始新一轮浏览：同一天只触发一次；本页或其他标签页正在运行则跳过
    checkSchedule() {
      if (!scheduleEnabled) return;
      if (this.isEnabled) return;
      const today = this.todayKey();
      if (Storage.get('sched_last_run_date', '') === today) return;

      const now = new Date();
      const [hh, mm] = String(scheduleTime).split(':').map(Number);
      if (now.getHours() < hh || (now.getHours() === hh && now.getMinutes() < mm)) return;

      // 其他标签页可能在运行：交给那个页面自然收尾；心跳超过 15 秒视为已失效可接管
      if (Storage.get('auto_running', false) &&
          Date.now() - Storage.get('linuxdo_active_tab_time', 0) < 15000) return;

      Storage.set('sched_last_run_date', today);
      log(`⏰ 每日定时触发（${scheduleTime}），自动开始新一轮浏览`);
      this.start(false, true);
    }

    // 本轮结束的统一收尾点：彻底停止并记录结束原因，
    // 避免「只停列表浏览器但自动化仍运行」导致卡死检测 30 秒后反复重启空转
    finishRun(reason) {
      this.stop();
      this.history.flushPending();
      Storage.set('auto_finish_reason', reason);
      document.getElementById('auto-status').textContent = `已结束：${reason}`;
      log(`本轮结束：${reason}`);
    }

    // 面板上展示定时与目标配置的当前状态
    updateSchedStatus() {
      const el = document.getElementById('sched-status');
      if (!el) return;
      const remain = topicTarget > 0 ? topicTarget : '不限';
      const likes = likeTarget > 0 ? likeTarget : '不限';
      const minutes = maxMinutes > 0 ? `${maxMinutes} 分` : '不限';
      el.textContent = scheduleEnabled
        ? `${scheduleTime} 自动开始 · 目标 ${remain} 帖 / ${likes} 赞 / ${minutes}`
        : '每日定时关闭';
    }

    clearHistory() {
      if (confirm('确定要清除所有浏览记录吗？这将允许重新浏览所有话题。')) {
        this.history.clearHistory();
        this.updateStats();
        alert('浏览记录已清除');
      }
    }
  }

  // ==================== 启动 ====================
  installTimingsHook();
  const automation = new LinuxDoAutomation();
  automation.init();

  // 页面卸载时把节流未落盘的浏览记录 flush 掉，避免翻页时丢失最后几条记录
  // flushPending 只在确有待写数据时才写，路过/未登录页面不会触发，避免空数据覆盖历史
  // 注意：这里不再释放防多开锁——脚本自身翻页也会触发 beforeunload，会导致锁在每次
  // 跳转间隙被误释放；锁改为依赖 15 秒心跳超时自然失效，手动停止时由 stop() 主动释放
  window.addEventListener('beforeunload', () => {
    automation.history.flushPending();
  });

})();
