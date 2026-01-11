// src/sim.worker.js (P&ID v2.1: deviation-FOPDT + multi PI + quality gate + interlocks + MODE UJI)

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, Number(x)));
const step = (t, t0, amp) => (t >= t0 ? Number(amp) : 0.0);

const ramp = (prev_sp, target_sp, rate_per_s, dt) => {
  prev_sp = Number(prev_sp);
  target_sp = Number(target_sp);
  const rate = Math.abs(Number(rate_per_s));
  if (!Number.isFinite(rate) || rate <= 0) return target_sp;
  const maxDelta = rate * Number(dt);
  const delta = target_sp - prev_sp;
  if (Math.abs(delta) <= maxDelta) return target_sp;
  return prev_sp + Math.sign(delta) * maxDelta;
};

const deepCopyCfg = (cfg) => {
  const out = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (v && typeof v === "object" && !Array.isArray(v)) out[k] = deepCopyCfg(v);
    else if (Array.isArray(v)) out[k] = v.map((x) => (x && typeof x === "object" ? deepCopyCfg(x) : x));
    else out[k] = v;
  }
  return out;
};

const randn = () => {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
};

// ============================================================
// 2) PROCESS MODEL (Deviation FOPDT)
// y_ss = y0 + K*(u_del - u0) + d
// ============================================================
class FOPDTDev {
  constructor(K, tau, theta, y0 = 0.0, u0 = 0.0, dt = 1.0) {
    this.K = Number(K);
    this.tau = Math.max(Number(tau), 1e-9);
    this.theta = Math.max(Number(theta), 0.0);
    this.dt = Math.max(Number(dt), 1e-9);

    this.y0 = Number(y0);
    this.u0 = Number(u0);

    this.delay_steps = Math.round(this.theta / this.dt);
    this.buf = new Array(this.delay_steps + 1).fill(this.u0);
    this.y = Number(y0);
  }

  reset(y0, u0) {
    if (y0 !== undefined) this.y0 = Number(y0);
    if (u0 !== undefined) this.u0 = Number(u0);
    this.y = this.y0;
    this.buf = new Array(this.delay_steps + 1).fill(this.u0);
  }

  update(u, d = 0.0) {
    this.buf.push(Number(u));
    const u_del = this.buf.shift();

    const y_ss = this.y0 + this.K * (Number(u_del) - this.u0) + Number(d);
    const dy = (y_ss - this.y) * (this.dt / this.tau);

    this.y += dy;
    return this.y;
  }
}

// ============================================================
// 3) PI CONTROLLER (ANTI-WINDUP via back-calculation)
// ============================================================
class PI {
  constructor({ Kp, Ti, dt = 1.0, out_min = 0.0, out_max = 100.0, bias = 0.0, aw = 0.15 }) {
    this.Kp = Number(Kp);
    this.Ti = Math.max(Number(Ti), 1e-9);
    this.dt = Number(dt);

    this.out_min = Number(out_min);
    this.out_max = Number(out_max);
    this.bias = Number(bias);
    this.aw = Number(aw);

    this.I = 0.0;
    this.u_prev = clamp(this.bias, this.out_min, this.out_max);
  }

  reset(u0) {
    this.I = 0.0;
    this.u_prev = clamp(u0 !== undefined ? Number(u0) : this.bias, this.out_min, this.out_max);
  }

  update(sp, pv) {
    const e = Number(sp) - Number(pv);
    this.I += (this.dt / this.Ti) * e;

    const u_unsat = this.bias + this.Kp * (e + this.I);
    const u = clamp(u_unsat, this.out_min, this.out_max);

    // back-calculation: tarik integral balik saat saturasi
    this.I += this.aw * (u - u_unsat);

    this.u_prev = u;
    return u;
  }
}

// ============================================================
// 4) QUALITY GATE (DISCRETE): hysteresis + time delay
// ============================================================
class QualityGate {
  constructor(cfg_gate) {
    this.c = cfg_gate;
    this.route = "RECYCLE";
    this.on_timer = 0.0;
    this.off_timer = 0.0;
  }

  reset() {
    this.route = "RECYCLE";
    this.on_timer = 0.0;
    this.off_timer = 0.0;
  }

  update(dt, TT106, rho15, dTsub, analyzer_ok = true, permissive_ok = true) {
    const c = this.c;

    if (!analyzer_ok || !permissive_ok) {
      this.route = "RECYCLE";
      this.on_timer = 0.0;
      this.off_timer = 0.0;
      return this.route;
    }

    const on_ok =
      (c.TT106_on_low <= TT106 && TT106 <= c.TT106_on_high) &&
      (c.rho15_on_low <= rho15 && rho15 <= c.rho15_on_high) &&
      (dTsub >= c.dTsub_min);

    const off_bad =
      (TT106 < c.TT106_off_low || TT106 > c.TT106_off_high) ||
      (rho15 < c.rho15_off_low || rho15 > c.rho15_off_high) ||
      (dTsub < c.dTsub_min_off);

    if (this.route === "RECYCLE") {
      this.on_timer = on_ok ? (this.on_timer + dt) : 0.0;
      if (this.on_timer >= c.delay_on_s) {
        this.route = "PRODUCT";
        this.on_timer = 0.0;
        this.off_timer = 0.0;
      }
    } else {
      this.off_timer = off_bad ? (this.off_timer + dt) : 0.0;
      if (this.off_timer >= c.delay_off_s) {
        this.route = "RECYCLE";
        this.on_timer = 0.0;
        this.off_timer = 0.0;
      }
    }

    return this.route;
  }
}

// ============================================================
// 5) INTERLOCK MINIMUM (TABLE-STYLE LOGIC)
// ============================================================
const makeInterlocks = (cfg) => {
  const IL = [];

  IL.push({
    name: "IL-01 Preheater T_HH -> close steam_pre (TV-101)",
    cond: (pv) => pv.T_feed_out >= cfg.IL.T_feed_HH,
    act:  (mv) => { mv.u_steam_pre = 0.0; }
  });

  IL.push({
    name: "IL-02 Reboiler T_HH -> close steam_reb (TV-102)",
    cond: (pv) => pv.T_reb >= cfg.IL.T_reb_HH,
    act:  (mv) => { mv.u_steam_reb = 0.0; }
  });

  IL.push({
    name: "IL-03 Condenser T_out_HH -> force RECYCLE",
    cond: (pv) => pv.T_cond_out >= cfg.IL.T_cond_out_HH,
    act:  (mv) => { mv.force_route = "RECYCLE"; }
  });

  IL.push({
    name: "IL-04 V201 Level_HH -> force draw high (LV-201)",
    cond: (pv) => pv.L_v201 >= cfg.IL.L_v201_HH,
    act:  (mv) => { mv.u_draw = Math.max(mv.u_draw ?? 0.0, cfg.IL.u_draw_force_high); }
  });

  IL.push({
    name: "IL-05 V201 Level_LL -> force draw low (LV-201)",
    cond: (pv) => pv.L_v201 <= cfg.IL.L_v201_LL,
    act:  (mv) => { mv.u_draw = Math.min(mv.u_draw ?? 0.0, cfg.IL.u_draw_force_low); }
  });

  IL.push({
    name: "IL-06 Analyzer FAIL -> force RECYCLE",
    cond: (pv) => !pv.analyzer_ok,
    act:  (mv) => { mv.force_route = "RECYCLE"; }
  });

  return IL;
};

// ============================================================
// 6) DISTILLATION PLANT DUMMY (P&ID PHILOSOPHY) — FIXED BASELINE
// - Temperatures now deviation-based (reachable SP)
// - V201 level balance corrected (no forced LL at baseline)
// ============================================================
class DistilPlant {
  constructor(dt = 1.0) {
    this.dt = Number(dt);

    // ===== Nominal (around which deviation model works) =====
    this.F_feed0 = 50.0;

    this.T_feed0 = 120.0;   // TIC-101 nominal
    this.T_reb0  = 165.0;   // TIC-102 nominal
    this.T_cond0 = 35.0;    // TIC-201 nominal

    this.TT106_0 = 95.0;    // top temp proxy nominal
    this.rho0    = 0.7400;  // rho15 nominal
    this.L0      = 50.0;    // V201 level nominal

    // ===== MV nominal/bias (matches BASE_CONFIG biases) =====
    this.u_feed0      = 50.0;
    this.u_steam_pre0 = 35.0;
    this.u_steam_reb0 = 40.0;
    this.u_cw0        = 45.0;
    this.u_reflux0    = 55.0; // important: bias 55 should give F_reflux ~ 50
    this.u_draw0      = 25.0;

    // ===== Blocks (Deviation FOPDT) =====
    this.G_Ffeed = new FOPDTDev(1.0,   25,  2,  this.F_feed0, this.u_feed0,      this.dt);

    // Reachable: u=0..100 -> ~99..159 C
    this.G_Tfeed = new FOPDTDev(0.60, 140, 10,  this.T_feed0, this.u_steam_pre0, this.dt);

    // Reachable: u=0..100 -> ~131..216 C
    this.G_Treb  = new FOPDTDev(0.85, 180, 12,  this.T_reb0,  this.u_steam_reb0, this.dt);

    // Reflux flow: bias 55 -> PV ~ 50
    this.G_Fref  = new FOPDTDev(0.80,  40,  3,  50.0,        this.u_reflux0,    this.dt);

    // Condenser: more u_cw -> lower T_cond_out
    this.G_Tcond = new FOPDTDev(-0.25, 160, 12, this.T_cond0, this.u_cw0,        this.dt);

    // TT106 + rho are "filtered proxies": treat their setpoint as the input signal
    this.G_TT106 = new FOPDTDev(1.0,  120,  8, this.TT106_0, this.TT106_0,       this.dt);
    this.G_rho   = new FOPDTDev(1.0,  240, 30, this.rho0,    this.rho0,          this.dt);

    // ===== V201 inventory =====
    this.L = this.L0;

    // ===== Disturbances / constraints =====
    this.d_feed_temp   = 0.0;  // additive to T_feed_out
    this.d_vapor_load  = 0.0;  // additive to T_reb
    this.cw_degrade    = 1.0;  // multiply u_cw (reduce effective cooling)
    this.analyzer_ok   = true;

    // ===== Condensate inflow nominal (fix level balance) =====
    // baseline: F_cond_in0 ≈ F_reflux0(50) + F_draw0(0.8*25=20) = 70
    this.F_cond0 = 70.0;
  }

  reset() {
    // reset dynamics & states
    this.G_Ffeed.reset(this.F_feed0, this.u_feed0);
    this.G_Tfeed.reset(this.T_feed0, this.u_steam_pre0);
    this.G_Treb.reset(this.T_reb0, this.u_steam_reb0);
    this.G_Fref.reset(50.0, this.u_reflux0);
    this.G_Tcond.reset(this.T_cond0, this.u_cw0);
    this.G_TT106.reset(this.TT106_0, this.TT106_0);
    this.G_rho.reset(this.rho0, this.rho0);

    this.L = this.L0;

    this.d_feed_temp = 0.0;
    this.d_vapor_load = 0.0;
    this.cw_degrade = 1.0;
    this.analyzer_ok = true;
  }

  update(mv, noise = true) {
    const u_feed      = clamp(mv.u_feed ?? this.u_feed0, 0, 100);
    const u_steam_pre = clamp(mv.u_steam_pre ?? this.u_steam_pre0, 0, 100);
    const u_steam_reb = clamp(mv.u_steam_reb ?? this.u_steam_reb0, 0, 100);
    const u_cw        = clamp(mv.u_cw ?? this.u_cw0, 0, 100);
    const u_reflux    = clamp(mv.u_reflux ?? this.u_reflux0, 0, 100);
    const u_draw      = clamp(mv.u_draw ?? this.u_draw0, 0, 100);

    // ===== Primary measured loops =====
    const F_feed     = this.G_Ffeed.update(u_feed, 0.0);
    const T_feed_out = this.G_Tfeed.update(u_steam_pre, this.d_feed_temp);
    const T_reb      = this.G_Treb.update(u_steam_reb, this.d_vapor_load);

    const F_reflux   = this.G_Fref.update(u_reflux, 0.0);

    // Cooling water degradation: reduce effective u (baseline stays OK when degrade=1)
    const u_cw_eff = u_cw * this.cw_degrade;
    const T_cond_out = this.G_Tcond.update(u_cw_eff, 0.0);

    // ===== Internal proxies (top temperature / TT201) =====
    // TT106 steady signal before filtering:
    // - naik saat T_reb naik
    // - turun saat reflux naik (lebih banyak reflux -> top lebih dingin)
    // - sedikit naik saat feed naik
    const TT106_ss =
      this.TT106_0 +
      0.35 * (T_reb - this.T_reb0) -
      0.20 * (F_reflux - 50.0) +
      0.05 * (F_feed - this.F_feed0);

    const TT106 = this.G_TT106.update(TT106_ss, 0.0);

    // TT201 proxy: sedikit lebih tinggi dari TT106, tergantung kondisi reboiler
    const TT201 = TT106 + 0.20 * (T_reb - this.T_reb0);

    // ===== Reflux drum level (V201) — FIXED balance =====
    // inflow condense: base 70 with mild dependency on vapor/feed
    const F_cond_in =
      Math.max(
        0.0,
        this.F_cond0 +
          0.20 * (T_reb - this.T_reb0) +
          0.10 * (F_feed - this.F_feed0)
      );

    // draw valve characteristic
    const F_draw = 0.8 * u_draw;

    // inventory update (scaled)
    const dL = (F_cond_in - F_reflux - F_draw) * (this.dt / 200.0);
    this.L = clamp(this.L + dL, 0.0, 100.0);

    // ===== Density (rho15) =====
    // - naik saat top temp naik (lebih berat)
    // - turun saat reflux naik (lebih ringan / lebih banyak pemisahan)
    const rho_ss =
      this.rho0 +
      0.0009 * (TT106 - this.TT106_0) -
      0.0011 * (F_reflux - 50.0);

    const rho15 = this.G_rho.update(rho_ss, 0.0);

    const pv = {
      F_feed,
      T_feed_out,
      T_reb,
      TT106,
      TT201,
      T_cond_out,
      F_reflux,
      L_v201: this.L,
      rho15,
      analyzer_ok: this.analyzer_ok
    };

    if (!noise) return pv;

    // measurement noise
    return {
      ...pv,
      F_feed:     pv.F_feed     + randn() * 0.4,
      T_feed_out: pv.T_feed_out + randn() * 0.2,
      T_reb:      pv.T_reb      + randn() * 0.25,
      TT106:      pv.TT106      + randn() * 0.25,
      TT201:      pv.TT201      + randn() * 0.25,
      T_cond_out: pv.T_cond_out + randn() * 0.2,
      F_reflux:   pv.F_reflux   + randn() * 0.5,
      L_v201:     pv.L_v201     + randn() * 0.2,
      rho15:      pv.rho15      + randn() * 0.0005
    };
  }
}

// ============================================================
// 7) METRICS
// ============================================================
const calc_iae_itae = (t, sp, pv, normalize = false, span = 1.0) => {
  const dt = t.length > 1 ? (t[1] - t[0]) : 1.0;
  let iae = 0.0;
  let itae = 0.0;

  const safeSpan = Math.max(Number(span), 1e-9);

  for (let i = 0; i < t.length; i++) {
    let e = Number(sp[i]) - Number(pv[i]);
    if (normalize) e = e / safeSpan;
    iae += Math.abs(e) * dt;
    itae += Number(t[i]) * Math.abs(e) * dt;
  }
  return { iae, itae };
};

const overshoot_percent = (sp, pv) => {
  const spFinal = Number(sp[sp.length - 1]);
  if (!Number.isFinite(spFinal) || Math.abs(spFinal) < 1e-9) return null;
  let peak = -Infinity;
  for (let i = 0; i < pv.length; i++) peak = Math.max(peak, Number(pv[i]));
  return Math.max(0.0, ((peak - spFinal) / Math.abs(spFinal)) * 100.0);
};

const settling_time = (t, sp, pv, band = 0.02, hold_s = 60.0) => {
  const spFinal = Number(sp[sp.length - 1]);
  const tol = Math.max(Math.abs(spFinal) * Number(band), 1e-6);

  const dt = t.length > 1 ? (t[1] - t[0]) : 1.0;
  const hold_n = Math.max(1, Math.round(Number(hold_s) / Math.max(dt, 1e-9)));

  const inside = pv.map((v) => Math.abs(Number(v) - spFinal) <= tol);

  for (let i = 0; i < t.length; i++) {
    const j = i + hold_n;
    if (j <= t.length) {
      let ok = true;
      for (let k = i; k < j; k++) { if (!inside[k]) { ok = false; break; } }
      if (ok) return Number(t[i]);
    }
  }
  return null;
};

const gate_stats = (routeArr) => {
  const r = routeArr.map((x) => (x === "PRODUCT" ? 1 : 0));
  const frac = r.reduce((a, b) => a + b, 0) / Math.max(1, r.length);
  let switches = 0;
  for (let i = 1; i < r.length; i++) if (r[i] !== r[i - 1]) switches++;
  return { productPct: frac * 100.0, switches };
};

// ============================================================
// 8) SIMULATION CORE
// ============================================================
const simulate = (cfg) => {
  const dt = cfg.SIM.dt;
  const sim_s = cfg.SIM.sim_s;

  const plant = new DistilPlant(dt);
  plant.reset();

  const C = {
    FIC101: new PI({ ...cfg.LOOP.FIC101, dt }),
    TIC101: new PI({ ...cfg.LOOP.TIC101, dt }),
    TIC102: new PI({ ...cfg.LOOP.TIC102, dt }),
    TIC201: new PI({ ...cfg.LOOP.TIC201, dt }),
    FIC201: new PI({ ...cfg.LOOP.FIC201, dt }),
    LIC201: new PI({ ...cfg.LOOP.LIC201, dt }),
  };
  Object.values(C).forEach((c) => c.reset());

  const gate = new QualityGate(cfg.GATE);
  gate.reset();

  const interlocks = makeInterlocks(cfg);
  let active_prev = new Set();
  const event_log = [];

  // ramped SP
  const sp = {
    F_feed: cfg.SP.F_feed,
    T_feed_out: cfg.SP.T_feed_out,
    T_reb: cfg.SP.T_reboiler,
    T_cond_out: cfg.SP.T_cond_out,
    F_reflux: cfg.SP.F_reflux,
    L_v201: cfg.SP.L_v201,
  };

  const mv = {
    u_feed: cfg.MV_INIT.u_feed,
    u_steam_pre: cfg.MV_INIT.u_steam_pre,
    u_steam_reb: cfg.MV_INIT.u_steam_reb,
    u_cw: cfg.MV_INIT.u_cw,
    u_reflux: cfg.MV_INIT.u_reflux,
    u_draw: cfg.MV_INIT.u_draw,
    force_route: null,
  };

  const log = {
    t: [],
    F_feed: [], T_feed_out: [], T_reb: [], TT106: [], TT201: [], T_cond_out: [],
    F_reflux: [], L_v201: [], rho15: [], analyzer_ok: [],
    SP_F_feed: [], SP_T_feed_out: [], SP_T_reb: [], SP_T_cond_out: [], SP_F_reflux: [], SP_L_v201: [],
    u_feed: [], u_steam_pre: [], u_steam_reb: [], u_cw: [], u_reflux: [], u_draw: [],
    dTsub: [], route: []
  };

  let route_prev = "RECYCLE";
  const steps = Array.isArray(cfg.TEST.sp_steps) ? cfg.TEST.sp_steps : [];

  for (let ti = 0; ti <= sim_s; ti += dt) {
    // disturbances (MODE UJI / test)
    plant.d_feed_temp  = step(ti, cfg.TEST.t_feed_dist, cfg.TEST.d_feed_temp);
    plant.d_vapor_load = step(ti, cfg.TEST.t_vapor_dist, cfg.TEST.d_vapor);
    plant.cw_degrade   = 1.0 - step(ti, cfg.TEST.t_cw_degrade, cfg.TEST.cw_degrade_drop);

    if (cfg.TEST.analyzer_fail_enable) plant.analyzer_ok = (ti < cfg.TEST.t_analyzer_fail);
    else plant.analyzer_ok = true;

    // SP targets base + step list
    const sp_target = {
      F_feed: cfg.SP.F_feed,
      T_feed_out: cfg.SP.T_feed_out,
      T_reb: cfg.SP.T_reboiler,
      T_cond_out: cfg.SP.T_cond_out,
      F_reflux: cfg.SP.F_reflux,
      L_v201: cfg.SP.L_v201,
    };

    for (const s of steps) {
      if (ti >= Number(s.t)) {
        const k = s.key;
        sp_target[k] = Number(sp_target[k]) + Number(s.delta);
      }
    }

    // ramp SPs
    sp.F_feed     = ramp(sp.F_feed,     sp_target.F_feed,     cfg.RAMP.rate_F_feed,     dt);
    sp.T_feed_out = ramp(sp.T_feed_out, sp_target.T_feed_out, cfg.RAMP.rate_T_feed_out, dt);
    sp.T_reb      = ramp(sp.T_reb,      sp_target.T_reb,      cfg.RAMP.rate_T_reboiler, dt);
    sp.T_cond_out = ramp(sp.T_cond_out, sp_target.T_cond_out, cfg.RAMP.rate_T_cond_out, dt);
    sp.F_reflux   = ramp(sp.F_reflux,   sp_target.F_reflux,   cfg.RAMP.rate_F_reflux,   dt);
    sp.L_v201     = ramp(sp.L_v201,     sp_target.L_v201,     cfg.RAMP.rate_L_v201,     dt);

    // measurement (uses previous mv -> then we compute mv for next step)
    const pv = plant.update(mv, cfg.SIM.noise);
    const dTsub = pv.TT201 - pv.T_cond_out;

    // PI loops
    mv.u_feed      = C.FIC101.update(sp.F_feed, pv.F_feed);
    mv.u_steam_pre = C.TIC101.update(sp.T_feed_out, pv.T_feed_out);
    mv.u_steam_reb = C.TIC102.update(sp.T_reb, pv.T_reb);
    mv.u_cw        = C.TIC201.update(sp.T_cond_out, pv.T_cond_out);
    mv.u_reflux    = C.FIC201.update(sp.F_reflux, pv.F_reflux);
    mv.u_draw      = C.LIC201.update(sp.L_v201, pv.L_v201);

    // gate update
    const permissive_ok = (cfg.GATE.perm_L_min < pv.L_v201 && pv.L_v201 < cfg.GATE.perm_L_max);
    let route = gate.update(dt, pv.TT106, pv.rho15, dTsub, pv.analyzer_ok, permissive_ok);

    // interlocks override
    mv.force_route = null;
    const active_now = new Set();

    const pv_for_il = { ...pv, dTsub };
    for (const il of interlocks) {
      if (il.cond(pv_for_il)) {
        active_now.add(il.name);
        il.act(mv);
      }
    }

    if (mv.force_route === "RECYCLE" || mv.force_route === "PRODUCT") route = mv.force_route;

    if (route !== route_prev) {
      event_log.push([ti, `GATE_SWITCH: ${route_prev} -> ${route}`]);
      route_prev = route;
    }

    const became_active = [...active_now].filter((x) => !active_prev.has(x));
    const became_clear  = [...active_prev].filter((x) => !active_now.has(x));

    for (const name of became_active) event_log.push([ti, `INTERLOCK_ON: ${name}`]);
    for (const name of became_clear)  event_log.push([ti, `INTERLOCK_OFF: ${name}`]);

    active_prev = active_now;

    // log
    log.t.push(ti);

    log.F_feed.push(pv.F_feed);
    log.T_feed_out.push(pv.T_feed_out);
    log.T_reb.push(pv.T_reb);
    log.TT106.push(pv.TT106);
    log.TT201.push(pv.TT201);
    log.T_cond_out.push(pv.T_cond_out);
    log.F_reflux.push(pv.F_reflux);
    log.L_v201.push(pv.L_v201);
    log.rho15.push(pv.rho15);
    log.analyzer_ok.push(pv.analyzer_ok ? 1 : 0);

    log.SP_F_feed.push(sp.F_feed);
    log.SP_T_feed_out.push(sp.T_feed_out);
    log.SP_T_reb.push(sp.T_reb);
    log.SP_T_cond_out.push(sp.T_cond_out);
    log.SP_F_reflux.push(sp.F_reflux);
    log.SP_L_v201.push(sp.L_v201);

    log.u_feed.push(mv.u_feed);
    log.u_steam_pre.push(mv.u_steam_pre);
    log.u_steam_reb.push(mv.u_steam_reb);
    log.u_cw.push(mv.u_cw);
    log.u_reflux.push(mv.u_reflux);
    log.u_draw.push(mv.u_draw);

    log.dTsub.push(dTsub);
    log.route.push(route);
  }

  return { log, event_log };
};

// ============================================================
// 9) METRIC SUMMARY (per loop)
// ============================================================
const summarize_metrics = (log, cfg) => {
  const t = log.t;
  const use_norm = cfg.METRIC.normalize_error;
  const spans = cfg.METRIC.span;

  const one = (loopName, spKey, pvKey) => {
    const sp = log[spKey];
    const pv = log[pvKey];

    const { iae, itae } = calc_iae_itae(t, sp, pv, use_norm, spans[loopName]);
    const os = overshoot_percent(sp, pv);
    const st = settling_time(t, sp, pv, cfg.METRIC.settle_band, cfg.METRIC.settle_hold_s);

    return { IAE: iae, ITAE: itae, OvershootPct: os, SettlingTime: st };
  };

  const mapping = [
    ["T_feed_out", "SP_T_feed_out", "T_feed_out"],
    ["T_reb",      "SP_T_reb",      "T_reb"],
    ["T_cond_out", "SP_T_cond_out", "T_cond_out"],
    ["F_feed",     "SP_F_feed",     "F_feed"],
    ["F_reflux",   "SP_F_reflux",   "F_reflux"],
    ["L_v201",     "SP_L_v201",     "L_v201"],
  ];

  return mapping.map(([name, spk, pvk]) => ({ name, ...one(name, spk, pvk) }));
};

// ============================================================
// 10) MODE UJI (TEST SUITE)
// ============================================================
const run_test_suite = (base_cfg) => {
  const tests = [];

  // A) Baseline
  {
    const cfgA = deepCopyCfg(base_cfg);
    cfgA.TEST.sp_steps = [];
    cfgA.TEST.analyzer_fail_enable = false;

    // baseline suite: disturbances OFF
    cfgA.TEST.d_feed_temp = 0.0;
    cfgA.TEST.d_vapor = 0.0;
    cfgA.TEST.cw_degrade_drop = 0.0;

    tests.push(["A0_BASELINE", cfgA]);
  }

  // B) Step tests
  const step_t = 600.0;
  const step_defs = [
    ["B1_STEP_TIC101", { t: step_t, key: "T_feed_out", delta: +3.0 }],
    ["B2_STEP_TIC102", { t: step_t, key: "T_reb",      delta: +3.0 }],
    ["B3_STEP_TIC201", { t: step_t, key: "T_cond_out", delta: +2.0 }],
    ["B4_STEP_FIC101", { t: step_t, key: "F_feed",     delta: +5.0 }],
    ["B5_STEP_FIC201", { t: step_t, key: "F_reflux",   delta: +5.0 }],
    ["B6_STEP_LIC201", { t: step_t, key: "L_v201",     delta: +5.0 }],
  ];

  for (const [name, stp] of step_defs) {
    const cfgB = deepCopyCfg(base_cfg);
    cfgB.TEST.sp_steps = [stp];
    cfgB.TEST.analyzer_fail_enable = false;

    // keep disturbances OFF for step tests
    cfgB.TEST.d_feed_temp = 0.0;
    cfgB.TEST.d_vapor = 0.0;
    cfgB.TEST.cw_degrade_drop = 0.0;

    tests.push([name, cfgB]);
  }

  // C) Disturbance tests
  {
    const cfgC1 = deepCopyCfg(base_cfg);
    cfgC1.TEST.sp_steps = [];
    cfgC1.TEST.analyzer_fail_enable = false;
    cfgC1.TEST.d_feed_temp = 8.0;
    cfgC1.TEST.cw_degrade_drop = 0.0;
    cfgC1.TEST.d_vapor = 0.0;
    tests.push(["C1_DIST_FEED_TEMP", cfgC1]);
  }
  {
    const cfgC2 = deepCopyCfg(base_cfg);
    cfgC2.TEST.sp_steps = [];
    cfgC2.TEST.analyzer_fail_enable = false;
    cfgC2.TEST.d_feed_temp = 0.0;
    cfgC2.TEST.d_vapor = 0.0;
    cfgC2.TEST.cw_degrade_drop = 0.25;
    tests.push(["C2_DIST_CW_DEGRADE", cfgC2]);
  }
  {
    const cfgC3 = deepCopyCfg(base_cfg);
    cfgC3.TEST.sp_steps = [];
    cfgC3.TEST.analyzer_fail_enable = true;
    cfgC3.TEST.t_analyzer_fail = 1800;
    cfgC3.TEST.d_feed_temp = 0.0;
    cfgC3.TEST.d_vapor = 0.0;
    cfgC3.TEST.cw_degrade_drop = 0.0;
    tests.push(["C3_ANALYZER_FAIL", cfgC3]);
  }

  const results = [];
  for (const [name, cfg] of tests) {
    const { log } = simulate(cfg);
    const metrics = summarize_metrics(log, cfg);
    const g = gate_stats(log.route);

    const totalIAE = metrics.reduce((acc, r) => acc + (Number(r.IAE) || 0), 0);

    results.push({
      name,
      gate: g,
      totalIAE,
      metrics
    });
  }

  return results;
};

// ============================================================
// DEFAULT CONFIG (matching Colab decisions)
// ============================================================
const BASE_CONFIG = {
  SIM: { sim_s: 3600, dt: 1.0, noise: true },

  SP: {
    F_feed: 50.0,
    T_feed_out: 120.0,
    T_reboiler: 165.0,
    T_cond_out: 35.0,
    F_reflux: 50.0,
    L_v201: 50.0,
  },

  RAMP: {
    rate_F_feed: 0.50,
    rate_T_feed_out: 0.05,
    rate_T_reboiler: 0.05,
    rate_T_cond_out: 0.05,
    rate_F_reflux: 0.50,
    rate_L_v201: 0.20,
  },

  MV_INIT: {
    u_feed: 50.0,
    u_steam_pre: 35.0,
    u_steam_reb: 40.0,
    u_cw: 45.0,
    u_reflux: 55.0,
    u_draw: 25.0,
  },

  LOOP: {
    FIC101: { Kp: 1.2, Ti: 40,  out_min: 0, out_max: 100, bias: 50, aw: 0.12 },
    TIC101: { Kp: 1.2, Ti: 180, out_min: 0, out_max: 100, bias: 35, aw: 0.15 },
    TIC102: { Kp: 1.1, Ti: 220, out_min: 0, out_max: 100, bias: 40, aw: 0.15 },
    TIC201: { Kp: 1.0, Ti: 220, out_min: 0, out_max: 100, bias: 45, aw: 0.15 },
    FIC201: { Kp: 1.4, Ti: 80,  out_min: 0, out_max: 100, bias: 55, aw: 0.10 },
    LIC201: { Kp: 0.8, Ti: 400, out_min: 0, out_max: 100, bias: 25, aw: 0.08 },
  },

  GATE: {
    TT106_on_low: 60.0,
    TT106_on_high: 120.0,

    rho15_on_low: 0.700,
    rho15_on_high: 0.775,

    TT106_off_low: 58.0,
    TT106_off_high: 122.0,
    rho15_off_low: 0.695,
    rho15_off_high: 0.780,

    dTsub_min: 5.0,
    dTsub_min_off: 4.0,

    delay_on_s: 120.0,
    delay_off_s: 30.0,

    perm_L_min: 10.0,
    perm_L_max: 90.0,
  },

  IL: {
    T_feed_HH: 150.0,
    T_reb_HH: 200.0,
    T_cond_out_HH: 60.0,
    L_v201_HH: 95.0,
    L_v201_LL: 5.0,
    u_draw_force_high: 90.0,
    u_draw_force_low: 0.0,
  },

  // Default single-run = baseline (disturbances OFF).
  // MODE UJI akan override sesuai skenario.
  TEST: {
    sp_steps: [],
    t_feed_dist: 900,
    d_feed_temp: 0.0,
    t_vapor_dist: 1500,
    d_vapor: 0.0,
    t_cw_degrade: 2100,
    cw_degrade_drop: 0.0,
    analyzer_fail_enable: false,
    t_analyzer_fail: 2600,
  },

  METRIC: {
    normalize_error: true,
    span: {
      T_feed_out: 60.0,
      T_reb: 80.0,
      T_cond_out: 50.0,
      F_feed: 100.0,
      F_reflux: 100.0,
      L_v201: 100.0,
    },
    settle_band: 0.02,
    settle_hold_s: 60.0,
  }
};

// ============================================================
// Build cfg from UI params
// ============================================================
const build_cfg_from_params = (p) => {
  const cfg = deepCopyCfg(BASE_CONFIG);

  // SIM
  cfg.SIM.sim_s = clamp(p.sim_s ?? cfg.SIM.sim_s, 600, 7200);
  cfg.SIM.dt = clamp(p.dt ?? cfg.SIM.dt, 0.5, 5.0);
  cfg.SIM.noise = !!(p.noise ?? cfg.SIM.noise);

  // SP
  cfg.SP.F_feed = Number(p.sp_Ffeed ?? cfg.SP.F_feed);
  cfg.SP.T_feed_out = Number(p.sp_Tfeed ?? cfg.SP.T_feed_out);
  cfg.SP.T_reboiler = Number(p.sp_Treb ?? cfg.SP.T_reboiler);
  cfg.SP.T_cond_out = Number(p.sp_Tcond ?? cfg.SP.T_cond_out);
  cfg.SP.F_reflux = Number(p.sp_Freflux ?? cfg.SP.F_reflux);
  cfg.SP.L_v201 = Number(p.sp_Lv201 ?? cfg.SP.L_v201);

  // LOOP tuning
  cfg.LOOP.FIC101.Kp = Number(p.kpFIC101 ?? cfg.LOOP.FIC101.Kp);
  cfg.LOOP.FIC101.Ti = Number(p.tiFIC101 ?? cfg.LOOP.FIC101.Ti);

  cfg.LOOP.TIC101.Kp = Number(p.kpTIC101 ?? cfg.LOOP.TIC101.Kp);
  cfg.LOOP.TIC101.Ti = Number(p.tiTIC101 ?? cfg.LOOP.TIC101.Ti);

  cfg.LOOP.TIC102.Kp = Number(p.kpTIC102 ?? cfg.LOOP.TIC102.Kp);
  cfg.LOOP.TIC102.Ti = Number(p.tiTIC102 ?? cfg.LOOP.TIC102.Ti);

  cfg.LOOP.TIC201.Kp = Number(p.kpTIC201 ?? cfg.LOOP.TIC201.Kp);
  cfg.LOOP.TIC201.Ti = Number(p.tiTIC201 ?? cfg.LOOP.TIC201.Ti);

  cfg.LOOP.FIC201.Kp = Number(p.kpFIC201 ?? cfg.LOOP.FIC201.Kp);
  cfg.LOOP.FIC201.Ti = Number(p.tiFIC201 ?? cfg.LOOP.FIC201.Ti);

  cfg.LOOP.LIC201.Kp = Number(p.kpLIC201 ?? cfg.LOOP.LIC201.Kp);
  cfg.LOOP.LIC201.Ti = Number(p.tiLIC201 ?? cfg.LOOP.LIC201.Ti);

  // GATE knobs
  cfg.GATE.TT106_on_low = Number(p.g_tt_low ?? cfg.GATE.TT106_on_low);
  cfg.GATE.TT106_on_high = Number(p.g_tt_high ?? cfg.GATE.TT106_on_high);

  cfg.GATE.rho15_on_low = Number(p.g_rho_low ?? cfg.GATE.rho15_on_low);
  cfg.GATE.rho15_on_high = Number(p.g_rho_high ?? cfg.GATE.rho15_on_high);

  cfg.GATE.dTsub_min = Number(p.g_dTsub ?? cfg.GATE.dTsub_min);
  cfg.GATE.delay_on_s = Number(p.g_delay_on ?? cfg.GATE.delay_on_s);
  cfg.GATE.delay_off_s = Number(p.g_delay_off ?? cfg.GATE.delay_off_s);

  // auto hysteresis widening
  cfg.GATE.TT106_off_low  = cfg.GATE.TT106_on_low - 2.0;
  cfg.GATE.TT106_off_high = cfg.GATE.TT106_on_high + 2.0;
  cfg.GATE.rho15_off_low  = cfg.GATE.rho15_on_low - 0.005;
  cfg.GATE.rho15_off_high = cfg.GATE.rho15_on_high + 0.005;
  cfg.GATE.dTsub_min_off  = Math.max(0.0, cfg.GATE.dTsub_min - 1.0);

  // Single-run toggle: analyzer fail only (disturbances OFF by default)
  cfg.TEST.analyzer_fail_enable = !!(p.analyzerFail ?? cfg.TEST.analyzer_fail_enable);

  return cfg;
};

// ============================================================
// Worker message protocol
// ============================================================
self.onmessage = (e) => {
  try {
    const payload = e.data || {};
    const mode = payload.mode || "single"; // "single" | "suite"

    const cfg = build_cfg_from_params(payload);

    if (mode === "suite") {
      const suite = run_test_suite(cfg);
      self.postMessage({ mode: "suite", suite });
      return;
    }

    // single = baseline run
    cfg.TEST.sp_steps = [];
    // baseline: disturbances OFF
    cfg.TEST.d_feed_temp = 0.0;
    cfg.TEST.d_vapor = 0.0;
    cfg.TEST.cw_degrade_drop = 0.0;

    const { log, event_log } = simulate(cfg);
    const metrics = summarize_metrics(log, cfg);
    const gate = gate_stats(log.route);

    // downsample chart data
    const maxPts = 700;
    const factor = Math.max(1, Math.floor(log.t.length / maxPts));

    const chartData = [];
    for (let i = 0; i < log.t.length; i += factor) {
      const route01 = (log.route[i] === "PRODUCT") ? 1 : 0;

      chartData.push({
        t: Math.round(log.t[i]),

        // temps
        Tfeed: log.T_feed_out[i], SP_Tfeed: log.SP_T_feed_out[i],
        Treb:  log.T_reb[i],      SP_Treb:  log.SP_T_reb[i],
        Tcond: log.T_cond_out[i], SP_Tcond: log.SP_T_cond_out[i],
        TT106: log.TT106[i],
        TT201: log.TT201[i],

        // quality
        rho15: log.rho15[i],
        Gate_rho_low: cfg.GATE.rho15_on_low,
        Gate_rho_high: cfg.GATE.rho15_on_high,

        dTsub: log.dTsub[i],
        Gate_dTsub_min: cfg.GATE.dTsub_min,

        route: route01,
        analyzer_ok: log.analyzer_ok[i],

        // flows & level
        Ffeed: log.F_feed[i],
        SP_Ffeed: log.SP_F_feed[i],
        Freflux: log.F_reflux[i],
        SP_Freflux: log.SP_F_reflux[i],
        Lv201: log.L_v201[i],
        SP_Lv201: log.SP_L_v201[i],

        // MVs
        u_feed: log.u_feed[i],
        u_steam_pre: log.u_steam_pre[i],
        u_steam_reb: log.u_steam_reb[i],
        u_cw: log.u_cw[i],
        u_reflux: log.u_reflux[i],
        u_draw: log.u_draw[i],
      });
    }

    const eventLog = (event_log || []).slice(0, 200).map(([t, msg]) => ({ t, msg }));

    self.postMessage({ mode: "single", chartData, metrics, gate, eventLog });
  } catch (err) {
    self.postMessage({ error: String(err?.message || err) });
  }
};