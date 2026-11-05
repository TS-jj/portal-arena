/* ==========================================================
   PORTAL ARENA — Enhancement Layer
   Runs synchronously in <head>, before the deferred game module.
   ========================================================== */
(function () {
  'use strict';

  /* ---------------- preferences ---------------- */
  var KEY = 'portal-arena.settings.v1';
  /* Primary input device: a coarse pointer means phone/tablet -> on-screen controls. */
  var isTouch = (function () {
    try {
      var coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
      return !!coarse && (('ontouchstart' in window) || navigator.maxTouchPoints > 0);
    } catch (e) { return false; }
  })();

  var DEFAULTS = {
    cross: '#e8f0e8', crossLen: 7, crossThick: 2, sensitivity: 3,
    hudOp: 100, brightness: 100, contrast: 100, saturate: 100,
    volume: 68, soft: 65, lowfx: isTouch,
    minimap: true, stats: !isTouch, markers: true, vignette: false, audioRev: 2
  };
  var S = (function () {
    try {
      var raw = JSON.parse(localStorage.getItem(KEY) || '{}');
      var o = {}, k;
      for (k in DEFAULTS) o[k] = (raw[k] === undefined ? DEFAULTS[k] : raw[k]);
      /* one-time migration: older saves kept the raw, harsher mix */
      if (raw.audioRev !== 2) {
        o.volume = Math.min(o.volume, 68);
        o.soft = 65;
        o.audioRev = 2;
      }
      /* the stats overlay collides with the score row on a phone */
      if (isTouch) o.stats = false;
      return o;
    } catch (e) { return JSON.parse(JSON.stringify(DEFAULTS)); }
  })();
  var currentVolume = S.volume / 100;
  var softness = Math.max(0, Math.min(100, Number(S.soft)));

  /* ---------------- audio: one master chain for every sound ----------------
     The game feeds all of its audio into THREE.AudioListener -> context.destination.
     Splicing a chain in front of that single connection gives us, at once:
        source -> rumble cut -> harsh-band EQ -> air cut -> soft limiter -> master -> out
       - a real volume slider (original had none),
       - a "softness" control that tames the piercing 2-4 kHz band and the clipped
         transients of the shipped gunshot / portal-hum samples,
       - a limiter so overlapping auto-fire voices stop building up to distortion. */
  var chains = [];
  var nativeConnect = null;
  var chainMap = null;

  function tuneChain(ch) {
    try {
      var s = Math.max(0, Math.min(1, softness / 100));
      var t = ch.ctx.currentTime;
      ch.harsh.gain.value = -10 * s;                        /* 0 .. -10 dB @ 2.7 kHz */
      ch.air.frequency.value = 17000 - 8000 * s;            /* 17 k .. 9 kHz */
      ch.lim.threshold.value = -15 - 7 * s;
      ch.lim.ratio.value = 2.6 + 2.6 * s;
      ch.master.gain.cancelScheduledValues(t);
      ch.master.gain.setTargetAtTime(currentVolume * (1 - 0.22 * s), t, 0.06);
    } catch (e) {}
  }

  try {
    if (window.AudioNode && AudioNode.prototype.connect && window.WeakMap) {
      nativeConnect = AudioNode.prototype.connect;
      chainMap = new WeakMap();

      var makeChain = function (ctx) {
        var hp = ctx.createBiquadFilter();
        hp.type = 'highpass'; hp.frequency.value = 45; hp.Q.value = 0.6;
        var harsh = ctx.createBiquadFilter();
        harsh.type = 'peaking'; harsh.frequency.value = 2700; harsh.Q.value = 0.9; harsh.gain.value = -6.5;
        var air = ctx.createBiquadFilter();
        air.type = 'lowpass'; air.frequency.value = 13000; air.Q.value = 0.4;
        var lim = ctx.createDynamicsCompressor();
        lim.threshold.value = -19; lim.knee.value = 24; lim.ratio.value = 4;
        lim.attack.value = 0.004; lim.release.value = 0.22;
        var master = ctx.createGain();
        master.gain.value = 0;                              /* fades in, no click */
        nativeConnect.call(hp, harsh);
        nativeConnect.call(harsh, air);
        nativeConnect.call(air, lim);
        nativeConnect.call(lim, master);
        nativeConnect.call(master, ctx.destination);
        var ch = { ctx: ctx, harsh: harsh, air: air, lim: lim, master: master, input: hp };
        chains.push(ch);
        tuneChain(ch);
        return ch;
      };

      AudioNode.prototype.connect = function (dest) {
        try {
          var ctx = this.context;
          if (dest && ctx && dest === ctx.destination && !this.__paRouted) {
            this.__paRouted = true;
            var ch = chainMap.get(ctx) || makeChain(ctx);
            chainMap.set(ctx, ch);
            var args = Array.prototype.slice.call(arguments, 1);
            return nativeConnect.apply(this, [ch.input].concat(args));
          }
        } catch (e) { /* never break game audio */ }
        return nativeConnect.apply(this, arguments);
      };
    }
  } catch (e) { /* audio enhancement is optional */ }

  /* small diagnostic handle: lets you confirm the chain is live in devtools */
  try {
    window.__paAudio = {
      chains: chains,
      state: function () { return { volume: currentVolume, softness: softness }; }
    };
  } catch (e) {}

  function setVolume(v) {
    currentVolume = Math.max(0, Math.min(1, v));
    for (var i = 0; i < chains.length; i++) tuneChain(chains[i]);
  }
  function setTone(v) {
    softness = Math.max(0, Math.min(100, v));
    for (var i = 0; i < chains.length; i++) tuneChain(chains[i]);
  }

  /* The rifle sample is mastered hot (peak above full scale) and is retriggered
     many times per second on auto fire. Trim each voice a little and cap it so
     stacked shots stop slamming the limiter. */
  function hookGameAudio(g) {
    try {
      if (!g || !g.assets || g.assets.__paHooked || typeof g.assets.play !== 'function') return;
      var orig = g.assets.play;
      g.assets.play = function (buf, opts) {
        if (opts && typeof opts.volume === 'number') {
          opts.volume = Math.min(0.46, opts.volume * 0.8);
        }
        return orig.apply(this, arguments);
      };
      g.assets.__paHooked = true;
    } catch (e) {}
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }

  /* The game exposes its instance on window.__game; its input object owns
     the real mouse sensitivity, so this setting changes actual handling. */
  /* Phones have far less GPU headroom than a desktop. Capping the back buffer
     (and dropping shadow maps) is the difference between 25 and 45 fps. */
  function applyPerf(g) {
    if (!g || !g.renderer) return;
    var want = S.lowfx ? 1 : 0;
    if (g.renderer.__paPerf === want) return;
    try {
      var r = g.renderer;
      r.setPixelRatio(Math.min(window.devicePixelRatio || 1, S.lowfx ? 1.25 : 2));
      if (r.shadowMap) r.shadowMap.enabled = !S.lowfx;
      r.__paPerf = want;
      window.dispatchEvent(new Event('resize'));
    } catch (e) {}
  }

  function applyGameSettings() {
    try {
      var g = window.__game;
      if (!g) return;
      if (g.input) g.input.sensitivity = Number(S.sensitivity);
      hookGameAudio(g);
      applyPerf(g);
    } catch (e) { /* game may not be constructed yet */ }
  }

  /* ---------------- helpers ---------------- */
  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html !== undefined) n.innerHTML = html;
    return n;
  }
  function icon(path) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
      'stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  var ICON_GEAR = icon('<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.94 19.3a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.7 8.94a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15.06 4.7a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.14.6.66 1.03 1.28 1.03H21a2 2 0 1 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15z"/>');
  var ICON_FULL = icon('<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/>');
  var ICON_MAP = icon('<path d="M9 3 3 6v15l6-3 6 3 6-3V3l-6 3-6-3z"/><path d="M9 3v15M15 6v15"/>');

  var toastTimer = null;
  function toast(msg, ms) {
    var t = document.getElementById('pa-toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('on'); }, ms || 3000);
  }

  function toggleFullscreen() {
    var d = document.documentElement;
    try {
      if (!document.fullscreenElement) {
        (d.requestFullscreen || d.webkitRequestFullscreen || function () {}).call(d);
      } else {
        (document.exitFullscreen || document.webkitExitFullscreen || function () {}).call(document);
      }
    } catch (e) { toast('当前环境不支持全屏', 2200); }
  }

  /* Embedded previews (iframes/webviews) usually refuse pointer lock, which
     leaves you unable to look around. Detect it and offer a real window. */
  var isFramed = (function () {
    try { return window.self !== window.top; } catch (e) { return true; }
  })();
  function openNewWindow() {
    try {
      var w = window.open(location.href, '_blank');
      if (!w) location.href = location.href;
    } catch (e) { location.href = location.href; }
  }

  /* ---------------- settings panel ---------------- */
  var COLORS = ['#e8f0e8', '#35d8f2', '#8fd08f', '#ffd34f', '#ff6a5a'];
  var SLIDERS = [
    ['crossLen', '臂长', 4, 14, 1, 'px'],
    ['crossThick', '粗细', 1, 4, 1, 'px'],
    ['hudOp', 'HUD 不透明度', 30, 100, 5, '%'],
    ['brightness', '亮度', 60, 150, 5, '%'],
    ['contrast', '对比度', 70, 150, 5, '%'],
    ['saturate', '饱和度', 0, 180, 5, '%'],
    ['volume', '音量', 0, 100, 5, '%']
  ];
  var TOGGLES = [
    ['minimap', '小地图'], ['stats', '性能信息'],
    ['markers', '队友标记'], ['vignette', '电影暗角'],
    ['lowfx', '省电模式']
  ];

  function panelHTML() {
    var h = '<div class="pa-panel-hd"><h3>作战设置</h3><span>SETTINGS</span></div>';
    h += '<div class="pa-sec">准星 / CROSSHAIR</div>';
    h += '<div class="pa-row"><label>颜色</label><div class="pa-swatches">';
    for (var i = 0; i < COLORS.length; i++) {
      h += '<div class="pa-swatch" data-color="' + COLORS[i] + '" style="background:' + COLORS[i] + '"></div>';
    }
    h += '</div></div>';
    function slider(k, label, min, max, step, unit) {
      return '<div class="pa-row"><label>' + label + '</label>' +
        '<input class="pa-slider" type="range" data-k="' + k + '" min="' + min + '" max="' + max +
        '" step="' + step + '" value="' + S[k] + '"><output data-o="' + k + '">' + S[k] + unit + '</output></div>';
    }
    h += slider('crossLen', '臂长', 4, 14, 1, 'px');
    h += slider('crossThick', '粗细', 1, 4, 1, 'px');
    h += '<div class="pa-sec">操作 / CONTROL</div>';
    h += slider('sensitivity', '鼠标灵敏度', 1, 8, 0.5, '');
    h += '<div class="pa-sec">对局 / MATCH</div>';
    h += '<div class="pa-row"><label>击杀目标</label><div class="pa-chips">';
    var limits = [20, 30, 50, 100], li;
    for (li = 0; li < limits.length; li++) {
      h += '<button class="pa-chip" data-limit="' + limits[li] + '" type="button">' + limits[li] + '</button>';
    }
    h += '</div></div>';
    h += '<div class="pa-sec">界面 / HUD</div>';
    h += slider('hudOp', 'HUD 不透明度', 30, 100, 5, '%');
    for (var j = 0; j < TOGGLES.length; j++) {
      h += '<div class="pa-row"><label>' + TOGGLES[j][1] + '</label>' +
        '<div class="pa-toggle" data-t="' + TOGGLES[j][0] + '"></div></div>';
    }
    h += '<div class="pa-sec">画面与音效 / DISPLAY</div>';
    h += slider('brightness', '亮度', 60, 150, 5, '%');
    h += slider('contrast', '对比度', 70, 150, 5, '%');
    h += slider('saturate', '饱和度', 0, 180, 5, '%');
    h += slider('volume', '音量', 0, 100, 5, '%');
    h += slider('soft', '音效柔化', 0, 100, 5, '%');
    h += '<div class="pa-actions"><button class="pa-btn" data-act="reset">恢复默认</button>' +
      '<button class="pa-btn primary" data-act="close">完成</button></div>';
    h += '<div class="pa-hint">设置自动保存在本机浏览器中。按 ESC 退出鼠标锁定后可随时调整。</div>';
    return h;
  }

  function apply() {
    var r = document.documentElement.style;
    r.setProperty('--pa-cross', S.cross);
    r.setProperty('--pa-cross-len', S.crossLen + 'px');
    r.setProperty('--pa-cross-thick', S.crossThick + 'px');
    r.setProperty('--pa-hud-op', S.hudOp / 100);
    r.setProperty('--pa-minimap', S.minimap ? 'block' : 'none');
    r.setProperty('--pa-stats', S.stats ? 'block' : 'none');
    r.setProperty('--pa-markers', S.markers ? 'block' : 'none');
    r.setProperty('--pa-filter', 'brightness(' + S.brightness + '%) contrast(' + S.contrast +
      '%) saturate(' + S.saturate + '%)');
    document.body.classList.toggle('pa-vignette', !!S.vignette);
    setVolume(S.volume / 100);
    setTone(S.soft);
    applyGameSettings();
    save();
    syncControls();
  }

  function syncControls() {
    var panel = document.getElementById('pa-panel');
    if (!panel) return;
    var sw = panel.querySelectorAll('.pa-swatch');
    for (var i = 0; i < sw.length; i++) {
      sw[i].classList.toggle('on', sw[i].getAttribute('data-color') === S.cross);
    }
    var sl = panel.querySelectorAll('.pa-slider');
    for (var j = 0; j < sl.length; j++) {
      var k = sl[j].getAttribute('data-k');
      sl[j].value = S[k];
      var out = panel.querySelector('[data-o="' + k + '"]');
      if (out) {
        var u = (k === 'crossLen' || k === 'crossThick') ? 'px' : (k === 'sensitivity' ? '' : '%');
        out.textContent = S[k] + u;
      }
    }
    var tg = panel.querySelectorAll('.pa-toggle');
    for (var m = 0; m < tg.length; m++) {
      tg[m].classList.toggle('on', !!S[tg[m].getAttribute('data-t')]);
    }
    var chips = panel.querySelectorAll('.pa-chip');
    var live = 30;
    try { live = window.__paGetKillLimit ? window.__paGetKillLimit() : (Number(localStorage.getItem('portal-arena.killLimit')) || 30); } catch (e) {}
    for (var c = 0; c < chips.length; c++) {
      chips[c].classList.toggle('on', Number(chips[c].getAttribute('data-limit')) === live);
    }
  }

  function bindPanel(panel) {
    panel.addEventListener('input', function (e) {
      var t = e.target;
      if (t.classList.contains('pa-slider')) {
        S[t.getAttribute('data-k')] = Number(t.value);
        apply();
      }
    });
    panel.addEventListener('click', function (e) {
      var t = e.target;
      if (t.classList.contains('pa-swatch')) { S.cross = t.getAttribute('data-color'); apply(); }
      else if (t.classList.contains('pa-toggle')) {
        var k = t.getAttribute('data-t'); S[k] = !S[k]; apply();
      } else if (t.getAttribute && t.getAttribute('data-act') === 'reset') {
        for (var k2 in DEFAULTS) S[k2] = DEFAULTS[k2];
        try { if (window.__paSetKillLimit) window.__paSetKillLimit(30); } catch (e3) {}
        apply(); toast('已恢复默认设置', 1800);
      } else if (t.classList.contains('pa-chip') && t.getAttribute('data-limit')) {
        var lim = Number(t.getAttribute('data-limit'));
        try { if (window.__paSetKillLimit) window.__paSetKillLimit(lim); } catch (e) {}
        try { localStorage.setItem('portal-arena.killLimit', String(lim)); } catch (e2) {}
        syncControls();
        toast('击杀目标设为 ' + lim + ' 击杀 · 立即生效', 2400);
      } else if (t.getAttribute && t.getAttribute('data-act') === 'close') {
        closePanel();
      }
    });
  }

  function openPanel() {
    var p = document.getElementById('pa-panel');
    var b = document.querySelector('[data-pa="settings"]');
    if (p) p.classList.add('on');
    if (b) b.classList.add('on');
    document.body.classList.add('pa-panel-open');
  }
  function closePanel() {
    var p = document.getElementById('pa-panel');
    var b = document.querySelector('[data-pa="settings"]');
    if (p) p.classList.remove('on');
    if (b) b.classList.remove('on');
    document.body.classList.remove('pa-panel-open');
  }
  function togglePanel() {
    var p = document.getElementById('pa-panel');
    if (p && p.classList.contains('on')) closePanel(); else openPanel();
  }

  /* ---------------- loading progress ---------------- */
  var done = false, lastPct = 0, seen = Object.create(null), lastFile = '';
  function shortName(u) {
    try {
      var s = decodeURIComponent(u.split('?')[0].split('/').pop());
      return s.length > 34 ? s.slice(0, 31) + '...' : s;
    } catch (e) { return 'resources'; }
  }
  function setPct(v, label) {
    var bar = document.getElementById('pa-bar');
    var num = document.getElementById('pa-pct');
    var file = document.getElementById('pa-file');
    if (bar) bar.style.width = v + '%';
    if (num) num.textContent = Math.round(v) + '%';
    if (file && label) file.textContent = label;
  }
  function tickProgress() {
    if (done) return;
    var entries = [];
    try { entries = performance.getEntriesByType('resource') || []; } catch (e) {}
    for (var i = 0; i < entries.length; i++) {
      var n = entries[i].name;
      if (n.indexOf('/assets/') > 0 && !seen[n]) { seen[n] = 1; lastFile = n; }
    }
    var count = Object.keys(seen).length;
    var pct = Math.min(96, Math.round(count / 128 * 100));
    if (pct > lastPct) {
      lastPct = pct;
      setPct(pct, '正在载入 · ' + (lastFile ? shortName(lastFile) : 'resources'));
    }
  }
  function finishLoading() {
    if (done) return;
    done = true;
    setPct(100, '部署就绪');
    setTimeout(function () {
      var l = document.getElementById('pa-loader');
      if (l) {
        l.classList.add('out');
        setTimeout(function () { l.style.display = 'none'; }, 380);
      }
    }, 480);
  }
  function watchDeployButton() {
    function visible() {
      var p = document.getElementById('play');
      return p && getComputedStyle(p).display !== 'none';
    }
    if (visible()) { finishLoading(); return; }
    var mo = new MutationObserver(function () {
      if (visible()) { finishLoading(); mo.disconnect(); }
    });
    var p = document.getElementById('play');
    if (p) mo.observe(p, { attributes: true, attributeFilter: ['style'] });
    var iv = setInterval(function () {
      if (visible()) { finishLoading(); clearInterval(iv); }
    }, 250);
    /* safety net: never leave the player stuck behind a loader */
    setTimeout(function () {
      clearInterval(iv);
      if (!done) {
        finishLoading();
        var b = document.getElementById('play');
        if (b && getComputedStyle(b).display === 'none') b.style.display = 'block';
      }
    }, 20000);
  }

  /* ---------------- touch controls (phone / tablet) ----------------
     The upstream build is keyboard + pointer-lock only: on a phone it loads but
     cannot be played at all. This layer writes into the game's own input object,
     so movement, aiming, firing and weapon handling behave exactly like desktop. */
  function buildTouch() {
    if (!isTouch) return null;

    /* Layout follows PUBG Mobile / 和平精英 conventions:
         left  — analogue move wheel, thumb never leaves the corner
         right — one big fire button, with aim / jump / crouch / reload in reach
         rail  — four weapon slots, tap to swap (no hidden wheel gestures) */
    var wrap = el('div'); wrap.id = 'pa-touch';
    wrap.innerHTML =
      '<div id="pa-look"></div>' +
      '<div id="pa-stick"><i></i><b></b></div>' +
      '<div id="pa-weapons">' +
        '<button class="pa-wslot" data-w="0" type="button"><b>1</b><span>步枪</span></button>' +
        '<button class="pa-wslot" data-w="1" type="button"><b>2</b><span>手枪</span></button>' +
        '<button class="pa-wslot" data-w="2" type="button"><b>3</b><span>霰弹</span></button>' +
        '<button class="pa-wslot" data-w="3" type="button"><b>4</b><span>狙击</span></button>' +
      '</div>' +
      '<button class="pa-tb pa-fire-main" data-tb="fire" type="button">开火</button>' +
      '<button class="pa-tb pa-aim" data-tb="aim" type="button">开镜</button>' +
      '<button class="pa-tb pa-jump" data-tb="jump" type="button">跳跃</button>' +
      '<button class="pa-tb pa-crouch" data-tb="crouch" type="button">蹲下</button>' +
      '<button class="pa-tb pa-reload" data-tb="reload" type="button">换弹</button>' +
      '<button class="pa-tb pa-switch" data-tb="switch" type="button">切枪</button>';
    document.body.appendChild(wrap);

    var stick = wrap.querySelector('#pa-stick');
    var knob = stick.querySelector('b');
    var look = wrap.querySelector('#pa-look');
    var wslots = wrap.querySelectorAll('.pa-wslot');
    var WSLUG = ['rifle', 'pistol', 'shotgun', 'sniper'];

    function getInput() {
      var g = window.__game;
      return g && g.input ? g.input : null;
    }

    var TRAVEL = 54;
    var LOOK = 1.9;
    var crouched = false;

    function setMove(nx, ny) {
      var i = getInput(); if (!i) return;
      var fwd = -ny, right = nx;
      if (fwd > 0.26) i.keys.add('KeyW'); else i.keys.delete('KeyW');
      if (fwd < -0.26) i.keys.add('KeyS'); else i.keys.delete('KeyS');
      if (right > 0.26) i.keys.add('KeyD'); else i.keys.delete('KeyD');
      if (right < -0.26) i.keys.add('KeyA'); else i.keys.delete('KeyA');
      if (fwd > 0.84) i.keys.add('ShiftLeft'); else i.keys.delete('ShiftLeft');
    }
    function releaseMove() {
      var i = getInput(); if (!i) return;
      var k = ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'ShiftLeft'];
      for (var n = 0; n < k.length; n++) i.keys.delete(k[n]);
    }

    /* ---- left thumb: analogue wheel ---- */
    var stickId = null;
    function moveStick(e) {
      var r = stick.getBoundingClientRect();
      var dx = e.clientX - (r.left + r.width / 2);
      var dy = e.clientY - (r.top + r.height / 2);
      var len = Math.hypot(dx, dy) || 1;
      var k = Math.min(1, len / TRAVEL);
      var nx = (dx / len) * k, ny = (dy / len) * k;
      knob.style.transform = 'translate(' + (nx * TRAVEL).toFixed(1) + 'px,' + (ny * TRAVEL).toFixed(1) + 'px)';
      setMove(nx, ny);
    }
    stick.addEventListener('pointerdown', function (e) {
      stickId = e.pointerId;
      try { stick.setPointerCapture(e.pointerId); } catch (x) {}
      moveStick(e); e.preventDefault();
    });
    stick.addEventListener('pointermove', function (e) {
      if (e.pointerId !== stickId) return;
      moveStick(e); e.preventDefault();
    });
    function endStick(e) {
      if (stickId === null || (e && e.pointerId !== stickId)) return;
      stickId = null;
      knob.style.transform = '';
      releaseMove();
    }
    stick.addEventListener('pointerup', endStick);
    stick.addEventListener('pointercancel', endStick);

    /* ---- right thumb: drag anywhere outside the buttons to aim ---- */
    var lookId = null, lx = 0, ly = 0;
    look.addEventListener('pointerdown', function (e) {
      lookId = e.pointerId; lx = e.clientX; ly = e.clientY;
      try { look.setPointerCapture(e.pointerId); } catch (x) {}
      e.preventDefault();
    });
    look.addEventListener('pointermove', function (e) {
      if (e.pointerId !== lookId) return;
      var i = getInput(); if (!i) return;
      i.mouse.dx += (e.clientX - lx) * LOOK;
      i.mouse.dy += (e.clientY - ly) * LOOK;
      lx = e.clientX; ly = e.clientY;
      e.preventDefault();
    });
    function endLook(e) { if (e.pointerId === lookId) lookId = null; }
    look.addEventListener('pointerup', endLook);
    look.addEventListener('pointercancel', endLook);

    /* ---- weapon rail: direct slot swap instead of a wheel gesture ---- */
    for (var w = 0; w < wslots.length; w++) {
      (function (btn, idx) {
        btn.addEventListener('pointerdown', function (e) {
          e.preventDefault(); e.stopPropagation();
          var g = window.__game;
          try {
            /* equip directly: the queued Digit key is only consumed on the next tick */
            if (g && g.weapons && g.weapons.equip) g.weapons.equip(WSLUG[idx]);
            else {
              var i = getInput();
              if (i) i.pressed.add('Digit' + (idx + 1));
            }
          } catch (err) {}
          btn.classList.add('tap');
          setTimeout(function () { btn.classList.remove('tap'); }, 120);
        });
      })(wslots[w], w);
    }
    function syncWeapons() {
      var g = window.__game;
      if (!g || !g.weapons) return;
      var gun = g.weapons.gun;
      var cur = gun && gun.cfg ? gun.cfg.slug : '';
      var src = document.querySelectorAll('#slots .slot');
      for (var n = 0; n < wslots.length; n++) {
        var t = wslots[n].querySelector('span');
        var lbl = src[n] ? src[n].textContent.replace(/^[\d\s]+/, '').trim() : '';
        if (!lbl) {
          var w2 = g.weapons.weapons && g.weapons.weapons.get(WSLUG[n]);
          lbl = w2 ? w2.name : '';
        }
        if (lbl && t && t.textContent !== lbl) t.textContent = lbl;
        wslots[n].classList.toggle('on', cur === WSLUG[n]);
      }
    }
    setInterval(syncWeapons, 450);

    /* ---- action buttons ---- */
    var pressedAt = {};
    function press(btn) {
      var i = getInput(); if (!i) return;
      var a = btn.getAttribute('data-tb');
      if (a === 'fire') { fireDownAt = performance.now(); i.buttons.add(0); i.clicked.add(0); }
      else if (a === 'aim') { i.buttons.add(2); i.clicked.add(2); pressedAt.aim = performance.now(); }
      else if (a === 'jump') {
        i.keys.add('Space'); i.pressed.add('Space');
        setTimeout(function () { var j = getInput(); if (j) j.keys.delete('Space'); }, 90);
      }
      else if (a === 'reload') { i.pressed.add('KeyR'); }
      else if (a === 'switch') { i.mouse.wheel = 1; }
      else if (a === 'crouch') {
        crouched = !crouched;
        if (crouched) i.keys.add('KeyC'); else i.keys.delete('KeyC');
        btn.classList.toggle('latched', crouched);
      }
    }
    var fireDownAt = 0, fireTapToken = 0;
    function release(btn) {
      var i = getInput(); if (!i) return;
      var a = btn.getAttribute('data-tb');
      if (a === 'fire') {
        i.buttons.delete(0);
        /* A tap can start and end between two frames, so the game never sees a
           trigger pull. Hold the button virtually for ~3 frames instead. */
        if (performance.now() - fireDownAt < 110) {
          var tok = ++fireTapToken;
          i.buttons.add(0);
          setTimeout(function () {
            if (fireTapToken !== tok) return;
            var j = getInput(); if (j) j.buttons.delete(0);
          }, 110);
        }
      }
      else if (a === 'aim') {
        i.buttons.delete(2);
        i.released.set(2, performance.now() - (pressedAt.aim || performance.now()));
      }
    }
    var allBtns = wrap.querySelectorAll('.pa-tb');
    for (var b = 0; b < allBtns.length; b++) {
      (function (btn) {
        var a = btn.getAttribute('data-tb');
        btn.addEventListener('pointerdown', function (e) {
          e.preventDefault(); e.stopPropagation();
          btn.classList.add('on');
          try { btn.setPointerCapture(e.pointerId); } catch (x) {}
          press(btn);
        });
        var up = function (e) {
          if (a === 'crouch') return;                 /* crouch is a latch, not a hold */
          btn.classList.remove('on');
          release(btn);
        };
        btn.addEventListener('pointerup', up);
        btn.addEventListener('pointercancel', up);
      })(allBtns[b]);
    }

    /* The game ignores input unless this flag is set. Pointer lock does not exist
       on touch devices, so pin it and keep the look-pad as the only camera input. */
    setInterval(function () {
      if (!document.body.classList.contains('pa-touch-on')) return;
      if (document.body.classList.contains('pa-map-open')) return;
      var i = getInput();
      if (i && !i.locked) i.locked = true;
    }, 500);

    return {
      start: function () {
        document.body.classList.add('pa-touch-on');
        var i = getInput(); if (i) i.locked = true;
        crouched = false;
        syncWeapons();
        toast('左摇杆移动 · 右侧拖动转视角 · 开火键射击 · 底部数字键换枪', 5600);
      },
      stop: function () {
        document.body.classList.remove('pa-touch-on');
      }
    };
  }

  /* ---------------- build the UI ---------------- */
  function build() {
    var body = document.body;

    var bar = el('div'); bar.id = 'pa-topbar';
    bar.innerHTML = '<div class="pa-brand"><i></i><span>PORTAL ARENA · 4V4 TACTICAL</span></div>' +
      '<div class="pa-tools">' +
      '<div class="pa-icon" data-pa="settings" title="作战设置" role="button" aria-label="作战设置">' + ICON_GEAR + '</div>' +
      '<div class="pa-icon" data-pa="map" title="战术地图" role="button" aria-label="战术地图">' + ICON_MAP + '</div>' +
      '<div class="pa-icon" data-pa="full" title="全屏" role="button" aria-label="全屏">' + ICON_FULL + '</div>' +
      '</div>';
    body.appendChild(bar);

    var panel = el('div'); panel.id = 'pa-panel'; panel.innerHTML = panelHTML();
    body.appendChild(panel);
    bindPanel(panel);
    syncControls();

    var hint = el('div'); hint.id = 'pa-pausehint';
    hint.textContent = '战斗已暂停 · 调整设置或返回战场';
    body.appendChild(hint);

    var vig = el('div'); vig.id = 'pa-vignette'; body.appendChild(vig);
    var tst = el('div'); tst.id = 'pa-toast'; body.appendChild(tst);
    var badge = el('div'); badge.id = 'pa-badge';
    badge.innerHTML = '<em>PA</em>PORTAL ARENA';
    body.appendChild(badge);

    /* ---- minimap legend + full-screen tactical map ----
       The map uses shape as well as colour, so the legend has to repeat both:
       green arrow = you, blue disc = teammate, red triangle = enemy, diamond = portal. */
    var legend = el('div'); legend.id = 'pa-maplegend';
    legend.innerHTML =
      '<span class="lg"><s class="self"></s>你·1号</span>' +
      '<span class="lg"><s class="ally"></s>队友 2·3·4</span>' +
      '<span class="lg"><s class="foe"></s>敌人·红</span>' +
      '<span class="lg"><s class="portal"></s>传送门</span>' +
      '<span class="lg pa-lg-map" data-act="bigmap"><s class="big"></s>全图</span>';
    body.appendChild(legend);
    legend.querySelector('[data-act="bigmap"]').addEventListener('click', function (e) {
      e.stopPropagation(); toggleBigMap();
    });

    var bigmap = el('div'); bigmap.id = 'pa-bigmap';
    bigmap.innerHTML = '<div class="hd"><b>战术地图</b><span>TACTICAL MAP · RIFT</span></div>' +
      '<canvas width="480" height="480"></canvas>' +
      '<div class="lgd">' +
        '<span class="lg"><s class="self"></s>你（1号·绿色箭头）</span>' +
        '<span class="lg"><s class="ally"></s>队友（蓝色编号 2 / 3 / 4）</span>' +
        '<span class="lg"><s class="foe"></s>敌人（红色，视野内）</span>' +
        '<span class="lg"><s class="portal"></s>传送门</span>' +
      '</div>' +
      '<button class="pa-btn" data-act="close">关闭地图（M）</button>';
    body.appendChild(bigmap);
    bigmap.addEventListener('click', function (e) {
      if (e.target === bigmap || (e.target.getAttribute && e.target.getAttribute('data-act') === 'close')) {
        toggleBigMap(false);
      }
    });

    function toggleBigMap(force) {
      var box = document.getElementById('pa-bigmap');
      if (!box) return;
      var on = force === undefined ? !box.classList.contains('on') : !!force;
      box.classList.toggle('on', on);
      body.classList.toggle('pa-map-open', on);
      try {
        var mm = window.__game && window.__game.minimap;
        if (mm) mm._big = on;              /* only the large map shows every crate label */
      } catch (e) {}
      /* pause aiming while the map is up, otherwise dragging it turns the camera */
      try {
        var g = window.__game;
        if (g && g.input) {
          if (on) { g.__paLockBefore = !!g.input.locked; g.input.locked = false; }
          else if (g.__paLockBefore) { g.input.locked = true; g.__paLockBefore = false; }
        }
      } catch (e) {}
      if (!on) return;
      var src = document.getElementById('minimap');
      var dst = box.querySelector('canvas');
      if (src && dst && src.width) {
        var x = dst.getContext('2d');
        x.clearRect(0, 0, dst.width, dst.height);
        x.drawImage(src, 0, 0, dst.width, dst.height);
      }
    }
    setInterval(function () {
      if (!bigmap.classList.contains('on')) return;
      var src = document.getElementById('minimap');
      var dst = bigmap.querySelector('canvas');
      if (!src || !src.width) return;
      var x = dst.getContext('2d');
      x.clearRect(0, 0, dst.width, dst.height);
      x.drawImage(src, 0, 0, dst.width, dst.height);
    }, 180);

    if (isTouch) body.classList.add('pa-istouch');
    var touchCtl = buildTouch();

    /* ---------------- landscape-first gate ----------------
       A web page cannot rotate the screen by itself:
         - Android Chrome only honours screen.orientation.lock() while the page is
           fullscreen, so fullscreen must be requested inside the tap gesture first;
         - iOS Safari ships neither the lock nor most of the Screen Orientation API,
           so the honest fallback is this rotate prompt (plus a manifest that opens
           the installed web app straight into landscape).
       The game itself stays perfectly playable in portrait -- the prompt is a hint
       with a "continue in portrait" escape hatch, never a dead end. */
    var rotSkipped = false;
    try { rotSkipped = sessionStorage.getItem('pa.portraitok') === '1'; } catch (e) {}

    function isPortrait() {
      try { if (window.matchMedia) return window.matchMedia('(orientation: portrait)').matches; } catch (e) {}
      return window.innerHeight > window.innerWidth;
    }
    function lockLandscape() {
      var ok = false;
      function tryLock() {
        var so = screen.orientation || screen.msOrientation || null;
        if (!so || typeof so.lock !== 'function') return false;
        try {
          var p = so.lock('landscape');
          if (p && p.catch) p.catch(function () {});
          return true;
        } catch (e) { return false; }
      }
      try {
        var root = document.documentElement;
        var req = root.requestFullscreen || root.webkitRequestFullscreen;
        if (req && !document.fullscreenElement && !document.webkitFullscreenElement) {
          var r = req.call(root, { navigationUI: 'hide' });
          if (r && r.then) r.then(function () { tryLock(); }, function () { tryLock(); });
          else { tryLock(); }
        } else {
          ok = tryLock();
        }
      } catch (e) { tryLock(); }
      return ok;
    }
    try { window.__paLockLandscape = lockLandscape; } catch (e) {}

    var rot = el('div'); rot.id = 'pa-rotate';
    rot.innerHTML = '<div class="in">' +
      '<div class="ph"><i></i></div>' +
      '<b>请横屏游玩</b>' +
      '<p>横屏才有完整视野和双手操作区。<br>浏览器不允许网页自行旋转屏幕，需要把手机横过来。</p>' +
      '<button class="pa-btn primary" data-act="lock">全屏并尝试锁定横屏</button>' +
      '<span class="skip" data-act="skip">继续竖屏（简化布局）</span>' +
      '<em id="pa-rotate-note"></em>' +
      '</div>';
    body.appendChild(rot);

    function refreshRotate() {
      if (!isTouch) { rot.classList.remove('on'); return; }
      var on = isPortrait() && !rotSkipped;
      rot.classList.toggle('on', on);
      body.classList.toggle('pa-portrait', on);
    }
    rot.addEventListener('click', function (e) {
      var a = e.target.getAttribute && e.target.getAttribute('data-act');
      if (a === 'skip') {
        rotSkipped = true;
        try { sessionStorage.setItem('pa.portraitok', '1'); } catch (er) {}
        refreshRotate();
        toast('已切换为竖屏布局 · 建议横屏获得完整视野', 3000);
      } else if (a === 'lock') {
        var supported = lockLandscape();
        var note = document.getElementById('pa-rotate-note');
        if (note) note.textContent = supported
          ? '正在切换横屏…'
          : '当前浏览器不支持自动锁定，请手动把手机横过来';
        setTimeout(refreshRotate, 400);
      }
    });
    refreshRotate();
    window.addEventListener('orientationchange', function () { setTimeout(refreshRotate, 160); });
    window.addEventListener('resize', refreshRotate);
    try {
      if (screen.orientation && screen.orientation.addEventListener) {
        screen.orientation.addEventListener('change', function () { setTimeout(refreshRotate, 120); });
      }
    } catch (e) {}

    if (isFramed) body.classList.add('pa-framed');

    /* A missing WebGL context is the most common cause of a black screen. */
    var webglOK = (function () {
      try {
        var c = document.createElement('canvas');
        var gl = c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl');
        if (gl) {
          var lose = gl.getExtension('WEBGL_lose_context');
          if (lose) lose.loseContext();
        }
        return !!gl;
      } catch (e) { return false; }
    })();
    if (!webglOK) {
      var warn = el('div'); warn.id = 'pa-nowebgl';
      warn.innerHTML = '<div><h4>无法启动 3D 战场</h4>' +
        '<p>当前浏览器或显卡环境不支持 WebGL。<br>请用最新版 Chrome / Edge 打开，并确认已开启硬件加速。</p></div>';
      body.appendChild(warn);
    }

    var lockhelp = el('div'); lockhelp.id = 'pa-lockhelp';
    lockhelp.innerHTML = '<div class="box">' +
      '<h4>鼠标未锁定</h4>' +
      '<p>当前窗口不允许锁定鼠标指针，游戏的键盘移动也会被一并禁用。<br>可启用兼容操作立即开玩，或在新窗口获得完整体验。</p>' +
      '<div class="acts">' +
      '<button class="pa-btn primary" data-act="fallback">启用兼容操作</button>' +
      '<button class="pa-btn" data-act="new">在新窗口打开</button>' +
      '</div></div>';
    body.appendChild(lockhelp);
    lockhelp.addEventListener('click', function (e) {
      var a = e.target.getAttribute && e.target.getAttribute('data-act');
      if (a === 'new') openNewWindow();
      else if (a === 'fallback') enableFallback();
      else if (a === 'skip') lockhelp.classList.remove('on');
    });

    var fallbackBar = el('div'); fallbackBar.id = 'pa-fallback-bar';
    fallbackBar.textContent = '兼容操作中 · 移动鼠标转视角';
    body.appendChild(fallbackBar);

    /* When a container refuses pointer lock the game keeps input.locked=false
       and therefore ignores BOTH mouse and keyboard. Pin the flag so WASD and
       free-look keep working, and hide the cursor so it feels close to normal. */
    var fallbackOn = false;
    function enableFallback() {
      lockhelp.classList.remove('on');
      var g = window.__game;
      if (!g || !g.input) { toast('战场还在载入，请稍候再试', 2600); return; }
      if (fallbackOn) return;
      fallbackOn = true;
      g.input.locked = true;
      body.classList.add('pa-fallback');
      toast('兼容操作已开启 · 移动鼠标转视角', 4200);
      var keep = setInterval(function () {
        if (!fallbackOn) { clearInterval(keep); return; }
        if (document.body.classList.contains('pa-map-open')) return;
        var g2 = window.__game;
        if (g2 && g2.input && !g2.input.locked) {
          try { g2.input.locked = true; } catch (e) {}
        }
      }, 700);
    }

    bar.querySelector('[data-pa="settings"]').addEventListener('click', function (e) {
      e.stopPropagation(); togglePanel();
    });
    bar.querySelector('[data-pa="full"]').addEventListener('click', function (e) {
      e.stopPropagation(); toggleFullscreen();
    });
    bar.querySelector('[data-pa="map"]').addEventListener('click', function (e) {
      e.stopPropagation(); toggleBigMap();
    });

    document.addEventListener('pointerdown', function (e) {
      var p = document.getElementById('pa-panel');
      if (!p || !p.classList.contains('on')) return;
      if (p.contains(e.target) || (e.target.closest && e.target.closest('[data-pa="settings"]'))) return;
      closePanel();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !document.pointerLockElement) closePanel();
      /* pointer lock swallows every click, so the map needs a key to toggle */
      if ((e.code === 'KeyM' || e.key === 'm' || e.key === 'M') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        var tag = (e.target && e.target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea') return;
        if (!body.classList.contains('pa-ingame') && !document.pointerLockElement) return;
        e.preventDefault();
        toggleBigMap();
      }
    });

    apply();

    /* the round target sits between the two scores as a bare number, which reads
       like a scoreline -- label it so nobody mistakes 30 for a team's kills */
    setInterval(function () {
      var g = window.__game;
      if (!g || !g.hud) return;
      var target = g.hud.goal || (window.__paGetKillLimit ? window.__paGetKillLimit() : 30);
      var el2 = document.getElementById('goal');
      var want = '目标 ' + target;
      if (el2 && el2.textContent !== want) el2.textContent = want;
      var gt = document.getElementById('goaltext');
      if (gt && gt.textContent !== want) gt.textContent = want;
    }, 700);

    /* __game is created by the deferred module; retry until it exists */
    var gTries = 0;
    var gTimer = setInterval(function () {
      applyGameSettings();
      if ((window.__game && window.__game.input) || ++gTries > 45) clearInterval(gTimer);
    }, 400);

    /* start screen augmentation (React mounts this a moment later) */
    function decorateStart() {
      var start = document.getElementById('start');
      if (!start) return false;
      var card = start.querySelector('.card');
      var art = start.querySelector('.art');
      var loading = document.getElementById('loading');
      if (!card || !art || !loading) return false;
      if (document.getElementById('pa-loader')) return true;

      var frameNote = el('div'); frameNote.id = 'pa-frame-note';
      frameNote.innerHTML = '<span>预览窗口内鼠标可能无法锁定</span>' +
        '<button type="button">在新窗口打开</button>';
      frameNote.querySelector('button').addEventListener('click', openNewWindow);
      var mission = card.querySelector('.mission');
      if (mission && mission.parentNode === card) card.insertBefore(frameNote, mission);
      else card.appendChild(frameNote);

      /* Touch devices get a control legend instead of the keyboard list */
      if (isTouch) {
        var keys = card.querySelector('.keys');
        if (keys) {
          keys.innerHTML = '<b>左摇杆</b><span>移动 / 冲刺</span>' +
            '<b>右半屏拖动</b><span>转视角</span>' +
            '<b>开火键</b><span>射击</span>' +
            '<b>瞄准键</b><span>举镜</span>' +
            '<b>跳 / 蹲</b><span>跳跃 / 蹲伏</span>' +
            '<b>换弹 / 换枪</b><span>弹药与武器</span>';
        }
        frameNote.style.display = 'none';
      }

      var loader = el('div'); loader.id = 'pa-loader';
      loader.innerHTML = '<div class="pa-load-row"><span>正在加载资源</span><b id="pa-pct">0%</b></div>' +
        '<div class="pa-track"><u id="pa-bar"></u></div>' +
        '<div class="pa-file" id="pa-file">初始化战场数据…</div>';
      card.insertBefore(loader, loading.nextSibling);

      /* If an upstream asset ever fails, show the reason instead of hiding it */
      try {
        new MutationObserver(function () {
          var msg = (loading.textContent || '').trim();
          if (msg.indexOf('加载失败') === 0) {
            var f = document.getElementById('pa-file');
            var b = document.getElementById('pa-bar');
            if (f) { f.textContent = msg; f.style.color = '#ff6a5a'; }
            if (b) { b.style.background = '#ff6a5a'; b.style.width = '100%'; }
          }
        }).observe(loading, { childList: true, characterData: true, subtree: true });
      } catch (e) {}

      for (var i = 0; i < 14; i++) {
        var m = el('span', 'pa-mote');
        m.style.left = (16 + Math.random() * 68) + '%';
        m.style.top = (28 + Math.random() * 58) + '%';
        m.style.animationDuration = (5 + Math.random() * 6).toFixed(1) + 's';
        m.style.animationDelay = (-Math.random() * 12).toFixed(1) + 's';
        m.style.opacity = (0.35 + Math.random() * 0.5).toFixed(2);
        art.appendChild(m);
      }

      /* deploy / pause state */
      var play = document.getElementById('play');
      var inGame = false;
      if (play) {
        /* 16 MB of assets takes a while on a phone connection, and the button the
           module wires last is the only real "ready" signal: it assigns
           play.onclick right after init() resolves. Tapping before that used to
           do nothing at all, which reads as "broken". */
        if (typeof play.onclick !== 'function') {
          play.disabled = true;
          var gateT0 = Date.now();
          var readyTimer = setInterval(function () {
            var ok = typeof play.onclick === 'function' || Date.now() - gateT0 > 90000;
            if (!ok) return;
            clearInterval(readyTimer);
            play.disabled = false;
            play.textContent = '部署';
          }, 250);
        }
        play.addEventListener('click', function () {
          if (!done) { toast('战场资源加载中 · 请稍候再部署', 2200); return; }
          inGame = true;
          applyGameSettings();
          body.classList.add('pa-ingame');
          body.classList.remove('pa-paused');
          closePanel();
          if (touchCtl) {
            /* must run inside the tap gesture, otherwise the browser refuses fullscreen */
            try { lockLandscape(); } catch (e) {}
            setTimeout(refreshRotate, 320);
            /* Touch has no pointer lock: silence the module's lock request so its
               pointerlockchange handler cannot pop the menu back over the board. */
            try {
              var gg = window.__game;
              if (gg && gg.input) gg.input.lock = function () {};
            } catch (e) {}
            /* last resort: the match is running but the menu is still painted */
            var unstick = function () {
              var g2 = window.__game;
              var st = document.getElementById('start');
              if (!g2 || !g2.started || !st) return;
              if (st.style.display !== 'none' && !body.classList.contains('pa-paused')) st.style.display = 'none';
            };
            setTimeout(unstick, 420);
            setTimeout(unstick, 1300);
            touchCtl.start();
          } else {
            toast('WASD 移动 · 鼠标左键开火 · ESC 暂停', 3800);
            setTimeout(function () {
              if (!document.pointerLockElement && !fallbackOn) lockhelp.classList.add('on');
            }, 1300);
          }
        });
      }
      document.addEventListener('pointerlockchange', function () {
        if (body.classList.contains('pa-map-open') && !document.pointerLockElement) {
          try { toggleBigMap(false); } catch (e) {}
        }
        if (document.pointerLockElement) {
          lockhelp.classList.remove('on');
          if (fallbackOn) { fallbackOn = false; body.classList.remove('pa-fallback'); }
        }
        if (!inGame) return;
        var locked = !!document.pointerLockElement;
        body.classList.toggle('pa-ingame', locked);
        body.classList.toggle('pa-paused', !locked);
        var b = document.getElementById('play');
        if (b) b.textContent = locked ? '部署' : '返回战场';
      });

      tickProgress();
      var progTimer = setInterval(function () {
        tickProgress();
        if (done) clearInterval(progTimer);
      }, 220);
      watchDeployButton();
      return true;
    }

    if (!decorateStart()) {
      var mo = new MutationObserver(function () {
        if (decorateStart()) mo.disconnect();
      });
      mo.observe(body, { childList: true, subtree: true });
      setTimeout(function () { mo.disconnect(); }, 60000);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
