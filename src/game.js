/* =============================================================================
 * game.js — 《提灯者》游戏引擎
 * -----------------------------------------------------------------------------
 * 结构：
 *   1. 参数与全局状态
 *   2. 工具函数（坐标换算、碰撞、时间格式）
 *   3. 关卡加载 / 状态机覆盖层
 *   4. 每帧更新（玩家 → 闸门 → 影障 → 怪物 → 收集与胜负）
 *   5. 每帧渲染（世界 → 黑暗遮罩 → 准星）
 * -----------------------------------------------------------------------------
 * 设计约定（写在这里方便你之后改）：
 *   - 静态墙和闸门是「阻挡物」：本体贴着它们滑行，不会死。
 *   - 怪物和影障是「致命物」：碰到立刻失败。
 *   - 光心在鼠标准星，不在本体：本体只是以 1.6px/帧慢慢追光。
 *   - 光晕既是视野也是冻结场：怪物/影障在光内且无遮挡才会被定住；怪物进光先刹车 0.18s。
 *   - 光照到闸门开关时门打开，光移开后门缓慢关上；门要关时如果玩家站在门里，则保持开启。
 * ========================================================================== */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 1. 参数与全局状态
  // ---------------------------------------------------------------------------
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const overlay = document.getElementById('overlay');
  const hud = {
    stage: document.getElementById('stageLabel'),
    frag: document.getElementById('fragLabel'),
    time: document.getElementById('timeLabel'),
    total: document.getElementById('totalLabel'),
  };

  // 界面文案统一走 i18n.js；脚本缺失时回退原文，游戏逻辑不受影响。
  const L = function (key) {
    if (typeof I18n !== 'undefined' && I18n && typeof I18n.t === 'function') {
      return I18n.t.apply(I18n, arguments);
    }
    return key;
  };

  const STATE = { START: 'START', PLAYING: 'PLAYING', LOSE: 'LOSE', WIN: 'WIN' };

  // 手感参数：想调难度主要改这里。
  const P = {
    // 玩家：平稳追随鼠标光点，速度刻意低于怪物，靠光和地形而非逃跑求生
    playerSpeed: 1.6,      // 本体最大速度，像素 / 帧（60fps 基准）
    playerEase: 0.05,      // 追随插值比例：越小越"拖拽"
    stopDistance: 2,       // 光点离本体小于此距离时停步站立
    walkFrameTime: 0.16,   // 行走两帧的切换周期（秒）
    playerRadius: 5,
    playerDotRadius: 2.2,  // 脚下保留的小白点
    bodyHeadOffset: 21,    // 身体代理：头圆圆心在脚点上方 21px
    bodyHeadRadius: 12,    // 身体代理：头圆半径（只用于撞墙，不影响拾取/受伤）
    patrolSpeed: 1.15,     // 怪物巡逻速度（比追逐慢）
    patrolHome: 130,       // 巡逻活动半径（相对出生点）
    sightRange: 300,       // 怪物最大可视距离
    monsterSpeed: 2.2,     // 比玩家快：光才是武器，逃跑不是
    brakeTime: 0.18,       // 怪物进光后的刹车时长（秒），结束后才冻结
    monsterRadius: 12,
    wallThickness: 7,      // 墙的碰撞厚度（像素），画出来是 2px 的线
    pickupRadius: 14,      // 碎片触碰半径
    exitRadius: 20,
    // 脚印轨迹：每走 footprintGap 像素留一个点，footprintFade 毫秒内线性淡出
    footprintGap: 14,
    footprintFade: 4500,   // 约 4.5 秒淡出
    footprintMax: 48,      // 最多保留的脚印数
    // 怪物红眼 / 抖动：以到老人本体的距离为准，eyeGlowRange 外无效果
    eyeGlowRange: 260,     // 开始渐强的距离
    eyeGlowNear: 60,       // 小于此距离强度封顶为 1
    shakeMax: 2.6,         // 最大抖动幅度（像素，仅视觉）
    loseDelay: 1500,       // 失败后按 R 的冷却，毫秒
    gateOpenRate: 0.035,   // 每帧开度增量
    gateCloseRate: 0.018,
    gateOpenThreshold: 0.55, // 开度 >= 此值才不阻挡
  };

  const monsterImg = new Image();
  monsterImg.src = 'assets/monster.png';

  // 老年冒险家：站立 + 两帧行走；碎片素材
  const adventurerImgs = [new Image(), new Image(), new Image()];
  adventurerImgs[0].src = 'assets/adventurer_standing.png';
  adventurerImgs[1].src = 'assets/adventurer_walk1.png';
  adventurerImgs[2].src = 'assets/adventurer_walk2.png';
  const fragmentImg = new Image();
  fragmentImg.src = 'assets/fragment.png';

  const mask = document.createElement('canvas');
  mask.width = W;
  mask.height = H;
  const mctx = mask.getContext('2d');

  let state = STATE.START;
  let levelIndex = 0;
  let level = null;
  let world = null;
  let totalElapsed = 0;
  let levelElapsed = 0;
  let loseElapsed = 0;
  let lastFrame = 0;
  const target = { x: W / 2, y: H / 2 };

  // ---------------------------------------------------------------------------
  // 2. 工具函数
  // ---------------------------------------------------------------------------
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function formatTime(ms) {
    const t = Math.max(0, ms) / 1000;
    const m = Math.floor(t / 60).toString().padStart(2, '0');
    const s = Math.floor(t % 60).toString().padStart(2, '0');
    const d = Math.floor((t * 10) % 10);
    return `${m}:${s}.${d}`;
  }

  // 网格线段 → 像素矩形（用于碰撞）
  function segmentToRect(seg, cell, thickness) {
    const [x1, y1, x2, y2] = seg;
    const t = thickness / 2;
    if (y1 === y2) {
      const a = Math.min(x1, x2) * cell, b = Math.max(x1, x2) * cell;
      return { x: a - t, y: y1 * cell - t, w: b - a + thickness, h: thickness };
    }
    const a = Math.min(y1, y2) * cell, b = Math.max(y1, y2) * cell;
    return { x: x1 * cell - t, y: a - t, w: thickness, h: b - a + thickness };
  }

  function circleRect(cx, cy, r, rect) {
    const nx = clamp(cx, rect.x, rect.x + rect.w);
    const ny = clamp(cy, rect.y, rect.y + rect.h);
    return (cx - nx) ** 2 + (cy - ny) ** 2 < r * r;
  }

  // 角色尺寸 / 身体代理：随格宽缩放，保证 Stage 3 的窄通道也能通过。
  // 角色画在脚点上方，身体代理圆覆盖头肩，只参与撞墙判定。
  function bodyMetrics() {
    // 上下墙各留 3.5px 半厚 + 2px 余量；角色顶端不能碰到相邻墙
    const h = Math.min(36, level.cell / 2 - 6);
    const total = (h - 6) + 1; // 代理顶端比贴图顶端再多 1px，确保不擦墙
    const headR = total * (P.bodyHeadRadius / (P.bodyHeadOffset + P.bodyHeadRadius));
    return { h, w: h * 0.75, headOff: total - headR, headR };
  }

  // 玩家专用：脚圆 + 头肩代理圆都不能进墙。用二分找贴墙位置，两轴独立滑行。
  function movePlayer(ent, dx, dy, rects) {
    const bm = bodyMetrics();
    const blocked = (x, y) => {
      const hy = y - bm.headOff;
      for (const r of rects) {
        if (circleRect(x, y, ent.r, r)) return true;
        if (circleRect(x, hy, bm.headR, r)) return true;
      }
      return false;
    };
    const advance = (axis, amount) => {
      if (!amount) return;
      const at = t => [ent.x + (axis === 'x' ? t : 0), ent.y + (axis === 'y' ? t : 0)];
      const [tx, ty] = at(amount);
      // 若起点已被闸门等物体压住，直接放行这一步，避免卡死。
      if (blocked(ent.x, ent.y)) {
        if (axis === 'x') ent.x = tx; else ent.y = ty;
        return;
      }
      if (!blocked(tx, ty)) {
        if (axis === 'x') ent.x = tx; else ent.y = ty;
        return;
      }
      let lo = 0, hi = amount;
      for (let i = 0; i < 8; i++) {
        const mid = (lo + hi) / 2;
        const [mx, my] = at(mid);
        if (blocked(mx, my)) hi = mid; else lo = mid;
      }
      if (axis === 'x') ent.x += lo; else ent.y += lo;
    };
    advance('x', dx);
    advance('y', dy);
    ent.x = clamp(ent.x, ent.r, W - ent.r);
    ent.y = clamp(ent.y, bm.headOff + bm.headR + 3, H - ent.r);
  }

  // 分轴移动：先走 X 再走 Y，撞墙时贴住墙面，另一轴仍可滑动。
  function moveEntity(ent, dx, dy, rects) {
    ent.x += dx;
    for (let pass = 0; pass < 2; pass++) {
      for (const r of rects) {
        if (!circleRect(ent.x, ent.y, ent.r, r)) continue;
        if (dx > 0) ent.x = r.x - ent.r;
        else if (dx < 0) ent.x = r.x + r.w + ent.r;
      }
    }
    ent.y += dy;
    for (let pass = 0; pass < 2; pass++) {
      for (const r of rects) {
        if (!circleRect(ent.x, ent.y, ent.r, r)) continue;
        if (dy > 0) ent.y = r.y - ent.r;
        else if (dy < 0) ent.y = r.y + r.h + ent.r;
      }
    }
    ent.x = clamp(ent.x, ent.r, W - ent.r);
    ent.y = clamp(ent.y, ent.r, H - ent.r);
  }

  function barrierRect(b) {
    const c = level.cell;
    if (b.axis === 'y') {
      return {
        x: (b.fixed - 0.3) * c,
        y: (b.pos - b.length / 2) * c,
        w: 0.6 * c,
        h: b.length * c,
      };
    }
    return {
      x: (b.pos - b.length / 2) * c,
      y: (b.fixed - 0.3) * c,
      w: b.length * c,
      h: 0.6 * c,
    };
  }

  const rectCenter = r => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

  // 所有能挡住视线和光的线段：静态墙 + 关闭的闸门 + 影障四条边
  function getOccluderSegments() {
    const c = level.cell;
    const segs = level.walls.map(([x1, y1, x2, y2]) => ({
      a: { x: x1 * c, y: y1 * c }, b: { x: x2 * c, y: y2 * c },
    }));
    for (const g of world.gates) {
      if (!g.closed) continue;
      const [x1, y1, x2, y2] = g.segment;
      segs.push({ a: { x: x1 * c, y: y1 * c }, b: { x: x2 * c, y: y2 * c } });
    }
    for (const b of world.barriers) {
      const r = barrierRect(b);
      const tl = { x: r.x, y: r.y }, tr = { x: r.x + r.w, y: r.y };
      const br = { x: r.x + r.w, y: r.y + r.h }, bl = { x: r.x, y: r.y + r.h };
      segs.push({ a: tl, b: tr }, { a: tr, b: br }, { a: br, b: bl }, { a: bl, b: tl });
    }
    return segs;
  }

  function segmentsIntersect(p1, p2, p3, p4) {
    const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const d1 = cross(p1, p2, p3), d2 = cross(p1, p2, p4);
    const d3 = cross(p3, p4, p1), d4 = cross(p3, p4, p2);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
           ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  }

  function hasLineOfSight(from, to) {
    for (const s of world.occluders || []) {
      if (segmentsIntersect(from, to, s.a, s.b)) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // 3. 关卡加载 / 覆盖层
  // ---------------------------------------------------------------------------
  function loadLevel(index) {
    levelIndex = index;
    level = LEVELS[index];
    const c = level.cell;
    const px = g => g * c;

    world = {
      staticRects: level.walls.map(w => segmentToRect(w, c, P.wallThickness)),
      occluders: [],
      particles: [],
      clock: 0,              // 本关累计毫秒，供脚印淡出用
      trail: [],             // 老人脚印：{x, y, t}
      player: {
        x: px(level.spawn.x), y: px(level.spawn.y),
        r: P.playerRadius,
        moving: false, facing: -1, walkTime: 0,
        moveDX: 0, moveDY: -1,
        lastFootX: px(level.spawn.x), lastFootY: px(level.spawn.y),
      },
      monsters: level.monsters.map(m => ({
        x: px(m.x), y: px(m.y), r: P.monsterRadius,
        facing: -1, frozen: false,
        home: { x: px(m.x), y: px(m.y) },
        patrolDir: { x: 1, y: 0 }, patrolTimer: 0,
        braking: false, brakeTime: 0, brakeSpeed: 0,
        brakeDX: 0, brakeDY: -1,
        lastDX: 0, lastDY: -1, lastSpeed: 0,
        glow: 0, shakeX: 0, shakeY: 0,  // 装饰：红眼强度与抖动位移（每帧更新）
      })),
      fragments: level.fragments.map(f => ({
        x: px(f.x), y: px(f.y), collected: false,
      })),
      gates: (level.gates || []).map(g => ({
        switchPos: { x: px(g.switch.x), y: px(g.switch.y) },
        segment: g.segment,
        open: 0,
        closed: true,
        rect: segmentToRect(g.segment, c, P.wallThickness + 4),
      })),
      barriers: (level.barriers || []).map(b => ({
        ...b,
        pos: b.from,
        dir: 1,
        frozen: false,
      })),
      unlockTimer: 0,
    };

    target.x = world.player.x;
    target.y = world.player.y;
    levelElapsed = 0;
    loseElapsed = 0;
    state = STATE.PLAYING;
    overlay.classList.add('hidden');
    updateHud();
  }

  function setPanel(html) {
    overlay.innerHTML = `<div class="panel">${html}</div>`;
    overlay.classList.remove('hidden');
  }

  function showLose() {
    const canRetry = loseElapsed >= P.loseDelay;
    setPanel(`
      <p class="result">${L('loseResult')}</p>
      <p class="detail">${L('loseDetail', formatTime(levelElapsed))}</p>
      <div class="row">
        <button id="retryBtn" data-action="retry" ${canRetry ? '' : 'disabled'}>${L(canRetry ? 'retryReady' : 'retryWaiting')}</button>
      </div>
      <p class="tip">${L('loseTip')}</p>
    `);
  }

  function showWin() {
    const last = levelIndex === LEVELS.length - 1;
    const buttons = last
      ? `<button data-action="retry">${L('btnRetry')}</button><button data-action="restart">${L('btnRestart')}</button>`
      : `<button data-action="next">${L('btnNext')}</button><button data-action="retry">${L('btnRetry')}</button>`;
    setPanel(`
      <p class="result">${L(last ? 'winLast' : 'winNormal')}</p>
      <p class="detail">${L('winDetail', formatTime(levelElapsed), formatTime(totalElapsed))}</p>
      <div class="row">${buttons}</div>
      <p class="tip">${L(last ? 'winTipLast' : 'winTipNext', LEVELS[Math.min(levelIndex + 1, LEVELS.length - 1)].name)}</p>
    `);
  }

  overlay.addEventListener('click', e => {
    const action = e.target.dataset && e.target.dataset.action;
    if (!action) return;
    if (action === 'start' || action === 'restart') {
      totalElapsed = 0;
      loadLevel(0);
    } else if (action === 'retry') {
      if (state === STATE.LOSE && loseElapsed < P.loseDelay) return;
      loadLevel(levelIndex);
    } else if (action === 'next') {
      loadLevel(levelIndex + 1);
    }
  });

  window.addEventListener('keydown', e => {
    if (e.key !== 'r' && e.key !== 'R') return;
    if (state === STATE.LOSE && loseElapsed >= P.loseDelay) loadLevel(levelIndex);
    else if (state === STATE.WIN) loadLevel(levelIndex);
  });

  window.addEventListener('mousemove', e => {
    const rect = canvas.getBoundingClientRect();
    target.x = clamp((e.clientX - rect.left) * (W / rect.width), 0, W);
    target.y = clamp((e.clientY - rect.top) * (H / rect.height), 0, H);
  });

  function updateHud() {
    if (!level) return;
    const got = world.fragments.filter(f => f.collected).length;
    hud.stage.textContent = L('stage', levelIndex + 1);
    hud.frag.textContent = L('fragments', got);
    hud.time.textContent = L('levelTime', formatTime(levelElapsed));
    hud.total.textContent = L('totalTime', formatTime(totalElapsed));
  }

  // 语言切换时刷新动态文案；静态元素由 i18n.js 自己更新。
  function refreshUI() {
    updateHud();
    if (state === STATE.LOSE) showLose();
    else if (state === STATE.WIN) showWin();
  }

  // ---------------------------------------------------------------------------
  // 4. 每帧更新
  // ---------------------------------------------------------------------------
  function collisionRects() {
    const rects = world.staticRects.slice();
    for (const g of world.gates) if (g.closed) rects.push(g.rect);
    return rects;
  }

  // 怪物没有地图：看不见玩家时只沿当前通道乱走，撞墙就换方向，
  // 并尽量待在出生点附近（P.patrolHome）。
  function patrolMonster(m, f, rects) {
    if (m.patrolTimer <= 0) {
      const dirs = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
      const forward = dirs.filter(d => !(d.x === -m.patrolDir.x && d.y === -m.patrolDir.y));
      const candidates = forward.length ? forward : dirs;
      candidates.sort(() => Math.random() - 0.5);
      let chosen = { x: 0, y: 0 };
      for (const d of candidates) {
        const test = { x: m.x, y: m.y, r: m.r };
        const probe = P.patrolSpeed * 8;
        moveEntity(test, d.x * probe, d.y * probe, rects);
        if (Math.hypot(test.x - m.x, test.y - m.y) > probe * 0.5 &&
            dist(test, m.home) <= P.patrolHome) {
          chosen = d;
          break;
        }
      }
      m.patrolDir = chosen;
      m.patrolTimer = 40 + Math.random() * 90;
    }
    if (m.patrolDir.x || m.patrolDir.y) {
      const step = P.patrolSpeed * f;
      const before = { x: m.x, y: m.y };
      moveEntity(m, m.patrolDir.x * step, m.patrolDir.y * step, rects);
      if (Math.hypot(m.x - before.x, m.y - before.y) < step * 0.3) {
        m.patrolTimer = 0;
        m.lastSpeed = 0;
      } else {
        m.lastDX = m.patrolDir.x; m.lastDY = m.patrolDir.y;
        m.lastSpeed = P.patrolSpeed;
      }
      if (m.patrolDir.x) m.facing = m.patrolDir.x > 0 ? 1 : -1;
    }
    m.patrolTimer -= f;
  }

  function spawnPickupParticles(x, y) {
    for (let i = 0; i < 18; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 0.5 + Math.random() * 2.4;
      const life = 450 + Math.random() * 450;
      world.particles.push({
        x, y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life, max: life,
        rgb: i % 3 === 0 ? '170,220,255' : '255,255,255',
      });
    }
  }

  function update(dt) {
    const f = dt / (1000 / 60);
    levelElapsed += dt;
    totalElapsed += dt;
    world.clock += dt;

    // --- 玩家：平稳追随光点 + 限速 + 分轴碰撞 ---
    // 注意：光心是 target（鼠标），不是本体；本体只是慢慢追上去。
    const p = world.player;
    p.moving = false;
    const dx = target.x - p.x, dy = target.y - p.y;
    const d = Math.hypot(dx, dy);
    if (d > P.stopDistance) {
      const step = Math.min(d * P.playerEase, P.playerSpeed * f, d);
      movePlayer(p, (dx / d) * step, (dy / d) * step, collisionRects());
      p.moving = true;
      p.walkTime += dt / 1000;
      p.moveDX = dx / d; p.moveDY = dy / d;
      if (Math.abs(dx) > Math.abs(dy)) p.facing = dx > 0 ? 1 : -1;
    } else {
      p.walkTime = 0;
    }

    // --- 脚印：本体每走 footprintGap 像素记一个点；过期的清掉 ---
    if (Math.hypot(p.x - p.lastFootX, p.y - p.lastFootY) >= P.footprintGap) {
      world.trail.push({ x: p.x, y: p.y, t: world.clock });
      if (world.trail.length > P.footprintMax) world.trail.shift();
      p.lastFootX = p.x; p.lastFootY = p.y;
    }
    world.trail = world.trail.filter(fp => world.clock - fp.t <= P.footprintFade);

    // --- 闸门：开关在光里就开，否则缓慢关 ---
    for (const g of world.gates) {
      const lit = dist(target, g.switchPos) <= level.lightRadius;
      const rate = lit ? P.gateOpenRate : -P.gateCloseRate;
      g.open = clamp(g.open + rate * f, 0, 1);
      if (!lit && circleRect(p.x, p.y, p.r, g.rect)) {
        g.open = Math.max(g.open, P.gateOpenThreshold); // 别把玩家夹在门里
      }
      g.closed = g.open < P.gateOpenThreshold;
    }

    // --- 影障：光照到且视线通畅才冻结，否则往返移动；碰到玩家即失败 ---
    for (const b of world.barriers) {
      const rect = barrierRect(b);
      const center = rectCenter(rect);
      b.frozen = dist(target, center) <= level.lightRadius && hasLineOfSight(target, center);
      if (!b.frozen) {
        b.pos += b.dir * b.speed * f;
        if (b.pos <= b.from) { b.pos = b.from; b.dir = 1; }
        if (b.pos >= b.to) { b.pos = b.to; b.dir = -1; }
      }
      if (circleRect(p.x, p.y, p.r, barrierRect(b))) return lose();
    }

    // --- 怪物：光点照到才冻结；进光先刹车；看不见玩家就巡逻 ---
    const rects = collisionRects();
    for (const m of world.monsters) {
      const md = dist(p, m);
      const visible = hasLineOfSight(m, p);
      // 冻结判定看的是光点，不是本体：光扫到 + 光到怪物之间无遮挡
      const lit = dist(target, m) <= level.lightRadius && hasLineOfSight(target, m);

      if (!lit) {
        m.frozen = false;
        if (m.braking) { m.braking = false; m.brakeTime = 0; }
      }

      // 刚进光：先刹车滑行，不瞬间定住。保留进入前的方向与速度。
      if (lit && !m.frozen && !m.braking) {
        m.braking = true;
        m.brakeTime = 0;
        m.brakeSpeed = m.lastSpeed || P.monsterSpeed;
        m.brakeDX = m.lastDX || (m.facing > 0 ? 1 : -1);
        m.brakeDY = m.lastDY || 0;
      }

      if (m.braking) {
        const t = clamp(m.brakeTime / P.brakeTime, 0, 1);
        const speed = m.brakeSpeed * (1 - t);
        if (speed > 0) moveEntity(m, m.brakeDX * speed * f, m.brakeDY * speed * f, rects);
        m.brakeTime += dt / 1000;
        if (m.brakeTime >= P.brakeTime) {
          m.braking = false;
          m.frozen = true;
          m.lastSpeed = 0;
        }
      } else if (!m.frozen) {
        if (visible && md <= P.sightRange) {
          if (md > 0.1) {
            m.facing = p.x > m.x ? 1 : -1;
            const dirX = (p.x - m.x) / md, dirY = (p.y - m.y) / md;
            const step = Math.min(P.monsterSpeed * f, md);
            moveEntity(m, dirX * step, dirY * step, rects);
            m.lastDX = dirX; m.lastDY = dirY; m.lastSpeed = P.monsterSpeed;
          }
        } else {
          patrolMonster(m, f, rects);
        }
      }
      // 装饰：红眼强度与抖动，以到老人本体的实时距离为准（260px 起渐强）
      const moodMd = dist(p, m);
      m.glow = clamp((P.eyeGlowRange - moodMd) / (P.eyeGlowRange - P.eyeGlowNear), 0, 1);
      if (m.frozen) {
        // 被光定住时不抖动，只保留红眼盯着你
        m.shakeX = 0; m.shakeY = 0;
      } else {
        const amp = P.shakeMax * m.glow;
        const ph = world.clock / 1000;
        m.shakeX = Math.sin(ph * 41 + m.x) * amp;
        m.shakeY = Math.cos(ph * 37 + m.y) * amp;
      }

      // 冻结 / 刹车中的怪物同样致命：定住后还得绕路，这才是地形反制
      if (moodMd < p.r + m.r) return lose();
    }

    // --- 碎片：碰到即拾取，并炸开白色/淡蓝光点 ---
    for (const frag of world.fragments) {
      if (!frag.collected && dist(p, frag) < P.pickupRadius) {
        frag.collected = true;
        spawnPickupParticles(frag.x, frag.y);
      }
    }
    for (const pt of world.particles) {
      pt.x += pt.vx * f;
      pt.y += pt.vy * f;
      pt.vx *= 0.965;
      pt.vy *= 0.965;
      pt.life -= dt;
    }
    world.particles = world.particles.filter(pt => pt.life > 0);

    const allGot = world.fragments.every(frag => frag.collected);
    if (allGot && world.unlockTimer < 1) {
      world.unlockTimer = Math.min(1, world.unlockTimer + 0.05 * f);
    }

    // --- 出口：集齐碎片后进入即通关 ---
    const exitPos = {
      x: level.exit.x * level.cell,
      y: level.exit.y * level.cell,
    };
    if (allGot && dist(p, exitPos) < P.exitRadius) {
      state = STATE.WIN;
      showWin();
    }

    updateHud();
  }

  function lose() {
    state = STATE.LOSE;
    loseElapsed = 0;
    showLose();
    updateHud();
  }

  // ---------------------------------------------------------------------------
  // 5. 渲染
  // ---------------------------------------------------------------------------
  // 极淡的地面光池：让光晕范围本身可见，墙后硬阴影对比更明显
  function drawLightPool() {
    const R = level.lightRadius;
    const g = ctx.createRadialGradient(target.x, target.y, 0, target.x, target.y, R);
    g.addColorStop(0, 'rgba(190,215,235,0.11)');
    g.addColorStop(0.7, 'rgba(190,215,235,0.065)');
    g.addColorStop(1, 'rgba(190,215,235,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(target.x, target.y, R, 0, Math.PI * 2); ctx.fill();
  }

  function drawFloor() {
    const c = level.cell;
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    for (let r = 0; r < level.rows; r++) {
      for (let col = 0; col < level.cols; col++) {
        ctx.fillRect((col + 0.5) * c - 1, (r + 0.5) * c - 1, 2, 2);
      }
    }
  }

  function drawWalls() {
    const c = level.cell;
    ctx.lineCap = 'square';
    for (const [x1, y1, x2, y2] of level.walls) {
      ctx.beginPath();
      ctx.moveTo(x1 * c, y1 * c);
      ctx.lineTo(x2 * c, y2 * c);
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = 6;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(240,240,240,0.98)';
      ctx.lineWidth = 2.4;
      ctx.stroke();
    }
  }

  function drawGates(now) {
    for (const g of world.gates) {
      const [x1, y1, x2, y2] = g.segment;
      const c = level.cell;
      ctx.beginPath();
      ctx.moveTo(x1 * c, y1 * c);
      ctx.lineTo(x2 * c, y2 * c);
      ctx.lineWidth = 8;
      ctx.strokeStyle = `rgba(150,190,215,${0.15 + 0.75 * (1 - g.open)})`;
      ctx.stroke();

      const s = g.switchPos;
      const pulse = 0.5 + 0.5 * Math.sin(now / 260);
      ctx.beginPath();
      ctx.arc(s.x, s.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = g.open > 0.5
        ? `rgba(190,225,255,${0.7 + 0.3 * pulse})`
        : 'rgba(255,255,255,0.45)';
      ctx.fill();
    }
  }

  function drawBarriers() {
    for (const b of world.barriers) {
      const r = barrierRect(b);
      ctx.fillStyle = b.frozen ? 'rgba(120,160,185,0.85)' : 'rgba(90,90,105,0.8)';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = b.frozen ? 'rgba(235,245,255,0.9)' : 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
    }
  }

  function drawFragments(now) {
    world.fragments.forEach((frag, i) => {
      if (frag.collected) return;
      const pulse = 0.62 + 0.38 * Math.sin(now / 320 + i * 1.9);
      const size = Math.min(40, level.cell * 0.82);
      ctx.save();
      ctx.translate(frag.x, frag.y);
      ctx.globalAlpha = pulse;
      if (fragmentImg.complete && fragmentImg.naturalWidth) {
        ctx.drawImage(fragmentImg, -size / 2, -size / 2, size, size);
      } else {
        ctx.rotate(Math.PI / 4);
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(-6, -6, 12, 12);
      }
      ctx.restore();
    });
  }

  function drawParticles() {
    for (const pt of world.particles) {
      ctx.fillStyle = `rgba(${pt.rgb},${clamp(pt.life / pt.max, 0, 1)})`;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawExit(now) {
    const c = level.cell;
    const x = level.exit.x * c, y = level.exit.y * c;
    const unlocked = world.unlockTimer > 0.2;
    const pulse = 0.6 + 0.4 * Math.sin(now / 280);
    ctx.save();
    ctx.translate(x, y);
    ctx.strokeStyle = unlocked
      ? `rgba(255,255,255,${0.55 + 0.45 * pulse})`
      : 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 2;
    ctx.strokeRect(-14, -14, 28, 28);
    if (unlocked) {
      ctx.beginPath();
      ctx.moveTo(-6, 0); ctx.lineTo(6, 0);
      ctx.moveTo(0, -6); ctx.lineTo(0, 6);
      ctx.strokeStyle = `rgba(255,255,255,${pulse})`;
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawMonsters() {
    const p = world.player;
    for (const m of world.monsters) {
      ctx.save();
      // 抖动是纯视觉位移，不影响 m.x/m.y 的碰撞判定
      ctx.translate(m.x + m.shakeX, m.y - 2 + m.shakeY);
      ctx.save();
      // 素材默认朝左：向左走用原图，向右走水平镜像。
      if (m.facing > 0) ctx.scale(-1, 1);
      if (monsterImg.complete && monsterImg.naturalWidth) {
        ctx.drawImage(monsterImg, -24, -28, 48, 52);
      } else {
        ctx.fillStyle = '#a33';
        ctx.beginPath();
        ctx.moveTo(0, -14); ctx.lineTo(12, 10); ctx.lineTo(-12, 10);
        ctx.closePath(); ctx.fill();
      }
      ctx.restore();

      // 红眼：离老人越近越红越亮（260px 起渐强），冻结时红光保留
      if (m.glow > 0) {
        const ex = m.facing > 0 ? 7 : -7;  // 眼睛在素材里的局部位置（朝右时镜像）
        const ey = -19;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const grd = ctx.createRadialGradient(ex, ey, 0, ex, ey, 13);
        grd.addColorStop(0, `rgba(255,70,45,${0.95 * m.glow})`);
        grd.addColorStop(0.4, `rgba(255,28,18,${0.55 * m.glow})`);
        grd.addColorStop(1, 'rgba(255,0,0,0)');
        ctx.fillStyle = grd;
        ctx.beginPath(); ctx.arc(ex, ey, 13, 0, Math.PI * 2); ctx.fill();
        ctx.restore();

        // 瞳孔朝老人偏移：直勾勾盯着你
        const gx = p.x - m.x, gy = p.y - m.y;
        const gl = Math.hypot(gx, gy) || 1;
        const pop = 2.4;
        ctx.fillStyle = `rgba(255,238,225,${0.5 + 0.45 * m.glow})`;
        ctx.beginPath();
        ctx.arc(ex + (gx / gl) * pop, ey + (gy / gl) * pop, 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();

      // 刹车中的短促划痕：提示"它想冲过来，但被光钉住了"
      if (m.braking) {
        const k = clamp(1 - m.brakeTime / P.brakeTime, 0, 1);
        const nx = -(m.brakeDY || 0), ny = m.brakeDX || 0;
        const bx = m.x - (m.brakeDX || 0) * 12;
        const by = m.y - (m.brakeDY || 0) * 12;
        ctx.strokeStyle = `rgba(255,150,150,${0.55 + 0.4 * k})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(bx + nx * 8, by + ny * 8);
        ctx.lineTo(bx - (m.brakeDX || 0) * 20 + nx * 8, by - (m.brakeDY || 0) * 20 + ny * 8);
        ctx.moveTo(bx - nx * 8, by - ny * 8);
        ctx.lineTo(bx - (m.brakeDX || 0) * 20 - nx * 8, by - (m.brakeDY || 0) * 20 - ny * 8);
        ctx.stroke();
      }

      if (m.frozen) {
        ctx.beginPath();
        ctx.arc(m.x, m.y, 19, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(220,240,255,0.8)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }

  function drawPlayer() {
    const p = world.player;
    // 平稳行走：静止用 standing，移动时两帧匀速交替，不再有支点/顿挫
    const frame = Math.floor(p.walkTime / P.walkFrameTime) % 2;
    const img = !p.moving ? adventurerImgs[0] : adventurerImgs[frame === 0 ? 1 : 2];
    const bob = p.moving ? Math.sin(p.walkTime * 10) * 0.7 : 0;
    const bm = bodyMetrics();
    const h = bm.h, w = bm.w;

    ctx.save();
    ctx.translate(p.x, p.y + bob);
    // 素材默认朝左：向右走时水平镜像
    if (p.facing > 0) ctx.scale(-1, 1);
    if (img.complete && img.naturalWidth) {
      ctx.drawImage(img, -w / 2, -h + 6, w, h);
    } else {
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(0, -h / 2, 5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();

    // 缩小后的脚下白点，标示精确碰撞位置（不参与晃动）
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.beginPath(); ctx.arc(p.x, p.y, P.playerDotRadius, 0, Math.PI * 2); ctx.fill();
  }

  // 黑幕 + destination-out 径向渐变 = 柔和光晕镂空
  function applyMask() {
    const R = level.lightRadius;
    const light = target; // 光心跟着鼠标，不再锁在本体
    mctx.globalCompositeOperation = 'source-over';
    mctx.fillStyle = '#000';
    mctx.fillRect(0, 0, W, H);
    mctx.globalCompositeOperation = 'destination-out';
    const grad = mctx.createRadialGradient(light.x, light.y, 0, light.x, light.y, R);
    grad.addColorStop(0, 'rgba(0,0,0,1)');
    grad.addColorStop(0.70, 'rgba(0,0,0,1)');
    grad.addColorStop(0.86, 'rgba(0,0,0,0.82)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    mctx.fillStyle = grad;
    mctx.beginPath();
    mctx.arc(light.x, light.y, R, 0, Math.PI * 2);
    mctx.fill();

    // 墙背后重新涂黑：从光点向每条遮挡线段两端投射阴影
    mctx.globalCompositeOperation = 'source-over';
    mctx.fillStyle = '#000';
    for (const s of world.occluders || []) {
      const dx1 = s.a.x - light.x, dy1 = s.a.y - light.y;
      const dx2 = s.b.x - light.x, dy2 = s.b.y - light.y;
      const l1 = Math.hypot(dx1, dy1), l2 = Math.hypot(dx2, dy2);
      if (l1 < 0.5 || l2 < 0.5) continue;
      const far = 1000;
      const p1 = { x: s.a.x + (dx1 / l1) * far, y: s.a.y + (dy1 / l1) * far };
      const p2 = { x: s.b.x + (dx2 / l2) * far, y: s.b.y + (dy2 / l2) * far };
      mctx.beginPath();
      mctx.moveTo(s.a.x, s.a.y);
      mctx.lineTo(s.b.x, s.b.y);
      mctx.lineTo(p2.x, p2.y);
      mctx.lineTo(p1.x, p1.y);
      mctx.closePath();
      mctx.fill();
    }
    ctx.drawImage(mask, 0, 0);
  }

  // 脚印与常亮锚点：画在遮罩之后，因此在黑暗里也永远可见。
  // 这是"鼠标甩远后仍能找到老人"的关键——不能跟着光被涂黑。
  function drawTrail() {
    const p = world.player;
    // 淡出的脚印：越旧越淡，约 footprintFade 毫秒后消失
    for (const fp of world.trail) {
      const k = clamp(1 - (world.clock - fp.t) / P.footprintFade, 0, 1);
      if (k <= 0) continue;
      ctx.save();
      ctx.translate(fp.x, fp.y);
      ctx.scale(1, 0.6);
      ctx.fillStyle = `rgba(205,225,240,${0.5 * k})`;
      ctx.beginPath(); ctx.arc(0, 0, 2.4, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    // 当前位置的常亮锚点：即使老人静止、脚印全淡光了也找得到
    ctx.strokeStyle = 'rgba(190,220,240,0.75)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(p.x, p.y, 9, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(225,240,250,0.95)';
    ctx.beginPath(); ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2); ctx.fill();
  }

  function drawCrosshair() {
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(target.x - 7, target.y); ctx.lineTo(target.x - 2, target.y);
    ctx.moveTo(target.x + 2, target.y); ctx.lineTo(target.x + 7, target.y);
    ctx.moveTo(target.x, target.y - 7); ctx.lineTo(target.x, target.y - 2);
    ctx.moveTo(target.x, target.y + 2); ctx.lineTo(target.x, target.y + 7);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillRect(target.x - 1, target.y - 1, 2, 2);
  }

  function render(now) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    if (level && world) {
      drawLightPool();
      drawFloor();
      drawWalls();
      drawGates(now);
      drawBarriers();
      drawFragments(now);
      drawExit(now);
      drawParticles();
      drawMonsters();
      drawPlayer();
      applyMask();
      drawTrail();   // 遮罩之后：脚印与锚点永远可见
    }
    drawCrosshair();
  }

  // ---------------------------------------------------------------------------
  // 主循环
  // ---------------------------------------------------------------------------
  function frame(now) {
    const dt = Math.min(now - lastFrame || 16.667, 50);
    lastFrame = now;

    if (level && world) world.occluders = getOccluderSegments();

    if (state === STATE.PLAYING) {
      update(dt);
    } else if (state === STATE.LOSE) {
      loseElapsed += dt;
      if (loseElapsed >= P.loseDelay) {
        const btn = document.getElementById('retryBtn');
        if (btn && btn.disabled) {
          btn.disabled = false;
          btn.textContent = L('retryReady');
        }
      }
    }

    render(now);
    requestAnimationFrame(frame);
  }

  // 初始化：先把第一关画在标题画面后面
  level = LEVELS[0];
  world = {
    staticRects: level.walls.map(w => segmentToRect(w, level.cell, P.wallThickness)),
    occluders: [],
    particles: [],
    clock: 0,
    trail: [],
    player: {
      x: level.spawn.x * level.cell, y: level.spawn.y * level.cell, r: P.playerRadius,
      moving: false, facing: -1, walkTime: 0,
      moveDX: 0, moveDY: -1,
      lastFootX: level.spawn.x * level.cell, lastFootY: level.spawn.y * level.cell,
    },
    monsters: level.monsters.map(m => ({
      x: m.x * level.cell, y: m.y * level.cell, r: P.monsterRadius,
      facing: -1, frozen: false,
      home: { x: m.x * level.cell, y: m.y * level.cell },
      patrolDir: { x: 1, y: 0 }, patrolTimer: 0,
      braking: false, brakeTime: 0, brakeSpeed: 0,
      brakeDX: 0, brakeDY: -1,
      lastDX: 0, lastDY: -1, lastSpeed: 0,
      glow: 0, shakeX: 0, shakeY: 0,
    })),
    fragments: level.fragments.map(f => ({ x: f.x * level.cell, y: f.y * level.cell, collected: false })),
    gates: (level.gates || []).map(g => ({
      switchPos: { x: g.switch.x * level.cell, y: g.switch.y * level.cell },
      segment: g.segment, open: 0, closed: true,
      rect: segmentToRect(g.segment, level.cell, P.wallThickness + 4),
    })),
    barriers: (level.barriers || []).map(b => ({ ...b, pos: b.from, dir: 1, frozen: false })),
    unlockTimer: 0,
  };
  target.x = world.player.x;
  target.y = world.player.y;
  updateHud(); // 若浏览器记住了英文偏好，标题画面里的 HUD 也要跟着显示英文

  // 调试用：网址后加 #play 直接开局，#stage2 / #stage3 直接跳关。
  if (typeof location !== 'undefined') {
    const h = location.hash.toLowerCase();
    if (h === '#play') loadLevel(0);
    else if (h === '#stage2') loadLevel(1);
    else if (h === '#stage3') loadLevel(2);
  }

  requestAnimationFrame(frame);

  // 语言切换时通知游戏重绘失败 / 通关面板与 HUD。
  if (typeof I18n !== 'undefined' && I18n && typeof I18n.onChange === 'function') {
    I18n.onChange(refreshUI);
  }

  // 调试钩子：在浏览器控制台里可以查看状态 / 跳关 / 移动目标点。
  window.__lantern = {
    getLang: () => (typeof I18n !== 'undefined' && I18n ? I18n.getLang() : 'zh'),
    setLang: lang => { if (typeof I18n !== 'undefined' && I18n) I18n.setLang(lang); },
    getState: () => state,
    getWorld: () => world,
    getLevel: () => level,
    getLevelIndex: () => levelIndex,
    getLight: () => ({ x: target.x, y: target.y }),
    loadLevel,
    setTarget: (x, y) => { target.x = x; target.y = y; },
    hasLineOfSight: (a, b) => hasLineOfSight(a, b),
    getOccluders: () => world.occluders,
    getTrail: () => world.trail,
    getClock: () => world.clock,
  };
})();
