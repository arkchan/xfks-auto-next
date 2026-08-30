// ==UserScript==
// @name         xfks 学法考试 · 自动翻页（积分变蓝即点击）
// @namespace    xfks-auto-next-page
// @version      2.0.0
// @description  监控课程页右下角「0.5分」积分徽标：变蓝（本页积分已发、允许翻页）后自动点击右侧翻页箭头；带悬浮状态窗，可暂停/继续、可拖动。
// @match        https://xfks-study.gdsf.gov.cn/study/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';
  if (window.__xfksAutoNext) return; // 防止重复注入
  window.__xfksAutoNext = true;

  // ================= 配置 =================
  const CFG = {
    interval: 800,         // 检查间隔（毫秒）
    cooldown: 5000,        // 点击一次后的冷却时间（毫秒），防止连点
    scorePattern: /^\d+(\.\d+)?\s*分$/, // 积分徽标文字样式，如「0.5分」「1分」
    requireBadge: true,    // true=积分徽标变蓝才点；false=不检查徽标，直接点未禁用的下一页
    fallbackTextNext: true,// 页面上没有积分徽标时，退回「下一页」文字按钮检测
    showPanel: true,       // 右下角悬浮状态窗
  };
  // ========================================

  let running = true;
  let clickCount = 0;
  let lastClickAt = 0;
  let lastBadgeBlue = null;   // null=没找到徽标
  let panel = null, statusEl = null, toggleBtn = null;

  const log = (...a) => console.log('%c[自动翻页]', 'color:#1e80ff;font-weight:bold', ...a);

  // ---------- 颜色 / 状态工具 ----------
  function parseColor(s) {
    const m = /rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(s || '');
    return m ? { r: +m[1], g: +m[2], b: +m[3] } : null;
  }
  // 蓝通道明显高于红、不低于绿 → 视为「蓝色」
  function isBluish(c) {
    return !!c && c.b > c.r + 20 && c.b >= c.g;
  }
  function classesOf(el) {
    return typeof el.className === 'string' ? el.className : '';
  }
  function isVisible(el) {
    return !!(el.offsetParent || el.getClientRects().length) &&
      getComputedStyle(el).visibility !== 'hidden';
  }
  function area(el) {
    const r = el.getBoundingClientRect();
    return r.width * r.height;
  }
  function inDisabledLikeState(el) {
    if (el.disabled) return true;
    if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return true;
    for (let n = el, i = 0; n && i < 3; i++, n = n.parentElement) {
      if (/(disabled|disab|grey|gray|ban|unclick|noallow|not-?allow)/i.test(classesOf(n))) return true;
    }
    const st = getComputedStyle(el);
    if (st.pointerEvents === 'none') return true;
    if (parseFloat(st.opacity) < 0.4) return true;
    return false;
  }

  // ---------- 积分徽标（如「0.5分」） ----------
  function findScoreBadge() {
    let best = null;
    document.querySelectorAll('div,span,p,li,a,i,b,em').forEach(el => {
      if (panel && panel.contains(el)) return;
      const t = (el.textContent || '').replace(/\s+/g, '');
      if (!CFG.scorePattern.test(t) || !isVisible(el)) return;
      // 取面积最小的（最内层节点就是徽标本身）
      if (!best || area(el) < area(best)) best = el;
    });
    return best;
  }
  // 徽标是否变蓝：背景/文字颜色，其次自身与祖先的 blue/active/done 类名
  function badgeIsBlue(el) {
    const st = getComputedStyle(el);
    if (isBluish(parseColor(st.backgroundColor))) return true;
    if (isBluish(parseColor(st.color))) return true;
    if (/(blue|active|done|finish|ok|enable)/i.test(classesOf(el))) return true;
    for (let n = el.parentElement, i = 0; n && i < 3; i++, n = n.parentElement) {
      if (isBluish(parseColor(getComputedStyle(n).backgroundColor))) return true;
      if (/(blue|active|done|finish|ok|enable)/i.test(classesOf(n))) return true;
    }
    return false;
  }

  // ---------- 翻页目标（右侧箭头 / 「下一页」按钮） ----------
  function findNextTargets() {
    const vw = window.innerWidth;
    const vp = vw * window.innerHeight;
    const res = [];
    document.querySelectorAll(
      'a,button,div,span,li,p,i,img,svg,[role="button"],[class*="next" i],[class*="arrow" i],[class*="right" i]'
    ).forEach(el => {
      if (panel && panel.contains(el)) return;
      if (isVisible(el) === false) return;
      if (area(el) > vp * 0.25) return; // 排除大块容器
      const cls = classesOf(el) + ' ' + (el.id || '');
      if (/(prev|left|back|up)/i.test(cls)) return; // 千万别点成上一页
      const txt = (el.textContent || '').trim();
      const isTextNext = txt && txt.length <= 8 && /下一(页|步|章|节|个)/.test(txt);
      const isChevron = /^[>›»❯≫＞]{1,2}$/.test(txt);
      const isIconArrow = /(^|[\s_-])(next|arrow|chevron|btn-?next|page-?next|right-?arrow)/i.test(cls);
      if (!isTextNext && !isChevron && !isIconArrow) return;
      const r = el.getBoundingClientRect();
      // 图标/箭头必须是屏幕右半边的；文字按钮不限位置
      if (!isTextNext && r.left < vw * 0.5) return;
      res.push({ el, score: r.left / vw }); // 越靠右越优先
    });
    return res.sort((a, b) => (b.score - a.score) || (area(a.el) - area(b.el))).map(o => o.el);
  }

  // ---------- 模拟点击 ----------
  function fireClick(el) {
    const r = el.getBoundingClientRect();
    const opts = {
      bubbles: true, cancelable: true, view: window,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    };
    ['mousedown', 'mouseup', 'click'].forEach(t => {
      try { el.dispatchEvent(new MouseEvent(t, opts)); } catch (e) { /* 忽略 */ }
    });
    el.click();
  }

  // ---------- 主循环 ----------
  function tick() {
    if (!running) return;
    const now = Date.now();
    if (now - lastClickAt < CFG.cooldown) return;

    const badge = findScoreBadge();
    lastBadgeBlue = badge ? badgeIsBlue(badge) : null;

    let targets = findNextTargets();
    // 没有积分徽标的页面，退回文字「下一页」检测
    const allowClick = CFG.requireBadge
      ? (lastBadgeBlue === true || (!badge && CFG.fallbackTextNext))
      : true;

    if (allowClick) {
      for (const el of targets) {
        if (inDisabledLikeState(el)) continue;
        fireClick(el);
        clickCount++;
        lastClickAt = now;
        log(`积分已变蓝，已点击翻页，累计 ${clickCount} 次`);
        break;
      }
    }
    updatePanel();
  }

  // ---------- 悬浮窗 ----------
  function buildPanel() {
    panel = document.createElement('div');
    panel.style.cssText =
      'position:fixed;right:16px;bottom:16px;z-index:2147483647;' +
      'background:rgba(20,30,50,.85);color:#fff;font:12px/1.6 "Microsoft YaHei",sans-serif;' +
      'padding:10px 12px;border-radius:8px;min-width:200px;user-select:none;' +
      'box-shadow:0 4px 12px rgba(0,0,0,.25);';
    panel.innerHTML =
      '<div class="xfks-drag" style="cursor:move;opacity:.7;">⇕ xfks 自动翻页（可拖动）</div>' +
      '<div class="xfks-status" style="white-space:pre-line;margin:2px 0 6px;"></div>' +
      '<button class="xfks-toggle" style="cursor:pointer;border:0;border-radius:4px;padding:3px 12px;background:#1e80ff;color:#fff;">暂停</button>';
    document.body.appendChild(panel);
    statusEl = panel.querySelector('.xfks-status');
    toggleBtn = panel.querySelector('.xfks-toggle');
    toggleBtn.addEventListener('click', () => {
      running = !running;
      toggleBtn.textContent = running ? '暂停' : '继续';
      toggleBtn.style.background = running ? '#1e80ff' : '#888';
      updatePanel();
    });
    // 拖动
    const drag = panel.querySelector('.xfks-drag');
    let moving = false, sx = 0, sy = 0, ox = 0, oy = 0;
    drag.addEventListener('mousedown', e => {
      moving = true; sx = e.clientX; sy = e.clientY;
      const r = panel.getBoundingClientRect(); ox = r.left; oy = r.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!moving) return;
      panel.style.left = (ox + e.clientX - sx) + 'px';
      panel.style.top = (oy + e.clientY - sy) + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => { moving = false; });
  }

  function updatePanel() {
    if (!panel) return;
    const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const badgeState = lastBadgeBlue === null
      ? '⚪ 未找到积分徽标'
      : (lastBadgeBlue ? '🔵 已变蓝，可翻页' : '⚪ 灰色，等待积分');
    const state = !running
      ? '状态：已暂停'
      : `徽标：${badgeState}\n已自动翻页 ${clickCount} 次\n最近点击 ${lastClickAt ? t : '—'}`;
    statusEl.textContent = state;
  }

  // ---------- 启动 ----------
  function main() {
    if (CFG.showPanel && document.body) buildPanel();
    setInterval(tick, CFG.interval);
    log(`v2 已启动：每 ${CFG.interval}ms 检查积分徽标，变蓝即点翻页（冷却 ${CFG.cooldown}ms）`);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
})();
