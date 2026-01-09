// src/sim.worker.js

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const step = (t, t0, amp) => (t >= t0 ? amp : 0.0);

const randn = () => {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
};

class FOPDT {
  constructor(K, tau, theta, y0 = 0.0, dt = 1.0) {
    this.K = K; this.tau = tau; this.theta = theta; this.dt = dt;
    this.delay_steps = Math.round(theta / dt);
    this.buf = new Array(this.delay_steps + 1).fill(0.0);
    this.y = y0;
  }
  reset(y0) {
    if (y0 !== undefined) this.y = y0;
    this.buf = new Array(this.delay_steps + 1).fill(0.0);
  }
  update(u, d = 0.0) {
    this.buf.push(u);
    const u_del = this.buf.shift();
    const dy = (this.K * u_del + d - this.y) * (this.dt / Math.max(this.tau, 1e-9));
    this.y += dy;
    return this.y;
  }
}

class PID {
  constructor(Kp, Ti, dt = 1.0, out_min = 0.0, out_max = 100.0, bias = 0.0, aw = 0.15, reverse = false) {
    this.Kp = Kp; this.Ti = Ti; this.dt = dt;
    this.out_min = out_min; this.out_max = out_max; this.bias = bias; this.aw = aw; this.reverse = reverse;
    this.i = 0.0; this.e_prev = 0.0;
    this.u_prev = clamp(bias, out_min, out_max);
  }
  reset(u0) {
    this.i = 0.0; this.e_prev = 0.0;
    this.u_prev = clamp(u0 !== undefined ? u0 : this.bias, this.out_min, this.out_max);
  }
  update(sp, pv) {
    const e = this.reverse ? (pv - sp) : (sp - pv);
    if (this.Ti && this.Ti > 1e-9) this.i += (this.dt / this.Ti) * e;
    const u_unsat = this.bias + this.Kp * (e + this.i);
    const u = clamp(u_unsat, this.out_min, this.out_max);
    if (this.Ti && this.Ti > 1e-9) this.i += this.aw * (u - u_unsat);
    this.e_prev = e; this.u_prev = u;
    return u;
  }
}

class DistilPlantDummy {
  constructor(dt = 1.0) {
    this.dt = dt;
    this.T_feed0 = 120.0; this.T_cond0 = 45.0; this.P_top0 = 150.0; this.rho0 = 0.7400;
    this.G_Tfeed_steam = new FOPDT(0.60, 140, 10, this.T_feed0, dt);
    this.G_Tcond_cw = new FOPDT(-0.25, 160, 12, this.T_cond0, dt);
    this.G_Freflux_fv = new FOPDT(0.80, 40, 3, 50.0, dt);
    this.G_P_vent = new FOPDT(-0.90, 90, 6, 0.0, dt);
    this.G_rho_analyzer = new FOPDT(1.0, 240, 30, this.rho0, dt);
    this.d_feed_temp = 0.0; this.d_vapor_load = 0.0; this.cw_degrade = 1.0;
    this.T_feed = this.T_feed0; this.T_cond = this.T_cond0; this.F_reflux = 50.0; this.P_top = this.P_top0; this.rho = this.rho0;
  }
  reset() { Object.assign(this, new DistilPlantDummy(this.dt)); }
  update(u_steam, u_cw, u_fv, u_vent, noise = true) {
    u_steam = clamp(u_steam, 0, 100); u_cw = clamp(u_cw, 0, 100);
    u_fv = clamp(u_fv, 0, 100); u_vent = clamp(u_vent, 0, 100);

    this.T_feed = this.G_Tfeed_steam.update(u_steam, this.d_feed_temp);
    this.T_cond = this.G_Tcond_cw.update(u_cw * this.cw_degrade, 0.0);
    this.F_reflux = this.G_Freflux_fv.update(u_fv, 0.0);

    const vapor_coupling = 0.70 * (this.T_feed - this.T_feed0) - 0.15 * (this.F_reflux - 50.0);
    const relief = this.G_P_vent.update(u_vent, 0.0);
    this.P_top = this.P_top0 + this.d_vapor_load + vapor_coupling + relief + 0.20 * (this.T_cond - this.T_cond0);

    const rho_ss = this.rho0 + 0.0008 * (this.T_feed - this.T_feed0) - 0.0012 * (this.F_reflux - 50.0);
    this.rho = this.G_rho_analyzer.update(rho_ss, 0.0);

    if (!noise) return { Tfeed: this.T_feed, Tcond: this.T_cond, Ptop: this.P_top, Freflux: this.F_reflux, rho: this.rho };

    return {
      Tfeed: this.T_feed + randn() * 0.2,
      Tcond: this.T_cond + randn() * 0.2,
      Ptop: this.P_top + randn() * 0.3,
      Freflux: this.F_reflux + randn() * 0.4,
      rho: this.rho + randn() * 0.0005,
    };
  }
}

const calculateMetrics = (tArr, pvArr, spArr, bandPct = 0.01, minAbs = 0.0) => {
  let iae = 0, ise = 0, overshoot = 0, undershoot = 0, settlingTime = null;
  const spFinal = spArr[spArr.length - 1];
  const tol = Math.max(minAbs, bandPct * Math.abs(spFinal));

  let settledIndex = -1;
  for (let i = tArr.length - 1; i >= 0; i--) {
    if (Math.abs(pvArr[i] - spFinal) > tol) { settledIndex = i + 1; break; }
  }
  if (settledIndex < tArr.length) settlingTime = tArr[settledIndex];
  else settlingTime = null;

  for (let i = 1; i < tArr.length; i++) {
    const dt = (tArr[i] - tArr[i - 1]);
    const e = spArr[i] - pvArr[i];
    iae += Math.abs(e) * dt;
    ise += (e * e) * dt;
    overshoot = Math.max(overshoot, pvArr[i] - spFinal);
    undershoot = Math.max(undershoot, spFinal - pvArr[i]);
  }

  return { IAE: iae, ISE: ise, Overshoot: Math.max(0, overshoot), Undershoot: Math.max(0, undershoot), SettlingTime: settlingTime };
};

self.onmessage = (e) => {
  const params = e.data;

  const { sim_s, dt, sp_Tfeed, sp_Tcond, sp_rho, enableP, kp101, ti101, kp201, ti201, kpf, tif, kpa, tia, kpp, tip } = params;

  const plant = new DistilPlantDummy(dt);
  plant.reset();

  const tic101 = new PID(kp101, ti101, dt, 0, 100, 35, 0.15, false);
  const tic201 = new PID(kp201, ti201, dt, 0, 100, 45, 0.15, true);
  const fic201 = new PID(kpf, tif, dt, 0, 100, 55, 0.10, false);
  const aic201 = new PID(kpa, tia, dt, 10, 90, 50, 0.05, true);
  const pic201 = new PID(kpp, tip, dt, 0, 100, 5, 0.10, true);

  const log = {
    t: [], Tfeed: [], Tcond: [], Ptop: [], Freflux: [], rho: [],
    SP_Tfeed: [], SP_Tcond: [], SP_rho: [], SP_reflux: [], SP_Ptop: [],
    u_steam: [], u_cw: [], u_fv: [], u_vent: []
  };

  let u_steam = 35, u_cw = 45, u_fv = 55, u_vent = 5;
  let sp_reflux = 50.0;

  const t_sp_step = 600, d_sp_Tfeed = 3.0;
  const t_feed_dist = 900, d_feed_temp = 8.0;
  const t_vapor_dist = 1500, d_vapor = 12.0;
  const t_cw_degrade = 2100, cw_degrade_amt = 0.25;

  for (let ti = 0; ti <= sim_s; ti += dt) {
    plant.d_feed_temp = step(ti, t_feed_dist, d_feed_temp);
    plant.d_vapor_load = step(ti, t_vapor_dist, d_vapor);
    plant.cw_degrade = 1.0 - step(ti, t_cw_degrade, cw_degrade_amt);

    const spTfeed = sp_Tfeed + step(ti, t_sp_step, d_sp_Tfeed);
    const spTcond = sp_Tcond;
    const spRho = sp_rho;
    const spPtop = 150.0;

    const m = plant.update(u_steam, u_cw, u_fv, u_vent, true);

    u_steam = tic101.update(spTfeed, m.Tfeed);
    u_cw = tic201.update(spTcond, m.Tcond);
    sp_reflux = aic201.update(spRho, m.rho);
    u_fv = fic201.update(sp_reflux, m.Freflux);
    u_vent = enableP ? pic201.update(spPtop, m.Ptop) : 0.0;

    log.t.push(ti);
    log.Tfeed.push(m.Tfeed); log.Tcond.push(m.Tcond); log.Ptop.push(m.Ptop);
    log.Freflux.push(m.Freflux); log.rho.push(m.rho);

    log.SP_Tfeed.push(spTfeed); log.SP_Tcond.push(spTcond);
    log.SP_rho.push(spRho); log.SP_reflux.push(sp_reflux); log.SP_Ptop.push(spPtop);

    log.u_steam.push(u_steam); log.u_cw.push(u_cw); log.u_fv.push(u_fv); log.u_vent.push(u_vent);
  }

  // downsample chart data (tetap seperti kamu)
  const factor = Math.max(1, Math.floor(log.t.length / 500));
  const chartData = [];
  for (let i = 0; i < log.t.length; i += factor) {
    chartData.push({
      t: Math.round(log.t[i]),
      Tfeed: log.Tfeed[i], SP_Tfeed: log.SP_Tfeed[i],
      Tcond: log.Tcond[i], SP_Tcond: log.SP_Tcond[i],
      rho: log.rho[i], SP_rho: log.SP_rho[i],
      Freflux: log.Freflux[i], SP_reflux: log.SP_reflux[i],
      Ptop: log.Ptop[i], SP_Ptop: log.SP_Ptop[i],
      u_steam: log.u_steam[i], u_cw: log.u_cw[i], u_fv: log.u_fv[i], u_vent: log.u_vent[i]
    });
  }

  const m1 = calculateMetrics(log.t, log.Tfeed, log.SP_Tfeed, 0.01, 0.3);
  const m2 = calculateMetrics(log.t, log.Tcond, log.SP_Tcond, 0.01, 0.3);
  const m3 = calculateMetrics(log.t, log.rho, log.SP_rho, 0.01, 0.001);
  const m4 = calculateMetrics(log.t, log.Freflux, log.SP_reflux, 0.02, 0.5);

  const metrics = [
    { name: "TIC-101 (Preheater)", ...m1 },
    { name: "TIC-201 (Condenser)", ...m2 },
    { name: "AIC-201 (Density)", ...m3 },
    { name: "FIC-201 (Reflux)", ...m4 },
  ];

  self.postMessage({ chartData, metrics });
};