(function () {
  'use strict';

  const { hsvToRgb, rgbToHex, rgbToLab, deltaE2000, accuracyFromDeltaE } = window.ColorMath;

  const TOTAL_ROUNDS = 5;
  const MAX_TRIES = 1;
  const MEMORY_SECONDS = 3;
  const PERFECT = 99; // 이 이상이면 남은 시도 없이 라운드 종료
  const BEST_KEY = 'colorcorrect.best';

  const GRADES = [
    { min: 95, grade: 'S', title: '색채의 신! 거의 완벽한 눈이에요.' },
    { min: 90, grade: 'A', title: '아주 예리한 색감각이에요.' },
    { min: 80, grade: 'B', title: '좋은 눈을 가졌어요.' },
    { min: 70, grade: 'C', title: '괜찮아요, 조금만 더!' },
    { min: 60, grade: 'D', title: '색 감각을 더 키워 볼까요?' },
    { min: -1, grade: 'F', title: '다시 도전해 보세요!' },
  ];

  const $ = (id) => document.getElementById(id);
  const el = {
    screens: { start: $('screen-start'), game: $('screen-game'), result: $('screen-result') },
    bestRecord: $('best-record'),
    hudRound: $('hud-round'), hudAvg: $('hud-avg'),
    targetSwatch: $('target-swatch'), targetCover: $('target-cover'), coverText: $('cover-text'),
    targetHex: $('target-hex'), pickSwatch: $('pick-swatch'), pickHex: $('pick-hex'),
    sv: $('sv-canvas'), hue: $('hue-canvas'),
    submit: $('btn-submit'), next: $('btn-next'), confirm: $('btn-confirm'),
    attempts: $('attempts'),
    grade: $('grade'), gradeTitle: $('grade-title'), finalAvg: $('final-avg'),
    newRecord: $('new-record'), summaryBody: $('summary-body'),
  };

  const state = {
    mode: 'see',
    round: 0,
    target: null,        // { h, s, v, rgb, lab, hex }
    tries: [],           // 현재 라운드의 시도 [{ rgb, hex, acc, hsv }]
    results: [],         // 라운드별 { target, best }
    pick: { h: 0, s: 0.5, v: 0.75 },
    roundOver: false,
    memoryTimer: null,
  };

  /* ---------- 유틸 ---------- */
  const fmt = (n) => n.toFixed(1) + '%';
  const rand = (a, b) => a + Math.random() * (b - a);

  function makeColor(h, s, v) {
    const rgb = hsvToRgb(h, s, v);
    return { h, s, v, rgb, lab: rgbToLab(rgb), hex: rgbToHex(rgb) };
  }

  function randomTarget(prev) {
    // 너무 어둡거나 회색에 가까운 색은 피하고, 직전 목표와 색조가 겹치지 않게
    let h;
    do { h = rand(0, 360); } while (prev && Math.abs(((h - prev.h + 540) % 360) - 180) < 40);
    return makeColor(h, rand(0.3, 1), rand(0.35, 1));
  }

  function gradeFor(avg) {
    return GRADES.find((g) => avg >= g.min);
  }

  function loadBest() {
    try { return JSON.parse(localStorage.getItem(BEST_KEY)) || {}; } catch (e) { return {}; }
  }
  function saveBest(best) {
    try { localStorage.setItem(BEST_KEY, JSON.stringify(best)); } catch (e) { /* 저장 불가 환경 */ }
  }

  function showScreen(name) {
    Object.entries(el.screens).forEach(([k, s]) => s.classList.toggle('active', k === name));
    if (name === 'game') requestAnimationFrame(resizeCanvases);
  }

  /* ---------- 색상 팔레트 (HSV 피커) ---------- */
  const svCtx = el.sv.getContext('2d');
  const hueCtx = el.hue.getContext('2d');

  function resizeCanvases() {
    const dpr = window.devicePixelRatio || 1;
    [el.sv, el.hue].forEach((c) => {
      const r = c.getBoundingClientRect();
      c.width = Math.max(1, Math.round(r.width * dpr));
      c.height = Math.max(1, Math.round(r.height * dpr));
    });
    drawPicker();
  }

  function drawPicker() {
    const { h, s, v } = state.pick;
    const dpr = window.devicePixelRatio || 1;

    // 채도(가로) × 밝기(세로) 사각형
    const W = el.sv.width, H = el.sv.height;
    svCtx.fillStyle = rgbToHex(hsvToRgb(h, 1, 1));
    svCtx.fillRect(0, 0, W, H);
    const white = svCtx.createLinearGradient(0, 0, W, 0);
    white.addColorStop(0, '#fff');
    white.addColorStop(1, 'rgba(255,255,255,0)');
    svCtx.fillStyle = white;
    svCtx.fillRect(0, 0, W, H);
    const black = svCtx.createLinearGradient(0, 0, 0, H);
    black.addColorStop(0, 'rgba(0,0,0,0)');
    black.addColorStop(1, '#000');
    svCtx.fillStyle = black;
    svCtx.fillRect(0, 0, W, H);
    drawRing(svCtx, s * W, (1 - v) * H, 8 * dpr, dpr);

    // 색조 슬라이더
    const HW = el.hue.width, HH = el.hue.height;
    const grad = hueCtx.createLinearGradient(0, 0, HW, 0);
    for (let i = 0; i <= 12; i++) grad.addColorStop(i / 12, rgbToHex(hsvToRgb(i * 30, 1, 1)));
    hueCtx.fillStyle = grad;
    hueCtx.fillRect(0, 0, HW, HH);
    const x = (h / 360) * HW;
    hueCtx.lineWidth = 3 * dpr;
    hueCtx.strokeStyle = '#fff';
    hueCtx.strokeRect(x - 4 * dpr, 1.5 * dpr, 8 * dpr, HH - 3 * dpr);
    hueCtx.lineWidth = 1 * dpr;
    hueCtx.strokeStyle = 'rgba(0,0,0,.6)';
    hueCtx.strokeRect(x - 5.5 * dpr, 0.5 * dpr, 11 * dpr, HH - 1 * dpr);

    updatePickPreview();
  }

  function drawRing(ctx, x, y, r, dpr) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.lineWidth = 3 * dpr;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, r + 2 * dpr, 0, Math.PI * 2);
    ctx.lineWidth = 1 * dpr;
    ctx.strokeStyle = 'rgba(0,0,0,.6)';
    ctx.stroke();
  }

  function updatePickPreview() {
    const hex = rgbToHex(hsvToRgb(state.pick.h, state.pick.s, state.pick.v));
    el.pickSwatch.style.background = hex;
    el.pickHex.textContent = hex;
  }

  const clamp01 = (n) => Math.max(0, Math.min(1, n));
  const canEdit = () => !state.roundOver && !el.screens.game.classList.contains('locked');

  function bindDrag(canvas, onMove) {
    const handle = (e) => {
      const r = canvas.getBoundingClientRect();
      onMove(clamp01((e.clientX - r.left) / r.width), clamp01((e.clientY - r.top) / r.height));
      drawPicker();
    };
    canvas.addEventListener('pointerdown', (e) => {
      if (!canEdit()) return;
      canvas.setPointerCapture(e.pointerId);
      handle(e);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (canEdit() && canvas.hasPointerCapture(e.pointerId)) handle(e);
    });
  }

  bindDrag(el.sv, (x, y) => { state.pick.s = x; state.pick.v = 1 - y; });
  bindDrag(el.hue, (x) => { state.pick.h = Math.min(359.9, x * 360); });

  // 키보드로도 조절 (Shift = 크게)
  el.sv.addEventListener('keydown', (e) => {
    if (!canEdit()) return;
    const step = e.shiftKey ? 0.05 : 0.01;
    const map = { ArrowLeft: ['s', -step], ArrowRight: ['s', step], ArrowUp: ['v', step], ArrowDown: ['v', -step] };
    if (!map[e.key]) return;
    e.preventDefault();
    const [k, d] = map[e.key];
    state.pick[k] = clamp01(state.pick[k] + d);
    drawPicker();
  });
  el.hue.addEventListener('keydown', (e) => {
    if (!canEdit()) return;
    const step = e.shiftKey ? 10 : 1;
    const d = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step }[e.key];
    if (d === undefined) return;
    e.preventDefault();
    state.pick.h = (state.pick.h + d + 360) % 360;
    drawPicker();
  });

  window.addEventListener('resize', () => {
    if (el.screens.game.classList.contains('active')) resizeCanvases();
  });

  /* ---------- 게임 흐름 ---------- */
  function startGame() {
    state.mode = document.querySelector('input[name="mode"]:checked').value;
    state.round = 0;
    state.results = [];
    state.target = null;
    showScreen('game');
    startRound();
  }

  function startRound() {
    state.round += 1;
    state.tries = [];
    state.roundOver = false;
    state.target = randomTarget(state.target);
    // 시작 색은 무작위 (목표와 무관)
    state.pick = { h: rand(0, 360), s: rand(0.2, 0.8), v: rand(0.4, 0.9) };

    el.targetSwatch.style.background = state.target.hex;
    el.targetHex.textContent = '';
    el.attempts.innerHTML = '';
    el.submit.hidden = false;
    el.submit.disabled = false;
    el.next.hidden = true;
    el.confirm.hidden = true;
    el.screens.game.classList.remove('locked');
    updateHud();
    drawPicker();

    clearInterval(state.memoryTimer);
    if (state.mode === 'memory') {
      let left = MEMORY_SECONDS;
      el.targetCover.classList.remove('shown');
      el.coverText.textContent = '?';
      el.submit.disabled = true;
      el.screens.game.classList.add('locked');
      el.targetSwatch.dataset.count = left;
      state.memoryTimer = setInterval(() => {
        left -= 1;
        el.targetSwatch.dataset.count = left;
        if (left <= 0) {
          clearInterval(state.memoryTimer);
          delete el.targetSwatch.dataset.count;
          el.targetCover.classList.add('shown');
          el.submit.disabled = false;
          el.screens.game.classList.remove('locked');
        }
      }, 1000);
    } else {
      el.targetCover.classList.remove('shown');
      delete el.targetSwatch.dataset.count;
    }
  }

  function updateHud() {
    el.hudRound.textContent = `${state.round} / ${TOTAL_ROUNDS}`;
    const done = state.results.map((r) => r.best.acc);
    el.hudAvg.textContent = done.length ? fmt(average(done)) : '-';
  }

  const average = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

  function hintsFor(pick, target) {
    const hints = [];
    const dv = target.v - pick.v;
    const ds = target.s - pick.s;
    const amount = (d, big) => (Math.abs(d) > big ? '많이 ' : '조금 ');

    // 색조: 목표가 충분히 선명할 때만 의미가 있음
    if (target.s > 0.15 && target.v > 0.15) {
      const dh = target.h - pick.h; // 슬라이더 위에서의 방향
      const wrap = ((dh + 540) % 360) - 180;
      if (Math.abs(wrap) > 6) {
        hints.push(`색조 ${Math.abs(wrap) > 30 ? '많이' : '조금'} ${dh > 0 ? '오른쪽 →' : '← 왼쪽'}`);
      }
    }
    if (Math.abs(dv) > 0.04) hints.push(`${amount(dv, 0.2)}${dv > 0 ? '더 밝게' : '더 어둡게'}`);
    if (Math.abs(ds) > 0.04) hints.push(`${amount(ds, 0.2)}${ds > 0 ? '더 선명하게' : '더 흐리게'}`);
    return hints;
  }

  function submit() {
    if (state.roundOver || el.submit.disabled) return;
    const pick = makeColor(state.pick.h, state.pick.s, state.pick.v);
    const dE = deltaE2000(state.target.lab, pick.lab);
    const acc = accuracyFromDeltaE(dE);
    const attempt = { ...pick, acc, dE, hints: hintsFor(state.pick, state.target) };
    state.tries.push(attempt);

    const isLast = state.tries.length >= MAX_TRIES || acc >= PERFECT;
    renderAttempt(attempt, state.tries.length, isLast);
    updateHud();

    if (isLast) endRound();
    else el.confirm.hidden = false;
  }

  function renderAttempt(a, n, isLast) {
    const li = document.createElement('li');
    li.className = 'attempt ' + tier(a.acc);
    const hintText = isLast ? '' : (a.hints.length ? a.hints.join(' · ') : '거의 다 왔어요!');
    li.innerHTML = `
      <span class="attempt-n">${n}차</span>
      <span class="mini" style="background:${a.hex}"></span>
      <span class="attempt-body">
        <span class="attempt-acc">${fmt(a.acc)}</span>
        <span class="attempt-msg">${message(a.acc)}</span>
        ${hintText ? `<span class="attempt-hint">${hintText}</span>` : ''}
      </span>`;
    el.attempts.appendChild(li);
  }

  function tier(acc) {
    if (acc >= 95) return 't-s';
    if (acc >= 85) return 't-a';
    if (acc >= 70) return 't-b';
    return 't-c';
  }

  function message(acc) {
    if (acc >= PERFECT) return '완벽해요!';
    if (acc >= 95) return '거의 똑같아요!';
    if (acc >= 90) return '아주 가까워요';
    if (acc >= 80) return '가까워요';
    if (acc >= 65) return '조금 멀어요';
    return '많이 달라요';
  }

  function endRound() {
    state.roundOver = true;
    const best = state.tries.reduce((a, b) => (b.acc > a.acc ? b : a));
    state.results.push({ target: state.target, best });

    el.targetCover.classList.remove('shown');
    el.targetHex.textContent = state.target.hex;
    el.submit.hidden = true;
    el.confirm.hidden = true;
    el.next.hidden = false;
    el.next.textContent = state.round >= TOTAL_ROUNDS ? '결과 보기 →' : '다음 라운드 →';
    el.screens.game.classList.add('locked');

    // 최고 시도를 팔레트와 미리보기에 표시 (화면 크기가 바뀌어 다시 그려져도 유지됨)
    state.pick = { h: best.h, s: best.s, v: best.v };
    drawPicker();

    const li = document.createElement('li');
    li.className = 'round-score';
    li.innerHTML = `라운드 ${state.round} 점수 <b>${fmt(best.acc)}</b>`;
    el.attempts.appendChild(li);
    updateHud();
    el.next.focus();
  }

  function next() {
    if (state.round >= TOTAL_ROUNDS) showResult();
    else startRound();
  }

  function showResult() {
    const avg = average(state.results.map((r) => r.best.acc));
    const g = gradeFor(avg);
    el.grade.textContent = g.grade;
    el.grade.className = 'grade g-' + g.grade.toLowerCase();
    el.gradeTitle.textContent = g.title;
    el.finalAvg.textContent = fmt(avg);

    el.summaryBody.innerHTML = state.results.map((r, i) => `
      <tr>
        <td>${i + 1}</td>
        <td><span class="mini" style="background:${r.target.hex}"></span><code>${r.target.hex}</code></td>
        <td><span class="mini" style="background:${r.best.hex}"></span><code>${r.best.hex}</code></td>
        <td class="${tier(r.best.acc)}">${fmt(r.best.acc)}</td>
      </tr>`).join('');

    const best = loadBest();
    const key = state.mode;
    const isNew = !(best[key] >= avg);
    if (isNew) { best[key] = avg; saveBest(best); }
    el.newRecord.hidden = !isNew;
    showScreen('result');
  }

  function renderBestRecord() {
    const best = loadBest();
    const parts = [];
    if (best.see != null) parts.push(`보면서 ${gradeFor(best.see).grade} (${fmt(best.see)})`);
    if (best.memory != null) parts.push(`기억해서 ${gradeFor(best.memory).grade} (${fmt(best.memory)})`);
    el.bestRecord.textContent = parts.length ? '최고 기록 · ' + parts.join(' / ') : '';
  }

  /* ---------- 이벤트 ---------- */
  $('btn-start').addEventListener('click', startGame);
  el.submit.addEventListener('click', submit);
  el.confirm.addEventListener('click', () => { if (!state.roundOver && state.tries.length) endRound(); });
  el.next.addEventListener('click', next);
  $('btn-restart').addEventListener('click', () => { renderBestRecord(); showScreen('start'); });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !el.screens.game.classList.contains('active')) return;
    if (document.activeElement && document.activeElement.tagName === 'BUTTON') return;
    if (!state.roundOver) submit();
    else next();
  });

  renderBestRecord();
})();
