/* ============================================================
 * game.js — LMSNIPER 메인 게임 로직 / 렌더링 / 입력
 * 좌표: 탄도계와 동일 (x 사거리, y 상방, z 우측).
 * 화면각 단위: mrad (mil). 1 mil = 사거리 1km에서 1m.
 * ============================================================ */
'use strict';

(() => {
  const canvas = document.getElementById('scope-canvas');
  const ctx = canvas.getContext('2d');
  const $ = id => document.getElementById(id);

  /* ---------------- 게임 상태 ---------------- */
  const S = {
    phase: 'menu',            // menu | play
    rifle: null, ammo: null, mission: null,
    zeroAngle: 0,             // 100 m 영점 발사각 [rad]
    aim: { yaw: 0, pitch: 0 },// 조준 방향 (LOS 기준 mrad)
    sway: { yaw: 0, pitch: 0 },
    recoil: { yaw: 0, pitch: 0 },
    dial: { elev: 0, wind: 0 },  // 터렛 클릭 수 (1클릭 = 0.1 mil)
    mag: 12,                  // 배율
    pointerLocked: false,
    magazine: 0,
    canFireAt: 0,
    reloading: false,
    // 신체
    breathPhase: 0, o2: 100, holdingBreath: false, recovering: 0, heartRate: 70,
    heartPhase: 0,
    // 바람 (실시간)
    windNow: 0, windDirNow: 0, windNoiseT: 0,
    // 사격 기록
    shots: [],                // {dy, dz, hit, score, tof, vImp}
    activeShot: null,         // 비행 중 탄
    impactMarks: [],          // 표적면 명중 흔적 {y, z}
    puffs: [],                // 지면 착탄 먼지 {yawMrad, pitchMrad, t0}
    score: 0,
    calcVisible: false,
    calcSolution: null,
    spotterNoise: { wind: 0, dir: 0, elev: 0 },
    lastHudUpdate: 0,
    shakeT: 0,
    msg: '', msgUntil: 0,
    firedTotal: 0,
  };

  /* ---------------- 유틸 ---------------- */
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const now = () => performance.now() / 1000;
  const fmt = (v, d = 1) => v.toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d });

  // 가벼운 1D 노이즈 (사인 합성)
  function noise1(t, seed = 0) {
    return (Math.sin(t * 1.7 + seed * 12.9) * 0.5 +
            Math.sin(t * 0.53 + seed * 78.2) * 0.3 +
            Math.sin(t * 3.1 + seed * 37.7) * 0.2);
  }
  let gaussSpare = null;
  function gauss() {
    if (gaussSpare != null) { const s = gaussSpare; gaussSpare = null; return s; }
    let u = 0, v = 0;
    while (!u) u = Math.random();
    while (!v) v = Math.random();
    const r = Math.sqrt(-2 * Math.log(u));
    gaussSpare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  }

  /* ---------------- 오디오 (합성음) ---------------- */
  let AC = null;
  function audio() {
    if (!AC) { try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { /* muted */ } }
    return AC;
  }
  function playShot() {
    const ac = audio(); if (!ac) return;
    const t = ac.currentTime;
    const buf = ac.createBuffer(1, ac.sampleRate * 0.4, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ac.sampleRate * 0.05));
    const src = ac.createBufferSource(); src.buffer = buf;
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
    const g = ac.createGain(); g.gain.setValueAtTime(0.7, t);
    src.connect(lp).connect(g).connect(ac.destination); src.start(t);
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

  /* ---------------- 기하 ---------------- */
  function geom() {
    const m = S.mission;
    const incl = m.env.inclineDeg * Math.PI / 180;
    const D = m.distanceM;
    return {
      incl,
      Dh: D * Math.cos(incl),          // 수평 사거리
      ty: D * Math.sin(incl),          // 표적 중심 높이
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

  /* 현재 조건에서의 사격 제원 (탄도 계산기용) */
  function computeSolution() {
    const g = geom();
    const env = { ...S.mission.env, windSpeed: S.mission.env.windSpeed, coriolis: true };
    const p = ammoParams();
    let delta = 0, r = null;
    for (let i = 0; i < 4; i++) {
      r = Ballistics.solveAtRange(p, env,
        { elevRad: g.incl + S.zeroAngle + delta, azRad: 0 }, g.Dh, { dt: 0.003 });
      if (!r) return null;
      delta += (g.ty - r.y) / g.Dh;
    }
    const windMil = r ? -(r.z / g.Dh) * 1000 : 0;
    // 관측수 오차 반영 (임무 난이도)
    const e = S.mission.spotterErr;
    return {
      elevMil: delta * 1000 * (1 + e * S.spotterNoise.elev),
      windMil: windMil * (1 + e * S.spotterNoise.wind),
      tof: r.t, vImpact: r.v,
      dropM: -(r.y - g.ty - g.Dh * (delta)), spinDrift: r.spinDrift,
    };
  }

  /* ---------------- 게임 시작 ---------------- */
  function startGame() {
    const m = S.mission;
    S.zeroAngle = Ballistics.zeroAngle(ammoParams(), m.env, 100);
    S.aim = { yaw: 0, pitch: 0 };
    S.dial = { elev: 0, wind: 0 };
    S.mag = 12;
    S.magazine = S.rifle.magCapacity;
    S.shots = []; S.impactMarks = []; S.puffs = [];
    S.score = 0; S.firedTotal = 0;
    S.o2 = 100; S.heartRate = 70; S.recovering = 0;
    S.recoil = { yaw: 0, pitch: 0 };
    S.activeShot = null; S.reloading = false; S.canFireAt = 0;
    S.spotterNoise = { wind: gauss() * 0.5, dir: gauss() * 0.5, elev: gauss() * 0.3 };
    S.calcSolution = null;
    S.phase = 'play';
    $('menu').classList.add('hidden');
    $('game').classList.remove('hidden');
    setMsg(`임무 개시 — ${m.name} · 표적 거리 ${m.distanceM.toLocaleString()} m`, 5);
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
    if (S.magazine <= 0) { setMsg('탄창 비었음 — R 키로 재장전', 2.5); return; }

    S.magazine--;
    S.firedTotal++;
    S.canFireAt = t + (S.rifle.id === 'm107a1' ? 0.6 : 1.5);
    playShot();

    const g = geom();
    // 총구속도 편차 + 총기 고유 산포 (~0.5 MOA)
    const mv = S.ammo.mv + gauss() * S.ammo.mvSd;
    const disp = 0.145e-3;
    const elevRad = g.incl + S.zeroAngle
      + (S.aim.pitch + S.sway.pitch + S.recoil.pitch) * 1e-3
      + S.dial.elev * 0.1e-3
      + gauss() * disp;
    const azRad = (S.aim.yaw + S.sway.yaw + S.recoil.yaw) * 1e-3
      + S.dial.wind * 0.1e-3
      + gauss() * disp;

    // 발사 순간의 실제 바람으로 시뮬레이션
    const env = {
      ...S.mission.env,
      windSpeed: S.windNow,
      windFromDeg: S.windDirNow,
      coriolis: true,
    };
    const r = Ballistics.solveAtRange(ammoParams(mv), env,
      { elevRad, azRad }, g.Dh, { dt: 0.003, recordPath: true });

    // 반동 (양각대 복원으로 서서히 잦아드는 카메라 오프셋)
    S.recoil.pitch += S.rifle.recoilMrad * (0.7 + Math.random() * 0.5);
    S.recoil.yaw += S.rifle.recoilMrad * 0.25 * (Math.random() - 0.4);
    S.shakeT = t + 0.18;

    if (!r) { setMsg('탄이 표적까지 도달하지 못했다 (탄속 소진)', 3); return; }

    const dy = r.y - g.ty;   // 표적 중심 기준 수직 오차 [m]
    const dz = r.z;          // 수평 오차 [m]
    const hit = Math.abs(dy) <= g.halfH && Math.abs(dz) <= g.halfW;
    const radial = Math.hypot(dy / g.halfH, dz / g.halfW); // 정규화 반경
    const ringScore = hit ? Math.max(5, Math.round(10 - radial * 5)) : 0;
    const mass = S.ammo.bulletGr * 6.479891e-5; // kg
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
        ` · 낙하시간 ${fmt(res.tof, 2)}s · 착탄속도 ${fmt(res.vImp, 0)} m/s · 에너지 ${fmt(res.energy / 1000, 2)} kJ`, 5);
    } else {
      playThud(S.mission.distanceM / 343);
      const dirV = res.dy > 0 ? '위' : '아래';
      const dirH = res.dz > 0 ? '오른쪽' : '왼쪽';
      setMsg(`빗나감 — ${dirV} ${fmt(Math.abs(res.dy), 2)} m · ${dirH} ${fmt(Math.abs(res.dz), 2)} m` +
        ` (${fmt(Math.abs(res.dy / g.Dh) * 1000, 1)}/${fmt(Math.abs(res.dz / g.Dh) * 1000, 1)} mil)`, 5);
      // 지면/배경 착탄 먼지: 표적면 통과 각위치
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
    setMsg('재장전 중...', 2.5);
    setTimeout(() => { S.magazine = S.rifle.magCapacity; S.reloading = false; setMsg('장전 완료', 1.5); }, 2500);
  }

  /* ---------------- 업데이트 ---------------- */
  let lastT = now();
  function update() {
    const t = now();
    const dt = Math.min(0.05, t - lastT);
    lastT = t;
    if (S.phase !== 'play') return;

    const env = S.mission.env;

    // 바람 변동 (돌풍)
    S.windNoiseT += dt;
    const gust = env.gustiness || 0.2;
    S.windNow = Math.max(0, env.windSpeed * (1 + gust * noise1(S.windNoiseT * 0.6, 1)));
    S.windDirNow = env.windFromDeg + 14 * gust * noise1(S.windNoiseT * 0.35, 2);

    // 호흡 / 심박
    S.breathPhase += dt * (2 * Math.PI / 4.2);
    S.heartPhase += dt * (S.heartRate / 60) * 2 * Math.PI;
    if (S.holdingBreath && S.o2 > 0 && S.recovering <= 0) {
      S.o2 = Math.max(0, S.o2 - dt * 14);
      if (S.o2 === 0) { S.recovering = 4; S.heartRate = 105; }
    } else {
      S.o2 = Math.min(100, S.o2 + dt * (S.recovering > 0 ? 10 : 25));
    }
    if (S.recovering > 0) S.recovering = Math.max(0, S.recovering - dt);
    S.heartRate = Math.max(70, S.heartRate - dt * 6);

    // 조준 흔들림 (호흡 + 심박 + 미세 떨림)
    const holdEff = (S.holdingBreath && S.o2 > 0 && S.recovering <= 0) ? 0.15 : 1;
    const recovEff = S.recovering > 0 ? 2.2 : 1;
    const amp = 0.5 * S.rifle.swayFactor * holdEff * recovEff;
    const beat = Math.pow(Math.max(0, Math.sin(S.heartPhase)), 12) * 0.25 * (S.heartRate / 70);
    S.sway.pitch = amp * (Math.sin(S.breathPhase) * 0.8 + noise1(t * 0.9, 5) * 0.4) + beat * recovEff;
    S.sway.yaw = amp * (noise1(t * 0.7, 9) * 0.55) + beat * 0.3;

    // 반동 복원 (지수 감쇠)
    const rd = Math.exp(-dt * 2.8);
    S.recoil.pitch *= rd;
    S.recoil.yaw *= rd;

    // 비행 중 탄 처리
    if (S.activeShot && t - S.activeShot.t0 >= S.activeShot.tof) resolveShot();

    // HUD 갱신 (스로틀)
    if (t - S.lastHudUpdate > 0.15) { S.lastHudUpdate = t; updateHud(); }
  }

  /* ---------------- HUD ---------------- */
  function updateHud() {
    const m = S.mission, env = m.env, g = geom();
    const e = m.spotterErr;
    const wSpd = S.windNow * (1 + e * S.spotterNoise.wind * 0.5);
    const wDir = S.windDirNow + e * 20 * S.spotterNoise.dir;

    $('hud-mission').innerHTML =
      `<h4>임무</h4><b>${m.name}</b><br>${m.briefing}<br>` +
      `<span class="warn">점수: ${S.score}</span> · 발사 ${S.firedTotal}발 · 명중 ${S.shots.filter(s => s.hit).length}발`;

    $('hud-env').innerHTML =
      `<h4>관측수 제원</h4>` +
      `거리(레이저): <b>${m.distanceM.toLocaleString()} m</b><br>` +
      `바람: <b>${fmt(wSpd, 1)} m/s</b> / ${fmt((wDir + 360) % 360, 0)}° 방향에서<br>` +
      `기온 ${fmt(env.tempC, 0)}℃ · 습도 ${fmt(env.rhPct, 0)}%<br>` +
      `고도 ${env.altitudeM.toLocaleString()} m · 기압 ${fmt(Ballistics.pressureAtAltitude(env.altitudeM), 0)} hPa<br>` +
      `위도 ${fmt(env.latitudeDeg, 1)}° · 사격방위 ${fmt(env.fireAzimuthDeg, 0)}°<br>` +
      `경사각 <b>${fmt(env.inclineDeg, 0)}°</b>` +
      (env.earthCurvature ? ` · <span class="warn">지구 곡률 유효</span>` : '');

    $('hud-weapon').innerHTML =
      `<h4>화기</h4><b>${S.rifle.name}</b><br>${S.ammo.name}<br>` +
      `탄창: <b>${S.magazine}</b> / ${S.rifle.magCapacity}` +
      (S.reloading ? ' <span class="warn">(재장전 중)</span>' : '') +
      `<br>배율: ${fmt(S.mag, 0)}×`;

    const o2Cls = S.o2 < 30 ? 'bad' : '';
    $('hud-body').innerHTML =
      `<h4>터렛 / 신체</h4>` +
      `엘리베이션: <b>${fmt(S.dial.elev * 0.1, 1)} mil</b> (↑↓)<br>` +
      `윈디지: <b>${fmt(S.dial.wind * 0.1, 1)} mil</b> (←→)<br>` +
      `산소 <span class="meter o2"><i style="width:${S.o2}%"></i></span> <span class="${o2Cls}">${fmt(S.o2, 0)}%</span><br>` +
      `심박 <span class="meter hr"><i style="width:${clamp((S.heartRate - 50) / 80 * 100, 0, 100)}%"></i></span> ${fmt(S.heartRate, 0)} bpm` +
      (S.recovering > 0 ? '<br><span class="bad">호흡 회복 중 — 조준 불안정!</span>' : '');

    if (S.calcVisible) {
      const sol = S.calcSolution;
      $('hud-calc').innerHTML = `<h4>탄도 계산기</h4>` + (sol ?
        `권장 엘리베이션: <b>${fmt(sol.elevMil, 1)} mil</b><br>` +
        `권장 윈디지: <b>${fmt(sol.windMil, 1)} mil</b><br>` +
        `예상 비행시간: ${fmt(sol.tof, 2)} s<br>` +
        `예상 착탄속도: ${fmt(sol.vImpact, 0)} m/s<br>` +
        `스핀 편류: ${fmt(sol.spinDrift * 100, 1)} cm<br>` +
        `<span style="color:var(--dim);font-size:11px">관측 오차 포함 — 맹신 금물</span>`
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
    plains:  { skyTop: '#7fb4d9', skyBot: '#cfe3ea', ground: ['#8aa35f', '#5d7a45', '#41582f'], haze: '#c9d4bd' },
    mountain:{ skyTop: '#6e9fc9', skyBot: '#d7e4ec', ground: ['#9aa38e', '#6b7a62', '#4a5844'], haze: '#c2cdc4' },
    desert:  { skyTop: '#96b6d0', skyBot: '#e8d9b8', ground: ['#d9c08a', '#b89e66', '#93794a'], haze: '#e3d3ad' },
    tundra:  { skyTop: '#8ba7bd', skyBot: '#d5dde3', ground: ['#b9c2b4', '#8e9a8b', '#6a7568'], haze: '#c8d1cb' },
  };

  function draw() {
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (S.phase !== 'play') return;

    const t = now();
    const g = geom();
    const m = S.mission;
    const ter = TERRAIN[m.terrain] || TERRAIN.plains;
    const cx = W / 2, cy = H / 2;

    // 스코프 FOV: 배율에 반비례 (5×에서 ≈3.2°, 25×에서 ≈0.64°)
    const fovMrad = 16 / S.mag * 17.4533;
    const ppm = H / fovMrad; // px per mrad

    // 카메라 방향 (흔들림 포함) + 사격 반동 셰이크
    let camYaw = S.aim.yaw + S.sway.yaw + S.recoil.yaw;
    let camPitch = S.aim.pitch + S.sway.pitch + S.recoil.pitch;
    if (t < S.shakeT) {
      camYaw += (Math.random() - 0.5) * 3;
      camPitch += (Math.random() - 0.5) * 3;
    }

    // 세계각(mrad) → 화면 px
    const sx = yawMrad => cx + (yawMrad - camYaw) * ppm;
    const sy = pitchMrad => cy - (pitchMrad - camPitch) * ppm;

    // 절대 pitch(수평 기준 rad) → LOS 기준 mrad
    const relPitch = absRad => (absRad - g.incl) * 1000;

    /* --- 하늘 --- */
    const skyGrad = ctx.createLinearGradient(0, 0, 0, H);
    skyGrad.addColorStop(0, ter.skyTop);
    skyGrad.addColorStop(1, ter.skyBot);
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, W, H);

    /* --- 원경 산 실루엣 --- */
    const horizonY = sy(relPitch(0));
    ctx.fillStyle = 'rgba(72,90,104,0.8)';
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let px = 0; px <= W; px += 8) {
      const yawM = camYaw + (px - cx) / ppm;
      const hM = Math.max(0.5, 3.5 + 3 * noise1(yawM * 0.011, 3) + 1.8 * noise1(yawM * 0.037, 7));
      ctx.lineTo(px, sy(relPitch(0) + hM));
    }
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fill();

    /* --- 지면 (거리 밴드 + 대기 원근) --- */
    const eyeH = 1.6;
    const groundYat = r => lerp(-eyeH, g.ty - g.halfH - 0.3, clamp(r / g.Dh, 0, 1.15));
    const NB = 30;
    let prevY = H + 50;
    for (let i = 0; i < NB; i++) {
      const r = 18 * Math.pow(1.215, i); // 18 m … ~6 km (로그 간격)
      const gp = relPitch(Math.atan2(groundYat(r), r));
      const yPix = sy(gp);
      const fade = clamp(r / (g.Dh * 1.4), 0, 1);
      const base = mixColor(ter.ground[0], ter.ground[2], fade * 0.7);
      const tone = 0.18 + 0.16 * noise1(i * 1.7, 4); // 질감 변화
      ctx.fillStyle = mixColor(mixColor(base, ter.ground[1], tone), ter.haze, fade * 0.38);
      ctx.fillRect(0, yPix, W, Math.max(0, prevY - yPix) + 2);
      prevY = yPix;
    }
    // 지평선 위쪽 잔여는 haze로
    ctx.fillStyle = mixColor(ter.ground[2], ter.haze, 0.85);
    const farY = sy(relPitch(Math.atan2(groundYat(6000), 6000)));
    if (farY > horizonY) ctx.fillRect(0, horizonY, W, farY - horizonY);

    /* --- 바람 깃발 (사거리 1/4, 1/2, 3/4 지점) --- */
    const windPsi = (S.windDirNow - m.env.fireAzimuthDeg) * Math.PI / 180;
    const windZ = -Math.sin(windPsi) * S.windNow; // 우측(+) 성분
    const flagFracs = [0.55, 0.75, 0.95]; // 표적 근처 구간에 배치
    for (let i = 0; i < flagFracs.length; i++) {
      const r = g.Dh * flagFracs[i];
      // 조준선에서 ±4.5 mil 옆 — 스코프 시야 안에 들어오도록
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
      // 깃발 천: 바람 방향/세기 (실물 ~0.9 m 깃발의 각크기)
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

    /* --- 표적 --- */
    const tYawHalf = Math.atan2(g.halfW, g.Dh) * 1000;
    const tPitchC = 0; // LOS 원점 = 표적 중심
    const tPitchHalf = Math.atan2(g.halfH, g.Dh) * 1000;
    const tx0 = sx(-tYawHalf), tx1 = sx(tYawHalf);
    const ty0 = sy(tPitchC + tPitchHalf), ty1 = sy(tPitchC - tPitchHalf);
    // 스탠드
    const standB = sy(relPitch(Math.atan2(g.ty - g.halfH - 0.35, g.Dh)));
    ctx.strokeStyle = '#4b423a'; ctx.lineWidth = Math.max(1, (tx1 - tx0) * 0.06);
    ctx.beginPath(); ctx.moveTo((tx0 + tx1) / 2, standB); ctx.lineTo((tx0 + tx1) / 2, ty1); ctx.stroke();
    // 강철판
    ctx.fillStyle = '#e8e4da';
    ctx.strokeStyle = '#6f6a5f'; ctx.lineWidth = 1.5;
    roundRect(tx0, ty0, tx1 - tx0, ty1 - ty0, Math.min(8, (tx1 - tx0) * 0.12));
    ctx.fill(); ctx.stroke();
    // 스코어링 링
    ctx.strokeStyle = 'rgba(70,70,60,0.55)';
    for (let ring = 1; ring <= 3; ring++) {
      const f = ring / 4;
      ctx.lineWidth = 1;
      ctx.strokeRect(
        lerp((tx0 + tx1) / 2, tx0, f), lerp((ty0 + ty1) / 2, ty0, f),
        (tx1 - tx0) * f, (ty1 - ty0) * f);
    }
    // 명중 흔적
    for (const mk of S.impactMarks) {
      const mx = sx(Math.atan2(mk.z, g.Dh) * 1000);
      const my = sy(Math.atan2(mk.y, g.Dh) * 1000);
      ctx.fillStyle = '#2f2b26';
      ctx.beginPath(); ctx.arc(mx, my, Math.max(1.5, ppm * 0.06), 0, 7); ctx.fill();
    }

    /* --- 착탄 먼지 (빗나감) --- */
    const alive = [];
    for (const p of S.puffs) {
      const age = t - p.t0;
      if (age < 2.2) {
        alive.push(p);
        const px = sx(p.yawMrad), py = sy(p.pitchMrad);
        ctx.fillStyle = `rgba(150,130,100,${0.5 * (1 - age / 2.2)})`;
        ctx.beginPath();
        ctx.arc(px, py - age * 8, 4 + age * 14, 0, 7);
        ctx.fill();
      }
    }
    S.puffs = alive;

    /* --- 비행 중 탄환 트레이서 --- */
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
          ctx.beginPath(); ctx.arc(bx, by, 2.2, 0, 7); ctx.fill();
          ctx.fillStyle = 'rgba(255,235,170,0.25)';
          ctx.beginPath(); ctx.arc(bx, by, 5, 0, 7); ctx.fill();
        }
      }
    }

    /* --- 아지랑이 (mirage) --- */
    const mirage = clamp((m.env.tempC - 15) / 30, 0, 1) * clamp(S.mag / 25, 0.3, 1);
    if (mirage > 0.05) {
      ctx.save();
      ctx.globalAlpha = mirage * 0.16;
      for (let i = 0; i < 4; i++) {
        const yy = horizonY + 30 + i * 42 + Math.sin(t * 2.4 + i) * 3;
        ctx.drawImage(canvas, 0, yy, W, 12, Math.sin(t * 3.5 + i * 1.8) * 3.5, yy, W, 12);
      }
      ctx.restore();
    }

    /* --- 스코프 마스크 + 레티클 --- */
    const R = Math.min(W, H) * 0.485;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.arc(cx, cy, R, 0, Math.PI * 2, true);
    ctx.fillStyle = '#050605';
    ctx.fill('evenodd');
    ctx.restore();
    // 비네팅
    const vig = ctx.createRadialGradient(cx, cy, R * 0.55, cx, cy, R);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = vig;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.fill();

    // 레티클 (FFP mil 눈금 — 배율과 함께 스케일)
    ctx.strokeStyle = 'rgba(10,12,10,0.95)';
    ctx.fillStyle = 'rgba(10,12,10,0.95)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
    ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
    ctx.stroke();
    ctx.font = `${Math.max(9, ppm * 0.28)}px sans-serif`;
    ctx.textAlign = 'center';
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
          ctx.fillText(Math.abs(mil), cx + 0.55 * ppm, hy + 3);
        }
      }
    }
    // 두꺼운 외곽 스타디아
    ctx.lineWidth = Math.max(3, ppm * 0.1);
    ctx.beginPath();
    [[-1, 0], [1, 0], [0, -1], [0, 1]].forEach(([dx, dy]) => {
      ctx.moveTo(cx + dx * R * 0.92, cy + dy * R * 0.92);
      ctx.lineTo(cx + dx * Math.min(R, 11 * ppm), cy + dy * Math.min(R, 11 * ppm));
    });
    ctx.stroke();

    // 포인터락 안내
    if (!S.pointerLocked) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(cx - 190, cy + R * 0.55 - 20, 380, 40);
      ctx.fillStyle = '#d9ecd9';
      ctx.font = '15px sans-serif';
      ctx.fillText('화면을 클릭해 조준을 시작하세요', cx, cy + R * 0.55 + 6);
    }
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

  function parseColor(c) {
    if (c[0] === '#') {
      return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
    }
    return c.match(/\d+/g).slice(0, 3).map(Number); // 'rgb(r,g,b)'
  }
  function mixColor(c1, c2, f) {
    const a = parseColor(c1), b = parseColor(c2);
    const m = a.map((v, i) => Math.round(lerp(v, b[i], f)));
    return `rgb(${m[0]},${m[1]},${m[2]})`;
  }

  /* ---------------- 명중률 분석 (A 키) ---------------- */
  function runAnalysis() {
    if (S.phase !== 'play') return;
    document.exitPointerLock && document.exitPointerLock();
    $('analysis').classList.remove('hidden');
    $('analysis-table').innerHTML = '<p style="color:var(--dim)">계산 중...</p>';

    setTimeout(() => {
      const g = geom();
      const env = { ...S.mission.env, coriolis: true };
      const p = ammoParams();
      // 이상적 조준(완전 보정) 기준 발사각
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
    // 스케일: 표적 + 산포 포함
    const spread = Math.max(target.halfW * 2.2, target.halfH * 2.2, exp.CEP * 3, 0.5);
    const sc = Math.min(c.width, c.height) / (2 * spread);
    // 축
    x.strokeStyle = '#28382c'; x.lineWidth = 1;
    x.beginPath(); x.moveTo(0, cy); x.lineTo(c.width, cy); x.moveTo(cx, 0); x.lineTo(cx, c.height); x.stroke();
    // 표적 사각형
    x.strokeStyle = '#e05c4a'; x.lineWidth = 1.6;
    x.strokeRect(cx + (target.centerZ - target.halfW) * sc,
                 cy - (target.centerY - g.ty + target.halfH) * sc,
                 target.halfW * 2 * sc, target.halfH * 2 * sc);
    // CEP 원 (평균 탄착점 중심)
    const mzx = cx + exp.meanZ * sc, mzy = cy - (exp.meanY - g.ty) * sc;
    x.strokeStyle = '#8fd14f';
    x.beginPath(); x.arc(mzx, mzy, exp.CEP * sc, 0, 7); x.stroke();
    // 탄착점
    x.fillStyle = 'rgba(90,160,220,0.75)';
    for (const p of exp.impacts) {
      x.beginPath();
      x.arc(cx + p.z * sc, cy - (p.y - g.ty) * sc, 1.6, 0, 7);
      x.fill();
    }
    x.fillStyle = '#7d9484'; x.font = '11px sans-serif';
    x.fillText(`탄착군 n=${exp.n} · 격자 중심 = 표적 중심 · 녹색 원 = CEP`, 10, c.height - 10);
  }

  function renderAnalysisTable(exp, ana) {
    if (!exp || !ana) { $('analysis-table').innerHTML = '<p class="bad">계산 실패 (사거리 초과?)</p>'; return; }
    const row = (name, a, b, unit, d = 2) =>
      `<tr><td>${name}</td><td>${fmt(a, d)}</td><td>${fmt(b, d)}</td><td>${fmt(Math.abs(a - b), d)}</td></tr>`;
    $('analysis-table').innerHTML =
      `<table>
        <caption>두 방법의 명중률 예측 비교 (단위: DEP/REP/CEP = m)</caption>
        <tr><th></th><th>해석적 방법</th><th>실험적 방법</th><th>오차</th></tr>
        ${row('편향공산오차 DEP [m]', ana.DEP, exp.DEP, 'm')}
        ${row('수직공산오차 REP [m]', ana.REP, exp.REP, 'm')}
        ${row('원형공산오차 CEP [m]', ana.CEP, exp.CEP, 'm')}
        ${row('표적 명중률 [%]', ana.hitProb * 100, exp.hitProb * 100, '%', 1)}
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
    if (S.phase !== 'play') {
      return;
    }
    switch (e.code) {
      case 'ArrowUp': S.dial.elev++; e.preventDefault(); break;
      case 'ArrowDown': S.dial.elev--; e.preventDefault(); break;
      case 'ArrowRight': S.dial.wind++; e.preventDefault(); break;
      case 'ArrowLeft': S.dial.wind--; e.preventDefault(); break;
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

  /* ---------------- 메인 루프 ---------------- */
  function loop() {
    update();
    draw();
    requestAnimationFrame(loop);
  }

  buildMenu();
  loop();
})();
