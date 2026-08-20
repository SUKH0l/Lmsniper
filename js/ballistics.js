/* ============================================================
 * ballistics.js — 외부탄도학 엔진 (point-mass 3-DOF model)
 *
 * 참고 문헌:
 *  - G. Klimi, "Elements of Exterior Ballistics" (G-함수, 개선 오일러법,
 *    표준대기, 코리올리/스핀편류/바람 편류)
 *  - C. Cranz & K. Becker, "Handbook of Ballistics Vol.1 — Exterior
 *    Ballistics" (공기저항, 궤적족 이론)
 *  - 김건인 외, "탄도방정식을 이용한 화력 성능 분석에 관한 연구",
 *    KSME 2017 (탄착군 기반 실험적 명중률 + 민감도 기반 해석적 명중률)
 *
 * 좌표계: x = 사거리(downrange, 수평), y = 상방, z = 우측  (오른손계)
 * ============================================================ */
'use strict';

const Ballistics = (() => {

  /* ---------- 표준 저항 함수 (Reference G-functions) ----------
   * Mach 수 대비 표준탄 항력계수 Cd. G1(플랫베이스 구형탄),
   * G7(보트테일 장거리탄). 공개된 표준값의 근사 테이블. */
  const G1_TABLE = [
    [0.00, 0.2629], [0.05, 0.2558], [0.10, 0.2487], [0.15, 0.2413],
    [0.20, 0.2344], [0.25, 0.2278], [0.30, 0.2214], [0.35, 0.2155],
    [0.40, 0.2104], [0.45, 0.2061], [0.50, 0.2032], [0.55, 0.2020],
    [0.60, 0.2034], [0.70, 0.2165], [0.725, 0.2230], [0.75, 0.2313],
    [0.775, 0.2417], [0.80, 0.2546], [0.825, 0.2706], [0.85, 0.2901],
    [0.875, 0.3136], [0.90, 0.3415], [0.925, 0.3734], [0.95, 0.4084],
    [0.975, 0.4448], [1.00, 0.4805], [1.025, 0.5136], [1.05, 0.5427],
    [1.075, 0.5677], [1.10, 0.5883], [1.15, 0.6053], [1.20, 0.6191],
    [1.30, 0.6393], [1.40, 0.6518], [1.50, 0.6589], [1.60, 0.6621],
    [1.80, 0.6625], [2.00, 0.6573], [2.20, 0.6491], [2.50, 0.6337],
    [3.00, 0.6057], [3.50, 0.5764], [4.00, 0.5482], [5.00, 0.4980],
  ];
  const G7_TABLE = [
    [0.00, 0.1198], [0.50, 0.1194], [0.60, 0.1194], [0.70, 0.1197],
    [0.80, 0.1215], [0.85, 0.1242], [0.875, 0.1266], [0.90, 0.1306],
    [0.925, 0.1368], [0.95, 0.1464], [0.975, 0.1660], [1.00, 0.2054],
    [1.025, 0.2993], [1.05, 0.3803], [1.075, 0.4015], [1.10, 0.4043],
    [1.15, 0.4034], [1.20, 0.4014], [1.30, 0.3955], [1.40, 0.3884],
    [1.50, 0.3810], [1.60, 0.3732], [1.80, 0.3580], [2.00, 0.3440],
    [2.20, 0.3315], [2.50, 0.3160], [3.00, 0.2938], [3.50, 0.2767],
    [4.00, 0.2629], [5.00, 0.2500],
  ];

  function interpTable(table, m) {
    if (m <= table[0][0]) return table[0][1];
    const last = table[table.length - 1];
    if (m >= last[0]) return last[1];
    let lo = 0, hi = table.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (table[mid][0] <= m) lo = mid; else hi = mid;
    }
    const [m0, c0] = table[lo], [m1, c1] = table[hi];
    return c0 + (c1 - c0) * (m - m0) / (m1 - m0);
  }

  function dragCd(model, mach) {
    return interpTable(model === 'G7' ? G7_TABLE : G1_TABLE, mach);
  }

  /* ---------- 표준대기 / 공기 특성 (Klimi Ch.3) ---------- */

  // 기압고도식(barometric formula): 해수면 기압 → 고도 기압 [hPa]
  function pressureAtAltitude(altM, seaLevelhPa = 1013.25) {
    return seaLevelhPa * Math.pow(1 - 0.0065 * altM / 288.15, 5.25588);
  }

  // 습윤공기 밀도 [kg/m³] — Magnus 포화수증기압 + 분압 합성
  function airDensity(tempC, pressurehPa, rhPct) {
    const T = tempC + 273.15;
    const es = 6.1078 * Math.pow(10, (7.5 * tempC) / (237.3 + tempC)); // hPa
    const pv = Math.max(0, Math.min(100, rhPct)) / 100 * es;
    const pd = Math.max(0, pressurehPa - pv);
    return (pd * 100) / (287.058 * T) + (pv * 100) / (461.495 * T);
  }

  // 음속 [m/s]
  function speedOfSound(tempC) {
    return 331.3 * Math.sqrt(1 + tempC / 273.15);
  }

  /* ---------- 환경 구성 ---------- */
  // env: {tempC, rhPct, altitudeM, pressurehPa|null, windSpeed, windFromDeg,
  //       fireAzimuthDeg, latitudeDeg, inclineDeg, earthCurvature}
  function resolveEnv(env) {
    const pressure = env.pressurehPa != null
      ? env.pressurehPa
      : pressureAtAltitude(env.altitudeM || 0);
    return {
      ...env,
      pressurehPa: pressure,
      rho: airDensity(env.tempC, pressure, env.rhPct),
      sos: speedOfSound(env.tempC),
    };
  }

  // 바람 벡터 (사격 좌표계): ψ = 풍향(불어오는 방위) - 사격 방위
  function windVector(speed, windFromDeg, fireAzimuthDeg) {
    const psi = (windFromDeg - fireAzimuthDeg) * Math.PI / 180;
    return { x: -speed * Math.cos(psi), y: 0, z: -speed * Math.sin(psi) };
  }

  /* ---------- 코리올리 (Klimi 4.6/5.5, Shapiro 근사 대신 완전항) ----------
   * Ω_frame = Ω(cosφ·cosAz, sinφ, -cosφ·sinAz),  a = -2 Ω × v */
  const OMEGA_E = 7.2921159e-5;
  function coriolisOmega(latDeg, azDeg) {
    const phi = latDeg * Math.PI / 180, az = azDeg * Math.PI / 180;
    return {
      x: OMEGA_E * Math.cos(phi) * Math.cos(az),
      y: OMEGA_E * Math.sin(phi),
      z: -OMEGA_E * Math.cos(phi) * Math.sin(az),
    };
  }

  /* ---------- 궤적 적분 ----------
   * 개선 오일러법(Heun, Klimi 5.9/App.E)으로 3-DOF 점질량 적분.
   * 항력: a = π·ρ·|v_rel|²·Cd(M) / (8·C),  C = 703.069·BC [kg/m²]
   *
   * params: {mv, bc, dragModel, spinDriftSign(+1 우회전), sgFactor}
   * launch: {elevRad, azRad}  (총열 지향각; 수평/사선 기준)
   * opts:   {maxRangeM, dt, recordPath}
   */
  function simulate(params, envIn, launch, opts = {}) {
    const env = resolveEnv(envIn);
    const dt = opts.dt || 0.004;
    const maxRange = opts.maxRangeM || 3500;
    const C = 703.069 * params.bc; // BC(lb/in²) → SI
    const wind = windVector(env.windSpeed, env.windFromDeg, env.fireAzimuthDeg);
    const om = env.coriolis === false
      ? { x: 0, y: 0, z: 0 }
      : coriolisOmega(env.latitudeDeg ?? 37, env.fireAzimuthDeg ?? 0);
    const g = 9.80665;

    let px = 0, py = 0, pz = 0;
    let vx = params.mv * Math.cos(launch.elevRad) * Math.cos(launch.azRad);
    let vy = params.mv * Math.sin(launch.elevRad);
    let vz = params.mv * Math.cos(launch.elevRad) * Math.sin(launch.azRad);
    let t = 0;
    const path = opts.recordPath ? [{ t, x: px, y: py, z: pz, v: params.mv }] : null;

    function accel(vx, vy, vz) {
      const rx = vx - wind.x, ry = vy - wind.y, rz = vz - wind.z;
      const vr = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1e-9;
      const cd = dragCd(params.dragModel, vr / env.sos);
      const k = Math.PI * env.rho * vr * cd / (8 * C); // a = k · v_rel
      return {
        x: -k * rx - 2 * (om.y * vz - om.z * vy),
        y: -k * ry - g - 2 * (om.z * vx - om.x * vz),
        z: -k * rz - 2 * (om.x * vy - om.y * vx),
      };
    }

    let steps = 0;
    const maxSteps = 200000;
    while (px < maxRange && t < 30 && steps++ < maxSteps) {
      // Heun (improved Euler)
      const a1 = accel(vx, vy, vz);
      const vx1 = vx + a1.x * dt, vy1 = vy + a1.y * dt, vz1 = vz + a1.z * dt;
      const a2 = accel(vx1, vy1, vz1);
      const nvx = vx + 0.5 * (a1.x + a2.x) * dt;
      const nvy = vy + 0.5 * (a1.y + a2.y) * dt;
      const nvz = vz + 0.5 * (a1.z + a2.z) * dt;
      px += 0.5 * (vx + nvx) * dt;
      py += 0.5 * (vy + nvy) * dt;
      pz += 0.5 * (vz + nvz) * dt;
      vx = nvx; vy = nvy; vz = nvz;
      t += dt;
      if (path && (steps % 5 === 0)) {
        path.push({ t, x: px, y: py, z: pz, v: Math.sqrt(vx * vx + vy * vy + vz * vz) });
      }
      if (py < -400) break; // 지면 아래 한참이면 중단
      if (vx <= 5) break;
    }
    return {
      path, t, x: px, y: py, z: pz,
      v: Math.sqrt(vx * vx + vy * vy + vz * vz),
      vx, vy, vz, env,
    };
  }

  /* 특정 사거리 x=D 에서의 (y, z, t, v) — 경계 보간 포함 */
  function solveAtRange(params, env, launch, D, opts = {}) {
    const res = simulate(params, env, launch, {
      maxRangeM: D, dt: opts.dt || 0.004, recordPath: opts.recordPath,
    });
    if (res.x < D - 1) return null; // 도달 실패 (탄속 소진)
    // 마지막 스텝에서 D를 살짝 지나침 → 선형 되돌림
    const over = res.x - D;
    const frac = res.vx > 0 ? over / res.vx : 0;
    let y = res.y - res.vy * frac;
    let z = res.z - res.vz * frac;
    const t = res.t - frac;

    // 스핀 편류 (Litz 근사, Klimi 5.8): drift[in] = 1.25(Sg+1.2)t^1.83
    const sg = params.sgFactor ?? 1.9;
    const spin = (params.spinDriftSign ?? 1) * 1.25 * (sg + 1.2) * Math.pow(Math.max(t, 0), 1.83) * 0.0254;
    z += spin;

    // 지구 곡률: 접평면 기준 표적 지반이 D²/(2R) 만큼 낮아짐 → 탄이 상대적으로 높게 감
    if (env.earthCurvature) y += D * D / (2 * 6.371e6);

    return { y, z, t, v: res.v, path: res.path, spinDrift: spin };
  }

  /* 영점 각도: 사거리 zeroM 에서 조준선(y=0)과 궤적이 만나는 발사각 (이분법) */
  function zeroAngle(params, env, zeroM) {
    let lo = -0.005, hi = 0.15;
    const quietEnv = { ...env, windSpeed: 0, coriolis: false };
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      const r = solveAtRange(params, quietEnv, { elevRad: mid, azRad: 0 }, zeroM, { dt: 0.002 });
      if (!r) { hi = mid; continue; }
      if (r.y > 0) hi = mid; else lo = mid;
    }
    return (lo + hi) / 2;
  }

  /* ---------- 명중률 분석 (KSME 2017 논문 방식) ---------- */

  // 정규난수 (Box-Muller)
  function gauss(rng) {
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function median(arr) {
    const s = [...arr].sort((a, b) => a - b);
    const n = s.length;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }

  /* 실험적 방법: 오차 요인을 몬테카를로로 삽입해 탄착군 생성.
   * errors: {sigmaMV(m/s), sigmaElevMrad, sigmaAzMrad, sigmaWind(m/s)}
   * 반환: 탄착점 목록 + REP/DEP/CEP + 사각 표적 명중률 */
  function experimentalHitAnalysis(params, env, baseLaunch, D, errors, target, nShots = 400, seed = 12345) {
    // xorshift128 시드 고정 난수
    let s0 = seed | 0 || 1, s1 = 0x9e3779b9;
    const rng = () => {
      let x = s0, y = s1;
      s0 = y;
      x ^= x << 23; x ^= x >>> 17; x ^= y ^ (y >>> 26);
      s1 = x;
      return ((s0 + s1) >>> 0) / 4294967296;
    };
    const impacts = [];
    for (let i = 0; i < nShots; i++) {
      const p2 = { ...params, mv: params.mv + errors.sigmaMV * gauss(rng) };
      const e2 = { ...env, windSpeed: Math.max(0, env.windSpeed + errors.sigmaWind * gauss(rng)) };
      const l2 = {
        elevRad: baseLaunch.elevRad + errors.sigmaElevMrad * 1e-3 * gauss(rng),
        azRad: baseLaunch.azRad + errors.sigmaAzMrad * 1e-3 * gauss(rng),
      };
      const r = solveAtRange(p2, e2, l2, D, { dt: 0.006 });
      if (r) impacts.push({ y: r.y, z: r.z });
    }
    if (!impacts.length) return null;
    const my = impacts.reduce((a, p) => a + p.y, 0) / impacts.length;
    const mz = impacts.reduce((a, p) => a + p.z, 0) / impacts.length;
    const dyAbs = impacts.map(p => Math.abs(p.y - my));
    const dzAbs = impacts.map(p => Math.abs(p.z - mz));
    const REP = median(dyAbs);   // 사거리(수직)공산오차
    const DEP = median(dzAbs);   // 편향공산오차
    const CEP = median(impacts.map(p => Math.hypot(p.y - my, p.z - mz)));
    let hits = 0;
    for (const p of impacts) {
      if (Math.abs(p.y - target.centerY) <= target.halfH &&
          Math.abs(p.z - target.centerZ) <= target.halfW) hits++;
    }
    return { impacts, meanY: my, meanZ: mz, REP, DEP, CEP, hitProb: hits / impacts.length, n: impacts.length };
  }

  /* 해석적 방법: 유한차분 편미분 감도 → 논문 식(1)
   *   σy² = (∂y/∂V·σV)² + (∂y/∂θ·σθ)² + (∂y/∂ψ·σψ)² + (∂y/∂W·σW)²  (z 동일)
   * 정규분포 가정 사각표적 명중률 = Py × Pz */
  function analyticHitAnalysis(params, env, baseLaunch, D, errors, target) {
    const base = solveAtRange(params, env, baseLaunch, D, { dt: 0.004 });
    if (!base) return null;
    const dV = 2.0, dA = 0.2e-3, dW = 0.5;
    const pV = solveAtRange({ ...params, mv: params.mv + dV }, env, baseLaunch, D, { dt: 0.004 });
    const pE = solveAtRange(params, env, { ...baseLaunch, elevRad: baseLaunch.elevRad + dA }, D, { dt: 0.004 });
    const pA = solveAtRange(params, env, { ...baseLaunch, azRad: baseLaunch.azRad + dA }, D, { dt: 0.004 });
    const pW = solveAtRange(params, { ...env, windSpeed: env.windSpeed + dW }, baseLaunch, D, { dt: 0.004 });
    if (!pV || !pE || !pA || !pW) return null;

    const partials = {
      dydV: (pV.y - base.y) / dV, dzdV: (pV.z - base.z) / dV,
      dydE: (pE.y - base.y) / dA, dzdE: (pE.z - base.z) / dA,
      dydA: (pA.y - base.y) / dA, dzdA: (pA.z - base.z) / dA,
      dydW: (pW.y - base.y) / dW, dzdW: (pW.z - base.z) / dW,
    };
    const sE = errors.sigmaElevMrad * 1e-3, sA = errors.sigmaAzMrad * 1e-3;
    const varY = (partials.dydV * errors.sigmaMV) ** 2 + (partials.dydE * sE) ** 2 +
                 (partials.dydA * sA) ** 2 + (partials.dydW * errors.sigmaWind) ** 2;
    const varZ = (partials.dzdV * errors.sigmaMV) ** 2 + (partials.dzdE * sE) ** 2 +
                 (partials.dzdA * sA) ** 2 + (partials.dzdW * errors.sigmaWind) ** 2;
    const sy = Math.sqrt(varY), sz = Math.sqrt(varZ);
    const K = 0.674489; // 공산오차 = 0.6745σ
    const phi = x => 0.5 * (1 + erf(x / Math.SQRT2));
    const Py = phi((target.centerY + target.halfH - base.y) / (sy || 1e-9)) -
               phi((target.centerY - target.halfH - base.y) / (sy || 1e-9));
    const Pz = phi((target.centerZ + target.halfW - base.z) / (sz || 1e-9)) -
               phi((target.centerZ - target.halfW - base.z) / (sz || 1e-9));
    return {
      partials, sigmaY: sy, sigmaZ: sz,
      REP: K * sy, DEP: K * sz,
      CEP: 0.5887 * (sy + sz), // 근사식
      hitProb: Py * Pz,
      meanY: base.y, meanZ: base.z,
    };
  }

  // 오차함수 근사 (Abramowitz & Stegun 7.1.26)
  function erf(x) {
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return sign * y;
  }

  return {
    dragCd, airDensity, pressureAtAltitude, speedOfSound, resolveEnv,
    windVector, coriolisOmega, simulate, solveAtRange, zeroAngle,
    experimentalHitAnalysis, analyticHitAnalysis,
  };
})();
