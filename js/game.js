/* ============================================================
 * game.js — LMSNIPER 메인 게임 로직 / 렌더링 / 입력
 * 좌표: 탄도계와 동일 (x 사거리, y 상방, z 우측).
 * 화면각 단위: mrad (mil). 1 mil = 사거리 1km에서 1m.
 *
 * 배경 에셋 파이프라인:
 *   assets/bg-<terrain>.jpg 파일이 존재하면 실사 파노라마 배경으로
 *   사용한다 (BG_META로 각도 매핑). 없으면 절차적 장면을 그린다.
 * ============================================================ */
'use strict';

(() => {
  const canvas = document.getElementById('scope-canvas');
  let ctx = canvas.getContext('2d');
  const $ = id => document.getElementById(id);
  const windCv = $('wind-canvas'), windCx = windCv.getContext('2d');
  const histCv = $('wind-history'), histCx = histCv.getContext('2d');

  /* ---------------- 게임 상태 ---------------- */
  const S = {
    phase: 'menu',
    rifle: null, ammo: null, mission: null,
    zeroAngle: 0,
    aim: { yaw: 0, pitch: 0 },
    sway: { yaw: 0, pitch: 0 },
    recoil: { yaw: 0, pitch: 0 },
    dial: { elev: 0, wind: 0 },     // 클릭 수 (1클릭 = 0.1 mil)
    mag: 12,
    pointerLocked: false,
    controlMode: 'drag',   // 'drag' | 'look' — C 키로 토글
    magazine: 0, canFireAt: 0, reloading: false,
    breathPhase: 0, o2: 100, holdingBreath: false, recovering: 0,
    heartRate: 70, heartPhase: 0,
    windNow: 0, windDirNow: 0, windNoiseT: 0,
    windMeas: 0, windDirMeas: 0,       // 풍속계 표시값 (센서 지연/오차)
    windHist: [],                       // {t, v}
    shots: [], activeShot: null,
    impactMarks: [], puffs: [],
    score: 0, firedTotal: 0,
    calcVisible: false, calcSolution: null,
    spotterNoise: { wind: 0, dir: 0, elev: 0 },
    lastHudUpdate: 0, shakeT: 0,
    msg: '', msgUntil: 0,
    dope: null,
    sceneSeed: 1,
    targets: [],              // {type:'hostile'|'civilian', dh, z, down, downT, marks[]}
    timeLeft: 0,
    ending: false,
    magMin: 5,
  };

  /* ---------------- 유틸 ---------------- */
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const now = () => performance.now() / 1000;
  const fmt = (v, d = 1) => v.toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d });
  const TAU = Math.PI * 2;

  function noise1(t, seed = 0) {
    return (Math.sin(t * 1.7 + seed * 12.9) * 0.5 +
            Math.sin(t * 0.53 + seed * 78.2) * 0.3 +
            Math.sin(t * 3.1 + seed * 37.7) * 0.2);
  }
  // 결정적 해시 난수 (장면 배치용)
  function hash(n) {
    const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  }
  let gaussSpare = null;
  function gauss() {
    if (gaussSpare != null) { const s = gaussSpare; gaussSpare = null; return s; }
    let u = 0, v = 0;
    while (!u) u = Math.random();
    while (!v) v = Math.random();
    const r = Math.sqrt(-2 * Math.log(u));
    gaussSpare = r * Math.sin(TAU * v);
    return r * Math.cos(TAU * v);
  }

  /* ---------------- 오디오 ---------------- */
  let AC = null;
  function audio() {
    if (!AC) { try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { } }
    return AC;
  }
  // 짧은 기계음 도우미: 대역 통과 노이즈 버스트
  function mechBurst(when, freq, dur, vol, q = 6) {
    const ac = audio(); if (!ac) return;
    const t = ac.currentTime + when;
    const buf = ac.createBuffer(1, Math.ceil(ac.sampleRate * dur), ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ac.sampleRate * dur * 0.25));
    const src = ac.createBufferSource(); src.buffer = buf;
    const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = q;
    const g = ac.createGain(); g.gain.setValueAtTime(vol, t);
    src.connect(bp).connect(g).connect(ac.destination); src.start(t);
  }
  function playShot() {
    const ac = audio(); if (!ac) return;
    const t = ac.currentTime;
    // 총성: 광대역 노이즈 + 저역 붐
    const buf = ac.createBuffer(1, ac.sampleRate * 0.7, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      const e = Math.exp(-i / (ac.sampleRate * 0.06)) + 0.25 * Math.exp(-i / (ac.sampleRate * 0.28));
      d[i] = (Math.random() * 2 - 1) * e;
    }
    const src = ac.createBufferSource(); src.buffer = buf;
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(2600, t);
    lp.frequency.exponentialRampToValueAtTime(500, t + 0.5);
    const g = ac.createGain(); g.gain.setValueAtTime(0.65, t);
    src.connect(lp).connect(g).connect(ac.destination); src.start(t);
    const o = ac.createOscillator(), og = ac.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(95, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.35);
    og.gain.setValueAtTime(0.55, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    o.connect(og).connect(ac.destination); o.start(t); o.stop(t + 0.45);
  }
  function playClick() { mechBurst(0, 3400, 0.03, 0.18, 8); }          // 터렛 클릭
  function playDry() { mechBurst(0, 1400, 0.05, 0.3, 5); }             // 공이치기 (빈 총)
  function playBolt(isSemi) {
    if (isSemi) { mechBurst(0.12, 700, 0.09, 0.35, 3); return; }       // 반자동 노리쇠 왕복
    mechBurst(0.55, 900, 0.07, 0.3, 4);   // 볼트 열기
    mechBurst(0.75, 650, 0.06, 0.25, 4);  // 후퇴
    mechBurst(1.05, 800, 0.08, 0.35, 3);  // 전진·폐쇄
  }
  function playReload() {
    mechBurst(0.1, 500, 0.1, 0.4, 3);     // 탄창 제거
    mechBurst(1.4, 550, 0.1, 0.45, 3);    // 탄창 삽입
    mechBurst(2.1, 850, 0.08, 0.35, 4);   // 노리쇠
  }
  // 바람 앰비언스: 저역 노이즈 루프, 풍속에 볼륨/음색 연동
  let windAmb = null;
  function startWindAmbience() {
    const ac = audio(); if (!ac || windAmb) return;
    const len = ac.sampleRate * 3;
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    let lp = 0;
    for (let i = 0; i < len; i++) { lp += ((Math.random() * 2 - 1) - lp) * 0.04; d[i] = lp * 3; }
    const src = ac.createBufferSource(); src.buffer = buf; src.loop = true;
    const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 380; bp.Q.value = 0.6;
    const g = ac.createGain(); g.gain.value = 0;
    src.connect(bp).connect(g).connect(ac.destination); src.start();
    windAmb = { gain: g, filter: bp };
  }
  function updateWindAmbience() {
    if (!windAmb || !AC) return;
    const target = clamp(S.windNow / 14, 0, 1) * 0.22;
    windAmb.gain.gain.setTargetAtTime(S.phase === 'play' ? target : 0, AC.currentTime, 0.4);
    windAmb.filter.frequency.setTargetAtTime(280 + S.windNow * 45, AC.currentTime, 0.6);
  }
  function playDing(delay) {
    const ac = audio(); if (!ac) return;
    const t = ac.currentTime + delay;
    [1567, 2349].forEach((f, i) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.frequency.value = f * (1 + 0.003 * i);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.25 / (i + 1), t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.2);
      o.connect(g).connect(ac.destination); o.start(t); o.stop(t + 1.3);
    });
  }
  function playThud(delay) {
    const ac = audio(); if (!ac) return;
    const t = ac.currentTime + delay;
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.25);
    g.gain.setValueAtTime(0.35, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.connect(g).connect(ac.destination); o.start(t); o.stop(t + 0.35);
  }

  /* ---------------- 기하 / 탄도 헬퍼 ---------------- */
  function geom() {
    const m = S.mission;
    const incl = m.env.inclineDeg * Math.PI / 180;
    const D = m.distanceM;
    return {
      incl,
      Dh: D * Math.cos(incl),
      ty: D * Math.sin(incl),
      halfW: m.target.widthM / 2,
      halfH: m.target.heightM / 2,
    };
  }
  function ammoParams(mvOverride) {
    return {
      mv: mvOverride ?? S.ammo.mv,
      bc: S.ammo.bc,
      dragModel: S.ammo.dragModel,
      sgFactor: S.ammo.sgFactor,
      spinDriftSign: 1,
    };
  }

  /* 현재 조건 사격 제원 (탄도 계산기, Tab) */
  function computeSolution() {
    const g = geom();
    const env = { ...S.mission.env, windSpeed: S.windMeas, windFromDeg: S.windDirMeas, coriolis: true };
    const p = ammoParams();
    let delta = 0, r = null;
    for (let i = 0; i < 4; i++) {
      r = Ballistics.solveAtRange(p, env,
        { elevRad: g.incl + S.zeroAngle + delta, azRad: 0 }, g.Dh, { dt: 0.003 });
      if (!r) return null;
      delta += (g.ty - r.y) / g.Dh;
    }
    const windMil = r ? -(r.z / g.Dh) * 1000 : 0;
    const e = S.mission.spotterErr;
    return {
      // 고각: 거리/대기 입력은 정확 → 소폭 가산 오차만 (최대 ±~0.5 mil)
      elevMil: delta * 1000 + e * S.spotterNoise.elev * 1.2,
      // 윈디지: 바람 관측이 가장 불확실 → 비례 오차
      windMil: windMil * (1 + e * S.spotterNoise.wind * 0.7),
      tof: r.t, vImpact: r.v, spinDrift: r.spinDrift,
    };
  }

  /* DOPE 표: 사거리별 엘리베이션 + 풍속(full-value)별 윈디지 */
  function buildDope() {
    const g = geom();
    const p = ammoParams();
    const baseEnv = { ...S.mission.env, windSpeed: 0, coriolis: true };
    const step = S.mission.distanceM > 1000 ? 200 : 100;
    const maxR = Math.min(
      Math.ceil(S.mission.distanceM * 1.25 / step) * step,
      S.rifle.effectiveRangeM * 1.6);
    const rows = [];
    for (let R = step; R <= maxR; R += step) {
      let delta = 0, r = null, ok = true;
      for (let i = 0; i < 3; i++) {
        r = Ballistics.solveAtRange(p, baseEnv,
          { elevRad: S.zeroAngle + delta, azRad: 0 }, R, { dt: 0.006 });
        if (!r) { ok = false; break; }
        delta += (0 - r.y) / R;
      }
      if (!ok) break;
      // 4 m/s full-value 측풍의 편류 → 1 m/s 당 mil
      const wEnv = { ...baseEnv, windSpeed: 4, windFromDeg: baseEnv.fireAzimuthDeg + 90 };
      const rw = Ballistics.solveAtRange(p, wEnv,
        { elevRad: S.zeroAngle + delta, azRad: 0 }, R, { dt: 0.006 });
      const milPer1 = rw ? Math.abs(rw.z - r.z) / R * 1000 / 4 : 0;
      rows.push({ R, elev: delta * 1000, w: milPer1 });
    }
    S.dope = rows;
    renderDope();
  }
  function renderDope() {
    if (!S.dope) return;
    const D = S.mission.distanceM;
    let best = 0, bd = 1e9;
    S.dope.forEach((r, i) => { const d = Math.abs(r.R - D); if (d < bd) { bd = d; best = i; } });
    const winds = [2, 4, 6, 8];
    let html = '<table><tr><th>거리</th><th>고각</th>' +
      winds.map(w => `<th>${w}㎧</th>`).join('') + '</tr>';
    S.dope.forEach((r, i) => {
      html += `<tr${i === best ? ' class="cur"' : ''}><td>${r.R}m</td><td>${r.elev.toFixed(1)}</td>` +
        winds.map(w => `<td>${(r.w * w).toFixed(1)}</td>`).join('') + '</tr>';
    });
    html += '</table><div class="note">고각: 100m 영점 기준 상향 mil · 풍속열: full-value 측풍 편류 mil<br>1 클릭 = 0.1 mil · 사선풍은 cos 성분 적용</div>';
    $('dope-table').innerHTML = html;
  }

  /* ---------------- 배경 사진 파이프라인 ---------------- */
  // assets/bg-<terrain>.jpg 가 있으면 실사 배경 사용.
  //  mradW: 사진 가로 전체가 커버하는 각도 [mrad]
  //  cFrac: 조준선(LOS) 높이에 해당하는 사진 세로 위치 (0=위) — 평지에선 지평선
  //  mradW는 사진 속 구조물의 실제 크기(픽셀 대비)로 역산해 표적 원근과 일치시킴.
  //  magMin: 사진 세로 커버 한계로 결정되는 최소 배율.
  const BG_META = {
    farm:     { mradW: 80,  cFrac: 0.62, xFrac: 0.80, magMin: 7 }, // 헛간 ~9 m
    forest:   { mradW: 70,  cFrac: 0.47, magMin: 6 },              // 유칼립투스 ~15 m
    plains:   { mradW: 56,  cFrac: 0.68, magMin: 9 },              // 아카시아 ~7 m
    mountain: { mradW: 140, cFrac: 0.55, magMin: 5 },              // 계곡 오두막 ~4 m
    desert:   { mradW: 105, cFrac: 0.47, magMin: 5 },              // 야자수 ~8 m
    tundra:   { mradW: 85,  cFrac: 0.34, magMin: 5 },              // 침엽수 ~12 m
    kasbah:   { mradW: 75,  cFrac: 0.50, magMin: 7 },              // 건물 2~3층 ~10 m
    _default: { mradW: 95,  cFrac: 0.46, magMin: 5 },
  };
  const BG = {};
  function tryLoadBg(terrain) {
    if (BG[terrain] !== undefined) return;
    BG[terrain] = null;
    const img = new Image();
    img.onload = () => { BG[terrain] = { img }; };
    img.onerror = () => { BG[terrain] = null; };
    img.src = `assets/bg-${terrain}.jpg`;
  }

  /* ---------------- 게임 시작 / 종료 ---------------- */
  function startGame() {
    const m = S.mission;
    S.zeroAngle = Ballistics.zeroAngle(ammoParams(), m.env, 100);
    S.aim = { yaw: 0, pitch: 0 };
    S.dial = { elev: 0, wind: 0 };
    S.recoil = { yaw: 0, pitch: 0 };
    S.magMin = (BG_META[m.terrain] || BG_META._default).magMin || 5;
    S.mag = clamp(12, S.magMin, 25);
    S.magazine = S.rifle.magCapacity;
    S.shots = []; S.impactMarks = []; S.puffs = [];
    S.score = 0; S.firedTotal = 0;
    S.o2 = 100; S.heartRate = 70; S.recovering = 0;
    S.activeShot = null; S.reloading = false; S.canFireAt = 0;
    S.spotterNoise = { wind: gauss() * 0.5, dir: gauss() * 0.5, elev: gauss() * 0.3 };
    S.calcSolution = null;
    S.windHist = [];
    S.windMeas = m.env.windSpeed; S.windDirMeas = m.env.windFromDeg;
    S.sceneSeed = [...m.id].reduce((a, c) => a + c.charCodeAt(0), 7);
    tryLoadBg(m.terrain);

    // ── 다중 표적 배치: 거리 ±10%, 좌우 산개, 각도상 최소 이격 3.4 mil ──
    S.targets = [];
    const incl = m.env.inclineDeg * Math.PI / 180;
    const spawn = type => {
      for (let tries = 0; tries < 50; tries++) {
        const Di = m.distanceM * (1 + (Math.random() * 2 - 1) * 0.10);
        const dh = Di * Math.cos(incl);
        const z = (Math.random() * 2 - 1) * m.distanceM * 0.03;
        const yaw = z / dh * 1000;
        if (Math.abs(yaw) > 26) continue;
        if (S.targets.every(o => Math.abs(o.z / o.dh * 1000 - yaw) > 3.4)) {
          S.targets.push({ type, dh, z, down: false, downT: 0, marks: [] });
          return;
        }
      }
      S.targets.push({
        type, dh: m.distanceM * Math.cos(incl),
        z: (Math.random() * 2 - 1) * m.distanceM * 0.03,
        down: false, downT: 0, marks: [],
      });
    };
    for (let i = 0; i < (m.hostiles ?? 1); i++) spawn('hostile');
    for (let i = 0; i < (m.civilians ?? 0); i++) spawn('civilian');
    S.timeLeft = m.timeLimitS ?? 180;
    S.ending = false;

    S.phase = 'play';
    $('menu').classList.add('hidden');
    $('result').classList.add('hidden');
    $('game').classList.remove('hidden');
    setMsg(`임무 개시 — ${m.name} · 적 ${m.hostiles ?? 1}` +
      ((m.civilians ?? 0) ? ` · 민간인 ${m.civilians} (사격 금지!)` : ''), 5);
    buildDope();
    updateHelpText();
    resize();
  }
  function backToMenu() {
    S.phase = 'menu';
    document.exitPointerLock && document.exitPointerLock();
    $('game').classList.add('hidden');
    $('analysis').classList.add('hidden');
    $('result').classList.add('hidden');
    $('menu').classList.remove('hidden');
    showStep('rifle');
  }
  function setMsg(text, dur = 3) { S.msg = text; S.msgUntil = now() + dur; }

  /* ---------------- 발사 / 판정 ---------------- */
  // 인체 존 판정 (dy: 인체 중심(지상 0.9 m) 기준 상방 [m], dz: 우측 [m])
  function zoneHit(dy, dz) {
    if (Math.hypot(dz, dy - 0.76) <= 0.13) return { zone: '머리', score: 10 };
    if (dy > 0.18 && dy <= 0.64 && Math.abs(dz) <= 0.19) return { zone: '흉부', score: 9 };
    if (dy > -0.12 && dy <= 0.18 && Math.abs(dz) <= 0.17) return { zone: '복부', score: 7 };
    if (dy > -0.90 && dy <= -0.12 && Math.abs(dz) <= 0.16) return { zone: '하지', score: 5 };
    if (dy > 0.05 && dy <= 0.60 && Math.abs(dz) <= 0.30) return { zone: '팔', score: 4 };
    return null;
  }
  // 수평거리 dh 지점의 지면 높이 [m]
  function gYat(dh) {
    const g = geom();
    return lerp(-1.6, g.ty - 0.9, clamp(dh / g.Dh, 0, 1.15));
  }

  function fire() {
    const t = now();
    if (t < S.canFireAt || S.reloading || S.activeShot || S.ending) return;
    if (S.magazine <= 0) { playDry(); setMsg('탄창 비었음 — R 키로 재장전', 2.5); return; }

    S.magazine--;
    S.firedTotal++;
    S.canFireAt = t + (S.rifle.id === 'm107a1' ? 0.6 : 1.5);
    playShot();
    playBolt(S.rifle.id === 'm107a1');

    const g = geom();
    const mv = S.ammo.mv + gauss() * S.ammo.mvSd;
    const disp = 0.145e-3; // ~0.5 MOA 고유 산포
    const elevRad = g.incl + S.zeroAngle
      + (S.aim.pitch + S.sway.pitch + S.recoil.pitch) * 1e-3
      + S.dial.elev * 0.1e-3
      + gauss() * disp;
    const azRad = (S.aim.yaw + S.sway.yaw + S.recoil.yaw) * 1e-3
      + S.dial.wind * 0.1e-3
      + gauss() * disp;

    const env = { ...S.mission.env, windSpeed: S.windNow, windFromDeg: S.windDirNow, coriolis: true };
    const maxDh = Math.max(g.Dh, ...S.targets.map(tg => tg.dh)) + 25;
    const r = Ballistics.solveAtRange(ammoParams(mv), env,
      { elevRad, azRad }, maxDh, { dt: 0.003, recordPath: true });

    S.recoil.pitch += S.rifle.recoilMrad * (0.7 + Math.random() * 0.5);
    S.recoil.yaw += S.rifle.recoilMrad * 0.25 * (Math.random() - 0.4);
    S.shakeT = t + 0.18;

    if (!r || !r.path || r.path.length < 2) {
      setMsg('탄이 표적까지 도달하지 못했다 (탄속 소진)', 3);
      return;
    }
    const path = r.path;
    const reach = path[path.length - 1].x;

    // 경로 보간 + 스핀 편류/지구 곡률 보정
    const sg = S.ammo.sgFactor ?? 1.9;
    const curv = !!env.earthCurvature;
    const atX = xq => {
      let lo = 0, hi = path.length - 1;
      if (xq >= path[hi].x) lo = hi - 1;
      else while (hi - lo > 1) { const mid = (lo + hi) >> 1; (path[mid].x <= xq) ? lo = mid : hi = mid; }
      const a = path[lo], b = path[lo + 1] || a;
      const f = b.x > a.x ? clamp((xq - a.x) / (b.x - a.x), 0, 1) : 0;
      const tt = lerp(a.t, b.t, f);
      const spin = 1.25 * (sg + 1.2) * Math.pow(Math.max(tt, 0), 1.83) * 0.0254;
      return {
        y: lerp(a.y, b.y, f) + (curv ? xq * xq / (2 * 6.371e6) : 0),
        z: lerp(a.z, b.z, f) + spin,
        t: tt, v: lerp(a.v, b.v, f),
      };
    };

    // 가까운 표적부터 피격 판정 (첫 명중에서 탄 정지)
    let hitIdx = -1, hitZone = null, hitAt = null;
    const order = S.targets.map((tg, i) => i)
      .filter(i => !S.targets[i].down && S.targets[i].dh <= reach)
      .sort((a, b) => S.targets[a].dh - S.targets[b].dh);
    for (const i of order) {
      const tg = S.targets[i];
      const p = atX(tg.dh);
      const dy = p.y - (gYat(tg.dh) + 0.9), dz = p.z - tg.z;
      const zh = zoneHit(dy, dz);
      if (zh) { hitIdx = i; hitZone = zh; hitAt = { ...p, dy, dz }; break; }
    }

    // 빗나감이면 각도상 최근접 생존 표적 기준 오차 계산
    let missInfo = null;
    if (hitIdx < 0) {
      let bd = 1e9;
      for (const tg of S.targets) {
        if (tg.down || tg.dh > reach) continue;
        const p = atX(tg.dh);
        const dy = p.y - (gYat(tg.dh) + 0.9), dz = p.z - tg.z;
        const dist = Math.hypot(dy, dz);
        if (dist < bd) { bd = dist; missInfo = { dy, dz, dh: tg.dh, p }; }
      }
    }
    const endP = atX(Math.min(g.Dh, reach));
    const tof = hitIdx >= 0 ? hitAt.t : endP.t;
    S.activeShot = {
      t0: t, path, tof,
      result: { hitIdx, hitZone, hitAt, missInfo, tof, vImp: hitIdx >= 0 ? hitAt.v : endP.v },
    };
  }

  function resolveShot() {
    const a = S.activeShot; if (!a) return;
    S.activeShot = null;
    const res = a.result;
    const g = geom();
    if (res.hitIdx >= 0) {
      const tg = S.targets[res.hitIdx];
      tg.down = true; tg.downT = now();
      tg.marks.push({ dy: res.hitAt.dy, dz: res.hitAt.dz });
      if (tg.type === 'civilian') {
        playThud(tg.dh / 343);
        S.shots.push({ hit: true, civilian: true });
        setMsg('민간인 피격!', 4);
        endMission(false, '민간인 피격 — 교전 수칙 위반');
        return;
      }
      playDing(tg.dh / 343);
      const bonus = res.hitZone.zone === '머리' ? 2 : 0;
      const pts = res.hitZone.score + bonus + (S.firedTotal === 1 ? 5 : 0);
      S.score += pts;
      S.shots.push({ hit: true, zone: res.hitZone.zone });
      const remain = S.targets.filter(x => x.type === 'hostile' && !x.down).length;
      setMsg(`${res.hitZone.zone} 명중! +${pts}점${bonus ? ' (헤드샷)' : ''}` +
        ` · 비행 ${fmt(res.tof, 2)}s · 착탄속도 ${fmt(res.vImp, 0)} m/s · 잔여 적 ${remain}`, 4.5);
      if (remain === 0) endMission(true, '모든 표적 제압');
    } else {
      playThud(S.mission.distanceM / 343);
      S.shots.push({ hit: false });
      const mi = res.missInfo;
      if (mi) {
        const dirV = mi.dy > 0 ? '위' : '아래';
        const dirH = mi.dz > 0 ? '오른쪽' : '왼쪽';
        setMsg(`빗나감 — 최근접 표적 기준 ${dirV} ${fmt(Math.abs(mi.dy), 2)} m · ` +
          `${dirH} ${fmt(Math.abs(mi.dz), 2)} m`, 4);
        S.puffs.push({
          yawMrad: Math.atan2(mi.p.z, mi.dh) * 1000,
          pitchMrad: (Math.atan2(mi.p.y, mi.dh) - g.incl) * 1000,
          t0: now(),
        });
      } else setMsg('빗나감', 3);
    }
  }

  /* ---------------- 임무 종료 / 결과 ---------------- */
  function endMission(success, reason) {
    if (S.ending) return;
    S.ending = true;
    setTimeout(() => showResult(success, reason), success ? 1300 : 900);
  }
  function showResult(success, reason) {
    S.phase = 'result';
    document.exitPointerLock && document.exitPointerLock();
    const hostTotal = S.targets.filter(x => x.type === 'hostile').length;
    const hostDown = S.targets.filter(x => x.type === 'hostile' && x.down).length;
    const hits = S.shots.filter(x => x.hit && !x.civilian).length;
    const acc = S.firedTotal ? hits / S.firedTotal : 0;
    const heads = S.shots.filter(x => x.zone === '머리').length;
    const tFrac = clamp(S.timeLeft / (S.mission.timeLimitS || 180), 0, 1);
    let grade = 'F';
    if (success) {
      const pts = acc * 55 + tFrac * 30 + (heads / Math.max(1, hostTotal)) * 15;
      grade = pts >= 78 ? 'S' : pts >= 60 ? 'A' : pts >= 40 ? 'B' : 'C';
    }
    $('result-title').textContent = success ? '임무 완료' : `임무 실패 — ${reason}`;
    $('result-title').classList.toggle('fail', !success);
    $('result-grade').textContent = grade;
    $('result-grade').classList.toggle('fail', !success);
    $('result-stats').innerHTML = `<table>
      <tr><td>제압한 적</td><td>${hostDown} / ${hostTotal}</td></tr>
      <tr><td>발사 / 명중</td><td>${S.firedTotal}발 / ${hits}발 (${fmt(acc * 100, 0)}%)</td></tr>
      <tr><td>헤드샷</td><td>${heads}</td></tr>
      <tr><td>남은 시간</td><td>${fmt(Math.max(0, S.timeLeft), 0)}초 / ${S.mission.timeLimitS}초</td></tr>
      <tr><td>총점</td><td>${S.score}</td></tr></table>`;
    $('result').classList.remove('hidden');
  }

  function reload() {
    if (S.reloading || S.magazine === S.rifle.magCapacity) return;
    S.reloading = true;
    playReload();
    setMsg('재장전 중...', 2.5);
    setTimeout(() => { S.magazine = S.rifle.magCapacity; S.reloading = false; setMsg('장전 완료', 1.5); }, 2500);
  }

  /* ---------------- 업데이트 ---------------- */
  let lastT = now();
  let lastHistPush = 0;
  function update() {
    const t = now();
    const dt = Math.min(0.05, t - lastT);
    lastT = t;
    if (S.phase !== 'play') return;

    const env = S.mission.env;
    const gust = env.gustiness || 0.2;

    // ── 임무 타이머 ──
    if (!S.ending) {
      S.timeLeft -= dt;
      if (S.timeLeft <= 0) { S.timeLeft = 0; endMission(false, '시간 초과'); }
    }

    // ── 바람: 장주기 드리프트(기류 변화) × 단주기 돌풍 ──
    S.windNoiseT += dt;
    const slow = 1 + 0.45 * noise1(S.windNoiseT * 0.035, 21);           // 수 분 주기
    const fast = 1 + gust * 0.6 * noise1(S.windNoiseT * 0.6, 1);        // 돌풍
    S.windNow = Math.max(0, env.windSpeed * slow * fast);
    S.windDirNow = env.windFromDeg
      + 28 * noise1(S.windNoiseT * 0.022, 22)                            // 풍향 장주기 변화
      + 12 * gust * noise1(S.windNoiseT * 0.35, 2);                      // 순간 요동

    // 풍속계 표시값: 1초 시정수 스무딩 + 관측 오차
    const e = S.mission.spotterErr;
    const k = 1 - Math.exp(-dt / 0.8);
    S.windMeas += (S.windNow * (1 + e * S.spotterNoise.wind * 0.4) - S.windMeas) * k;
    S.windDirMeas += (S.windDirNow + e * 15 * S.spotterNoise.dir - S.windDirMeas) * k;
    if (t - lastHistPush > 0.25) {
      lastHistPush = t;
      S.windHist.push({ t, v: S.windMeas });
      while (S.windHist.length && t - S.windHist[0].t > 45) S.windHist.shift();
    }

    // ── 호흡 / 심박 ──
    S.breathPhase += dt * (TAU / 4.2);
    S.heartPhase += dt * (S.heartRate / 60) * TAU;
    if (S.holdingBreath && S.o2 > 0 && S.recovering <= 0) {
      S.o2 = Math.max(0, S.o2 - dt * 14);
      if (S.o2 === 0) { S.recovering = 4; S.heartRate = 105; }
    } else {
      S.o2 = Math.min(100, S.o2 + dt * (S.recovering > 0 ? 10 : 25));
    }
    if (S.recovering > 0) S.recovering = Math.max(0, S.recovering - dt);
    S.heartRate = Math.max(70, S.heartRate - dt * 6);

    const holdEff = (S.holdingBreath && S.o2 > 0 && S.recovering <= 0) ? 0.15 : 1;
    const recovEff = S.recovering > 0 ? 2.2 : 1;
    const amp = 0.5 * S.rifle.swayFactor * holdEff * recovEff;
    const beat = Math.pow(Math.max(0, Math.sin(S.heartPhase)), 12) * 0.25 * (S.heartRate / 70);
    S.sway.pitch = amp * (Math.sin(S.breathPhase) * 0.8 + noise1(t * 0.9, 5) * 0.4) + beat * recovEff;
    S.sway.yaw = amp * (noise1(t * 0.7, 9) * 0.55) + beat * 0.3;

    // 반동 복원
    const rd = Math.exp(-dt * 2.8);
    S.recoil.pitch *= rd;
    S.recoil.yaw *= rd;

    if (S.activeShot && t - S.activeShot.t0 >= S.activeShot.tof) resolveShot();

    if (t - S.lastHudUpdate > 0.15) { S.lastHudUpdate = t; updateHud(); }
    drawWindMeter();
    updateWindAmbience();
  }

  /* ---------------- 풍향풍속계 위젯 ---------------- */
  function drawWindMeter() {
    const c = windCx, Wc = windCv.width, Hc = windCv.height;
    const cx = Wc / 2, cy = Hc / 2, R = Wc / 2 - 10;
    c.clearRect(0, 0, Wc, Hc);
    if (S.phase !== 'play') return;
    const fireAz = S.mission.env.fireAzimuthDeg;
    // 로즈: 12시 = 사격 방향
    c.strokeStyle = '#33463a'; c.lineWidth = 1.5;
    c.beginPath(); c.arc(cx, cy, R, 0, TAU); c.stroke();
    c.strokeStyle = '#26362c';
    c.beginPath(); c.arc(cx, cy, R * 0.62, 0, TAU); c.stroke();
    c.fillStyle = '#7d9484'; c.font = '10px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    for (let a = 0; a < 360; a += 30) {
      const rad = (a - 90) * Math.PI / 180;
      const x1 = cx + Math.cos(rad) * (R - 4), y1 = cy + Math.sin(rad) * (R - 4);
      const x2 = cx + Math.cos(rad) * R, y2 = cy + Math.sin(rad) * R;
      c.strokeStyle = '#4b6252';
      c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
    }
    // 표적 방향 마커 (12시)
    c.fillStyle = '#8fd14f';
    c.beginPath(); c.moveTo(cx, cy - R - 6); c.lineTo(cx - 5, cy - R + 4); c.lineTo(cx + 5, cy - R + 4); c.closePath(); c.fill();
    c.fillStyle = '#5f7566'; c.font = '9px sans-serif';
    c.fillText('표적', cx, cy - R + 13);
    // 북쪽 표시
    const northA = (-fireAz - 90) * Math.PI / 180;
    c.fillStyle = '#b46a55';
    c.fillText('N', cx + Math.cos(northA) * (R - 13), cy + Math.sin(northA) * (R - 13));
    // 바람 화살표: 바람이 "불어가는" 방향 (사수 기준)
    const rel = (S.windDirMeas - fireAz + 180) * Math.PI / 180; // to-direction
    const a0 = rel - Math.PI / 2;
    const spd = clamp(S.windMeas / 12, 0.12, 1);
    const len = R * 0.78 * (0.45 + 0.55 * spd);
    c.save();
    c.translate(cx, cy); c.rotate(a0 + Math.PI / 2);
    c.strokeStyle = '#e0a03c'; c.fillStyle = '#e0a03c'; c.lineWidth = 3; c.lineCap = 'round';
    c.beginPath(); c.moveTo(0, len * 0.45); c.lineTo(0, -len * 0.55); c.stroke();
    c.beginPath(); c.moveTo(0, -len * 0.55 - 8); c.lineTo(-7, -len * 0.55 + 6); c.lineTo(7, -len * 0.55 + 6); c.closePath(); c.fill();
    c.restore();
    // 중앙 속도
    c.fillStyle = '#0c120e';
    c.beginPath(); c.arc(cx, cy, 24, 0, TAU); c.fill();
    c.strokeStyle = '#33463a'; c.beginPath(); c.arc(cx, cy, 24, 0, TAU); c.stroke();
    c.fillStyle = '#eaf6ec'; c.font = '700 15px monospace';
    c.fillText(S.windMeas.toFixed(1), cx, cy - 4);
    c.fillStyle = '#7d9484'; c.font = '9px sans-serif';
    c.fillText('m/s', cx, cy + 10);

    // 디지털 표시
    const relDeg = ((S.windDirMeas - fireAz) % 360 + 360) % 360;
    const clock = Math.round(relDeg / 30) % 12 || 12;
    $('wind-digital').innerHTML =
      `${S.windMeas.toFixed(1)} <span class="dim">m/s</span> · ${Math.round(((S.windDirMeas % 360) + 360) % 360)}°` +
      ` <span class="dim">(${clock}시 방향에서)</span>`;

    // 히스토리 스파크라인 (최근 45초)
    const h = histCx, Wh = histCv.width, Hh = histCv.height;
    h.clearRect(0, 0, Wh, Hh);
    if (S.windHist.length > 1) {
      const t = now();
      const vmax = Math.max(2, ...S.windHist.map(p => p.v)) * 1.15;
      h.strokeStyle = '#4fb7d1'; h.lineWidth = 1.4;
      h.beginPath();
      S.windHist.forEach((p, i) => {
        const x = Wh - (t - p.t) / 45 * Wh;
        const y = Hh - 3 - (p.v / vmax) * (Hh - 8);
        i ? h.lineTo(x, y) : h.moveTo(x, y);
      });
      h.stroke();
      h.fillStyle = '#5f7566'; h.font = '8px sans-serif'; h.textAlign = 'left';
      h.fillText('풍속 45s', 3, 9);
    }
  }

  /* ---------------- HUD ---------------- */
  function updateHud() {
    const m = S.mission, env = m.env;

    const tl = Math.max(0, S.timeLeft);
    const clock = `${Math.floor(tl / 60)}:${String(Math.floor(tl % 60)).padStart(2, '0')}`;
    const hostRemain = S.targets.filter(x => x.type === 'hostile' && !x.down).length;
    const civCount = S.targets.filter(x => x.type === 'civilian' && !x.down).length;
    $('hud-mission').innerHTML =
      `<h4>임무</h4><b>${m.name}</b><br>` +
      `<span style="color:var(--dim);font-size:11.5px">` +
      `거리(레이저) <b>${m.distanceM.toLocaleString()} m</b> · 경사 ${fmt(env.inclineDeg, 0)}°<br>` +
      `기온 ${fmt(env.tempC, 0)}℃ · 습도 ${fmt(env.rhPct, 0)}% · 고도 ${env.altitudeM.toLocaleString()} m<br>` +
      `기압 ${fmt(Ballistics.pressureAtAltitude(env.altitudeM), 0)} hPa · 위도 ${fmt(env.latitudeDeg, 1)}° · 방위 ${fmt(env.fireAzimuthDeg, 0)}°` +
      (env.earthCurvature ? ' · <span class="warn">곡률 유효</span>' : '') +
      `</span><br>` +
      `<span class="${tl < 20 ? 'bad' : 'warn'}" style="font-size:15px;font-weight:700">⏱ ${clock}</span> · ` +
      `적 <b>${hostRemain}</b> 남음` +
      (civCount ? ` · <span class="bad">민간인 ${civCount} — 사격 금지</span>` : '') +
      `<br><span class="warn">점수 ${S.score}</span> · 발사 ${S.firedTotal} · 명중 ${S.shots.filter(x => x.hit && !x.civilian).length}`;

    $('hud-weapon').innerHTML =
      `<h4>화기 / 선택 탄종</h4><b>${S.rifle.name}</b><br>` +
      `${S.ammo.name}<br>` +
      `<span style="color:var(--dim);font-size:11.5px">BC(${S.ammo.dragModel}) ${S.ammo.bc} · V₀ ${fmt(S.ammo.mv, 0)} m/s · ${S.ammo.bulletGr} gr</span><br>` +
      `탄창 <b>${S.magazine}</b>/${S.rifle.magCapacity}` +
      (S.reloading ? ' <span class="warn">(재장전)</span>' : '') +
      ` · 배율 ${fmt(S.mag, 0)}×`;

    const o2Cls = S.o2 < 30 ? 'bad' : '';
    $('hud-body').innerHTML =
      `<h4>터렛 / 신체</h4>` +
      `엘리베이션 <b>${fmt(S.dial.elev * 0.1, 1)} mil</b> (↑↓) · ` +
      `윈디지 <b>${fmt(S.dial.wind * 0.1, 1)} mil</b> (←→)<br>` +
      `산소 <span class="meter o2"><i style="width:${S.o2}%"></i></span> <span class="${o2Cls}">${fmt(S.o2, 0)}%</span> · ` +
      `심박 <span class="meter hr"><i style="width:${clamp((S.heartRate - 50) / 80 * 100, 0, 100)}%"></i></span> ${fmt(S.heartRate, 0)}` +
      (S.recovering > 0 ? '<br><span class="bad">호흡 회복 중 — 조준 불안정!</span>' : '');

    if (S.calcVisible) {
      const sol = S.calcSolution;
      $('hud-calc').innerHTML = `<h4>탄도 계산기</h4>` + (sol ?
        `권장 엘리베이션: <b>${fmt(sol.elevMil, 1)} mil</b><br>` +
        `권장 윈디지: <b>${fmt(sol.windMil, 1)} mil</b><br>` +
        `예상 비행시간 ${fmt(sol.tof, 2)} s · 착탄속도 ${fmt(sol.vImpact, 0)} m/s<br>` +
        `스핀 편류 ${fmt(sol.spinDrift * 100, 1)} cm<br>` +
        `<span style="color:var(--dim);font-size:11px">현재 풍속계 값 기준 — 관측 오차 포함</span>`
        : '계산 불가 (사거리 초과)');
    }

    $('hud-log').textContent = now() < S.msgUntil ? S.msg : '';
  }

  /* ---------------- 렌더링 ---------------- */
  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resize);
  resize();

  const TERRAIN = {
    plains:  { skyTop: '#7fb4d9', skyBot: '#cfe3ea', ground: ['#8aa35f', '#5d7a45', '#41582f'], haze: '#c9d4bd', ridge: '#5f7568', features: ['pines'] },
    forest:  { skyTop: '#86b6d6', skyBot: '#d3e5e2', ground: ['#97a468', '#6a7a4b', '#4a5a34'], haze: '#cfd8c0', ridge: '#3d5240', features: ['berm', 'pines'] },
    farm:    { skyTop: '#8cbede', skyBot: '#dcebe8', ground: ['#a4b06a', '#79854d', '#565f38'], haze: '#d7ddc2', ridge: '#5c7258', features: ['barn', 'pines'] },
    mountain:{ skyTop: '#6e9fc9', skyBot: '#d7e4ec', ground: ['#9aa38e', '#6b7a62', '#4a5844'], haze: '#c2cdc4', ridge: '#697a86', features: ['peaks'] },
    desert:  { skyTop: '#96b6d0', skyBot: '#e8d9b8', ground: ['#d9c08a', '#b89e66', '#93794a'], haze: '#e3d3ad', ridge: '#a98f63', features: ['dunes'] },
    kasbah:  { skyTop: '#9db4c4', skyBot: '#e8d4ae', ground: ['#c9a978', '#a8865a', '#83683f'], haze: '#e0cfa6', ridge: '#96774f', features: ['dunes'] },
    tundra:  { skyTop: '#8ba7bd', skyBot: '#d5dde3', ground: ['#c3cbc0', '#98a396', '#75816f'], haze: '#d3dad6', ridge: '#8b9aa4', features: ['peaks'] },
  };

  function parseColor(c) {
    if (c[0] === '#') {
      return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
    }
    return c.match(/\d+/g).slice(0, 3).map(Number);
  }
  function mixColor(c1, c2, f) {
    const a = parseColor(c1), b = parseColor(c2);
    const m = a.map((v, i) => Math.round(lerp(v, b[i], f)));
    return `rgb(${m[0]},${m[1]},${m[2]})`;
  }
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ================================================================
   * 렌더링: 이중 패스
   *  패스 1 — 스코프 밖: 1× 육안 배율 주변시 (저해상 + 블러)
   *  패스 2 — 스코프 안: 현재 배율로 확대, 선명
   * ================================================================ */

  /* 세계 렌더링 (임의 컨텍스트/배율) */
  function renderWorld(tctx, Wv, Hv, ppmW, camYaw, camPitch, opts = {}) {
    const prevCtx = ctx; ctx = tctx;
    const t = now();
    const g = geom();
    const m = S.mission;
    const ter = TERRAIN[m.terrain] || TERRAIN.plains;
    const cx = Wv / 2, cy = Hv / 2;
    const sx = yawMrad => cx + (yawMrad - camYaw) * ppmW;
    const sy = pitchMrad => cy - (pitchMrad - camPitch) * ppmW;
    const relPitch = absRad => (absRad - g.incl) * 1000;
    const groundYat = r => lerp(-1.6, g.ty - 0.9, clamp(r / g.Dh, 0, 1.15));
    const groundPitchAt = r => relPitch(Math.atan2(groundYat(r), r));

    /* ===== 배경: 사진 or 절차적 ===== */
    const bg = BG[m.terrain];
    if (bg && bg.img) {
      const img = bg.img;
      const meta = BG_META[m.terrain] || BG_META._default;
      const pxm = img.width / meta.mradW;
      const sw = (Wv / ppmW) * pxm;
      const sh = (Hv / ppmW) * pxm;
      let sx0 = img.width * (meta.xFrac ?? 0.5) + camYaw * pxm - sw / 2;
      let sy0 = img.height * meta.cFrac - camPitch * pxm - sh / 2;
      sx0 = clamp(sx0, 0, Math.max(0, img.width - sw));
      sy0 = clamp(sy0, 0, Math.max(0, img.height - sh));
      ctx.drawImage(img, sx0, sy0, Math.min(sw, img.width), Math.min(sh, img.height), 0, 0, Wv, Hv);
    } else {
      drawProceduralScene();
    }

    function drawProceduralScene() {
      const skyGrad = ctx.createLinearGradient(0, 0, 0, Hv);
      skyGrad.addColorStop(0, ter.skyTop);
      skyGrad.addColorStop(1, ter.skyBot);
      ctx.fillStyle = skyGrad;
      ctx.fillRect(0, 0, Wv, Hv);

      /* 구름 (바람 따라 흐름) */
      const drift = t * (0.15 + S.windNow * 0.04);
      for (let i = 0; i < 7; i++) {
        const yawC = ((hash(S.sceneSeed + i) * 400 - 200) - drift + 200) % 400 - 200;
        const pitC = relPitch(0) + 22 + hash(S.sceneSeed + i * 3 + 1) * 60;
        const xw = (14 + hash(i + 9) * 26) * ppmW * 0.15;
        const x = sx(yawC), y = sy(pitC);
        if (x < -300 || x > Wv + 300) continue;
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.beginPath();
        ctx.ellipse(x, y, xw * 2.6, xw * 0.7, 0, 0, TAU);
        ctx.ellipse(x + xw, y - xw * 0.35, xw * 1.6, xw * 0.55, 0, 0, TAU);
        ctx.fill();
      }

      /* 원경 능선 */
      const peaks = ter.features.includes('peaks');
      for (let layer = 0; layer < 2; layer++) {
        const hScale = peaks ? (layer ? 9 : 16) : (layer ? 3 : 5.5);
        ctx.fillStyle = mixColor(ter.ridge, ter.haze, layer ? 0.25 : 0.55);
        ctx.beginPath();
        ctx.moveTo(0, Hv);
        for (let px = 0; px <= Wv; px += 8) {
          const yawM = camYaw + (px - cx) / ppmW;
          const hM = Math.max(0.4,
            hScale * 0.55 + hScale * 0.45 * noise1(yawM * 0.011, 3 + layer * 4) +
            hScale * 0.3 * noise1(yawM * 0.037, 7 + layer));
          ctx.lineTo(px, sy(relPitch(0) + hM));
        }
        ctx.lineTo(Wv, Hv);
        ctx.closePath();
        ctx.fill();
      }

      /* 지면 밴드 */
      let prevY = Hv + 50;
      for (let i = 0; i < 30; i++) {
        const r = 18 * Math.pow(1.215, i);
        const yPix = sy(groundPitchAt(r));
        const fade = clamp(r / (g.Dh * 1.4), 0, 1);
        const base = mixColor(ter.ground[0], ter.ground[2], fade * 0.7);
        const tone = 0.18 + 0.16 * noise1(i * 1.7, 4);
        ctx.fillStyle = mixColor(mixColor(base, ter.ground[1], tone), ter.haze, fade * 0.38);
        ctx.fillRect(0, yPix, Wv, Math.max(0, prevY - yPix) + 2);
        prevY = yPix;
      }
      ctx.fillStyle = mixColor(ter.ground[2], ter.haze, 0.85);
      const horizonY = sy(relPitch(0));
      const farY = sy(groundPitchAt(6000));
      if (farY > horizonY) ctx.fillRect(0, horizonY, Wv, farY - horizonY);

      /* 사구 */
      if (ter.features.includes('dunes')) {
        for (let d = 0; d < 3; d++) {
          const rD = g.Dh * (0.45 + d * 0.28);
          const baseP = groundPitchAt(rD);
          ctx.fillStyle = mixColor(ter.ground[1], ter.haze, 0.2 + d * 0.2);
          ctx.beginPath();
          ctx.moveTo(0, sy(baseP) + 20);
          for (let px = 0; px <= Wv; px += 10) {
            const yawM = camYaw + (px - cx) / ppmW;
            const hM = Math.max(0, 2.2 * noise1(yawM * 0.02 + d * 9, 15 + d));
            ctx.lineTo(px, sy(baseP + hM));
          }
          ctx.lineTo(Wv, sy(baseP) + 20);
          ctx.closePath();
          ctx.fill();
        }
      }

      /* 흙벽 백스톱 */
      if (ter.features.includes('berm')) {
        const rB = g.Dh + 25;
        const baseA = relPitch(Math.atan2(groundYat(rB), rB));
        const topH = g.ty + 0.9 + 2.2;
        ctx.fillStyle = mixColor('#c9b189', ter.haze, 0.18);
        ctx.beginPath();
        const x0b = sx(-38), x1b = sx(38);
        ctx.moveTo(x0b, sy(baseA));
        for (let px = x0b; px <= x1b; px += 8) {
          const yawM = camYaw + (px - cx) / ppmW;
          const topA = relPitch(Math.atan2(topH + 0.5 * noise1(yawM * 0.35, 31), rB));
          ctx.lineTo(px, sy(topA));
        }
        ctx.lineTo(x1b, sy(baseA));
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = 'rgba(140,115,80,0.5)';
        ctx.lineWidth = 1;
        for (let i = 0; i < 10; i++) {
          const yawM = -34 + hash(i + 40) * 68;
          const x = sx(yawM);
          ctx.beginPath();
          ctx.moveTo(x, sy(relPitch(Math.atan2(topH * (0.4 + hash(i + 50) * 0.5), rB))));
          ctx.lineTo(x + 2, sy(baseA));
          ctx.stroke();
        }
      }

      /* 소나무 스카이라인 */
      if (ter.features.includes('pines')) {
        const rT = g.Dh * 1.12 + 40;
        const baseY = ter.features.includes('berm') ? g.ty + 0.9 + 2.2 : groundYat(rT);
        ctx.fillStyle = mixColor('#2e4630', ter.haze, 0.3);
        for (let i = 0; i < 40; i++) {
          const yawM = -70 + i * 3.6 + hash(S.sceneSeed + i) * 2.5;
          const x = sx(yawM);
          if (x < -40 || x > Wv + 40) continue;
          const hTree = 7 + hash(S.sceneSeed * 3 + i) * 6;
          const wTree = (2.2 + hash(i + 77) * 1.6);
          const yBase = sy(relPitch(Math.atan2(baseY, rT)));
          const yTop = sy(relPitch(Math.atan2(baseY + hTree, rT)));
          const wPx = Math.atan2(wTree, rT) * 1000 * ppmW;
          ctx.beginPath();
          ctx.moveTo(x, yTop);
          ctx.lineTo(x - wPx, yBase);
          ctx.lineTo(x + wPx, yBase);
          ctx.closePath();
          ctx.fill();
        }
      }

      /* 헛간 */
      if (ter.features.includes('barn')) {
        const rBn = g.Dh * 0.92;
        const yawBn = -30;
        const baseA = r2 => relPitch(Math.atan2(groundYat(rBn) + r2, rBn));
        const wB = Math.atan2(6, rBn) * 1000 * ppmW;
        const x = sx(yawBn);
        const yB = sy(baseA(0)), yWall = sy(baseA(4.5)), yRoof = sy(baseA(7.5));
        ctx.fillStyle = mixColor('#8d3b2c', ter.haze, 0.15);
        ctx.fillRect(x - wB, yWall, wB * 2, yB - yWall);
        ctx.fillStyle = mixColor('#7d7466', ter.haze, 0.1);
        ctx.beginPath();
        ctx.moveTo(x - wB * 1.08, yWall);
        ctx.lineTo(x, yRoof);
        ctx.lineTo(x + wB * 1.08, yWall);
        ctx.closePath(); ctx.fill();
        ctx.strokeStyle = 'rgba(90,60,40,0.6)'; ctx.lineWidth = 1;
        for (let i = 1; i < 7; i++) {
          const fx = x - wB + (2 * wB / 7) * i;
          ctx.beginPath(); ctx.moveTo(fx, yWall); ctx.lineTo(fx, yB); ctx.stroke();
        }
        ctx.fillStyle = 'rgba(50,32,24,0.85)';
        ctx.fillRect(x - wB * 0.2, yWall + (yB - yWall) * 0.35, wB * 0.4, (yB - yWall) * 0.65);
      }
    }

    /* ===== 바람 깃발 ===== */
    const windPsi = (S.windDirNow - m.env.fireAzimuthDeg) * Math.PI / 180;
    const windZ = -Math.sin(windPsi) * S.windNow;
    const flagFracs = [0.55, 0.75, 0.95];
    for (let i = 0; i < flagFracs.length; i++) {
      const r = g.Dh * flagFracs[i];
      const zOff = (i % 2 ? 1 : -1) * r * 0.0045;
      const baseY = groundYat(r);
      const poleTopA = relPitch(Math.atan2(baseY + 2.6, r));
      const poleBotA = relPitch(Math.atan2(baseY, r));
      const yawA = Math.atan2(zOff, r) * 1000;
      const x = sx(yawA);
      if (x < -60 || x > Wv + 60) continue;
      ctx.strokeStyle = '#3a3f36';
      ctx.lineWidth = Math.max(1, ppmW * 0.02);
      ctx.beginPath(); ctx.moveTo(x, sy(poleBotA)); ctx.lineTo(x, sy(poleTopA)); ctx.stroke();
      const flagLen = clamp(Math.abs(windZ) / 8, 0.25, 1) * (0.9 / r) * 1000 * ppmW;
      const dir = windZ >= 0 ? 1 : -1;
      const flut = Math.sin(t * 6 + i) * 0.2 + 1;
      const fy = sy(poleTopA);
      ctx.fillStyle = '#d8402a';
      ctx.beginPath();
      ctx.moveTo(x, fy);
      ctx.lineTo(x + dir * flagLen * flut, fy + flagLen * 0.22 + Math.sin(t * 8 + i * 2) * 2);
      ctx.lineTo(x, fy + flagLen * 0.42);
      ctx.closePath(); ctx.fill();
    }

    /* ===== 인간형 표적지 (180 cm, 거리 비례 각크기) ===== */
    for (const tg of S.targets) {
      const cY = groundYat(tg.dh) + 0.9;
      const yawC = Math.atan2(tg.z, tg.dh) * 1000;
      const pitC = relPitch(Math.atan2(cY, tg.dh));
      const x = sx(yawC), y = sy(pitC);
      if (x < -120 || x > Wv + 120) continue;
      const k = ppmW * 1000 / tg.dh; // px per meter @ 표적 거리
      drawHuman(x, y, k, tg, t);
    }

    /* ===== 착탄 먼지 ===== */
    const alive = [];
    for (const p of S.puffs) {
      const age = t - p.t0;
      if (age < 2.2) {
        alive.push(p);
        const px = sx(p.yawMrad), py = sy(p.pitchMrad);
        ctx.fillStyle = `rgba(150,130,100,${0.5 * (1 - age / 2.2)})`;
        ctx.beginPath();
        ctx.arc(px, py - age * 8, (4 + age * 14) * (ppmW > 10 ? 1 : 0.4), 0, TAU);
        ctx.fill();
      }
    }
    S.puffs = alive;

    /* ===== 트레이서 ===== */
    if (S.activeShot) {
      const a = S.activeShot;
      const ft = t - a.t0;
      const path = a.path;
      if (path && path.length > 1) {
        let idx = path.findIndex(pt => pt.t >= ft);
        if (idx < 0) idx = path.length - 1;
        const pt = path[Math.max(0, idx)];
        if (pt.x > 3) {
          const yawM = Math.atan2(pt.z, pt.x) * 1000;
          const pitchM = relPitch(Math.atan2(pt.y, pt.x));
          const bx = sx(yawM), by = sy(pitchM);
          ctx.fillStyle = 'rgba(255,235,170,0.9)';
          ctx.beginPath(); ctx.arc(bx, by, 2.2, 0, TAU); ctx.fill();
          ctx.fillStyle = 'rgba(255,235,170,0.25)';
          ctx.beginPath(); ctx.arc(bx, by, 5, 0, TAU); ctx.fill();
        }
      }
    }

    /* ===== 아지랑이 ===== */
    if (opts.mirage) {
      const mirage = clamp((m.env.tempC - 15) / 30, 0, 1) * clamp(S.mag / 25, 0.3, 1);
      if (mirage > 0.05) {
        ctx.save();
        ctx.globalAlpha = mirage * 0.16;
        const hzY = sy(relPitch(0));
        for (let i = 0; i < 4; i++) {
          const yy = hzY + 30 + i * 42 + Math.sin(t * 2.4 + i) * 3;
          ctx.drawImage(ctx.canvas, 0, yy, Wv, 12, Math.sin(t * 3.5 + i * 1.8) * 3.5, yy, Wv, 12);
        }
        ctx.restore();
      }
    }

    ctx = prevCtx;
  }

  /* 인간형 표적지: 적(무장 실루엣) / 민간인(손 든 밝은 실루엣) */
  function drawHuman(x, y, k, tg, t) {
    const civ = tg.type === 'civilian';
    ctx.save();
    ctx.translate(x, y);
    if (tg.down) {
      const age = t - (tg.downT || t);
      const fall = Math.min(1, age * 2.2);
      ctx.globalAlpha = 1 - 0.45 * fall;
      ctx.translate(0, 0.9 * k);
      ctx.rotate((civ ? -1 : 1) * fall * Math.PI / 2 * 0.92);
      ctx.translate(0, -0.9 * k);
    }
    const fill = civ ? '#e6dfcd' : '#31363c';
    const line = civ ? '#8a8168' : '#15181b';
    const rr = (x0, y0, w, h, r) => {
      ctx.beginPath();
      ctx.moveTo(x0 + r, y0);
      ctx.arcTo(x0 + w, y0, x0 + w, y0 + h, r);
      ctx.arcTo(x0 + w, y0 + h, x0, y0 + h, r);
      ctx.arcTo(x0, y0 + h, x0, y0, r);
      ctx.arcTo(x0, y0, x0 + w, y0, r);
      ctx.closePath();
    };
    // 표적지 받침대
    ctx.strokeStyle = '#4b423a';
    ctx.lineWidth = Math.max(1, 0.03 * k);
    ctx.beginPath(); ctx.moveTo(-0.30 * k, 0.9 * k); ctx.lineTo(0.30 * k, 0.9 * k); ctx.stroke();
    ctx.fillStyle = fill; ctx.strokeStyle = line;
    ctx.lineWidth = Math.max(1, 0.02 * k);
    // 몸통 (+0.64 ~ -0.12 m)
    rr(-0.20 * k, -0.64 * k, 0.40 * k, 0.76 * k, 0.07 * k);
    ctx.fill(); ctx.stroke();
    // 골반 / 다리
    ctx.fillRect(-0.17 * k, 0.12 * k, 0.34 * k, 0.20 * k);
    ctx.fillRect(-0.15 * k, 0.32 * k, 0.12 * k, 0.58 * k);
    ctx.fillRect(0.03 * k, 0.32 * k, 0.12 * k, 0.58 * k);
    // 머리
    ctx.beginPath(); ctx.arc(0, -0.76 * k, 0.11 * k, 0, TAU); ctx.fill(); ctx.stroke();
    if (civ) {
      // 두 손 든 자세
      ctx.fillRect(-0.29 * k, -0.98 * k, 0.09 * k, 0.44 * k);
      ctx.fillRect(0.20 * k, -0.98 * k, 0.09 * k, 0.44 * k);
    } else {
      // 가슴 앞 대각 소총
      ctx.strokeStyle = '#0c0e10';
      ctx.lineWidth = 0.07 * k;
      ctx.beginPath();
      ctx.moveTo(-0.32 * k, 0.08 * k);
      ctx.lineTo(0.36 * k, -0.30 * k);
      ctx.stroke();
    }
    // 피탄 흔적
    for (const mk of tg.marks) {
      ctx.fillStyle = civ ? '#b03a2e' : '#0d0f11';
      ctx.beginPath();
      ctx.arc(mk.dz * k, -mk.dy * k, Math.max(1.5, 0.035 * k), 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  /* 스코프 밖 주변시: 1× 배율, 저해상 렌더 후 블러 */
  let outCv = null;
  function drawOuter(W, H, camYaw, camPitch) {
    const W2 = Math.max(2, W >> 1), H2 = Math.max(2, H >> 1);
    if (!outCv) outCv = document.createElement('canvas');
    if (outCv.width !== W2 || outCv.height !== H2) { outCv.width = W2; outCv.height = H2; }
    const octx = outCv.getContext('2d');
    const m = S.mission;
    const bg = BG[m.terrain];
    if (bg && bg.img) {
      // 사진: 화면 커버 + 미세 시차 (1× 근사)
      const img = bg.img;
      const meta = BG_META[m.terrain] || BG_META._default;
      const sc = Math.max(W2 / img.width, H2 / img.height) * 1.12;
      let dx = W2 / 2 - img.width * sc * (meta.xFrac ?? 0.5) - camYaw * 0.35;
      let dy = H2 / 2 - img.height * sc * meta.cFrac + camPitch * 0.35;
      dx = clamp(dx, W2 - img.width * sc, 0);
      dy = clamp(dy, H2 - img.height * sc, 0);
      octx.drawImage(img, dx, dy, img.width * sc, img.height * sc);
    } else {
      const ppmOut = H2 / 420; // 1× 육안 수직 시야 ≈ 24°
      renderWorld(octx, W2, H2, ppmOut, camYaw, camPitch, { mirage: false });
    }
    ctx.save();
    ctx.filter = 'blur(6px) brightness(0.8) saturate(0.9)';
    ctx.drawImage(outCv, 0, 0, W, H);
    ctx.filter = 'none';
    ctx.restore();
  }

  /* 스코프 경통 / 접안 고무링 (절차적) */
  function drawScopeBody(cx, cy, R) {
    const annulus = (r0, r1, style) => {
      ctx.beginPath();
      ctx.arc(cx, cy, r1, 0, TAU);
      ctx.arc(cx, cy, r0, 0, TAU, true);
      ctx.fillStyle = style;
      ctx.fill();
    };
    // 렌즈 베젤
    annulus(R, R * 1.045, '#08090a');
    // 접안 고무링
    const rub = ctx.createRadialGradient(cx, cy, R * 1.045, cx, cy, R * 1.14);
    rub.addColorStop(0, '#1d1e1d');
    rub.addColorStop(0.45, '#111211');
    rub.addColorStop(1, '#050606');
    annulus(R * 1.045, R * 1.14, rub);
    // 경통
    annulus(R * 1.14, R * 1.21, '#161716');
    // 상단 좌측 금속 하이라이트
    ctx.beginPath();
    ctx.arc(cx, cy, R * 1.175, Math.PI * 0.9, Math.PI * 1.45);
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = R * 0.05;
    ctx.stroke();
    // 렌즈 코팅 반사
    ctx.beginPath();
    ctx.arc(cx, cy, R - 1.5, Math.PI * 1.05, Math.PI * 1.5);
    ctx.strokeStyle = 'rgba(150,200,230,0.13)';
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  function draw() {
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (S.phase !== 'play' && S.phase !== 'result') return;

    const t = now();
    const cx = W / 2, cy = H / 2;
    const fovMrad = 16 / S.mag * 17.4533;
    const ppm = H / fovMrad;

    let camYaw = S.aim.yaw + S.sway.yaw + S.recoil.yaw;
    let camPitch = S.aim.pitch + S.sway.pitch + S.recoil.pitch;
    if (t < S.shakeT) {
      camYaw += (Math.random() - 0.5) * 3;
      camPitch += (Math.random() - 0.5) * 3;
    }

    /* ── 패스 1: 스코프 밖 (1× 흐린 주변시) ── */
    drawOuter(W, H, camYaw, camPitch);

    /* ── 패스 2: 스코프 안 (확대·선명) ── */
    const R = Math.min(W, H) * 0.44;
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.clip();
    renderWorld(ctx, W, H, ppm, camYaw, camPitch, { mirage: true });
    // 비네팅
    const vig = ctx.createRadialGradient(cx, cy, R * 0.55, cx, cy, R);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(0.85, 'rgba(0,0,0,0.25)');
    vig.addColorStop(1, 'rgba(0,0,0,0.6)');
    ctx.fillStyle = vig;
    ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
    // 렌즈 글레어
    const glr = ctx.createLinearGradient(cx - R, cy - R, cx + R * 0.4, cy + R * 0.4);
    glr.addColorStop(0, 'rgba(255,255,255,0.10)');
    glr.addColorStop(0.25, 'rgba(255,255,255,0)');
    ctx.fillStyle = glr;
    ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
    ctx.restore();

    /* ── 스코프 경통 + 레티클 + 터렛 + LED ── */
    drawScopeBody(cx, cy, R);
    drawReticle(cx, cy, R, ppm);
    drawTurrets(cx, cy, R);
    drawLed(cx, cy, R, S.mission);

    if (S.controlMode === 'look' && !S.pointerLocked && S.phase === 'play') {
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(cx - 190, cy + R * 0.55 - 20, 380, 40);
      ctx.fillStyle = '#d9ecd9';
      ctx.font = '15px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('화면을 클릭해 조준을 시작하세요', cx, cy + R * 0.55 + 6);
    }
  }

  function drawReticle(cx, cy, R, ppm) {
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.clip();
    ctx.strokeStyle = 'rgba(8,10,8,0.95)';
    ctx.fillStyle = 'rgba(8,10,8,0.95)';
    ctx.lineWidth = 1.1;
    // 십자선
    ctx.beginPath();
    ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
    ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
    ctx.stroke();
    ctx.font = `${Math.max(9, ppm * 0.26)}px sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    // mil 눈금
    for (let mil = -10; mil <= 10; mil++) {
      if (!mil) continue;
      const len = mil % 5 === 0 ? 0.24 : (mil % 2 === 0 ? 0.16 : 0.09);
      const hx = cx + mil * ppm, hy = cy - mil * ppm;
      if (Math.abs(mil * ppm) < R * 0.92) {
        ctx.beginPath();
        ctx.moveTo(hx, cy - len * ppm); ctx.lineTo(hx, cy + len * ppm);
        ctx.moveTo(cx - len * ppm, hy); ctx.lineTo(cx + len * ppm, hy);
        ctx.stroke();
        if (mil % 2 === 0 && ppm > 26) {
          ctx.fillText(Math.abs(mil), hx, cy + 0.62 * ppm);
          ctx.fillText(Math.abs(mil), cx + 0.55 * ppm, hy);
        }
      }
    }
    // 크리스마스트리: 하방 홀드오버 격자 (0.5 mil 간격 십자점)
    for (let down = 1; down <= 9; down++) {
      const y = cy + down * ppm;
      if (y > cy + R * 0.92) break;
      const width = Math.min(down, 6); // mil (아래로 갈수록 넓게)
      for (let wz = 0.5; wz <= width; wz += 0.5) {
        for (const s of [-1, 1]) {
          const x = cx + s * wz * ppm;
          const dotL = (wz * 2) % 2 === 0 ? 0.07 : 0.045;
          ctx.beginPath();
          ctx.moveTo(x - dotL * ppm, y); ctx.lineTo(x + dotL * ppm, y);
          ctx.moveTo(x, y - dotL * ppm); ctx.lineTo(x, y + dotL * ppm);
          ctx.stroke();
        }
      }
    }
    // 외곽 두꺼운 스타디아
    ctx.lineWidth = Math.max(3, ppm * 0.1);
    ctx.beginPath();
    [[-1, 0], [1, 0], [0, -1], [0, 1]].forEach(([dx, dy]) => {
      ctx.moveTo(cx + dx * R * 0.92, cy + dy * R * 0.92);
      ctx.lineTo(cx + dx * Math.min(R, 11 * ppm), cy + dy * Math.min(R, 11 * ppm));
    });
    ctx.stroke();
    ctx.restore();
  }

  /* 터렛 노브: 상단(엘리베이션) / 우측(윈디지), 클릭에 따라 눈금 밴드 회전 */
  function drawTurrets(cx, cy, R) {
    const draw = (side, clicks, label) => {
      ctx.save();
      ctx.translate(cx, cy);
      if (side === 'right') ctx.rotate(Math.PI / 2);
      ctx.translate(0, -(R + 8));
      // 노브 몸통
      const kw = Math.min(190, R * 0.52), kh = 46;
      ctx.fillStyle = '#141614';
      roundRectAt(-kw / 2, -kh, kw, kh, 8);
      ctx.fill();
      ctx.strokeStyle = '#333733'; ctx.lineWidth = 2;
      roundRectAt(-kw / 2, -kh, kw, kh, 8);
      ctx.stroke();
      // 널링
      ctx.strokeStyle = '#2a2d2a'; ctx.lineWidth = 2;
      for (let x = -kw / 2 + 6; x < kw / 2 - 4; x += 7) {
        ctx.beginPath(); ctx.moveTo(x, -kh + 4); ctx.lineTo(x, -kh + 12); ctx.stroke();
      }
      // 눈금 밴드: 0.1 mil 마다 작은 눈금, 1 mil 마다 숫자
      const mil = clicks * 0.1;
      const pxPerMil = 42;
      ctx.save();
      ctx.beginPath(); ctx.rect(-kw / 2 + 4, -kh + 14, kw - 8, kh - 18); ctx.clip();
      ctx.fillStyle = '#dfe6df'; ctx.strokeStyle = '#9aa59a';
      ctx.font = '11px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      const c0 = Math.floor(mil - kw / pxPerMil), c1 = Math.ceil(mil + kw / pxPerMil);
      for (let v = c0 * 10; v <= c1 * 10; v++) { // v = 0.1 mil 단위
        const x = (v * 0.1 - mil) * -pxPerMil; // 다이얼 올리면 밴드가 왼쪽으로
        if (x < -kw / 2 || x > kw / 2) continue;
        const major = v % 10 === 0;
        ctx.lineWidth = major ? 1.6 : 0.8;
        ctx.beginPath();
        ctx.moveTo(x, -kh + 15); ctx.lineTo(x, -kh + (major ? 27 : 21));
        ctx.stroke();
        if (major) ctx.fillText((v / 10).toString(), x, -kh + 29);
      }
      ctx.restore();
      // 인덱스 마커
      ctx.fillStyle = '#e0a03c';
      ctx.beginPath();
      ctx.moveTo(0, -2); ctx.lineTo(-5, 7); ctx.lineTo(5, 7); ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#7d9484'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(label, 0, -kh - 7);
      ctx.restore();
    };
    draw('top', S.dial.elev, `ELEV ${fmt(S.dial.elev * 0.1, 1)}`);
    draw('right', S.dial.wind, `WIND ${fmt(S.dial.wind * 0.1, 1)}`);
    function roundRectAt(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }
  }

  /* 스코프 내부 적색 LED 표시: 거리 · 풍속/풍향 */
  function drawLed(cx, cy, R, m) {
    ctx.save();
    ctx.font = '700 17px monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(255,40,25,0.9)';
    ctx.shadowBlur = 8;
    ctx.fillStyle = '#ff3b28';
    const yLed = cy + R * 0.62;
    ctx.fillText(`${m.distanceM}m`, cx - R * 0.33, yLed);
    // 풍속 + 방향 화살표 (사수 기준 불어가는 방향)
    const rel = (S.windDirMeas - m.env.fireAzimuthDeg + 180) * Math.PI / 180;
    ctx.fillText(`${S.windMeas.toFixed(1)}㎧`, cx + R * 0.30, yLed);
    ctx.translate(cx + R * 0.47, yLed);
    ctx.rotate(rel);
    ctx.beginPath();
    ctx.moveTo(0, -9); ctx.lineTo(-5, 4); ctx.lineTo(0, 1); ctx.lineTo(5, 4);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  /* ---------------- 명중률 분석 ---------------- */
  function runAnalysis() {
    if (S.phase !== 'play') return;
    document.exitPointerLock && document.exitPointerLock();
    $('analysis').classList.remove('hidden');
    $('analysis-table').innerHTML = '<p style="color:var(--dim)">계산 중...</p>';

    setTimeout(() => {
      const g = geom();
      const env = { ...S.mission.env, coriolis: true };
      const p = ammoParams();
      let delta = 0, r = null;
      for (let i = 0; i < 4; i++) {
        r = Ballistics.solveAtRange(p, env, { elevRad: g.incl + S.zeroAngle + delta, azRad: 0 }, g.Dh, { dt: 0.003 });
        if (!r) break;
        delta += (g.ty - r.y) / g.Dh;
      }
      let az = 0;
      if (r) az = -(r.z / g.Dh);
      const baseLaunch = { elevRad: g.incl + S.zeroAngle + delta, azRad: az };
      const errors = {
        sigmaMV: S.ammo.mvSd,
        sigmaElevMrad: 0.12 * S.rifle.swayFactor + 0.06,
        sigmaAzMrad: 0.10 * S.rifle.swayFactor + 0.06,
        sigmaWind: 0.4 + S.mission.spotterErr * 2.0,
      };
      const target = { centerY: g.ty, centerZ: 0, halfW: g.halfW, halfH: g.halfH };
      const exp = Ballistics.experimentalHitAnalysis(p, env, baseLaunch, g.Dh, errors, target, 400);
      const ana = Ballistics.analyticHitAnalysis(p, env, baseLaunch, g.Dh, errors, target);
      drawScatter(exp, target, g);
      renderAnalysisTable(exp, ana);
    }, 30);
  }
  function drawScatter(exp, target, g) {
    const c = $('scatter-canvas'), x = c.getContext('2d');
    x.clearRect(0, 0, c.width, c.height);
    if (!exp) return;
    const cx = c.width / 2, cy = c.height / 2;
    const spread = Math.max(target.halfW * 2.2, target.halfH * 2.2, exp.CEP * 3, 0.5);
    const sc = Math.min(c.width, c.height) / (2 * spread);
    x.strokeStyle = '#28382c'; x.lineWidth = 1;
    x.beginPath(); x.moveTo(0, cy); x.lineTo(c.width, cy); x.moveTo(cx, 0); x.lineTo(cx, c.height); x.stroke();
    x.strokeStyle = '#e05c4a'; x.lineWidth = 1.6;
    x.strokeRect(cx + (target.centerZ - target.halfW) * sc,
                 cy - (target.centerY - g.ty + target.halfH) * sc,
                 target.halfW * 2 * sc, target.halfH * 2 * sc);
    const mzx = cx + exp.meanZ * sc, mzy = cy - (exp.meanY - g.ty) * sc;
    x.strokeStyle = '#8fd14f';
    x.beginPath(); x.arc(mzx, mzy, exp.CEP * sc, 0, TAU); x.stroke();
    x.fillStyle = 'rgba(90,160,220,0.75)';
    for (const p of exp.impacts) {
      x.beginPath();
      x.arc(cx + p.z * sc, cy - (p.y - g.ty) * sc, 1.6, 0, TAU);
      x.fill();
    }
    x.fillStyle = '#7d9484'; x.font = '11px sans-serif'; x.textAlign = 'left';
    x.fillText(`탄착군 n=${exp.n} · 격자 중심 = 표적 중심 · 녹색 원 = CEP`, 10, c.height - 10);
  }
  function renderAnalysisTable(exp, ana) {
    if (!exp || !ana) { $('analysis-table').innerHTML = '<p class="bad">계산 실패 (사거리 초과?)</p>'; return; }
    const row = (name, a, b, d = 2) =>
      `<tr><td>${name}</td><td>${fmt(a, d)}</td><td>${fmt(b, d)}</td><td>${fmt(Math.abs(a - b), d)}</td></tr>`;
    $('analysis-table').innerHTML =
      `<table>
        <caption>두 방법의 명중률 예측 비교 (단위: DEP/REP/CEP = m)</caption>
        <tr><th></th><th>해석적 방법</th><th>실험적 방법</th><th>오차</th></tr>
        ${row('편향공산오차 DEP [m]', ana.DEP, exp.DEP)}
        ${row('수직공산오차 REP [m]', ana.REP, exp.REP)}
        ${row('원형공산오차 CEP [m]', ana.CEP, exp.CEP)}
        ${row('표적 명중률 [%]', ana.hitProb * 100, exp.hitProb * 100, 1)}
      </table>
      <p style="color:var(--dim);font-size:12px;margin-top:12px;line-height:1.7">
      오차 요인: 총구속도 σ=${fmt(S.ammo.mvSd, 1)} m/s, 조준(고각/방위) σ≈0.1~0.2 mil,
      바람 관측 σ=${fmt(0.4 + S.mission.spotterErr * 2, 1)} m/s.<br>
      해석적 방법: 편미분 민감도 합성 σ² = Σ(∂·σ)² · 실험적 방법: 몬테카를로 400발 탄착군.</p>`;
  }

  /* ---------------- 메뉴 ---------------- */
  function srcLine(item) {
    if (!item.descSourceUrl) return '';
    const label = item.descSource === 'wikipedia' ? '위키피디아' : '공식 페이지';
    return `<div class="src">출처(${label}): <a href="${item.descSourceUrl}" target="_blank" rel="noopener">${new URL(item.descSourceUrl).hostname}</a></div>`;
  }
  function buildMenu() {
    const rl = $('rifle-list');
    rl.innerHTML = '';
    for (const r of GameData.rifles) {
      const el = document.createElement('div');
      el.className = 'card';
      el.innerHTML =
        `<h3>${r.name}</h3><div class="sub">${r.caliber}</div>` +
        `<div class="desc">${r.desc}</div>` +
        `<div class="specs">총열 ${r.barrelMm} mm · 중량 ${r.weightKg} kg · 장탄 ${r.magCapacity}발 · 유효사거리 ~${r.effectiveRangeM.toLocaleString()} m</div>` +
        srcLine(r);
      el.onclick = () => { S.rifle = r; showStep('ammo'); };
      rl.appendChild(el);
    }
  }
  function buildAmmoMenu() {
    const al = $('ammo-list');
    al.innerHTML = '';
    for (const id of S.rifle.ammoIds) {
      const a = GameData.getAmmo(id);
      const el = document.createElement('div');
      el.className = 'card';
      el.innerHTML =
        `<h3>${a.name}</h3><div class="sub">${a.caliber}</div>` +
        `<div class="desc">${a.desc}</div>` +
        `<div class="specs">탄두 ${a.bulletGr} gr · BC(${a.dragModel}) ${a.bc} · 총구속도 ${fmt(a.mv, 0)} m/s</div>` +
        srcLine(a);
      el.onclick = () => { S.ammo = a; showStep('mission'); };
      al.appendChild(el);
    }
  }
  function buildMissionMenu() {
    const ml = $('mission-list');
    ml.innerHTML = '';
    for (const m of GameData.missions) {
      const el = document.createElement('div');
      el.className = 'card';
      const env = m.env;
      el.innerHTML =
        `<h3>${m.name}</h3><div class="sub">표적 ${m.target.widthM}×${m.target.heightM} m</div>` +
        `<div class="desc">${m.briefing}</div>` +
        `<div class="specs">바람 ${env.windSpeed} m/s · 기온 ${env.tempC}℃ · 고도 ${env.altitudeM} m · 경사 ${env.inclineDeg}°` +
        (env.earthCurvature ? ' · 곡률/코리올리 유효' : '') + `</div>`;
      el.onclick = () => { S.mission = m; startGame(); };
      ml.appendChild(el);
    }
  }
  function showStep(step) {
    ['rifle', 'ammo', 'mission'].forEach(s =>
      $('step-' + s).classList.toggle('hidden', s !== step));
    if (step === 'ammo') buildAmmoMenu();
    if (step === 'mission') buildMissionMenu();
  }
  document.querySelectorAll('.btn-back').forEach(b =>
    b.onclick = () => showStep(b.dataset.back));
  $('analysis-close').onclick = () => $('analysis').classList.add('hidden');
  $('btn-retry').onclick = () => { $('result').classList.add('hidden'); startGame(); };
  $('btn-menu').onclick = () => backToMenu();

  /* ---------------- 입력: 조준 방식 (마우스룩 / 드래그) ---------------- */
  // 'look'  — 클릭해 포인터 잠금 → 마우스 이동으로 조준 → 클릭으로 발사 (데스크톱 전용)
  // 'drag'  — 드래그해 조준 → 짧게 탭/클릭하면 발사 (포인터 잠금 불필요, 터치도 지원)
  function setControlMode(mode, announce = true) {
    if (S.controlMode === mode) return;
    S.controlMode = mode;
    if (mode === 'drag' && S.pointerLocked) document.exitPointerLock && document.exitPointerLock();
    updateHelpText();
    if (announce) setMsg(mode === 'drag' ? '조준 방식: 드래그 (짧게 클릭하면 발사)' : '조준 방식: 마우스룩 (클릭해 조준 잠금)', 3);
  }
  function updateHelpText() {
    $('hud-help').innerHTML = S.controlMode === 'drag'
      ? '드래그: 조준 · 짧게 클릭: 발사 · 휠: 배율 · ↑↓: 엘리베이션 · ←→: 윈디지 · Shift: 숨 참기 · Tab: 탄도 계산기 · M: 메뉴 · A: 명중률 분석 · <b>C: 마우스룩으로 전환</b>'
      : '클릭: 조준 잠금/발사 · 휠: 배율 · ↑↓: 엘리베이션 · ←→: 윈디지 · Shift: 숨 참기 · Tab: 탄도 계산기 · M: 메뉴 · A: 명중률 분석 · <b>C: 드래그로 전환</b>';
  }

  // ── look 모드: 클릭 → 포인터 잠금 / 잠긴 상태에서 클릭 → 발사 ──
  canvas.addEventListener('click', () => {
    if (S.phase !== 'play' || S.controlMode !== 'look') return;
    audio() && AC.state === 'suspended' && AC.resume();
    startWindAmbience();
    if (!S.pointerLocked) {
      canvas.requestPointerLock && canvas.requestPointerLock();
    } else {
      fire();
    }
  });
  document.addEventListener('pointerlockchange', () => {
    S.pointerLocked = document.pointerLockElement === canvas;
  });
  document.addEventListener('mousemove', e => {
    if (S.phase !== 'play' || S.controlMode !== 'look' || !S.pointerLocked) return;
    const sens = 0.045 * (25 / S.mag);
    S.aim.yaw = clamp(S.aim.yaw + e.movementX * sens, -80, 80);
    S.aim.pitch = clamp(S.aim.pitch - e.movementY * sens, -80, 80);
  });

  // ── drag 모드: 드래그로 조준(포인터 잠금 불필요), 짧은 탭/클릭은 발사 ──
  let dragState = null;
  const DRAG_THRESHOLD = 6; // px — 이보다 적게 움직이면 "탭"으로 간주해 발사
  canvas.addEventListener('pointerdown', e => {
    if (S.phase !== 'play' || S.controlMode !== 'drag') return;
    audio() && AC.state === 'suspended' && AC.resume();
    startWindAmbience();
    canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
    dragState = { id: e.pointerId, lastX: e.clientX, lastY: e.clientY, startX: e.clientX, startY: e.clientY, moved: false };
  });
  canvas.addEventListener('pointermove', e => {
    if (S.phase !== 'play' || S.controlMode !== 'drag' || !dragState || e.pointerId !== dragState.id) return;
    const dx = e.clientX - dragState.lastX, dy = e.clientY - dragState.lastY;
    dragState.lastX = e.clientX; dragState.lastY = e.clientY;
    if (Math.hypot(e.clientX - dragState.startX, e.clientY - dragState.startY) > DRAG_THRESHOLD) dragState.moved = true;
    const sens = 0.045 * (25 / S.mag);
    S.aim.yaw = clamp(S.aim.yaw + dx * sens, -80, 80);
    S.aim.pitch = clamp(S.aim.pitch - dy * sens, -80, 80);
  });
  const endDrag = e => {
    if (S.controlMode !== 'drag' || !dragState || (e && e.pointerId !== dragState.id)) { return; }
    const wasTap = !dragState.moved;
    dragState = null;
    if (S.phase === 'play' && wasTap) fire();
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', () => { dragState = null; });
  window.addEventListener('wheel', e => {
    if (S.phase !== 'play') return;
    S.mag = clamp(S.mag - Math.sign(e.deltaY) * 1, S.magMin || 5, 25);
  }, { passive: true });

  window.addEventListener('keydown', e => {
    if (S.phase !== 'play') return;
    switch (e.code) {
      case 'ArrowUp': S.dial.elev++; playClick(); e.preventDefault(); break;
      case 'ArrowDown': S.dial.elev--; playClick(); e.preventDefault(); break;
      case 'ArrowRight': S.dial.wind++; playClick(); e.preventDefault(); break;
      case 'ArrowLeft': S.dial.wind--; playClick(); e.preventDefault(); break;
      case 'ShiftLeft': case 'ShiftRight': S.holdingBreath = true; break;
      case 'KeyR': reload(); break;
      case 'KeyM': backToMenu(); break;
      case 'KeyA': runAnalysis(); break;
      case 'KeyC': setControlMode(S.controlMode === 'drag' ? 'look' : 'drag'); break;
      case 'Tab':
        e.preventDefault();
        S.calcVisible = !S.calcVisible;
        $('hud-calc').classList.toggle('hidden', !S.calcVisible);
        if (S.calcVisible) S.calcSolution = computeSolution();
        break;
    }
    S.lastHudUpdate = 0;
  });
  window.addEventListener('keyup', e => {
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') S.holdingBreath = false;
  });

  // 계산기 열려 있으면 2초마다 현재 풍속계 값으로 갱신
  setInterval(() => {
    if (S.phase === 'play' && S.calcVisible) S.calcSolution = computeSolution();
  }, 2000);

  /* ---------------- 메인 루프 ---------------- */
  function loop() {
    update();
    draw();
    requestAnimationFrame(loop);
  }
  window.__lm = S;
  buildMenu();
  loop();
})();
