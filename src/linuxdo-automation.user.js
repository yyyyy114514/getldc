// ==UserScript==
// @name         Linux.do 自动浏览助手
// @namespace    https://linux.do/
// @version      2.7.4
// @description  自动浏览帖子、滚动查看所有回复、随机点赞、避免重复浏览、可限定每帖浏览楼层数、支持所选分区轮换、每日定时自动开始与浏览/点赞/时长目标与浮窗时钟；高级设置可调翻页/阅读/点赞速率与概率，内置反检测随机节奏与反指纹措施（不包装 fetch/XHR、点击式 SPA 导航、偏态人化延迟）；「人化随机」模式接管速度/定时/目标/高级设置，每天按普通人权重摇节奏·时段·目标·翻楼数、每帖重抽点赞概率与阅读/滚动节奏/中途离场/翻楼上限，点赞走页面真实按钮（含偶发犹豫，v2.7.3 修复点赞确认节点与限流冷却，点赞按今日目标自适应加成）；「调试模式」一键强制人化并立即开跑（跳过每日定时等待）；v2.7.4 修复并发互斥（世代令牌）/点赞时机与已读计数/跨午夜定时连环触发/多标签并发重摇/手动点赞重渲染误计
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
  // 【v2.7.4 修复 8be112f0 M2】非目标路径不再兜底 'latest'：若本页是列表页但路径不属于任何
  // 浏览目标（如 /top、/new 之外的定制视图），返回 null 让调用方跳过「本列表已扫」标记，
  // 否则 TopicListBrowser 一进 /top 就误标 latest 已扫，latest 在轮换里被跳过
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
    return null;
  }

  // 点赞开关
  let enableLike = true;
  // 只给主帖（楼主帖）点赞，不给回复楼层点赞
  let likeMainOnly = false;
  // 半透明信息浮窗：开启后面板不再显示统计信息，改为页面左上角半透明浮窗显示
  let floatingStats = false;

  // 【v2.7.0 人化随机模式】总开关：开启后速度/定时/目标不再用固定配置，
  // 改为每天按真人行为权重随机生成（见 ensureDailyProfile / speedValue / checkSchedule），
  // 模拟普通用户的长期行为分布。速度档位、定时时间、目标数值等原有设置全部保留作为基准，
  // 仅在本模式开启时被每日随机配置接管。点赞等所有操作均走页面真实按钮点击（见 clickLikeButton）。
  let humanMode = false;
  // 【v2.7.2 调试模式】会话内有效，不落盘：开启即强制人化 + 立即开始（跳过每日定时等待）
  let debugMode = false;
  // 调试开启前的人化开关状态：关闭调试时还原，避免 human_mode 被调试流程改掉后残留
  let debugPrevHumanMode = false;

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
    // 【v2.7.0 人化随机】人化模式下不用慢/中/快档位、无视高级设置数值，全部按
    // 今日节奏 τ × 每帖喜好参数生成（见 speedValue / refreshTopicParams）
    get scrollStep() {
      if (humanMode) return speedValue('scrollStep');            // 人化接管：τ×每帖
      return Storage.get('adv_scroll_step', 0) || speedValue('scrollStep');
    },
    get scrollInterval() {
      if (humanMode) return speedValue('scrollInterval');
      return Storage.get('adv_scroll_interval', 0) || speedValue('scrollInterval');
    },
    get loadWaitTime() {
      if (humanMode) return speedValue('loadWaitTime');
      return Storage.get('adv_load_wait', 0) || speedValue('loadWaitTime');
    },
    get minReadTime() {
      if (humanMode) return speedValue('minReadTime');
      return Storage.get('adv_min_read', 0) || speedValue('minReadTime');
    },
    get maxReadTime() {
      if (humanMode) return speedValue('maxReadTime');
      return Storage.get('adv_max_read', 0) || speedValue('maxReadTime');
    },
    get noNewContentRetry() { return speedValue('noNewContentRetry'); },

    // 点赞设置（动态从预设获取；高级设置百分比 >0 覆盖，上限 50%）
    // 【v2.7.0 人化随机】人化模式下每换一帖重抽一次点赞概率（4 档加权，见 refreshTopicParams）
    get likeChance() {
      if (humanMode) return perTopicLikeChance;
      const adv = Storage.get('adv_like_chance', 0);
      return adv > 0 ? Math.min(50, adv) / 100 : LIKE_CHANCE_PRESETS[currentLikeChance].value;
    },
    get minLikeInterval() {
      // 最小点赞间隔 (ms)；人化模式随每帖时间喜好缩放
      if (humanMode) return Math.round(2000 * perTopicTimeScale);
      return Storage.get('adv_like_interval', 0) || 2000;
    },

    // 会话设置（动态从目标配置读取，达到即自动停止）
    // 【v2.7.0 人化随机】开启人化后目标不看用户设定值：每天在 min~max 范围内随机抽取
    // （见 humanTopicTarget/humanLikeTarget，0=不限）——完全脱离用户设定的固定数值
    get maxLikesPerSession() {
      if (humanMode) return humanLikeTarget();
      return likeTarget;
    },
    get maxTopicsPerSession() {
      if (humanMode) return humanTopicTarget();
      return topicTarget;
    },

    // 返回列表设置（高级设置可覆盖；人化模式随每帖时间喜好缩放）
    get returnToListDelay() {
      if (humanMode) return Math.round(1000 * perTopicTimeScale);
      return Storage.get('adv_return_delay', 0) || 1000;
    },

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

  // ==================== 【v2.7.0】人化随机模式 ====================
  // 目标：让「长期行为」无法形成固定指纹。普通用户每天的节奏不是恒定的——
  // 状态好时刷得快，摸鱼时刷得慢；上论坛的时间每天漂移；目标达成点偶尔超额。
  // 本模式把长期固定点改成「两层随机」：
  //   每天一摇（当天状态稳定）：节奏倍率 τ、所选时段内随机基准时刻+大偏移、每日目标
  //     （帖/赞 在用户设定的 min~max 范围内随机整数，0=不限；时长上限由 human_duration 定死）
  //   每帖一摇（换帖重抽，模拟用户喜好）：点赞概率、阅读投入度、滚动步长、翻页间隔/加载等待
  // 逐秒/逐操作乱抖反而会在统计上露馅（方差过大的均匀噪声也非真人）。

  // 今日节奏 τ：>1 更慢、<1 更快。权重按普通用户浏览速度分布：
  //   极快 3%（0.35~0.55）  偏快 12%（0.55~0.8）  正常 40%（0.8~1.15）
  //   偏慢 30%（1.15~1.5）  很慢 12%（1.5~1.9）   极慢 3%（1.9~2.3）
  function drawDailyTempo() {
    const r = Math.random();
    if (r < 0.03) return 0.35 + Math.random() * 0.2;
    if (r < 0.15) return 0.55 + Math.random() * 0.25;
    if (r < 0.55) return 0.8 + Math.random() * 0.35;
    if (r < 0.85) return 1.15 + Math.random() * 0.35;
    if (r < 0.97) return 1.5 + Math.random() * 0.4;
    return 1.9 + Math.random() * 0.4;
  }

  // 今日定时偏移（分钟，带方向）：真人每天不会准点上线，偏移带权重：
  //   55% ±0~15 分   25% ±15~45 分   12% ±45~120 分
  //   6% ±2~4 小时   2% ±4~8 小时（偶尔差大半天才上来）
  function drawSchedOffset() {
    const r = Math.random();
    let max;
    if (r < 0.55) max = 15;
    else if (r < 0.80) max = 45;
    else if (r < 0.92) max = 120;
    else if (r < 0.98) max = 240;
    else max = 480;
    const sign = Math.random() < 0.5 ? -1 : 1;
    return sign * randomInt(0, max);
  }

  // 每日目标：在用户设定的 min~max 范围内随机整数（0=不限）。
  // lo 为 0 时表示「下限不限」，实际目标至少取 1；hi 为 0 表示该维度不限（返回 0）
  function drawRangeTarget(lo, hi) {
    const min = Math.max(0, Math.floor(Number(lo) || 0));
    const max = Math.max(0, Math.floor(Number(hi) || 0));
    if (max <= 0) return 0; // 上限 0 = 不限
    const from = Math.min(min, max) >= 1 ? Math.min(min, max) : 1;
    const to = Math.max(min, max);
    return randomInt(from, to);
  }

  // 一天一摇：按当天日期缓存当日配置，跨天自动重摇。
  // 用 GM 存储持久化，整页跳转/刷新不会丢；所有标签页共享同一套（真人只有一个行为基线）
  function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // 人化模式下每日目标（供 CONFIG 读取；0=不限）
  function humanTopicTarget() {
    if (!humanMode) return 0;
    ensureDailyProfile();
    return parseInt(Storage.get('human_topic_target', 0), 10) || 0;
  }

  function humanLikeTarget() {
    if (!humanMode) return 0;
    ensureDailyProfile();
    return parseInt(Storage.get('human_like_target', 0), 10) || 0;
  }

  // 【v2.7.4 人化翻楼·每帖重抽】当前帖的翻楼上限：每换一帖在 human_floor_min~max 范围内
  // 重抽一次（0=不限，整帖读完），模拟真人各帖耐心不一。与 floorLimit 相互独立：
  // 人化接管时 isOverFloorLimit 用这里的值，非人化仍走用户手设的 floorLimit。
  // 面板上 human-floor-min/max 只负责配置「每帖翻楼范围」，不再每天抽一个固定值。
  function humanFloorTarget() {
    if (!humanMode) return 0;
    return perTopicFloorLimit;
  }

  // 每帖一摇的喜好参数（内存态，只在本会话内生效；页面刷新/换帖自动重抽）。
  // 真人喜好是多变的：同一篇帖子可能很感兴趣读得久、下一帖划两下就走。
  // 换帖重抽的维度：点赞概率（4档加权）、阅读投入度、滚动步长、翻页间隔、加载等待、
  // 翻楼上限、中途离场（约 15% 的帖子不会读完）。
  let perTopicLikeChance = 0.15;    // 当前帖的点赞概率
  let perTopicReadScale = 1;        // 阅读投入度（min/maxReadTime 缩放）
  let perTopicScrollScale = 1;      // 滚动步长缩放
  let perTopicTimeScale = 1;        // 翻页间隔/加载等待 缩放
  let perTopicFloorLimit = 0;       // 当前帖的翻楼上限（0=不限，整帖读完）
  let perTopicGiveUpRatio = 0;      // 中途离场点（0=读完；>0 表示读到该帖该比例楼层即返回）
  function refreshTopicParams() {
    if (!humanMode) return;
    // 点赞概率 4 档加权：低5% 30% / 中15% 40% / 高25% 25% / 极高40% 5%
    const r = Math.random();
    if (r < 0.30) perTopicLikeChance = 0.05;
    else if (r < 0.70) perTopicLikeChance = 0.15;
    else if (r < 0.95) perTopicLikeChance = 0.25;
    else perTopicLikeChance = 0.40;
    // 阅读投入度：80% 的帖子在 0.7~1.3 之间起伏；约 20% 是「沉浸帖」，
    // 读到 1.6~2.4 倍时长（遇到感兴趣的长帖会读得明显更久，像真人一样）
    perTopicReadScale = Math.random() < 0.2 ? 1.6 + Math.random() * 0.8 : 0.7 + Math.random() * 0.6;
    // 滚动/时间类 0.85~1.15（帖子难易、长短起伏）
    perTopicScrollScale = 0.85 + Math.random() * 0.3;
    perTopicTimeScale = 0.85 + Math.random() * 0.3;
    // 【v2.7.4 人化翻楼·每帖重抽】翻楼上限不再每天抽一次，改为每帖重抽：
    // 真人点开不同帖子的耐心各不相同——热帖多看几楼、水帖划两下就走。
    // 仍在用户设定的 min~max 范围内随机（0=不限，整帖读完），面板只负责配置范围。
    perTopicFloorLimit = drawRangeTarget(
      Storage.get('human_floor_min', 0),
      Storage.get('human_floor_max', 0)
    );
    // 中途离场：约 15% 的帖子读到 55%~85% 楼层就返回列表（真人很少帖帖读完）
    perTopicGiveUpRatio = Math.random() < 0.15 ? 0.55 + Math.random() * 0.3 : 0;
  }

  // 每日配置的时间段 → 定时基准时刻。真人不会固定同一个点上线，
  // 而是在所选大时段（清晨/上午/下午/晚上/深夜）内每天随机一个基准时刻（分钟 0~1439）。
  // 晚睡党可能深夜 23:00~凌晨 5:00 出没，跨午夜按 0~1439 分钟内随机后仍归一位
  const HUMAN_TIME_RANGES = {
    early: ['清晨', 300, 480],       // 05:00~07:59
    morning: ['上午', 480, 720],     // 08:00~11:59
    afternoon: ['下午', 720, 1080],  // 12:00~17:59
    evening: ['晚上', 1080, 1380],   // 18:00~22:59
    night: ['深夜', 1380, 300]       // 23:00~04:59（跨午夜）
  };
  function getHumanTimeRange() {
    return Storage.get('human_time_range', 'evening');
  }
  function drawTimeBase() {
    const r = HUMAN_TIME_RANGES[getHumanTimeRange()];
    if (!r) return randomInt(300, 1439);
    const [label, start, end] = r;
    let base;
    if (end < start) {
      // 跨午夜区间（深夜 23:00~次日04:59）：把「start 之后到 23:59」与「00:00~end」两段
      // 拼成一条连续窗口再均匀抽：r∈[0, 360) 内，前 60 个落在 23:00~23:59，其余落在次日 0~299 分
      const span = (1440 - start) + end; // 深夜: 60 + 300 = 360 分钟
      const rOff = randomInt(0, span - 1);
      base = rOff < (1440 - start) ? start + rOff : rOff - (1440 - start);
    } else {
      // 非跨午夜（如清晨 300~480）：end 是该段的下一整点（08:00），实际可取到 end-1
      base = randomInt(start, end - 1);
    }
    return Math.min(base, 1439);
  }

  // 会话内固定「今天」：start() 时钉住会话起始日，会话跨零点运行期间 ensureDailyProfile
  // 不会重摇当日参数（真人不会半夜 0 点瞬间换一套行为基线）；stop()/finishRun 解除钉住
  let sessionPinnedDay = '';

  // 一天一摇：按当天日期缓存当日配置，跨天自动重摇。
  // 用 GM 存储持久化，整页跳转/刷新不会丢；所有标签页共享同一套（真人只有一个行为基线）
  // 摇出的当日配置：节奏 τ / 定时基准时刻+偏移 / 今日目标（帖/赞在用户设定范围内随机；0=不限）
  function ensureDailyProfile() {
    const today = sessionPinnedDay || todayKey();
    if (Storage.get('human_day', '') === today) return;
    // 【v2.7.4 修复 2da304fc L7】多标签并发重摇非原子：多个标签页同时发现 human_day
    // 过期后会各自重摇、互相覆盖，同一天可能落盘多套（甚至半套）随机参数——机器指纹。
    // 用带 TTL 的认领锁串行化：存在活动认领时本标签放弃本次重摇（下次调度再来，
    // 届时 human_day 已更新直接返回）。持有认领的标签若崩溃，锁最多 3 秒过期自愈。
    const claimToken = `${TAB_ID}:${Date.now()}`;
    const curClaim = Storage.get('human_profile_claim', '');
    if (curClaim) {
      const claimedAt = parseInt(String(curClaim).split(':').pop(), 10);
      if (claimedAt > 0 && Date.now() - claimedAt < 3000) return;
    }
    Storage.set('human_profile_claim', claimToken);
    // 【v2.7.1 人化】节奏 τ 多日自相关：真人浏览节奏有惯性——连续几天大体接近，
    // 偶尔才大幅变化。60% 概率在昨日 τ 的 ±20% 内扰动，40% 概率全新抽取
    // （作息被打乱的日子，如周末/出差/熬夜后）。避免「每天从分布里独立重抽」
    // 造成的白噪声式跳变（那是机器特征，真人不会天天快慢剧烈切换）。
    const prevTempo = parseFloat(Storage.get('human_tempo_prev', 0)) || 0;
    let tempo;
    if (prevTempo > 0 && Math.random() < 0.6) {
      tempo = clamp(prevTempo * (0.8 + Math.random() * 0.4), 0.35, 2.3);
    } else {
      tempo = drawDailyTempo();
    }
    // 【v2.7.4 人化】开始时刻同样自相关：60% 概率在昨日基准 ±30 分钟内扰动
    // （真人每天上线时刻相近，白噪声式跳点是机器特征）；扰动落出所选时段则重抽。
    // 修复「开始时刻无自相关」（H2 2da304fc）与「深夜档 83% 落到次日凌晨、却按今天
    // 提前 22 小时触发」的根因之一。
    const prevBase = parseInt(Storage.get('human_sched_base_prev', '-1'), 10);
    const r = HUMAN_TIME_RANGES[getHumanTimeRange()];
    let base;
    if (r && prevBase >= 0 && Math.random() < 0.6) {
      const cand = prevBase + randomInt(-30, 30);
      const [, s, e] = r;
      const inside = e < s ? (cand >= s || cand <= e) : (cand >= s && cand < e);
      base = inside ? clamp(cand, 0, 1439) : drawTimeBase();
    } else {
      base = drawTimeBase();
    }
    Storage.set('human_tempo', tempo);
    Storage.set('human_tempo_prev', tempo);
    Storage.set('human_sched_base', base);
    Storage.set('human_sched_base_prev', base);
    Storage.set('human_sched_offset', drawSchedOffset());
    const topicLo = Storage.get('human_topic_min', 30);
    const topicHi = Storage.get('human_topic_max', 50);
    const likeLo = Storage.get('human_like_min', 10);
    const likeHi = Storage.get('human_like_max', 20);
    Storage.set('human_topic_target', drawRangeTarget(topicLo, topicHi));
    Storage.set('human_like_target', drawRangeTarget(likeLo, likeHi));
    // 提交标记：全部参数落盘之后才写 human_day（验证认领仍未易主——生成期间被其他
    // 标签抢走认领则放弃本次结果，避免半套参数被当作当日配置）；随即释放认领
    if (Storage.get('human_profile_claim') !== claimToken) return;
    Storage.set('human_day', today);
    Storage.set('human_profile_claim', '0');
    // 【v2.7.4】翻楼目标不再每日抽取（每帖重抽，见 refreshTopicParams/humanFloorTarget），
    // 这里只保留 min~max 范围供面板展示与日志使用
    const t = Storage.get('human_tempo', 1);
    const schedBase = parseInt(Storage.get('human_sched_base', 1080), 10);
    const off = parseInt(Storage.get('human_sched_offset', 0), 10);
    const tt = parseInt(Storage.get('human_topic_target', 0), 10);
    const lt = parseInt(Storage.get('human_like_target', 0), 10);
    const floorLo = Storage.get('human_floor_min', 0);
    const floorHi = Storage.get('human_floor_max', 0);
    const hh = String(Math.floor(schedBase / 60)).padStart(2, '0');
    const mm = String(schedBase % 60).padStart(2, '0');
    log(`人化模式：今日节奏 ×${t.toFixed(2)}，基准时段 ${hh}:${mm} 偏移 ${off >= 0 ? '+' : ''}${off} 分，目标 ${tt > 0 ? tt : '不限'} 帖 / ${lt > 0 ? lt : '不限'} 赞 / 每帖翻楼 ${floorHi > 0 ? `${floorLo}~${floorHi} 楼` : '不限'}`);
  }

  // 人化速度：以「正常」档为基准，按今日节奏 τ 整体缩放，再叠加每帖喜好缩放
  // （换帖重抽，见 refreshTopicParams）。慢/中/快档位与人化高级设置均被人化接管。
  function speedValue(key) {
    if (!humanMode) return SPEED_PRESETS[currentSpeed][key];
    ensureDailyProfile();
    const t = Storage.get('human_tempo', 1);
    const base = SPEED_PRESETS.normal;
    switch (key) {
      case 'scrollStep': return clamp(Math.round(base.scrollStep / Math.pow(t, 0.3) * perTopicScrollScale), 250, 650);
      // 【v2.7.4】方向修正：慢节奏日（t 大）等新内容更有耐心 → 重试次数应更多而非更少，
      // 原式除 t^0.5 会把「慢→少等、快→多等」的方向反掉
      case 'noNewContentRetry': return clamp(Math.round(base.noNewContentRetry * Math.pow(t, 0.5)), 2, 6);
      case 'scrollInterval': return Math.round(base.scrollInterval * t * perTopicTimeScale);
      case 'loadWaitTime': return Math.round(base.loadWaitTime * t * perTopicTimeScale);
      case 'minReadTime': return Math.round(base.minReadTime * t * perTopicReadScale);
      case 'maxReadTime': return Math.round(base.maxReadTime * t * perTopicReadScale);
      default: return Math.round(base[key] * t);
    }
  }

  // 人化模式时长上限（分钟）：由 human_duration 定死（0=不限），供 CONFIG.maxMinutes 使用
  function humanDurationMin() {
    if (!humanMode) return 0;
    const d = parseInt(Storage.get('human_duration', 60), 10);
    return d > 0 ? d : 0;
  }

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  // 输入健壮性（fb052830 L7）：用户或旧数据可能给出 Infinity / NaN / 非法字符串，
  // Number('Infinity') 能穿过 Math.max(0,...) 直接存进配置，之后所有目标判定都被
  // 无穷值带偏。一律归一为非负整数，非法输入返回 0
  function safeInt(v) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  }

  // 人化开关：写入存储并同步面板 UI 状态（隐藏被接管行、显示人化专属设置）
  function setHumanMode(enabled) {
    humanMode = !!enabled;
    Storage.set('human_mode', humanMode);
    if (humanMode && !scheduleEnabled) {
      // 【v2.7.4】定时总闸现在对所有模式生效（不再「人化恒开」）；开启人化时若总闸关着，
      // 人化日程永远无法触发，这里自动补开总闸并落盘，保证「开人化就能跑」
      scheduleEnabled = true;
      Storage.set('sched_enabled', true);
    }
    document.querySelectorAll('.human-btn[data-human]').forEach(btn => {
      btn.classList.remove('active');
      if ((btn.dataset.human === 'true') === humanMode) btn.classList.add('active');
    });
    const statusEl = document.getElementById('human-status');
    if (statusEl) statusEl.textContent = humanMode ? '已开启（每日随机节奏/时段/目标）' : '未开启';
    syncPanelHumanVisibility();
    if (humanMode) ensureDailyProfile();
    log(`人化随机模式: ${humanMode ? '已开启' : '已关闭'}`);
  }

  // 【v2.7.2 调试模式】一键强制开启人化模式并立即开始浏览（跳过每日定时等待）：
  // 人化模式每天在「所选时段内随机基准时刻+偏移」才自动启动，想立刻验证人化行为
  // 就得手动等定时或临时改时段。调试开关把「强制人化 + 立即开跑」合并成一步。
  // 会话内生效（不落盘）：刷新后按钮回到关闭态，人化是否保持由 human_mode 独立决定。
  function setDebugMode(enabled) {
    debugMode = !!enabled;
    document.querySelectorAll('.debug-btn[data-debug]').forEach(btn => {
      btn.classList.remove('active');
      if ((btn.dataset.debug === 'true') === debugMode) btn.classList.add('active');
    });
    // 调试时联动控制台日志：看不到过程日志的调试毫无意义（修复：调试开关与 CONFIG.debug 脱节）
    CONFIG.debug = debugMode;
    if (debugMode) {
      debugPrevHumanMode = humanMode;
      setHumanMode(true); // 强制人化：接管速度/定时/目标/高级设置
      log('调试模式：已强制开启人化模式（跳过每日定时等待）');
    } else {
      // 状态对称：关闭调试时还原调试前的人化开关状态，
      // 而不是把 setHumanMode(true) 落盘的 human_mode=true 永远留在存储里（刷新后残留）
      setHumanMode(debugPrevHumanMode);
      // 日志联动还原为存储里用户自己的设置（调试开启只是会话内临时打开日志）
      CONFIG.debug = !!Storage.get('debug', false);
      log('调试模式已关闭');
    }
  }

  // 人化专属设置：切换所选时段。改了立即生效——今天剩余的基准时刻按新时段重摇，
  // 不必等到明天才按新时段（定时偏移也一起重摇，避免新时段叠旧偏移出现同一固定组合）
  function setHumanTimeRange(range) {
    if (!HUMAN_TIME_RANGES[range]) return;
    Storage.set('human_time_range', range);
    document.querySelectorAll('.hr-btn[data-range]').forEach(btn => {
      btn.classList.remove('active');
      if (btn.dataset.range === range) btn.classList.add('active');
    });
    if (humanMode) {
      Storage.set('human_sched_base', drawTimeBase());
      Storage.set('human_sched_offset', drawSchedOffset());
      const base = parseInt(Storage.get('human_sched_base', 1080), 10);
      const off = parseInt(Storage.get('human_sched_offset', 0), 10);
      const hh = String(Math.floor(base / 60)).padStart(2, '0');
      const mm = String(base % 60).padStart(2, '0');
      log(`人化时段改为「${HUMAN_TIME_RANGES[range][0]}」，今日基准重摇为 ${hh}:${mm} 偏移 ${off >= 0 ? '+' : ''}${off} 分`);
    } else {
      log(`人化时段设为「${HUMAN_TIME_RANGES[range][0]}」（开启人化后生效）`);
    }
  }

  // 人化目标范围（帖/赞/翻楼）：min~max 输入写回；开启人化时重摇当日目标（0 表示不限）
  // 翻楼（floor）除外：翻楼上限已改为「每帖重抽」（refreshTopicParams 里按 min/max 抽取），
  // 不再有每日 target，这里只落范围
  function setHumanGoalRange(prefix, minVal, maxVal) {
    const lo = Math.max(0, Math.floor(Number(minVal) || 0));
    const hi = Math.max(0, Math.floor(Number(maxVal) || 0));
    Storage.set(`human_${prefix}_min`, lo);
    Storage.set(`human_${prefix}_max`, hi);
    if (prefix === 'floor') {
      log(`人化翻楼目标范围改为 ${lo}~${hi} 楼${hi === 0 ? '（不限）' : ''}（每帖重抽）`);
      if (humanMode) refreshTopicParams();
      return;
    }
    const key = `human_${prefix}_target`;
    if (humanMode) {
      Storage.set(key, drawRangeTarget(lo, hi));
      const t = parseInt(Storage.get(key, 0), 10);
      log(`人化${labelHumanGoal(prefix)}目标范围改为 ${lo}~${hi}，今日目标重摇为 ${t > 0 ? t : '不限'}`);
    } else {
      log(`人化${labelHumanGoal(prefix)}目标范围设为 ${lo}~${hi}（开启人化后生效）`);
    }
  }

  function labelHumanGoal(prefix) {
    if (prefix === 'topic') return '浏览';
    if (prefix === 'floor') return '翻楼';
    return '点赞';
  }

  // 人化时长上限（定死单值，0=不限）
  function setHumanDuration(value) {
    const n = Math.max(0, Math.floor(Number(value) || 0));
    Storage.set('human_duration', n);
    log(`人化时长上限设置为: ${n > 0 ? `${n} 分钟` : '不限'}`);
  }

  // 面板按人化开关切换：隐藏被接管的设置行（速度档位/定时/目标/高级设置/概率预设），
  // 显示人化专属设置区（时段+目标范围+时长）；关掉时恢复
  function syncPanelHumanVisibility() {
    if (typeof document === 'undefined' || !document.getElementById) return;
    ['speed', 'schedule', 'goal', 'advanced', 'floor'].forEach(k => {
      const el = document.getElementById(`human-hide-${k}`);
      if (el) el.classList.toggle('hidden', humanMode);
    });
    // 概率预设同样被接管（人化下每帖重抽点赞概率），开启人化后隐藏；
    // 恢复时按点赞开关状态（点赞关闭时概率行本来就不显示）
    const chanceRow = document.getElementById('like-chance-row');
    if (chanceRow) chanceRow.classList.toggle('hidden', humanMode || !enableLike);
    const box = document.getElementById('human-options');
    if (box) box.classList.toggle('hidden', !humanMode);
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
    // 【v2.7.3】用户手动重新开启点赞时，清除上次 429 限流留下的冷却标记，
    // 避免旧版本把 enable_like 永久关掉后，用户重新打开也仍被冷处理器卡住
    if (enabled) {
      Storage.set('like_disabled_until', 0);
    }
    log(`随机点赞: ${enabled ? '已开启' : '已关闭'}`);

    // 更新UI按钮状态
    if (updateUI) {
      document.querySelectorAll('.like-btn[data-like]').forEach(btn => {
        btn.classList.remove('active');
        if ((btn.dataset.like === 'true') === enabled) {
          btn.classList.add('active');
        }
      });
      // 点赞关闭时概率选项没有意义，整行收起；人化模式下概率被每帖抽签接管，
      // 同样隐藏（与 syncPanelHumanVisibility 的 humanMode 判定保持一致）
      const chanceRow = document.getElementById('like-chance-row');
      if (chanceRow) chanceRow.classList.toggle('hidden', !enabled || humanMode);
    }
  }

  // 只赞主帖：开启后仅给楼主帖点赞，跳过所有回复楼层
  function setLikeMainOnly(enabled) {
    likeMainOnly = enabled;
    Storage.set('like_main_only', enabled);
    log(enabled ? '只赞主帖：仅给楼主帖点赞' : '点赞范围：帖子与回复楼层都点赞');
  }

  // 处理点赞限制：点赞走 API 直连（sendLikeRequest）或页面真实按钮，命中 429/rate_limit 时调用。
  // 【v2.7.3 修复】不再永久关闭点赞开关——一次限流就把 enable_like 落盘为 false，会导致之后
  // 所有会话（含人化模式）永不点赞、面板恒 0，且用户无从得知开关被自动关掉。改为 30 分钟
  // 临时冷却：写入 like_disabled_until，shouldLike 在冷却期内跳过点赞，到期自动恢复。
  function handleLikeLimit() {
    const until = Date.now() + 30 * 60 * 1000;
    Storage.set('like_disabled_until', until);
    log('点赞被限流：暂停点赞 30 分钟（到期自动恢复，无需手动开关）');
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

  // 每日定时设置：时间格式 HH:MM。
  // 非法输入保留原有效时间（不静默回落 09:00，避免用户清空输入后行为被悄悄改写）；
  // 仅当「时间值真正改变」才重置当日触发守卫与抖动——纯开关切换不重置，
  // 否则用户当天反复开关定时会反复开放触发窗口，一天内被触发多轮
  function setSchedule(enabled, time) {
    const wasEnabled = scheduleEnabled;
    const wasTime = scheduleTime;
    scheduleEnabled = !!enabled;
    let t = scheduleTime;
    const m = String(time || '').match(/^(\d{1,2}):(\d{2})$/);
    if (m) {
      const h = Math.min(23, Math.max(0, parseInt(m[1], 10)));
      const mm = Math.min(59, Math.max(0, parseInt(m[2], 10)));
      t = `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    }
    scheduleTime = t;
    Storage.set('sched_enabled', scheduleEnabled);
    Storage.set('sched_time', scheduleTime);
    if (t !== wasTime) {
      // 时间变了 → 开放新的触发窗口：清掉「今日已运行」标记与今日抖动/启动秒数，
      // 否则同一天之前触发过的话，新设的时间会被一次/天守卫吞掉，到点不启动
      Storage.set('sched_last_run_date', '');
      Storage.set('sched_jitter_day', '');
      Storage.set('sched_fire_day', '');
    } else if (enabled && !wasEnabled) {
      // 仅重新开启（时间未变）：不重置当日守卫，但清掉启动秒数抖动，避免跨天沿用旧秒数
      Storage.set('sched_fire_day', '');
    }
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

  // 人化延迟：对均匀基准施加偏态扰动——真实人类的行为时间不是均匀分布，
  // 而是「大多数偏短、偶发明显偏慢」的偏态分布。直接均匀采样会在长时间序列
  // 的统计特征里暴露为机器人（每个间隔都落在固定区间的均匀带里）。
  // 从 [min,max] 均匀取基准后按概率拉伸/压缩：
  //   ~5% 明显偏慢「分心/重读」（2.2~4×）  ~13% 略慢（1.3~1.8×）
  //   ~15% 略快（0.75~1.0×）               ~12% 快速掠过（0.45~0.8×）
  //   ~55% 正常（±8% 微抖动）——不再整批原样落在均匀带里
  // 均值仍大致落在原区间内，不拖慢整体节奏，但分布形态接近人类。
  function skewDelay(baseMs) {
    const r = Math.random();
    let d = baseMs;
    if (r < 0.05) d = Math.round(baseMs * (2.2 + Math.random() * 1.8));
    else if (r < 0.18) d = Math.round(baseMs * (1.3 + Math.random() * 0.5));
    else if (r < 0.33) d = Math.round(baseMs * (0.75 + Math.random() * 0.25));
    else if (r < 0.45) d = Math.round(baseMs * (0.45 + Math.random() * 0.35));
    else d = Math.round(baseMs * (0.92 + Math.random() * 0.16));
    return d;
  }

  // 人化延迟（区间版）：随机取基准再施加偏态。
  // 上限不再用精确常数 15000——长序列里大量「正好 15000ms」是机器特征；
  // 超限后落在 15000~17000ms 的连续区间，仍低于卡死判定阈值
  function humanDelay(min, max) {
    const base = Math.floor(Math.random() * (max - min + 1)) + min;
    const skewed = skewDelay(base);
    const d = skewed > 15000 ? 15000 + randomInt(0, 2000) : skewed;
    return new Promise(resolve => setTimeout(resolve, d));
  }

  // 按帖子正文长度估算人类阅读时间：短楼（一句话/表情）快速划过，
  // 长帖按长度加时（最多到最长阅读时间的 2 倍）。这些停留时长会写入
  // /topics/timings 上报，让服务端看到的阅读速度与内容量相关（像真人）。
  // 【v2.7.4】去掉 <40 字固定 0.3~0.6× / 500~1500 恒等 max / >1500 恒等 1.3×max 这些
  // 硬折点与定值平台，改平滑饱和曲线：连续长度→连续时长；极慢节奏日里扫一眼短楼
  // 也只按 min 的 1/4 停顿，不再把长帖节奏套到一句话楼上
  function contentReadDelay(textLen) {
    const min = CONFIG.minReadTime;
    const max = CONFIG.maxReadTime;
    const len = Math.max(0, textLen);
    const sat = 1 - Math.exp(-len / 350);              // 350 字处投入约 63%，渐近趋满
    const shortFloor = Math.round(min * 0.25);         // 一句话楼的下限：min 的 1/4
    let d = shortFloor + (max - shortFloor) * sat;
    if (len > 1200) d *= 1 + Math.min(0.5, (len - 1200) / 4000); // 超长帖平滑加时（不超过 1.5×）
    return Math.round(d);
  }

  function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  // 【反检测 v2.6.9】点击式 SPA 导航：真人点话题链接走 Ember 客户端路由
  // （pushState 改 URL + XHR 拉 /t/topic/{id}.json），服务端日志看不到整页 HTML 请求；
  // 而脚本若一律 location.href 整页跳转，会出现「全站浏览全整页、零 JSON」的强指纹。
  // 改为点击真实链接，三种结局都能自洽：
  //   ① 被 Ember 拦截 → SPA 跳转（URL 变化由 checkUrlChange 轮询接管、换新浏览器）；
  //   ② 未被拦截 → 浏览器默认整页导航（等价 location.href，页面销毁、脚本重注入）；
  //   ③ 点击无效 → 1.2s 后 URL 未变，兜底整页跳转。
  // 强制 target=_self：避免链接自带 _blank 时开新标签，本页流程悬空。
  function navigateViaLinkClick(link, fallbackHref) {
    const before = window.location.href;
    try {
      if (link) {
        if (link.target === '_blank' || link.target === '_top') link.target = '_self';
        link.click();
      }
    } catch (e) {
      window.location.href = fallbackHref || before;
      return;
    }
    // 【v2.7.4】固定 1.2s 超时改为 200ms×20 轮询：Ember 路由/网络快慢不定，
    // 固定窗口要么在慢速下误判「没跳转」提前整页兜底（双导航竞态），要么快速页空等；
    // 轮询在 URL 一变就立刻结算，最多 4 秒仍未变才兜底整页跳转
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (window.location.href !== before) {
        clearInterval(timer);
        // URL 变了但页面没销毁 = Ember 拦截成功、SPA 跳转进行中：
        // 标记录下「本页是从列表 SPA 进来的」，回去时优先走 history.back()
        try { window._ldSpaEntry = true; } catch (e) {}
        return;
      }
      if (Date.now() - t0 >= 4000) {
        clearInterval(timer);
        window.location.href = fallbackHref || before;
      }
    }, 200);
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
  // 【v2.7.4】改为 async + SPA 兜底：列表页点链接进帖（Ember 客户端路由）时
  // #data-preloaded 仍是列表页数据、没有 topic_ 键，旧实现每次恒返 0 →
  // 「上次读到哪」的恢复在 SPA 场景完全失效。兜底拉 /t/topic/{id}.json，
  // 用每帖自带的 read 布尔标志找出最高已读楼层（比 last_read_post_number 更可靠）
  async function getLastReadPostNumber(topicId) {
    try {
      const el = document.querySelector('#data-preloaded');
      if (el) {
        const raw = JSON.parse(el.textContent)[`topic_${topicId}`];
        if (raw) {
          const topic = typeof raw === 'string' ? JSON.parse(raw) : raw;
          return Number(topic.last_read_post_number) || 0;
        }
      }
      const res = await fetch(`/t/topic/${topicId}.json`, { credentials: 'include' });
      if (!res.ok) return 0;
      const data = await res.json();
      const posts = data && data.post_stream && data.post_stream.posts ? data.post_stream.posts : [];
      let base = 0;
      for (const p of posts) {
        if (p.read && Number(p.post_number) > base) base = Number(p.post_number);
      }
      return base;
    } catch (e) {
      return 0;
    }
  }

  // 读取当前话题「实际总楼层数」（楼主帖算 1 楼，一条回复 = 一楼）。
  // 同样取自 #data-preloaded 的 topic 对象。
  // 【v2.7.4】优先 highest_post_number：它才是真实楼层号（删帖会留下空洞，
  // posts_count 只数现存帖数，用它会「提前收工」——楼层号跳着涨但计数没到）。
  // 用真实楼数做硬上限：帖子实际只有 2 楼时，读完 2 楼即收工，
  // 不再继续滚动等「永远等不到的新楼」，也避免浮窗楼层数虚高。
  // 【反检测 v2.6.9】SPA 客户端路由进入话题时 #data-preloaded 仍是列表页数据（无 topic_ 键），
  // 此时回退读页面进度条的真实总楼数（#topic-progress-total），避免误判为 0 导致等不存在的楼
  function getTopicTotalPosts(topicId) {
    try {
      const el = document.querySelector('#data-preloaded');
      if (el) {
        const raw = JSON.parse(el.textContent)[`topic_${topicId}`];
        if (raw) {
          const topic = typeof raw === 'string' ? JSON.parse(raw) : raw;
          const n = Number(topic.highest_post_number) || Number(topic.posts_count) || 0;
          if (n > 0) return n;
        }
      }
      // SPA 进入兜底：Discourse 页面进度条会显示真实总楼数
      const totalEl = document.querySelector('#topic-progress-total');
      const total = totalEl ? Number(totalEl.textContent.trim()) : 0;
      return total > 0 ? total : 0;
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

  // 元素是否真正可见：offsetParent!==null 不可靠（position:fixed 时 offsetParent 恒为 null，
  // 会被误判为不可见）；改为 getClientRects 是否非空 + 计算样式 display/visibility/opacity
  function isElementVisible(el) {
    if (!el || !el.getClientRects || el.getClientRects().length === 0) return false;
    const cs = window.getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.01;
  }

  // 时间线由 Ember 异步渲染，且「返回」只在当前位置落后于上次阅读位置时才出现，
  // 所以轮询等待而不是取一次就走；超时返回 null，由调用方决定退路
  async function waitForBackButton(timeout) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const btn = document.querySelector(BACK_BUTTON_SELECTOR);
      if (btn && isElementVisible(btn)) return btn;
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
        if (value === null) return defaultValue;
        try {
          return JSON.parse(value);
        } catch (e) {
          // 【v2.7.4】明文兜底：早期版本或外部工具写入的裸字符串（非 JSON）也能读，
          // 不再整段抛回 defaultValue 把已存配置丢掉
          return value;
        }
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
  humanMode = Storage.get('human_mode', false);
  loadSelectedCategories();

  // 数据迁移：v2.1.1 起 liked_posts 的键从话题内楼层序号改为全局 post id，
  // 旧键在新逻辑下全部失配（脏数据），一次性清空，避免重访旧话题时把已点赞的帖子误 toggle 取消
  // （viewed_topics 存的一直是话题 id，语义未变，保留不动）
  // 【v2.7.4】只在实际存在旧格式键时才清：旧键形如「话题id:楼层」（非纯数字）。
  // 若只是版本号缺失（全新环境/存储被清空）而 liked_posts 本来就是新格式，
  // 直接重跑清空会把用户已有的点赞去重记录误删（fb052830 L9）
  const STORAGE_VERSION = 2;
  const storedVersion = Storage.get('storage_version', 0);
  if (storedVersion < STORAGE_VERSION) {
    const liked = Storage.get('liked_posts', []);
    const hasLegacyKeys = Array.isArray(liked) && liked.some(k => !/^\d+$/.test(String(k)));
    if (hasLegacyKeys || storedVersion === 0) {
      Storage.set('liked_posts', []);
    }
    Storage.set('storage_version', STORAGE_VERSION);
    log('存储迁移：已检查 liked_posts 键格式（旧格式已重置为全局 post id）');
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
        // 【v2.7.4】不再对 liked 做 MAX_HISTORY 淘汰：点赞记录一旦被淘汰，
        // 同一帖子会被当成「没赞过」再次点赞——按钮 toggle 语义下等于取消之前的赞，
        // 且会话计数重复累加。点赞集合只增不删，单条记录极小，长期运行完全可接受
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

    // 【反检测 v2.6.9】统计来源从「拦截网络上报」改为「DOM 逐楼计数」：
    // 自动浏览在 processVisiblePosts 里逐楼处理，直接在这里计数（同楼层去重累计、
    // 持久化、楼层上限校验逻辑全部保留），不再需要包装页面 fetch/XHR。
    // 手动浏览（不开自动化、用户自己翻页）不再计入阅读楼层——浮窗统计本就以自动浏览为主。
    addFloor(topicId, floor) {
      if (!topicId || !floor) return;
      // 楼层上限检查：帖子实际只有 2 楼就不会数出 17 楼（被删帖留下的编号空洞不被计入）
      const totalPosts = getTopicTotalPosts(topicId);
      if (totalPosts > 0 && floor > totalPosts) return;

      this.syncFromStorage();
      const readKey = `${topicId}:${floor}`;
      if (this.readKeys.has(readKey)) return;
      this.readKeys.add(readKey);
      trimSet(this.readKeys, 20000);
      Storage.set('session_read_keys', [...this.readKeys]);
      this.onUpdate?.();
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
  // 【反检测 v2.6.9】已整体移除：包装页面 fetch/XMLHttpRequest 是实打实的客户端指纹——
  // 站内 JS 用 fetch.toString()/原型对比即可确认脚本存在。阅读楼层统计改为 DOM 来源
  // （processVisiblePosts 逐楼处理时直接计数），不再触碰页面网络层。

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
      // 反卡顿+反检测：滚动不是恒定 2~4 段等分——真实读者是混合节奏：
      // 偶尔一滚到底（1 段大位移）、偶尔 5~7 碎步、多数时候 2~4 段；
      // 段间停顿也施加偏态扰动（人类手指不会精确均匀地停 90~220ms）。
      const jitter = CONFIG.scrollJitter;
      const total = CONFIG.scrollStep + randomInt(-jitter, jitter);
      if (total <= 0) return;
      const r = Math.random();
      let steps;
      if (r < 0.15) {
        steps = 1; // 偶发：一滚到底
        // 【v2.7.4 修复 d6a2816c M2】单步大位移封顶 ≈0.6 视口高：矮视口 / 大楼间距下
        // 一次滚 600~700px 会跳过中间楼层——processVisiblePosts 只处理进入过可视带的帖子，
        // 被跳过的楼层既不计阅读也不触发点赞（可见带采样漏跳楼层）
        const vh = window.innerHeight || 800;
        if (total > Math.round(vh * 0.6)) total = Math.round(vh * 0.6);
      }
      else if (r < 0.30) steps = randomInt(5, 7); // 偶发：碎步慢滚
      else steps = randomInt(2, 4);
      let done = 0;
      for (let i = 0; i < steps && done < total; i++) {
        const remaining = total - done;
        // 前几段每次只滚掉 45%~65%，最后一段吃掉剩余部分，保证总位移一致
        const seg = (i === steps - 1) ? remaining : Math.round(remaining * (0.45 + Math.random() * 0.2));
        if (seg <= 0) break;
        window.scrollBy({ top: seg, behavior: 'auto' });
        done += seg;
        if (i < steps - 1) await humanDelay(90, 220);
      }
    }

    async scrollToTop() {
      window.scrollTo({ top: 0, behavior: 'auto' });
      await humanDelay(200, 400);
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
      // 【v2.7.4】进帖时刻与滚动次数：供「每帖至少停留/滚动若干再点赞」（M4 d6a2816c）与
      // 「进帖→返回绝对时长下限」（L3 8be112f0）使用
      this.enteredAt = Date.now();
      this.scrollsDone = 0;
      // 【v2.7.4 L3 d6a2816c】是否已标过「本帖已浏览」：由首个滚入视口的未读楼层触发，
      // 进帖即标会让「只点开就退出」的帖子也虚增浏览计数
      this.topicViewedMarked = false;
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

      // 【v2.7.0 人化随机】每进入一个新话题就重抽一次「喜好参数」（点赞概率/阅读投入/
      // 滚动步长/翻页间隔/加载等待），模拟真人各帖喜恶不一的行为起伏
      refreshTopicParams();

      log(`开始浏览话题 ${topicId}...`);
      // 【v2.7.4 修复 d6a2816c L3】进帖不再立即标记「已浏览」——只点开不读也会虚增浏览计数，
      // 改为在 processVisiblePosts 里读完第一个未读楼层时才标记（this.topicViewedMarked）
      this.onStatsUpdate?.();

      // 该帖实际总楼层数：用作滚动/等待的硬上限，帖子只有 2 楼就不会白等到「不存在的第 3 楼」
      this.topicTotalPosts = getTopicTotalPosts(topicId);
      if (this.topicTotalPosts > 0) {
        // 【v2.7.3 人化翻楼】人化下用每日翻楼目标（0=不限），非人化用手设 floorLimit
        const floorCap = humanMode ? humanFloorTarget() : floorLimit;
        log(`话题共 ${this.topicTotalPosts} 楼${floorCap > 0 && this.topicTotalPosts < floorCap ? `（小于楼层上限 ${floorCap}，读完即换帖）` : ''}`);
      }

      // 进入时先取已读位置快照：它既是「只计未读」的计数起点，也用来判断该续读还是从头读
      // 【v2.7.4】getLastReadPostNumber 改为 async（SPA 进入时 fetch JSON 兜底），这里 await
      this.floorBaseline = await getLastReadPostNumber(topicId);
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
        // 【v2.7.4 修复 8be112f0 L3】进帖→返回绝对时长下限：极速档 / 一两楼的短帖
        // 可能 1~2 秒就读完返回，进→回节奏过密是自动浏览指纹；不足 5 秒则补足再返回
        const stayedMs = Date.now() - this.enteredAt;
        if (stayedMs < 5000) {
          await humanDelay(5000 - stayedMs, 7000 - stayedMs);
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
        await humanDelay(1500, 2000);
        return;
      }

      window.location.href = firstPostPath;
      await humanDelay(2000, 2500);
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
      await humanDelay(CONFIG.loadWaitTime, CONFIG.loadWaitTime * 1.3);
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

          // 【v2.7.1 人化】随机「中途离场」：约 15% 的帖子读到 55%~85% 楼层就返回
          // 列表（真人很少帖帖读完，总有一部分帖子点开扫几眼就走）。因信息不足
          // 无法按比例裁断时（总楼数未知）仍按原逻辑读到尽头，保证目标进度可控。
          if (perTopicGiveUpRatio > 0 && this.topicTotalPosts > 0 &&
              this.maxFloorSeen >= Math.round(this.topicTotalPosts * perTopicGiveUpRatio)) {
            // 【v2.7.4 修复 d6a2816c L2】日志按实际阅读比例输出（maxFloorSeen/total），
            // 而非设定阈值比例——设定 60% 但实际滚到 73% 就离开时如实记录 73% 处
            log(`本帖读到 ${this.maxFloorSeen}/${this.topicTotalPosts} 楼后中途离开（${Math.round(this.maxFloorSeen / this.topicTotalPosts * 100)}% 处）`);
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
          // 【v2.7.4 修复 d6a2816c M4】滚动计数：本帖发生过的滚动次数。
          // shouldLike 依赖它加「进帖先滚过至少一次才允许点赞」的门槛——
          // 真人要滚过页面看到内容后才可能生出赞意，进帖首屏 1~3s 就赞是机器指纹
          this.scrollsDone++;

          // 偶发「回看」：真实读者偶尔会小幅上滚重读一小段（重读迹象），
          // 短暂停滞后滚回原位继续往下读；纯滚动上滑不会触发楼层重复处理（viewedPosts 去重）
          if (Math.random() < 0.08) {
            const back = randomInt(40, 140);
            window.scrollBy({ top: -back, behavior: 'auto' });
            await humanDelay(500, 1200);
            window.scrollBy({ top: back, behavior: 'auto' });
            await humanDelay(300, 700);
          }

          await humanDelay(CONFIG.scrollInterval, CONFIG.scrollInterval * 1.3);
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
        // 【v2.7.4 修复 d6a2816c L1】DOM 顺序即楼层顺序：一旦帖子顶边已落到视口下方，
        // 其后的楼层只会更靠下，本轮不可能可见——立即 break，避免对剩余楼层逐一
        // getBoundingClientRect 触发强制回流（帖子越多浪费越大）
        if (rect.top >= viewportHeight) break;
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
          // 【v2.7.4 修复 d6a2816c M3/L3】已读楼层（<= floorBaseline）滚过不重复计入：
          // 回复数/阅读统计/浏览帖数标记都以「未读楼层」为准——续读场景下重滚已读楼层
          // 不再虚增 sessionReplies、不再重复计入阅读、也不当作「新浏览的帖子」标记
          if (floor > this.floorBaseline) {
            this.unreadFloorsRead++;
            this.history.addReplyViewed();
            // 【反检测 v2.6.9】阅读楼层统计改为 DOM 来源（不再拦截网络上报）
            readingTracker.addFloor(getCurrentTopicId(), floor);
            // 【v2.7.4 修复 d6a2816c L3】仅当本帖有未读楼层真正被读过时才标记「已浏览」
            if (!this.topicViewedMarked) {
              this.topicViewedMarked = true;
              this.history.markTopicViewed(getCurrentTopicId());
              this.onStatsUpdate?.();
            }
          }
          this.onStatsUpdate?.();

          if (CONFIG.minReadTime > 0) {
            // 阅读停留按楼层正文长度估算（并施加偏态扰动），写入 /topics/timings 的
            // 时长与内容量挂钩，服务端看到的是「人在读帖」而非恒定均匀节奏
            const cooked = post.querySelector('.cooked');
            const textLen = cooked ? cooked.textContent.trim().length : 0;
            const base = contentReadDelay(textLen);
            await humanDelay(base, Math.round(base * 1.3) + 1);
          }

          if (this.shouldLike(post)) {
            await this.tryLikePost(post, postId);
          }
        }
      }
      return newPostFound;
    }

    // 楼层限额判定：默认按绝对楼层号卡（只看前 N 楼）；
    // 开启「只计未读」后改按实际浏览到的未读楼层个数卡，已读楼层滚过不计数。
    // 【v2.7.3 人化翻楼】人化模式下用每日随机抽取的翻楼目标（human_floor_target），
    // 而非用户手设的 floorLimit
    isOverFloorLimit(floor) {
      const limit = humanMode ? humanFloorTarget() : floorLimit;
      if (limit <= 0) return false;
      if (floorLimitUnreadOnly) return this.unreadFloorsRead >= limit;
      return Number.isFinite(floor) && floor > limit;
    }

    shouldLike(postElement) {
      if (!enableLike) return false;
      // 【v2.7.4 修复 d6a2816c M4】点赞时机门槛：进帖未满 4 秒、或帖子还没滚过/读完
      // （首屏之外还有内容且没滚动）时不点赞——真人不可能点开帖子 1~3 秒、内容未看就
      // 决定点赞。一屏就能读完的短帖（maxFloorSeen 已达总楼数）不受滚动门槛限制。
      // 注意: enteredAt 在 start() 创建浏览器实例时记录，短帖读完时一般已超 4 秒
      if (Date.now() - this.enteredAt < 4000) return false;
      const fullySeen = this.topicTotalPosts > 0 && this.maxFloorSeen >= this.topicTotalPosts;
      if (this.scrollsDone < 1 && !fullySeen) return false;
      // 【v2.7.3 修复】429 限流冷却期内跳过点赞（handleLikeLimit 写入 like_disabled_until，
      // 30 分钟自动恢复；冷却期内即使开关开着也不点赞，避免继续触发风控）
      if (Date.now() < (parseInt(Storage.get('like_disabled_until', 0), 10) || 0)) return false;
      // 只赞主帖：跳过回复楼层（Discourse 楼主帖的 article id 恒为 post_1）
      if (likeMainOnly && postElement && postElement.id !== 'post_1') return false;
      if (CONFIG.maxLikesPerSession > 0 && this.history.sessionLiked >= CONFIG.maxLikesPerSession) return false;
      const now = Date.now();
      const elapsed = now - this.lastLikeTime;
      // 【反检测 v2.6.9】点赞间隔不再设「绝不下限」的硬门槛：真人的点赞间隔分布里
      // 偶尔会出现 1 秒内的快速连赞（兴奋/手滑），恒定的 >=2000ms 下限本身就是
      // 统计指纹。改为软性：绝大多数维持最小间隔，偶发（约 8%）放行一次快速连赞
      // （400ms 以上即可），过快仍会被 429 风控兜底（handleLikeLimit 临时冷却）
      if (elapsed < CONFIG.minLikeInterval) {
        if (!(elapsed >= 400 && Math.random() < 0.08)) return false;
      }
      // 【v2.7.3 目标自适应】人化模式下按今日目标预算动态抬高点赞概率：剩余赞数 /
      // 剩余浏览目标（帖），算「每帖还需点几个赞」的平均需求，与每帖抽签概率取大者——
      // 目标 12 赞/30 帖时平均需求 0.4，若只按基础抽签（均值约 13.5%）要读 90 帖才能点满，
      // 按需求加成后 30 帖左右就能达成，也符合「浏览目标内自然点满」的人设
      if (humanMode) {
        const likeGoal = CONFIG.maxLikesPerSession;    // 人化下 = humanLikeTarget()，0=不限
        const topicGoal = CONFIG.maxTopicsPerSession;  // 人化下 = humanTopicTarget()，0=不限
        if (likeGoal > 0 && topicGoal > 0) {
          const remainingLikes = Math.max(0, likeGoal - this.history.sessionLiked);
          const remainingTopics = Math.max(1, topicGoal - this.history.sessionViewed);
          const needed = clamp(remainingLikes / remainingTopics, 0, 0.6);
          return Math.random() < Math.max(CONFIG.likeChance, needed);
        }
      }
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
        // 反检测：点赞前「思考」停顿换成偏态人化延迟，并偶发（约 10%）一次明显的
        // 「犹豫/重新考虑」长停顿——真人在点开赞前常会悬停考虑一下
        if (Math.random() < 0.10) {
          await humanDelay(1500, 3000);
        }
        await humanDelay(300, 900);

        // 【反检测 v2.7.0】点赞一律走「点击页面真实按钮」：由页面自身 JS 发出带完整
        // 头部的原生请求，与真人点击产生的网络流量完全一致（机器人直接 fetch 会暴露
        // 非浏览器指纹的特征）。按钮缺失（罕见）才退回 API 兜底。
        const clicked = await this.clickLikeButton(postElement);
        let result;
        if (clicked.success) {
          // 点击成功（或本就已赞）：直接记成功，绝不再发 toggle 取消它
          result = { success: true };
        } else if (clicked.noButton) {
          // 页面没有点赞按钮：退回 API 直连兜底
          result = await this.sendLikeRequest(actualPostId);
        } else {
          // 有点赞按钮但点击/确认失败：静默跳过本次，不盲发 toggle
          // （第二次 toggle 会取消掉可能已经成功的真实点击，造成双倍请求与 429）
          return false;
        }

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

    // 【v2.7.0 反检测】点击页面真实的反应按钮（而非机器人自己发 fetch）。
    // 参考 dosss bot_core.py do_like（querySelectorAll('button.btn-toggle-reaction-like')
    // → filter 掉 has-like/my-likes → target.click()）与 linuxdo-checkin click_like
    // （.discourse-reactions-reaction-button → click()）：找到按钮后由页面自身 JS
    // 发出原生请求，网络流量与真人点击完全一致，不暴露 fetch 包装特征。
    // 返回 { success, rateLimited, noButton }：
    //   success=true  -> 已确认点赞（或本就处于已赞态），调用方直接记成功
    //   noButton=true  -> 页面根本没有点赞按钮，调用方退回 sendLikeRequest 兜底
    //   success=false  -> 点击/确认失败，调用方静默跳过（绝不盲发 toggle，
    //                     那会取消掉可能已经成功的真实点击）
    async clickLikeButton(postElement) {
      try {
        const btns = Array.from(postElement.querySelectorAll(
          'button.btn-toggle-reaction-like, button.discourse-reactions-reaction-button, button[title="点赞此帖子"], button[title="Like this post"]'
        ));
        if (!btns.length) return { success: false, noButton: true };
        // 过滤已赞按钮：按钮自身或最近 .post 容器带 has-like / my-likes / liked class
        const candidates = btns.filter(btn => {
          const post = btn.closest('.post');
          const reactBtn = btn.closest('.discourse-reactions-reaction-button');
          const s = `${btn.className} ${post ? post.className : ''} ${reactBtn ? reactBtn.className : ''}`;
          return !/(has-like|my-likes|liked|has-reacted|has-used-main-reaction)/i.test(s);
        });
        // 候选全被滤掉 = 该帖本就被赞过（或按钮全部带已赞态）：直接按已赞处理，避免误 toggle
        if (!candidates.length) return { success: true, already: true, noButton: false };
        const btn = candidates[Math.floor(Math.random() * candidates.length)];
        // 模拟真人：滚动到视野中央 → 悬停 → 点击
        btn.scrollIntoView({ block: 'center', behavior: 'smooth' });
        await humanDelay(300, 900);
        // 【v2.7.1 人化】「点赞犹豫」：约 30% 概率先滚动离开按钮（像滑走再看一眼
        // 楼上的内容、或斟酌要不要点），再滑回来完成点击——真人很少一看到按钮就
        // 立刻机械点下，偶发的「先走再回」是典型的真人手部动作模式
        if (Math.random() < 0.3) {
          const away = randomInt(120, 320);
          window.scrollBy({ top: -away, behavior: 'smooth' });
          await humanDelay(700, 1600);
          btn.scrollIntoView({ block: 'center', behavior: 'smooth' });
          await humanDelay(400, 900);
        }
        btn.click();
        // 【v2.7.3 修复】点击后每 300ms 轮询确认，最长 ~3s：
        // 已赞态 (has-reacted/has-used-main-reaction) 由 discourse-reactions 插件加在
        // 外层 .discourse-reactions-actions 容器上（与 watchManualLikes 观察的同源节点），
        // 而非按钮或 .post 本身——旧代码查错节点导致「点了成功却判失败」，进而退回
        // sendLikeRequest toggle 把刚点的赞取消掉，造成双倍请求和 429。
        const likedState = () => {
          const container = postElement.querySelector('.discourse-reactions-actions');
          const containerCls = container ? container.className : '';
          if (/(has-reacted|has-used-main-reaction|has-like|my-likes|liked)/i.test(containerCls)) return true;
          // 标准 Discourse 点赞按钮（无 reactions 插件）：已赞态直接落在按钮上
          const freshBtn = postElement.querySelector(
            'button.btn-toggle-reaction-like, button.discourse-reactions-reaction-button, button[title="点赞此帖子"], button[title="Like this post"]'
          );
          return !!(freshBtn && /(has-like|my-likes|liked|has-reacted|has-used-main-reaction)/i.test(freshBtn.className));
        };
        let liked = likedState();
        const deadline = Date.now() + 3000;
        while (!liked && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 300));
          liked = likedState();
        }
        // 点了真实按钮（即便 3s 内没能确认）：也按成功返回，调用方记成功——真实点击的
        // 请求已经发出，绝不能再发 toggle 去取消它；确认不到多半是 Ember 渲染延迟
        return { success: true, confirmed: liked, noButton: false };
      } catch (e) {
        return { success: false, noButton: false };
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
      // 反检测：离帖前偶发「读完最后一段再走」的逗留（约 15% 概率多停 2~4s），
      // 避免每次都精确等上固定延迟就立刻跳走，暴露机械节奏
      if (Math.random() < 0.15) {
        await humanDelay(2000, 4000);
      }
      await humanDelay(CONFIG.returnToListDelay, CONFIG.returnToListDelay * 1.5);
      // 回到进入话题前的浏览目标（分区页或全站列表）：列表浏览器跳转前已把来源路径存进 Storage
      const returnUrl = Storage.get('session_return_path', '') || getDefaultBrowsePath();
      // 【反检测 v2.6.9】返回列表优先走 Ember SPA（history.back 触发 popstate 客户端路由，
      // 服务端看不到整页 HTML 请求）；仅当本页确实是从列表 SPA 进来的（点击被 Ember 拦截、
      // URL 变化且页面未销毁——由 navigateViaLinkClick 在兜底检查里置位 _spaEntry）才用它，
      // 否则退回整页跳转（等价 v2.6.8 行为，安全兜底）。真人「读完帖点浏览器←」就是这样。
      if (window._ldSpaEntry) {
        window._ldSpaEntry = false;
        window.history.back();
        // 后置校验：2s 内若 URL 没回到列表页（异常历史），强制整页兜底
        const beforeUrl = window.location.href;
        setTimeout(() => {
          try {
            if (getPageType() !== 'list') window.location.href = returnUrl;
          } catch (e) {
            if (window.location.href === beforeUrl) window.location.href = returnUrl;
          }
        }, 2000);
      } else {
        window.location.href = returnUrl;
      }
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
      // 【v2.7.4】连续空 DOM / 连续出错的计数：防止「吞错无界空转」和「空 DOM 被误标为已扫」
      this.emptyPassCount = 0;
      this.errorCount = 0;
      this.everFoundTopics = false;
      // 已扫过的列表集合：从实际路径推导（当前页）并叠加本会话早前扫过的列表。
      // 集合跨整页跳转持久化（键带会话 epoch），否则每跳转一次就丢，轮换会退化成
      // latest↔unread 交替空转，永远扫不到中间的 new
      const currentListKey = getCurrentListFromPath();
      const savedEpoch = Storage.get('session_scanned_lists_epoch', 0);
      this.scannedLists = new Set(
        savedEpoch === this.history.sessionEpoch ? Storage.get('session_scanned_lists', []) : []
      );
      // 【v2.7.4 修复 8be112f0 M2】当前页不在任何浏览目标（getCurrentListFromPath 返回 null）
      // 时不标记任何列表为已扫：路径不是目标时不该消费掉一个目标列表的轮换名额
      if (currentListKey) this.scannedLists.add(currentListKey);
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
            await humanDelay(CONFIG.loadWaitTime, CONFIG.loadWaitTime * 1.2);
            if (!this.scrollController.hasNewContent()) {
              if (this.scrollController.isContentFullyLoaded()) {
                // 【v2.7.4】空 DOM 保护：本轮从头到尾没见到任何话题行（SPA 正在渲染 /
                // 网络慢 / 页面没生成列表）时不能把该列表标成「已扫」直接换走——
                // 会漏掉整列表。emptyPassCount 由 findAndEnterUnviewedTopic 累积，
                // 连扫 5 次仍为空才认定确实没内容，允许换列表
                if (this.emptyPassCount < 5 && !this.everFoundTopics) {
                  await humanDelay(1500, 2500);
                  continue;
                }
                await this.switchToAnotherList();
                return;
              }
            }
          }

          await this.scrollController.scrollDown();
          await humanDelay(CONFIG.scrollInterval, CONFIG.scrollInterval * 1.2);
          found = await this.findAndEnterUnviewedTopic();
          this.errorCount = 0; // 成功走完一轮，清零错误计数
        } catch (error) {
          // 【v2.7.4】连续出错上限：原先吞掉一切错误无限循环，页面异常时会闷头空转
          this.errorCount++;
          if (this.errorCount >= 5) {
            log(`列表浏览连续出错 ${this.errorCount} 次，本轮结束`);
            this.stop();
            this.onFinished?.('列表出错');
            return;
          }
          await humanDelay(2000, 3000);
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

      // 【v2.7.4】DOM 里一个话题行都没有（页面未渲染/SPA 加载中）记一次空扫，
      // 下次见到真实行就清零——供 start() 判定是否「空列表值得换走」
      if (topicRows.length === 0) {
        this.emptyPassCount++;
      } else {
        this.emptyPassCount = 0;
        this.everFoundTopics = true;
      }

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
      await humanDelay(300, 600);

      log(`进入话题: ${pick.topicId}${pick.unread ? '（未读）' : ''}`);
      // 记住来源列表页（分区页或全站列表），话题页读完返回时跳回这里
      Storage.set('session_return_path', window.location.pathname);
      // 【反检测 v2.6.9】真人点话题是 Ember 客户端路由（SPA：pushState + XHR 拉
      // /t/topic/{id}.json，服务端看不到整页 HTML 请求）；整页 location.href 跳转
      // 会在访问日志里留下「全站浏览零 JSON 全整页」的强指纹。改为点击真实链接：
      // 被 Ember 拦截则 SPA 跳转（URL 变化由 checkUrlChange 接管换浏览器）；
      // 未被拦截则浏览器照常整页导航（等价 location.href）；点击无效则兜底整页跳转。
      // target 属性强制 _self，避免链接带 _blank 时开新标签导致本页流程悬空
      navigateViaLinkClick(pick.titleLink, pick.titleLink.href);
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
      await humanDelay(1000, 2000);
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
      this.stuckTimeout = 60000; // 【v2.7.4】30s 阈值太薄：人化最长停顿（阅读/分心）可达 17s+，叠加加载等待易误判卡死
      this.lastUrl = window.location.href;
      this.urlCheckInterval = null;
      this.schedTimer = null;
      // 【v2.7.4 修复 8be112f0 H2】浏览器世代令牌：checkStuck.restartBrowsing 与
      // checkUrlChange.handlePageTypeChange 可能并发各自创建一个 Topic/ListBrowser，
      // 导致楼层双计/重复点赞/onFinished 被调用两次。每次 runBrowserFor 递增世代，
      // 旧世代的浏览器在 start() 返回后若发现已被取代则立即停掉，其 onFinished 也
      // 只在仍是最新世代时才放行 finishRun
      this.runGeneration = 0;
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
      // 单次时长上限：跑满设定分钟数就收工（0=不限）。
      // 【v2.7.0 人化随机】人化模式下时长由 human_duration 定死接管（用户填的时长上限被隐藏）
      const limitMin = humanMode ? humanDurationMin() : maxMinutes;
      if (limitMin > 0) {
        const elapsedMin = (Date.now() - this.startTime) / 60000;
        if (elapsedMin >= limitMin) {
          log(`达到单次时长上限（${limitMin} 分钟），本轮结束`);
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
      // 【v2.7.4 修复 8be112f0 H2】世代令牌：本次启动的浏览器只有在仍是最新世代时
      // 才允许收尾（onFinished → finishRun），旧世代因并发重启而残留的浏览器收尾时
      // 不会误杀新一代；创建新浏览器前先停掉旧对象，防止两个浏览器并存运行
      const gen = ++this.runGeneration;
      const onUpdate = () => {
        this.updateStats();
        this.heartbeat();
      };
      const onFinished = (reason) => {
        if (gen === this.runGeneration) this.finishRun(reason);
      };
      if (pageType === 'topic') {
        this.topicBrowser?.stop();
        const browser = new TopicBrowser(this.history, onUpdate, onFinished);
        this.topicBrowser = browser;
        await browser.start();
        // 等待期间被更新的世代取代（并发重启/换页）：停掉这个过时的浏览器
        if (gen !== this.runGeneration) {
          this.topicBrowser?.stop();
          return;
        }
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
        this.listBrowser?.stop();
        const listBrowser = new TopicListBrowser(this.history, onUpdate, onFinished);
        this.listBrowser = listBrowser;
        await listBrowser.start();
        // 【v2.7.4 修复 8be112f0 H2】同上的世代检查：被并发重启取代则停掉并退出
        if (gen !== this.runGeneration) {
          this.listBrowser?.stop();
          return;
        }
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
        await humanDelay(3000, 5000);
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
      await humanDelay(1000, 1500);
      // 【v2.7.4】延迟期间可能已被用户手动停止，或上一轮因超时/达成目标已收工；
      // 不复查 isEnabled 会把已停止的控制器重新拉起来
      if (!this.isEnabled) return;
      this.heartbeat();

      try {
        await this.runBrowserFor(newPageType);
      } catch (error) {
        if (!this.isEnabled) return;
        await humanDelay(2000, 3000);
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

        // 如果在90秒内有其他标签页活动，且不是当前标签页，放弃自启
        // （与 start() 的多开租约阈值保持一致；旧 15s 只覆盖短心跳窗口，后台标签页
        // 节流时会被误判为「无活跃」而重复自启）
        if (Date.now() - lastActiveTime < 90000 && activeTabId !== TAB_ID) {
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
          // 【v2.7.4】二次校验：800ms 延迟期间其他标签页可能已拿锁，
          // start() 内部会对所有启动路径重做一次多开检查（90s 租约），这里不再盲目直启
          if (this.isEnabled) return;
          this.start();
        }, 800);
      }

      // 手动打开话题页：只挂手动点赞监听，不再进帖即标已浏览。
      // 【v2.7.4 修复 d6a2816c L3】进入页面立刻 markTopicViewed 会把「刚点开、还没读」
      // 的话题计入浏览并永久标记为已读，虚增统计；是否算作已浏览改由 TopicBrowser
      // 在读到首个未读楼层时才标记（自动路径），手动路径不抢记
      if (getPageType() === 'topic') {
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

        /* 人化随机模式开关：醒目高亮 */
        #linuxdo-auto-panel .row-human {
          background: linear-gradient(90deg, rgba(91,59,196,0.22), rgba(91,59,196,0.05));
          border: 1px solid rgba(91,59,196,0.45); border-radius: 10px; padding: 7px 9px;
          grid-column: 1 / -1; margin-bottom: 4px;
        }
        #linuxdo-auto-panel .row-human .row-label { color: #cfc0ff; font-weight: 600; }
        #linuxdo-auto-panel .row-human .speed-btn.active { background: #5b3bc4; color: #fff; }

        /* 调试模式：警示色（琥珀）区分于人化的紫色 */
        #linuxdo-auto-panel .row-debug {
          grid-column: 1 / -1; background: linear-gradient(90deg, rgba(214,140,40,0.20), rgba(214,140,40,0.05));
          border: 1px dashed rgba(214,140,40,0.55); border-radius: 10px; padding: 7px 9px; margin-bottom: 4px;
        }
        #linuxdo-auto-panel .row-debug .row-label { color: #ffc46b; font-weight: 600; }
        #linuxdo-auto-panel .row-debug .speed-btn.active { background: #c07a1e; color: #fff; }

        /* 人化专属设置区（开启人化后才显示）：整块纵向堆叠，内部各项各占一行 */
        #linuxdo-auto-panel .row-human-opt {
          grid-column: 1 / -1;
          display: flex; flex-direction: column; align-items: stretch; gap: 7px;
          background: linear-gradient(90deg, rgba(91,59,196,0.16), rgba(91,59,196,0.03));
          border: 1px dashed rgba(91,59,196,0.4); border-radius: 10px;
          padding: 10px 10px 6px; margin-bottom: 4px;
        }
        #linuxdo-auto-panel .row-human-opt-title {
          font-size: 12px; color: #cfc0ff; font-weight: 600;
          letter-spacing: 1px; margin-bottom: 2px;
        }
        #linuxdo-auto-panel .row-human-opt-line {
          display: flex; flex-direction: row; align-items: center; gap: 10px;
          width: 100%; min-width: 0;
        }
        /* 人化专属区的行标签（时段/浏览目标/点赞目标/时长上限）比 2 字长，放宽占位 */
        #linuxdo-auto-panel .row-human-opt-line .row-label { width: auto; min-width: 56px; white-space: nowrap; }
        #linuxdo-auto-panel .row-human-opt-line:hover { background: rgba(91,59,196,0.08); border-radius: 8px; }
        #linuxdo-auto-panel .hr-btn.active { background: #5b3bc4; color: #fff; }

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
      // 【v2.7.4】幂等守卫：setup 在 SPA 会话内可能被再次触发（页面类型切换时脚本
      // 重新注入但 document 未销毁），重复创建会堆出多个面板+重复事件绑定
      const existingPanel = document.getElementById('linuxdo-auto-panel');
      if (existingPanel) {
        existingPanel.remove();
      }
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
            <div class="row row-human"><span class="row-label">人化随机</span><div class="seg">
              <button class="speed-btn human-btn ${humanMode?'active':''}" data-human="true" title="开启后速度/定时/目标/高级设置由人化算法接管，模拟真人（下方被接管项不再显示）">开启</button>
              <button class="speed-btn human-btn ${!humanMode?'active':''}" data-human="false" title="使用下方手动设置">关闭</button>
            </div></div>
            <div class="row-hint">开启后速度档位/具体定时/目标数值/高级设置由人化算法接管（隐藏），下方人化专属设置每日随机抽取；关闭即恢复手动设置</div>
            <div class="row row-debug"><span class="row-label">调试模式</span><div class="seg">
              <button class="speed-btn debug-btn ${debugMode?'active':''}" data-debug="true" title="立即开启人化模式并跳过每日定时等待，马上开始一轮浏览（用于调试/尝鲜，刷新后自动关闭）">开启</button>
              <button class="speed-btn debug-btn ${!debugMode?'active':''}" data-debug="false" title="关闭调试模式">关闭</button>
            </div></div>
            <div class="row-hint">调试模式 = 强制开启人化模式 + 立即开始浏览，跳过「每日时段随机」的等待（刷新页面后自动关闭，人化开关仍由上方控制）</div>
            <div class="row row-human-opt ${humanMode?'':' hidden'}" id="human-options">
              <div class="row-human-opt-title">人化专属设置（开启后生效）</div>
              <div class="row row-human-opt-line"><span class="row-label">时段</span><div class="seg">
                <button class="speed-btn hr-btn ${getHumanTimeRange()==='early'?'active':''}" data-range="early" title="05:00~07:59 内每日随机">清晨</button>
                <button class="speed-btn hr-btn ${getHumanTimeRange()==='morning'?'active':''}" data-range="morning" title="08:00~11:59 内每日随机">上午</button>
                <button class="speed-btn hr-btn ${getHumanTimeRange()==='afternoon'?'active':''}" data-range="afternoon" title="12:00~17:59 内每日随机">下午</button>
                <button class="speed-btn hr-btn ${getHumanTimeRange()==='evening'?'active':''}" data-range="evening" title="18:00~22:59 内每日随机">晚上</button>
                <button class="speed-btn hr-btn ${getHumanTimeRange()==='night'?'active':''}" data-range="night" title="23:00~04:59 内每日随机">深夜</button>
              </div></div>
              <div class="row row-human-opt-line"><span class="row-label">浏览目标</span>
                <input type="number" class="floor-input target-input" id="human-topic-min" min="0" step="1" value="${Storage.get('human_topic_min', 30)}" title="每天在最小~最大之间随机抽一个浏览目标，0=不限">
                <span class="goal-unit">~</span>
                <input type="number" class="floor-input target-input" id="human-topic-max" min="0" step="1" value="${Storage.get('human_topic_max', 50)}" title="每天在最小~最大之间随机抽一个浏览目标，0=不限">
                <span class="goal-unit">帖</span>
              </div>
              <div class="row row-human-opt-line"><span class="row-label">点赞目标</span>
                <input type="number" class="floor-input target-input" id="human-like-min" min="0" step="1" value="${Storage.get('human_like_min', 10)}" title="每天在最小~最大之间随机抽一个点赞目标，0=不限">
                <span class="goal-unit">~</span>
                <input type="number" class="floor-input target-input" id="human-like-max" min="0" step="1" value="${Storage.get('human_like_max', 20)}" title="每天在最小~最大之间随机抽一个点赞目标，0=不限">
                <span class="goal-unit">赞</span>
              </div>
              <div class="row row-human-opt-line"><span class="row-label">翻楼目标</span>
                <input type="number" class="floor-input target-input" id="human-floor-min" min="0" step="1" value="${Storage.get('human_floor_min', 0)}" title="每帖浏览前 N 楼即换帖；每天在最小~最大之间随机抽一个，0=不限（整帖读完）">
                <span class="goal-unit">~</span>
                <input type="number" class="floor-input target-input" id="human-floor-max" min="0" step="1" value="${Storage.get('human_floor_max', 0)}" title="每帖浏览前 N 楼即换帖；每天在最小~最大之间随机抽一个，0=不限（整帖读完）">
                <span class="goal-unit">楼</span>
              </div>
              <div class="row row-human-opt-line"><span class="row-label">时长上限</span>
                <input type="number" class="floor-input target-input" id="human-duration-input" min="0" step="1" value="${Storage.get('human_duration', 60)}" title="本轮最多运行 N 分钟自动停止，0=不限">
                <span class="goal-unit">分钟（0=不限）</span>
              </div>
              <div class="row-hint">人化模式下每天在设定范围内随机抽取今日目标、在所选时段内随机定时（叠加 ±15分~±8小时偏移）；三项目标全 0 时无法开始</div>
            </div>
            <div class="row" id="human-hide-speed"><span class="row-label">速度</span><div class="seg">
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
            <div class="row" id="human-hide-floor"><span class="row-label">楼层</span>
              <input type="number" class="floor-input" id="floor-limit-input" min="0" step="1"
                placeholder="不限" title="每帖只浏览前 N 楼后换下一帖，留空或 0 表示不限">
              <label class="floor-check floor-check-inline" title="开启后已读楼层滚过不计数，只数上次阅读位置之后的新楼层">
                <input type="checkbox" id="floor-unread-only">只计未读
              </label>
            </div>
            <div class="row-hint">填 N 则每帖读到第 N 楼就换下一帖，留空或 0 表示整帖读完；勾选只计未读则不重复数已读楼层</div>
            <div class="row" id="human-hide-schedule"><span class="row-label">定时</span><div class="seg">
              <button class="speed-btn sched-btn ${scheduleEnabled?'active':''}" data-sched="true">开启</button>
              <button class="speed-btn sched-btn ${!scheduleEnabled?'active':''}" data-sched="false">关闭</button>
            </div>
              <input type="time" class="floor-input sched-time" id="sched-time-input" step="60"
                title="每天到这个时间自动开始新一轮浏览；修改时间即自动开启定时">
            </div>
            <div class="row row-goal" id="human-hide-goal"><span class="row-label">目标</span>
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
          <div id="human-hide-advanced">
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
            <div class="stats-row"><span class="stats-label">人化随机</span><span class="stats-value" id="human-status">${humanMode ? '已开启' : '未开启'}</span></div>
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
      // 【v2.7.4】移除 .list-btn 死绑定：面板 HTML 里并不存在 .list-btn 元素，
      // 这段查询永远命中 0 个节点（cf74d325 L1），留着一个「看起来能用」的死钩子误导维护
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
      document.querySelectorAll('.human-btn[data-human]').forEach(btn => btn.addEventListener('click', (e) => {
        setHumanMode(e.target.dataset.human === 'true');
      }));

      // 调试模式：开启时强制人化 + 立即开始（跳过每日定时等待），刷新后自动关闭
      document.querySelectorAll('.debug-btn[data-debug]').forEach(btn => btn.addEventListener('click', (e) => {
        const on = e.target.dataset.debug === 'true';
        setDebugMode(on);
        if (!on) return;
        if (this.isEnabled) {
          log('调试模式：已在浏览中，人化参数已即时生效');
        } else {
          log('调试模式：立即开始一轮人化浏览（跳过每日定时等待）');
          this.start(true, true);
        }
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
        // 【v2.7.4 修复 cf74d325 L3】改时间不再强制开启定时：仅按当前开关状态保存新时间，
        // 定时是否启用完全由「开启/关闭」按钮决定——否则用户只是顺手调一下时间，
        // 定时却被悄悄打开，次日到点自动开始（面板可见状态与实际行为不一致）
        setSchedule(scheduleEnabled, e.target.value);
        e.target.value = scheduleTime;
        this.updateSchedStatus();
      });

      // 人化专属设置：时段按钮 + 目标范围 min~max + 时长上限
      document.querySelectorAll('.hr-btn[data-range]').forEach(btn => btn.addEventListener('click', (e) => {
        setHumanTimeRange(e.target.dataset.range);
      }));
      const bindHumanRangeInputs = (minId, maxId, prefix, label) => {
        const minEl = document.getElementById(minId);
        const maxEl = document.getElementById(maxId);
        const apply = () => {
          setHumanGoalRange(prefix, minEl.value, maxEl.value);
          this.updateSchedStatus();
        };
        [minEl, maxEl].forEach(el => {
          el.addEventListener('keydown', (e) => e.stopPropagation());
          el.addEventListener('change', apply);
        });
      };
      bindHumanRangeInputs('human-topic-min', 'human-topic-max', 'topic', '浏览');
      bindHumanRangeInputs('human-like-min', 'human-like-max', 'like', '点赞');
      bindHumanRangeInputs('human-floor-min', 'human-floor-max', 'floor', '翻楼');
      const humanDurationInput = document.getElementById('human-duration-input');
      humanDurationInput.addEventListener('keydown', (e) => e.stopPropagation());
      humanDurationInput.addEventListener('change', (e) => {
        setHumanDuration(e.target.value);
        e.target.value = Number(e.target.value) > 0 ? e.target.value : '';
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
          // 【v2.7.0 人化随机】人化模式下倒计时用接管后的时长上限
          const limitMin = humanMode ? humanDurationMin() : maxMinutes;
          if (limitMin <= 0) {
            remainEl.textContent = '不限';
          } else if (this.isEnabled && this.startTime) {
            const remainMs = limitMin * 60000 - (Date.now() - this.startTime);
            remainEl.textContent = formatRemain(remainMs);
          } else {
            remainEl.textContent = formatRemain(limitMin * 60000);
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

      // 按已存的人化开关状态应用面板显隐（隐藏被接管行、显示人化专属设置区）
      syncPanelHumanVisibility();
      this.updateSchedStatus();
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
      // 【v2.7.0 人化随机】人化模式下进度按今日接管目标（范围随机结果）显示
      const gp = document.getElementById('goal-progress');
      if (gp) {
        const effT = humanMode ? humanTopicTarget() : topicTarget;
        const effL = humanMode ? humanLikeTarget() : likeTarget;
        const t = effT > 0 ? `${stats.sessionViewed}/${effT} 帖` : `已刷 ${stats.sessionViewed} 帖`;
        const l = effL > 0 ? `${stats.sessionLiked}/${effL} 赞` : `已赞 ${stats.sessionLiked}`;
        gp.textContent = `${t} · ${l}`;
      }
      this.updateSchedStatus();
    }

    // 手动点赞也计入本次点赞数：用户自己点掉的赞（或取消后重赞）实时反映到会话计数。
    // 只监听 class 变化（已反应状态由 discourse-reactions 插件加在 .discourse-reactions-actions
    // 容器上，类名含 reacted）。
    // 【v2.7.4 修复 d700e51f L6】用基线法区分「用户点击」与「插件/框架重渲染」：
    // 每条帖子记录最近一次观察到的 reacted 状态，只有 未赞→已赞（false→true 迁移）
    // 才算一次新赞。Discourse/Ember 重渲染会把 reacted 类反复重放一遍，直接数
    // 「出现 reacted」会把同一次点赞计数多次；用迁移判定后重渲染不产生新计数。
    // 机器人自动点赞走 tryLikePost 成功后 markPostLiked，天然去重，不会与这里重复计数。
    watchManualLikes() {
      if (typeof MutationObserver === 'undefined') return;
      this._manualLikeBaseline = new Map();
      // 初始基线：扫一遍当前已渲染的反应容器。首见只记录现状，不计数——
      // 避免把历史已点赞帖（一进页就带 reacted）误计为本会话新赞。
      document.querySelectorAll('.discourse-reactions-actions').forEach((el) => {
        const article = el.closest ? el.closest('article[id^="post_"]') : null;
        if (!article || !article.dataset || !article.dataset.postId) return;
        const cls = typeof el.className === 'string' ? el.className : '';
        this._manualLikeBaseline.set(String(article.dataset.postId), /reacted/i.test(cls));
      });
      this._manualLikeObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.type !== 'attributes' || mutation.attributeName !== 'class') continue;
          const target = mutation.target;
          if (!target || target.nodeType !== 1) continue;
          const cls = typeof target.className === 'string' ? target.className : '';
          if (!cls.includes('discourse-reactions-actions')) continue;
          const article = target.closest ? target.closest('article[id^="post_"]') : null;
          if (!article || !article.dataset || !article.dataset.postId) continue;
          const actualPostId = String(article.dataset.postId);
          const nowReacted = /reacted/i.test(cls);
          // 首次观察到这条帖子（比如帖子刚被懒加载插入）：记录现状作基线，不计数
          if (!this._manualLikeBaseline.has(actualPostId)) {
            this._manualLikeBaseline.set(actualPostId, nowReacted);
            continue;
          }
          const wasReacted = this._manualLikeBaseline.get(actualPostId);
          this._manualLikeBaseline.set(actualPostId, nowReacted);
          // 只有 未赞→已赞 的迁移是「用户刚点了个赞」；已赞→未赞是取消点赞，不算
          if (!wasReacted && nowReacted) {
            if (this.history.isPostLiked(actualPostId)) continue;
            this.history.markPostLiked(actualPostId);
            log(`检测到手动点赞帖子 (id=${actualPostId})`);
          }
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
      // 【v2.7.0 人化随机】人化模式下用接管后的目标（今日范围内随机 / human_duration 定死）判断
      const effTopics = humanMode ? humanTopicTarget() : topicTarget;
      const effLikes = humanMode ? humanLikeTarget() : likeTarget;
      const effMinutes = humanMode ? humanDurationMin() : maxMinutes;
      if (effTopics <= 0 && effLikes <= 0 && effMinutes <= 0) {
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
      // 【v2.7.4 人化】会话起始日钉住：跨零点运行期间每日参数不重摇（见 ensureDailyProfile）
      sessionPinnedDay = this.todayKey();

      // 多开检查对所有启动路径生效（手动 / 定时 / 自动恢复）：另一标签页还在活跃租约内
      // （90 秒心跳超时为失效）且拥有锁时，提醒或放弃，避免两个页面同时抓同一批帖子
      const lastActiveTime = Storage.get('linuxdo_active_tab_time', 0);
      const activeTabId = Storage.get('linuxdo_active_tab_id', null);
      const otherRunning = Date.now() - lastActiveTime < 90000 &&
        activeTabId !== TAB_ID && Storage.get('auto_running', false);
      if (otherRunning) {
        if (isManual) {
          if (!confirm('⚠️ 警告：检测到后台已有其他页面正在自动浏览。\n\n如果在多页同时运行可能会导致浏览器卡死。强制接管此页码？')) {
            return;
          }
        } else {
          log('检测到其他标签页正在运行（心跳有效期内），本页放弃自动开始');
          return;
        }
      }

      this.isEnabled = true;
      // 【v2.7.4】调试模式驱动的运行不写 auto_running：调试是「验一眼人化行为」的临时动作，
      // 落盘的话刷新页面会触发 autoResume 复跑一轮完整浏览（cf74d325 L5）
      Storage.set('auto_running', !debugMode);
      this.heartbeat();
      this.startTime = Date.now();

      document.getElementById('btn-auto-start').style.display = 'none';
      document.getElementById('btn-auto-stop').style.display = 'block';
      document.getElementById('auto-status').textContent = '运行中';
      document.getElementById('status-dot').className = 'status-indicator running';
      this.panel.classList.add('running');

      // 【v2.7.4 反误抢锁】独立心跳定时器：不再只靠「动作事件里顺手 heartbeat」。
      // 读长帖/等待加载时动作稀疏，若两标签页皆后台节流，租约会被误判失效互相抢锁；
      // 运行期间每 10 秒主动刷新一次租约，stop 时销毁
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => this.heartbeat(), 10000);

      this.startStuckDetection();
      this.startUrlWatcher();

      try {
        await this.runBrowserFor(getPageType());
      } catch (error) {
        if (this.isEnabled) {
          document.getElementById('auto-status').textContent = '出错，重试中...';
          await humanDelay(5000, 8000);
          if (this.isEnabled) this.restartBrowsing();
        }
      }
    }

    stop() {
      this.isEnabled = false;
      Storage.set('auto_running', false);
      Storage.set('linuxdo_active_tab_time', 0); // 释放占用锁
      sessionPinnedDay = ''; // 【v2.7.4】解除会话起始日钉住，跨天重摇恢复生效

      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
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
      // 定时总开关对所有模式生效：关闭后普通/人化都不再自动启动
      // （人化模式打开时若此前定时未开启，由 setHumanMode 一并打开总闸，保证人化接管仍开箱即用）
      if (!scheduleEnabled) return;
      if (this.isEnabled) return;
      const todayKey = this.todayKey();
      if (Storage.get('sched_last_run_date', '') === todayKey) return;

      // 【v2.7.4 修复 d700e51f M3】跨午夜连环触发防护：上一轮刚结束（60 分钟内）不立即
      // 再触发——23:50 那轮跑到次日凌晨 00:05 结束后，次日 profile 若抽到凌晨档 base，
      // 会落进 catchup 窗口被立刻拉起新一轮并提前消费当天配额（白噪声指纹 + 配额错位）
      const lastFinish = parseInt(Storage.get('sched_last_finish_at', 0), 10) || 0;
      if (lastFinish > 0 && Date.now() - lastFinish < 60 * 60000) return;

      const now = new Date();
      const nowMin = now.getHours() * 60 + now.getMinutes();
      const nowSec = nowMin * 60 + now.getSeconds();
      let targetMin;   // 原始目标分钟（可越界：<0 属昨天晚些时候，>=1440 属明天凌晨）
      let catchupMin;  // 目标时刻之后的「补跑」窗口（分钟）：真人会因作息漂移晚几分钟，不会晚几小时
      let schedDesc = scheduleTime;

      if (humanMode) {
        // 人化模式：定时被人化接管——当天基准时刻在所选时段内随机（human_sched_base），
        // 再叠加大偏移（human_sched_offset，±15分~±8小时）。不读用户填写的具体时间。
        ensureDailyProfile();
        const base = parseInt(Storage.get('human_sched_base', 1080), 10);
        const off = parseInt(Storage.get('human_sched_offset', 0), 10);
        targetMin = base + off;          // 不再 0~1439 钳死（23:59 提前触发的根源）
        catchupMin = 120;                // 目标时刻后 2 小时内上线都算「正常」
        const bhh = String(Math.floor(base / 60)).padStart(2, '0');
        const bmm = String(base % 60).padStart(2, '0');
        schedDesc = `基准 ${bhh}:${bmm} 偏移 ${off >= 0 ? '+' : ''}${off} 分`;
      } else {
        // 普通模式：设定时间 + 每天 0~5 分钟均匀抖动（精确到秒、每天同一瞬间启动是定时任务指纹）
        const [hh, mm] = String(scheduleTime).split(':').map(Number);
        const jitterDay = Storage.get('sched_jitter_day', '');
        let jitterMin = parseInt(Storage.get('sched_jitter_min', '-1'), 10);
        if (jitterDay !== todayKey || !(jitterMin >= 0 && jitterMin <= 5)) {
          jitterMin = randomInt(0, 5);
          Storage.set('sched_jitter_day', todayKey);
          Storage.set('sched_jitter_min', jitterMin);
        }
        targetMin = hh * 60 + mm + jitterMin;
        catchupMin = 30;                 // 过了设定时间 >30 分钟不补跑（真人不会迟到半小时才上线）
        schedDesc = `${scheduleTime} + ${jitterMin} 分抖动`;
      }

      // 越界目标归一化到「今天」的那一次出现时刻：深夜/跨午夜档的 base 落 0~299 分即次日凌晨，
      // 这里换算成本日对应钟点（01:40 / 03:00…），而不是把 23:59 当成今天的出现
      const todayTarget = ((targetMin % 1440) + 1440) % 1440;

      // 还没到点：今天晚些时候再看
      if (nowMin < todayTarget) return;

      // 目标时刻已过去太久：视为真人「今天已来过/错过」，不补跑（修复开页即触发的 22 小时提前）
      if (nowMin - todayTarget > catchupMin) return;

      // 启动瞬间再随机 0~90 秒：每次都在整分/30 秒边界精确启动也是定时任务指纹
      const fireDay = Storage.get('sched_fire_day', '');
      let fireOffset = parseInt(Storage.get('sched_fire_offset', '-1'), 10);
      if (fireDay !== todayKey || !(fireOffset >= 0 && fireOffset <= 90)) {
        fireOffset = randomInt(0, 90);
        Storage.set('sched_fire_day', todayKey);
        Storage.set('sched_fire_offset', fireOffset);
      }
      if (nowSec < todayTarget * 60 + fireOffset) return;

      // 其他标签页可能在运行：交给那个页面自然收尾；心跳超过 90 秒视为已失效可接管
      // （后台标签页定时器会被浏览器节流到 1 分钟级，15 秒租约太短会互相抢锁）
      if (Storage.get('auto_running', false) &&
          Date.now() - Storage.get('linuxdo_active_tab_time', 0) < 90000) return;

      // 目标全为 0（浏览/点赞/时长全不限）时不再消费当日配额：
      // 否则 start() 内部会跳过开始，但这里已提前写掉 sched_last_run_date，全天被静默吞掉
      const effGoals = humanMode
        ? (humanTopicTarget() > 0 || humanLikeTarget() > 0 || humanDurationMin() > 0)
        : (topicTarget > 0 || likeTarget > 0 || maxMinutes > 0);
      if (!effGoals) return;

      Storage.set('sched_last_run_date', todayKey);
      log(`⏰ 每日定时触发（${schedDesc}），自动开始新一轮浏览`);
      this.start(false, true);
    }

    // 本轮结束的统一收尾点：彻底停止并记录结束原因，
    // 避免「只停列表浏览器但自动化仍运行」导致卡死检测 30 秒后反复重启空转
    finishRun(reason) {
      // 【v2.7.4 修复 8be112f0 H2】幂等守卫：stop() 会把 isEnabled 置 false，
      // 收尾只允许「确实在运行中」的这一次执行——并发重启/换页产生的旧世代浏览器
      // 即使绕过世代令牌（runBrowserFor 的 onFinished）再回调 finishRun，也不会重复收尾
      if (!this.isEnabled) return;
      this.stop();
      this.history.flushPending();
      Storage.set('auto_finish_reason', reason);
      // 【v2.7.4 修复 d700e51f M3】记录本轮结束时刻：checkSchedule 用它做 60 分钟冷却，
      // 防止跨午夜连环触发（23:50 那轮跑到次日凌晨 00:05 结束后，次日凌晨档 base 落
      // catchup 窗口内又被立即拉起一轮、并提前消费当天配额）
      Storage.set('sched_last_finish_at', Date.now());
      document.getElementById('auto-status').textContent = `已结束：${reason}`;
      log(`本轮结束：${reason}`);
    }

    // 面板上展示定时与目标配置的当前状态
    updateSchedStatus() {
      const el = document.getElementById('sched-status');
      if (!el) return;
      // 【v2.7.0 人化随机】人化模式下显示接管后的今日目标（范围随机结果/定死时长）
      let display;
      if (humanMode) {
        ensureDailyProfile();
        const tt = humanTopicTarget();
        const lt = humanLikeTarget();
        const ft = humanFloorTarget();
        const dm = humanDurationMin();
        const remain = tt > 0 ? tt : '不限';
        const likes = lt > 0 ? lt : '不限';
        const floors = ft > 0 ? `前${ft}楼` : '不限';
        const minutes = dm > 0 ? `${dm} 分` : '不限';
        display = `人化接管 · 今日目标 ${remain} 帖 / ${likes} 赞 / 翻楼 ${floors} / ${minutes}`;
      } else {
        const remain = topicTarget > 0 ? topicTarget : '不限';
        const likes = likeTarget > 0 ? likeTarget : '不限';
        const minutes = maxMinutes > 0 ? `${maxMinutes} 分` : '不限';
        display = scheduleEnabled
          ? `${scheduleTime} 自动开始 · 目标 ${remain} 帖 / ${likes} 赞 / ${minutes}`
          : '每日定时关闭';
      }
      el.textContent = display;
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
