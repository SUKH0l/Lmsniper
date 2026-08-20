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
  const ctx = canvas.getContext('2d');
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
  const BG_META = {
    farm:     { mradW: 100, cFrac: 0.62, xFrac: 0.80 },
    forest:   { mradW: 90,  cFrac: 0.47 },
    plains:   { mradW: 95,  cFrac: 0.68 },
    mountain: { mradW: 102, cFrac: 0.55 },
    desert:   { mradW: 100, cFrac: 0.47 },
    tundra:   { mradW: 90,  cFrac: 0.34 },
    kasbah:   { mradW: 100, cFrac: 0.50 },
    _default: { mradW: 95,  cFrac: 0.46 },
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
    S.mag = 12;
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
    S.phase = 'play';
    $('menu').classList.add('hidden');
    $('game').classList.remove('hidden');
    setMsg(`임무 개시 — ${m.name} · 표적 거리 ${m.distanceM.toLocaleString()} m`, 5);
    buildDope();
    resize();
  }
  function backToMenu() {
    S.phase = 'menu';
    document.exitPointerLock && document.exitPointerLock();
    $('game').classList.add('hidden');
    $('analysis').classList.add('hidden');
    $('menu').classList.remove('hidden');
    showStep('rifle');
  }
  function setMsg(text, dur = 3) { S.msg = text; S.msgUntil = now() + dur; }

  /* ---------------- 발사 ---------------- */
  function fire() {
    const t = now();
    if (t < S.canFireAt || S.reloading || S.activeShot) return;
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
    const r = Ballistics.solveAtRange(ammoParams(mv), env,
      { elevRad, azRad }, g.Dh, { dt: 0.003, recordPath: true });

    S.recoil.pitch += S.rifle.recoilMrad * (0.7 + Math.random() * 0.5);
    S.recoil.yaw += S.rifle.recoilMrad * 0.25 * (Math.random() - 0.4);
    S.shakeT = t + 0.18;

    if (!r) { setMsg('탄이 표적까지 도달하지 못했다 (탄속 소진)', 3); return; }

    const dy = r.y - g.ty;
    const dz = r.z;
    const hit = Math.abs(dy) <= g.halfH && Math.abs(dz) <= g.halfW;
    const radial = Math.hypot(dy / g.halfH, dz / g.halfW);
    const ringScore = hit ? Math.max(5, Math.round(10 - radial * 5)) : 0;
    const mass = S.ammo.bulletGr * 6.479891e-5;
    const energy = 0.5 * mass * r.v * r.v;

    S.activeShot = {
      t0: t, path: r.path, tof: r.t,
      result: { dy, dz, hit, score: ringScore, tof: r.t, vImp: r.v, energy },
    };
  }
  function resolveShot() {
    const a = S.activeShot; if (!a) return;
    const res = a.result;
    const g = geom();
    S.shots.push(res);
    if (res.hit) {
      S.score += res.score + (S.firedTotal === 1 ? 5 : 0);
      S.impactMarks.push({ y: res.dy, z: res.dz });
      playDing(S.mission.distanceM / 343);
      setMsg(`명중! +${res.score}점${S.firedTotal === 1 ? ' (첫 발 보너스 +5)' : ''}` +
        ` · 비행 ${fmt(res.tof, 2)}s · 착탄속도 ${fmt(res.vImp, 0)} m/s · ${fmt(res.energy / 1000, 2)} kJ`, 5);
    } else {
      playThud(S.mission.distanceM / 343);
      const dirV = res.dy > 0 ? '위' : '아래';
      const dirH = res.dz > 0 ? '오른쪽' : '왼쪽';
      setMsg(`빗나감 — ${dirV} ${fmt(Math.abs(res.dy), 2)} m · ${dirH} ${fmt(Math.abs(res.dz), 2)} m` +
        ` (${fmt(Math.abs(res.dy / g.Dh) * 1000, 1)}/${fmt(Math.abs(res.dz / g.Dh) * 1000, 1)} mil)`, 5);
      S.puffs.push({
        yawMrad: (res.dz / g.Dh) * 1000,
        pitchMrad: (res.dy / g.Dh) * 1000,
        t0: now(),
      });
    }
    S.activeShot = null;
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

    $('hud-mission').innerHTML =
      `<h4>임무</h4><b>${m.name}</b><br>${m.briefing}<br>` +
      `<span style="color:var(--dim);font-size:11.5px">` +
      `거리(레이저) <b>${m.distanceM.toLocaleString()} m</b> · 경사 ${fmt(env.inclineDeg, 0)}°<br>` +
      `기온 ${fmt(env.tempC, 0)}℃ · 습도 ${fmt(env.rhPct, 0)}% · 고도 ${env.altitudeM.toLocaleString()} m<br>` +
      `기압 ${fmt(Ballistics.pressureAtAltitude(env.altitudeM), 0)} hPa · 위도 ${fmt(env.latitudeDeg, 1)}° · 방위 ${fmt(env.fireAzimuthDeg, 0)}°` +
      (env.earthCurvature ? ' · <span class="warn">곡률 유효</span>' : '') +
      `</span><br><span class="warn">점수 ${S.score}</span> · 발사 ${S.firedTotal} · 명중 ${S.shots.filter(s => s.hit).length}`;

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

  function draw() {
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (S.phase !== 'play') return;

    const t = now();
    const g = geom();
    const m = S.mission;
    const ter = TERRAIN[m.terrain] || TERRAIN.plains;
    const cx = W / 2, cy = H / 2;

    const fovMrad = 16 / S.mag * 17.4533;
    const ppm = H / fovMrad;

    let camYaw = S.aim.yaw + S.sway.yaw + S.recoil.yaw;
    let camPitch = S.aim.pitch + S.sway.pitch + S.recoil.pitch;
    if (t < S.shakeT) {
      camYaw += (Math.random() - 0.5) * 3;
      camPitch += (Math.random() - 0.5) * 3;
    }
    const sx = yawMrad => cx + (yawMrad - camYaw) * ppm;
    const sy = pitchMrad => cy - (pitchMrad - camPitch) * ppm;
    const relPitch = absRad => (absRad - g.incl) * 1000;

    const eyeH = 1.6;
    const groundYat = r => lerp(-eyeH, g.ty - g.halfH - 0.3, clamp(r / g.Dh, 0, 1.15));
    const groundPitchAt = r => relPitch(Math.atan2(groundYat(r), r));

    /* ===== 배경: 사진 에셋 or 절차적 장면 ===== */
    const bg = BG[m.terrain];
    if (bg && bg.img) {
      // 사진 배경: 각도 → 이미지 픽셀 매핑 (cFrac 행 = LOS 높이)
      const img = bg.img;
      const meta = BG_META[m.terrain] || BG_META._default;
      const pxm = img.width / meta.mradW;          // 이미지 px / mrad
      const sw = (W / ppm) * pxm;                  // 소스 폭/높이
      const sh = (H / ppm) * pxm;
      let sx0 = img.width * (meta.xFrac ?? 0.5) + camYaw * pxm - sw / 2;
      let sy0 = img.height * meta.cFrac - camPitch * pxm - sh / 2;
      sx0 = clamp(sx0, 0, Math.max(0, img.width - sw));
      sy0 = clamp(sy0, 0, Math.max(0, img.height - sh));
      ctx.drawImage(img, sx0, sy0, Math.min(sw, img.width), Math.min(sh, img.height), 0, 0, W, H);
    } else {
      drawProceduralScene();
    }

    function drawProceduralScene() {
      /* --- 하늘 --- */
      const skyGrad = ctx.createLinearGradient(0, 0, 0, H);
      skyGrad.addColorStop(0, ter.skyTop);
      skyGrad.addColorStop(1, ter.skyBot);
      ctx.fillStyle = skyGrad;
      ctx.fillRect(0, 0, W, H);

      /* --- 구름 (바람 따라 흐름) --- */
      const drift = t * (0.15 + S.windNow * 0.04);
      for (let i = 0; i < 7; i++) {
        const yawC = ((hash(S.sceneSeed + i) * 400 - 200) - drift + 200) % 400 - 200;
        const pitC = relPitch(0) + 22 + hash(S.sceneSeed + i * 3 + 1) * 60;
        const xw = (14 + hash(i + 9) * 26) * ppm * 0.15;
        const x = sx(yawC), y = sy(pitC);
        if (x < -300 || x > W + 300) continue;
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.beginPath();
        ctx.ellipse(x, y, xw * 2.6, xw * 0.7, 0, 0, TAU);
        ctx.ellipse(x + xw, y - xw * 0.35, xw * 1.6, xw * 0.55, 0, 0, TAU);
        ctx.fill();
      }

      /* --- 원경 능선 (2겹) --- */
      const peaks = ter.features.includes('peaks');
      for (let layer = 0; layer < 2; layer++) {
        const hScale = peaks ? (layer ? 9 : 16) : (layer ? 3 : 5.5);
        ctx.fillStyle = mixColor(ter.ridge, ter.haze, layer ? 0.25 : 0.55);
        ctx.beginPath();
        ctx.moveTo(0, H);
        for (let px = 0; px <= W; px += 8) {
          const yawM = camYaw + (px - cx) / ppm;
          const hM = Math.max(0.4,
            hScale * 0.55 + hScale * 0.45 * noise1(yawM * 0.011, 3 + layer * 4) +
            hScale * 0.3 * noise1(yawM * 0.037, 7 + layer));
          ctx.lineTo(px, sy(relPitch(0) + hM));
        }
        ctx.lineTo(W, H);
        ctx.closePath();
        ctx.fill();
      }

      /* --- 지면 (로그 간격 밴드 + 대기 원근) --- */
      let prevY = H + 50;
      for (let i = 0; i < 30; i++) {
        const r = 18 * Math.pow(1.215, i);
        const yPix = sy(groundPitchAt(r));
        const fade = clamp(r / (g.Dh * 1.4), 0, 1);
        const base = mixColor(ter.ground[0], ter.ground[2], fade * 0.7);
        const tone = 0.18 + 0.16 * noise1(i * 1.7, 4);
        ctx.fillStyle = mixColor(mixColor(base, ter.ground[1], tone), ter.haze, fade * 0.38);
        ctx.fillRect(0, yPix, W, Math.max(0, prevY - yPix) + 2);
        prevY = yPix;
      }
      ctx.fillStyle = mixColor(ter.ground[2], ter.haze, 0.85);
      const horizonY = sy(relPitch(0));
      const farY = sy(groundPitchAt(6000));
      if (farY > horizonY) ctx.fillRect(0, horizonY, W, farY - horizonY);

      /* --- 사구 (사막) --- */
      if (ter.features.includes('dunes')) {
        for (let d = 0; d < 3; d++) {
          const rD = g.Dh * (0.45 + d * 0.28);
          const baseP = groundPitchAt(rD);
          ctx.fillStyle = mixColor(ter.ground[1], ter.haze, 0.2 + d * 0.2);
          ctx.beginPath();
          ctx.moveTo(0, sy(baseP) + 20);
          for (let px = 0; px <= W; px += 10) {
            const yawM = camYaw + (px - cx) / ppm;
            const hM = Math.max(0, 2.2 * noise1(yawM * 0.02 + d * 9, 15 + d));
            ctx.lineTo(px, sy(baseP + hM));
          }
          ctx.lineTo(W, sy(baseP) + 20);
          ctx.closePath();
          ctx.fill();
        }
      }

      /* --- 흙벽 백스톱 (forest, 사진1 스타일) --- */
      if (ter.features.includes('berm')) {
        const rB = g.Dh + 25;
        const baseA = relPitch(Math.atan2(groundYat(rB), rB));
        const topH = g.ty + g.halfH + 2.2; // 표적 위 ~2m
        ctx.fillStyle = mixColor('#c9b189', ter.haze, 0.18);
        ctx.beginPath();
        const x0b = sx(-38), x1b = sx(38);
        ctx.moveTo(x0b, sy(baseA));
        for (let px = x0b; px <= x1b; px += 8) {
          const yawM = camYaw + (px - cx) / ppm;
          const topA = relPitch(Math.atan2(topH + 0.5 * noise1(yawM * 0.35, 31), rB));
          ctx.lineTo(px, sy(topA));
        }
        ctx.lineTo(x1b, sy(baseA));
        ctx.closePath();
        ctx.fill();
        // 침식 자국
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

      /* --- 소나무 스카이라인 --- */
      if (ter.features.includes('pines')) {
        const rT = g.Dh * 1.12 + 40;
        const baseY = ter.features.includes('berm') ? g.ty + g.halfH + 2.2 : groundYat(rT);
        ctx.fillStyle = mixColor('#2e4630', ter.haze, 0.3);
        for (let i = 0; i < 40; i++) {
          const yawM = -70 + i * 3.6 + hash(S.sceneSeed + i) * 2.5;
          const x = sx(yawM);
          if (x < -40 || x > W + 40) continue;
          const hTree = 7 + hash(S.sceneSeed * 3 + i) * 6; // 7~13 m
          const wTree = (2.2 + hash(i + 77) * 1.6);
          const yBase = sy(relPitch(Math.atan2(baseY, rT)));
          const yTop = sy(relPitch(Math.atan2(baseY + hTree, rT)));
          const wPx = Math.atan2(wTree, rT) * 1000 * ppm;
          ctx.beginPath();
          ctx.moveTo(x, yTop);
          ctx.lineTo(x - wPx, yBase);
          ctx.lineTo(x + wPx, yBase);
          ctx.closePath();
          ctx.fill();
        }
      }

      /* --- 헛간 (farm, 사진2 스타일) --- */
      if (ter.features.includes('barn')) {
        const rBn = g.Dh * 0.92;
        const yawBn = -30; // 좌측 (기본 시야 밖, 팬하면 보임)
        const baseA = r => relPitch(Math.atan2(groundYat(rBn) + r, rBn));
        const wB = Math.atan2(6, rBn) * 1000 * ppm;   // 폭 12 m
        const x = sx(yawBn);
        const yB = sy(baseA(0)), yWall = sy(baseA(4.5)), yRoof = sy(baseA(7.5));
        // 벽
        ctx.fillStyle = mixColor('#8d3b2c', ter.haze, 0.15);
        ctx.fillRect(x - wB, yWall, wB * 2, yB - yWall);
        // 지붕 (녹슨 함석)
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
        // 문
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
      if (x < -60 || x > W + 60) continue;
      ctx.strokeStyle = '#3a3f36';
      ctx.lineWidth = Math.max(1, ppm * 0.02);
      ctx.beginPath(); ctx.moveTo(x, sy(poleBotA)); ctx.lineTo(x, sy(poleTopA)); ctx.stroke();
      const flagLen = clamp(Math.abs(windZ) / 8, 0.25, 1) * (0.9 / r) * 1000 * ppm;
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

    /* ===== 표적 ===== */
    const tYawHalf = Math.atan2(g.halfW, g.Dh) * 1000;
    const tPitchHalf = Math.atan2(g.halfH, g.Dh) * 1000;
    const tx0 = sx(-tYawHalf), tx1 = sx(tYawHalf);
    const ty0 = sy(tPitchHalf), ty1 = sy(-tPitchHalf);
    const standB = sy(relPitch(Math.atan2(g.ty - g.halfH - 0.35, g.Dh)));
    ctx.strokeStyle = '#4b423a'; ctx.lineWidth = Math.max(1, (tx1 - tx0) * 0.06);
    ctx.beginPath(); ctx.moveTo((tx0 + tx1) / 2, standB); ctx.lineTo((tx0 + tx1) / 2, ty1); ctx.stroke();
    ctx.fillStyle = '#e8e4da';
    ctx.strokeStyle = '#6f6a5f'; ctx.lineWidth = 1.5;
    roundRect(tx0, ty0, tx1 - tx0, ty1 - ty0, Math.min(8, (tx1 - tx0) * 0.12));
    ctx.fill(); ctx.stroke();
    ctx.strokeStyle = 'rgba(70,70,60,0.55)';
    for (let ring = 1; ring <= 3; ring++) {
      const f = ring / 4;
      ctx.lineWidth = 1;
      ctx.strokeRect(
        lerp((tx0 + tx1) / 2, tx0, f), lerp((ty0 + ty1) / 2, ty0, f),
        (tx1 - tx0) * f, (ty1 - ty0) * f);
    }
    for (const mk of S.impactMarks) {
      const mx = sx(Math.atan2(mk.z, g.Dh) * 1000);
      const my = sy(Math.atan2(mk.y, g.Dh) * 1000);
      ctx.fillStyle = '#2f2b26';
      ctx.beginPath(); ctx.arc(mx, my, Math.max(1.5, ppm * 0.06), 0, TAU); ctx.fill();
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
        ctx.arc(px, py - age * 8, 4 + age * 14, 0, TAU);
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
    const mirage = clamp((m.env.tempC - 15) / 30, 0, 1) * clamp(S.mag / 25, 0.3, 1);
    if (mirage > 0.05) {
      ctx.save();
      ctx.globalAlpha = mirage * 0.16;
      const hzY = sy(relPitch(0));
      for (let i = 0; i < 4; i++) {
        const yy = hzY + 30 + i * 42 + Math.sin(t * 2.4 + i) * 3;
        ctx.drawImage(canvas, 0, yy, W, 12, Math.sin(t * 3.5 + i * 1.8) * 3.5, yy, W, 12);
      }
      ctx.restore();
    }

    /* ===== 스코프 프레임 ===== */
    const R = Math.min(W, H) * 0.47;
    // 렌즈 밖 마스크
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.arc(cx, cy, R, 0, TAU, true);
    ctx.fillStyle = '#070808';
    ctx.fill('evenodd');
    ctx.restore();
    // 렌즈 링 (금속)
    ctx.strokeStyle = '#1a1c1a'; ctx.lineWidth = 14;
    ctx.beginPath(); ctx.arc(cx, cy, R + 5, 0, TAU); ctx.stroke();
    ctx.strokeStyle = '#2c2f2c'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(cx, cy, R + 13, 0, TAU); ctx.stroke();
    // 비네팅 + 가장자리 수차
    const vig = ctx.createRadialGradient(cx, cy, R * 0.55, cx, cy, R);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(0.85, 'rgba(0,0,0,0.25)');
    vig.addColorStop(1, 'rgba(0,0,0,0.6)');
    ctx.fillStyle = vig;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.fill();
    // 렌즈 글레어
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.clip();
    const glr = ctx.createLinearGradient(cx - R, cy - R, cx + R * 0.4, cy + R * 0.4);
    glr.addColorStop(0, 'rgba(255,255,255,0.10)');
    glr.addColorStop(0.25, 'rgba(255,255,255,0)');
    ctx.fillStyle = glr;
    ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
    ctx.restore();

    /* --- 레티클 (FFP 크리스마스트리) --- */
    drawReticle(cx, cy, R, ppm);

    /* --- 터렛 노브 --- */
    drawTurrets(cx, cy, R);

    /* --- 스코프 내부 LED 표시 (사진2 스타일) --- */
    drawLed(cx, cy, R, m);

    if (!S.pointerLocked) {
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

  /* ---------------- 입력 ---------------- */
  canvas.addEventListener('click', () => {
    if (S.phase !== 'play') return;
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
    if (S.phase !== 'play' || !S.pointerLocked) return;
    const sens = 0.045 * (25 / S.mag);
    S.aim.yaw = clamp(S.aim.yaw + e.movementX * sens, -80, 80);
    S.aim.pitch = clamp(S.aim.pitch - e.movementY * sens, -80, 80);
  });
  window.addEventListener('wheel', e => {
    if (S.phase !== 'play') return;
    S.mag = clamp(S.mag - Math.sign(e.deltaY) * 1, 5, 25);
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
  buildMenu();
  loop();
})();
