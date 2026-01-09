import { useState, useEffect, useCallback, useRef } from 'react';
import { Play, RotateCcw, Activity, Settings, TrendingUp, BarChart3, Info, Sun, Moon, Download, FileText, ChevronLeft, ChevronRight, Camera } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend, ResponsiveContainer } from 'recharts';

/**
 * --- MATH & UTILS ---
 */
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const step = (t, t0, amp) => (t >= t0 ? amp : 0.0);

const randn = () => {
  let u = 0, v = 0;
  while (u === 0) u = Math.random(); 
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
};

/**
 * --- SIMULATION CLASSES ---
 */
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
  reset() {
    this.G_Tfeed_steam = new FOPDT(0.60, 140, 10, this.T_feed0, this.dt);
    this.G_Tcond_cw = new FOPDT(-0.25, 160, 12, this.T_cond0, this.dt);
    this.G_Freflux_fv = new FOPDT(0.80, 40, 3, 50.0, this.dt);
    this.G_P_vent = new FOPDT(-0.90, 90, 6, 0.0, this.dt);
    this.G_rho_analyzer = new FOPDT(1.0, 240, 30, this.rho0, this.dt);
    this.T_feed = this.T_feed0; this.T_cond = this.T_cond0; this.F_reflux = 50.0; this.P_top = this.P_top0; this.rho = this.rho0;
  }
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
      Tfeed: this.T_feed + randn() * 0.2, Tcond: this.T_cond + randn() * 0.2,
      Ptop: this.P_top + randn() * 0.3, Freflux: this.F_reflux + randn() * 0.4, rho: this.rho + randn() * 0.0005,
    };
  }
}

/**
 * --- METRICS CALCULATION ---
 */
const calculateMetrics = (tArr, pvArr, spArr, mvArr, bandPct = 0.01, minAbs = 0.0) => {
  let iae = 0, ise = 0, overshoot = 0, undershoot = 0, settlingTime = null;
  const spFinal = spArr[spArr.length - 1];
  const tol = Math.max(minAbs, bandPct * Math.abs(spFinal));
  let settledIndex = -1;
  for (let i = tArr.length - 1; i >= 0; i--) {
    if (Math.abs(pvArr[i] - spFinal) > tol) { settledIndex = i + 1; break; }
  }
  if (settledIndex < tArr.length) settlingTime = tArr[settledIndex];
  else settlingTime = null;
  if (Math.abs(pvArr[0] - spFinal) <= tol && settledIndex === 0) settlingTime = 0;

  for (let i = 0; i < tArr.length; i++) {
    const dt = (i === 0) ? 0 : (tArr[i] - tArr[i - 1]);
    const e = spArr[i] - pvArr[i];
    if (i > 0) { iae += Math.abs(e) * dt; ise += (e * e) * dt; }
    overshoot = Math.max(overshoot, pvArr[i] - spFinal);
    undershoot = Math.max(undershoot, spFinal - pvArr[i]);
  }
  return { IAE: iae, ISE: ise, Overshoot: Math.max(0, overshoot), Undershoot: Math.max(0, undershoot), SettlingTime: settlingTime };
};

/**
 * --- COMPONENTS ---
 */

// Logo 19 Elegant Component
const Logo19 = ({ className }) => (
  <div className={`relative flex items-center justify-center ${className}`}>
    <svg viewBox="0 0 100 100" className="w-full h-full text-teal-500 fill-current">
      <path d="M35 20 L45 20 L45 80 L35 80 Z" />
      <path d="M25 30 L40 20" stroke="currentColor" strokeWidth="6" strokeLinecap="round" />
      <path d="M65 50 C55 50 55 20 65 20 C75 20 75 50 65 50 Z M65 50 L65 80" stroke="currentColor" strokeWidth="8" fill="none" />
      <circle cx="65" cy="35" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
    </svg>
  </div>
);

// Chart Saver Helper
const downloadChartAsPng = (chartId, title) => {
  const svg = document.querySelector(`#${chartId} .recharts-surface`);
  if (!svg) return;
  
  const svgData = new XMLSerializer().serializeToString(svg);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const img = new Image();
  
  // Get SVG dimensions
  const svgSize = svg.getBoundingClientRect();
  canvas.width = svgSize.width;
  canvas.height = svgSize.height;
  
  img.onload = () => {
    // Fill background (white for image)
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    const pngFile = canvas.toDataURL("image/png");
    const downloadLink = document.createElement("a");
    downloadLink.download = `${title.replace(/\s+/g, '_')}.png`;
    downloadLink.href = pngFile;
    downloadLink.click();
  };
  
  img.src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svgData)));
};

export default function AimtopindoDashboard() {
  const [isDarkMode, setIsDarkMode] = useState(true);
  const [isSimulating, setIsSimulating] = useState(false);
  const [activeChartPage, setActiveChartPage] = useState(0);

  const [params, setParams] = useState({
    sim_s: 4800, dt: 1.0,
    sp_Tfeed: 120.0, sp_Tcond: 45.0, sp_rho: 0.7400,
    enableP: true,
    kp101: 2.0, ti101: 180,
    kp201: 4.0, ti201: 180,
    kpf: 1.5, tif: 80,
    kpa: 400, tia: 1000,
    kpp: 1.5, tip: 120
  });

  // Stores the parameters used for the LAST simulation run
  const [runParams, setRunParams] = useState(null); 
  const [simData, setSimData] = useState(null);
  const [metrics, setMetrics] = useState(null);

  const runSimulation = useCallback(async () => {
    setIsSimulating(true);
    await new Promise(r => setTimeout(r, 100));

    // Save current params as "Run Params" for the table
    setRunParams({...params});

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
    
    // Disturbance timing
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

    const factor = Math.max(1, Math.floor(log.t.length / 500));
    const chartData = [];
    for(let i=0; i<log.t.length; i+=factor) {
      chartData.push({
        t: Math.round(log.t[i]),
        Tfeed: log.Tfeed[i], SP_Tfeed: log.SP_Tfeed[i],
        Tcond: log.Tcond[i], SP_Tcond: log.SP_Tcond[i],
        rho: log.rho[i], SP_rho: log.SP_rho[i],
        Freflux: log.Freflux[i], SP_reflux: log.SP_reflux[i],
        Ptop: log.Ptop[i], SP_Ptop: log.SP_Ptop[i],
        u_steam: log.u_steam[i], u_cw: log.u_cw[i],
        u_fv: log.u_fv[i], u_vent: log.u_vent[i]
      });
    }
    setSimData(chartData);

    const m1 = calculateMetrics(log.t, log.Tfeed, log.SP_Tfeed, log.u_steam, 0.01, 0.3);
    const m2 = calculateMetrics(log.t, log.Tcond, log.SP_Tcond, log.u_cw, 0.01, 0.3);
    const m3 = calculateMetrics(log.t, log.rho, log.SP_rho, null, 0.01, 0.001);
    const m4 = calculateMetrics(log.t, log.Freflux, log.SP_reflux, log.u_fv, 0.02, 0.5);

    setMetrics([
      { name: "TIC-101 (Preheater)", ...m1 },
      { name: "TIC-201 (Condenser)", ...m2 },
      { name: "AIC-201 (Density)", ...m3 },
      { name: "FIC-201 (Reflux)", ...m4 },
    ]);

    setIsSimulating(false);
  }, [params]);

  useEffect(() => { runSimulation(); }, []);

  const handleParamChange = (key, val) => setParams(prev => ({ ...prev, [key]: parseFloat(val) }));

  // --- SUB COMPONENTS ---

  const SliderControl = ({ label, id, min, max, step, val, unit = "" }) => (
    <div className="mb-3">
      <div className={`flex justify-between text-xs mb-1 ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`}>
        <label htmlFor={id}>{label}</label>
        <span className="text-teal-500 font-mono font-bold">{val} {unit}</span>
      </div>
      <input 
        id={id} type="range" min={min} max={max} step={step} value={val} 
        onChange={(e) => handleParamChange(id, e.target.value)}
        className="w-full h-1 bg-gray-300 dark:bg-gray-700 rounded-lg appearance-none cursor-pointer accent-teal-500 hover:accent-teal-400"
      />
    </div>
  );

  const ChartCard = ({ title, id, children }) => (
    <div className={`border rounded-xl p-1 shadow-sm h-[400px] flex flex-col relative transition-colors duration-300
      ${isDarkMode ? 'bg-neutral-900 border-gray-800' : 'bg-white border-gray-200'}`} id={id}>
      <div className="px-4 py-3 flex justify-between items-center border-b border-gray-100 dark:border-gray-800">
        <div className={`text-sm font-bold uppercase tracking-wide ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
          {title}
        </div>
        <button 
          onClick={() => downloadChartAsPng(id, title)}
          className={`p-1.5 rounded-md transition-colors ${isDarkMode ? 'hover:bg-gray-700 text-gray-400' : 'hover:bg-gray-100 text-gray-500'}`}
          title="Unduh Grafik (PNG)"
        >
          <Camera size={16} />
        </button>
      </div>
      <div className="flex-1 p-2">
        {children}
      </div>
    </div>
  );

  // Pagination Logic for Charts
  const CHART_PAGES = [
    { title: "Temperatures (E-101 & C-201)", charts: ["Tfeed", "Tcond"] },
    { title: "Quality & Reflux", charts: ["rho", "Freflux"] },
    { title: "Controller Outputs (MV)", charts: ["outputs"] }
  ];

  return (
    <div className={`min-h-screen font-sans transition-colors duration-300 flex flex-col
      ${isDarkMode ? 'bg-neutral-950 text-gray-200 selection:bg-teal-900 selection:text-white' : 'bg-gray-50 text-gray-800 selection:bg-teal-100 selection:text-teal-900'}`}>
      
      {/* HEADER */}
      <header className={`border-b sticky top-0 z-50 backdrop-blur-md transition-colors duration-300
        ${isDarkMode ? 'border-gray-800 bg-neutral-900/80' : 'border-gray-200 bg-white/80'}`}>
        <div className="max-w-7xl mx-auto px-4 py-3 flex justify-between items-center">
          <div className="flex items-center gap-4">
            {/* LOGO AREA - Can be replaced by img src later */}
            <div className={`w-12 h-12 rounded-xl flex items-center justify-center border shadow-sm
               ${isDarkMode ? 'bg-neutral-800 border-gray-700' : 'bg-white border-gray-200'}`}>
               <Logo19 className="w-8 h-8" />
            </div>
            <div>
              <h1 className={`text-xl font-bold tracking-tight ${isDarkMode ? 'text-white' : 'text-gray-900'}`}>
                PT. Aimtopindo
              </h1>
              <p className="text-xs text-teal-500 uppercase tracking-widest font-bold">
                Kelompok 19 DMPR
              </p>
            </div>
          </div>

          <div className="flex items-center gap-4">
             {/* THEME TOGGLE */}
            <button 
              onClick={() => setIsDarkMode(!isDarkMode)}
              className={`p-2 rounded-full border transition-all
              ${isDarkMode ? 'bg-gray-800 border-gray-700 text-yellow-400' : 'bg-gray-100 border-gray-300 text-gray-600'}`}
            >
              {isDarkMode ? <Sun size={18} /> : <Moon size={18} />}
            </button>

            <button 
              onClick={runSimulation}
              disabled={isSimulating}
              className={`flex items-center gap-2 px-6 py-2.5 rounded-full font-medium transition-all shadow-lg 
                ${isSimulating 
                  ? 'bg-gray-700 text-gray-400 cursor-not-allowed' 
                  : 'bg-teal-500 hover:bg-teal-400 text-white hover:scale-105 shadow-teal-500/20'}`}
            >
              {isSimulating ? <RotateCcw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4 fill-current" />}
              {isSimulating ? 'Simulasi...' : 'Jalankan Simulasi'}
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-7xl mx-auto px-4 py-6 grid grid-cols-1 lg:grid-cols-12 gap-6 w-full">
        
        {/* LEFT COLUMN: CONTROLS (Fixed width, Scrollable if needed) */}
        <aside className="lg:col-span-3 space-y-4">
          <div className={`border rounded-xl p-5 shadow-sm ${isDarkMode ? 'bg-neutral-900 border-gray-800' : 'bg-white border-gray-200'}`}>
            <div className={`flex items-center gap-2 mb-4 font-semibold border-b pb-2 ${isDarkMode ? 'text-white border-gray-800' : 'text-gray-900 border-gray-100'}`}>
              <Settings className="w-4 h-4 text-teal-500" /> Pengaturan Global
            </div>
            <SliderControl label="Durasi (s)" id="sim_s" min={1800} max={7200} step={300} val={params.sim_s} />
            <SliderControl label="Time Step (dt)" id="dt" min={0.5} max={2.0} step={0.5} val={params.dt} />
            <div className={`flex items-center justify-between mt-4 p-2 rounded ${isDarkMode ? 'bg-gray-800/50' : 'bg-gray-50 border border-gray-100'}`}>
              <label className={`text-xs ${isDarkMode?'text-gray-300':'text-gray-600'}`}>Aktifkan Pressure Loop</label>
              <input 
                type="checkbox" 
                checked={params.enableP} 
                onChange={(e) => setParams({...params, enableP: e.target.checked})}
                className="w-4 h-4 accent-teal-500"
              />
            </div>
          </div>

          <div className={`border rounded-xl p-5 shadow-sm ${isDarkMode ? 'bg-neutral-900 border-gray-800' : 'bg-white border-gray-200'}`}>
            <div className={`flex items-center gap-2 mb-4 font-semibold border-b pb-2 ${isDarkMode ? 'text-white border-gray-800' : 'text-gray-900 border-gray-100'}`}>
              <TrendingUp className="w-4 h-4 text-teal-500" /> Setpoints
            </div>
            <SliderControl label="SP Feed Temp (°C)" id="sp_Tfeed" min={90} max={150} step={1} val={params.sp_Tfeed} />
            <SliderControl label="SP Cond Temp (°C)" id="sp_Tcond" min={30} max={70} step={1} val={params.sp_Tcond} />
            <SliderControl label="SP Density (g/cc)" id="sp_rho" min={0.70} max={0.80} step={0.0005} val={params.sp_rho} />
          </div>

          <div className={`border rounded-xl overflow-hidden shadow-sm flex flex-col max-h-[600px] ${isDarkMode ? 'bg-neutral-900 border-gray-800' : 'bg-white border-gray-200'}`}>
            <div className={`p-4 font-semibold flex items-center gap-2 border-b ${isDarkMode ? 'bg-gray-800/30 border-gray-800 text-white' : 'bg-gray-50 border-gray-100 text-gray-900'}`}>
              <BarChart3 className="w-4 h-4 text-teal-500" /> Tuning PID
            </div>
            <div className="p-4 space-y-6 overflow-y-auto custom-scrollbar flex-1">
              {['TIC-101 (Preheater)|kp101|ti101', 'TIC-201 (Condenser)|kp201|ti201', 'AIC-201 (Density)|kpa|tia', 'FIC-201 (Reflux Flow)|kpf|tif', 'PIC-201 (Pressure)|kpp|tip'].map((grp, i) => {
                const [title, kId, tId] = grp.split('|');
                return (
                  <div key={i} className={i > 0 ? "border-t pt-4 border-gray-700/30" : ""}>
                    <h4 className="text-xs font-bold text-teal-500 uppercase mb-2">{title}</h4>
                    <SliderControl label="Kp" id={kId} min={kId.includes('kpa') ? 50 : 0.2} max={kId.includes('kpa') ? 2000 : 10.0} step={kId.includes('kpa') ? 50 : 0.1} val={params[kId]} />
                    <SliderControl label="Ti (s)" id={tId} min={20} max={kId.includes('kpa') ? 2500 : 600} step={10} val={params[tId]} />
                  </div>
                )
              })}
            </div>
          </div>
        </aside>

        {/* RIGHT COLUMN: DATA VISUALIZATION */}
        <section className="lg:col-span-9 flex flex-col gap-6">
          
          {/* TABLES AREA (Grid of 2 tables) */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            
            {/* TABLE 1: PARAMETER METRICS (Settings Used) */}
            {runParams && (
            <div className={`border rounded-xl overflow-hidden shadow-sm ${isDarkMode ? 'bg-neutral-900 border-gray-800' : 'bg-white border-gray-200'}`}>
              <div className={`p-3 border-b flex items-center gap-2 ${isDarkMode ? 'border-gray-800' : 'border-gray-100'}`}>
                 <FileText className="w-4 h-4 text-teal-500" />
                 <h3 className={`font-semibold text-sm ${isDarkMode ? 'text-white' : 'text-gray-900'}`}>Tabel Parameter (Input)</h3>
              </div>
              <div className="overflow-x-auto">
                <table className={`w-full text-xs text-left`}>
                   <thead className={`${isDarkMode ? 'bg-gray-800 text-gray-400' : 'bg-gray-50 text-gray-600'} uppercase font-semibold`}>
                     <tr><th className="px-4 py-2">Loop</th><th className="px-4 py-2">Kp</th><th className="px-4 py-2">Ti</th></tr>
                   </thead>
                   <tbody className={`divide-y ${isDarkMode ? 'divide-gray-800 text-gray-300' : 'divide-gray-100 text-gray-700'}`}>
                     {[
                       ["TIC-101", runParams.kp101, runParams.ti101],
                       ["TIC-201", runParams.kp201, runParams.ti201],
                       ["FIC-201", runParams.kpf, runParams.tif],
                       ["AIC-201", runParams.kpa, runParams.tia],
                       ["PIC-201", runParams.kpp, runParams.tip]
                     ].map(([n, k, t], i) => (
                       <tr key={i}><td className="px-4 py-2 font-medium text-teal-500">{n}</td><td className="px-4 py-2">{k}</td><td className="px-4 py-2">{t}</td></tr>
                     ))}
                   </tbody>
                </table>
              </div>
            </div>
            )}

            {/* TABLE 2: PERFORMANCE METRICS (Output) */}
            {metrics && (
             <div className={`border rounded-xl overflow-hidden shadow-sm ${isDarkMode ? 'bg-neutral-900 border-gray-800' : 'bg-white border-gray-200'}`}>
               <div className={`p-3 border-b flex items-center gap-2 ${isDarkMode ? 'border-gray-800' : 'border-gray-100'}`}>
                 <Info className="w-4 h-4 text-teal-500" />
                 <h3 className={`font-semibold text-sm ${isDarkMode ? 'text-white' : 'text-gray-900'}`}>Tabel Kinerja (Output)</h3>
               </div>
               <div className="overflow-x-auto max-h-[200px] custom-scrollbar">
                 <table className="w-full text-xs text-left">
                   <thead className={`${isDarkMode ? 'bg-gray-800 text-gray-400' : 'bg-gray-50 text-gray-600'} uppercase font-semibold`}>
                     <tr>
                       <th className="px-4 py-2">Loop</th>
                       <th className="px-4 py-2">IAE</th>
                       <th className="px-4 py-2">Settling (s)</th>
                     </tr>
                   </thead>
                   <tbody className={`divide-y ${isDarkMode ? 'divide-gray-800 text-gray-300' : 'divide-gray-100 text-gray-700'}`}>
                     {metrics.map((row, idx) => (
                       <tr key={idx}>
                         <td className="px-4 py-2 font-medium text-teal-500">{row.name.split(' ')[0]}</td>
                         <td className="px-4 py-2">{row.IAE.toFixed(1)}</td>
                         <td className="px-4 py-2">{row.SettlingTime !== null ? row.SettlingTime.toFixed(0) : '-'}</td>
                       </tr>
                     ))}
                   </tbody>
                 </table>
               </div>
             </div>
            )}
          </div>

          {/* CHARTS CONTAINER WITH PAGINATION */}
          <div className="flex-1 flex flex-col">
            {/* Pagination Controls */}
            <div className="flex justify-between items-center mb-4">
               <h2 className={`text-lg font-bold ${isDarkMode ? 'text-white' : 'text-gray-800'}`}>
                 Grafik Simulasi: <span className="text-teal-500">{CHART_PAGES[activeChartPage].title}</span>
               </h2>
               <div className="flex gap-2">
                 <button 
                   onClick={() => setActiveChartPage(p => Math.max(0, p - 1))}
                   disabled={activeChartPage === 0}
                   className={`p-2 rounded-lg border flex items-center gap-1 text-sm font-medium transition-colors
                     ${isDarkMode ? 'border-gray-700 hover:bg-gray-800 disabled:opacity-30' : 'border-gray-200 hover:bg-gray-100 disabled:opacity-30'}`}
                 >
                   <ChevronLeft size={16} /> Prev
                 </button>
                 <div className="flex items-center gap-1 px-2">
                   {CHART_PAGES.map((_, idx) => (
                     <div 
                       key={idx} 
                       className={`w-2 h-2 rounded-full transition-all ${activeChartPage === idx ? 'bg-teal-500 w-4' : 'bg-gray-500'}`}
                     />
                   ))}
                 </div>
                 <button 
                   onClick={() => setActiveChartPage(p => Math.min(CHART_PAGES.length - 1, p + 1))}
                   disabled={activeChartPage === CHART_PAGES.length - 1}
                   className={`p-2 rounded-lg border flex items-center gap-1 text-sm font-medium transition-colors
                     ${isDarkMode ? 'border-gray-700 hover:bg-gray-800 disabled:opacity-30' : 'border-gray-200 hover:bg-gray-100 disabled:opacity-30'}`}
                 >
                   Next <ChevronRight size={16} />
                 </button>
               </div>
            </div>

            {/* Render Active Charts */}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 animate-fadeIn">
              {activeChartPage === 0 && (
                <>
                  <ChartCard title="E-101: Feed Temp (°C)" id="chart-tfeed">
                    <ResponsiveContainer>
                      <LineChart data={simData}>
                        <CartesianGrid strokeDasharray="3 3" stroke={isDarkMode ? "#333" : "#eee"} />
                        <XAxis dataKey="t" stroke="#888" tick={{fontSize: 10}} />
                        <YAxis stroke="#888" tick={{fontSize: 10}} domain={['auto', 'auto']} />
                        <RechartsTooltip contentStyle={{ backgroundColor: isDarkMode ? '#111' : '#fff', borderColor: isDarkMode ? '#333' : '#ddd', color: isDarkMode ? '#fff' : '#000' }} />
                        <Legend />
                        <Line type="monotone" dataKey="Tfeed" stroke="#2dd4bf" strokeWidth={2} dot={false} isAnimationActive={false} name="PV" />
                        <Line type="step" dataKey="SP_Tfeed" stroke="#9ca3af" strokeDasharray="4 4" dot={false} isAnimationActive={false} name="SP" />
                      </LineChart>
                    </ResponsiveContainer>
                  </ChartCard>
                  <ChartCard title="C-201: Condenser Temp (°C)" id="chart-tcond">
                    <ResponsiveContainer>
                      <LineChart data={simData}>
                        <CartesianGrid strokeDasharray="3 3" stroke={isDarkMode ? "#333" : "#eee"} />
                        <XAxis dataKey="t" stroke="#888" tick={{fontSize: 10}} />
                        <YAxis stroke="#888" tick={{fontSize: 10}} domain={['auto', 'auto']} />
                        <RechartsTooltip contentStyle={{ backgroundColor: isDarkMode ? '#111' : '#fff', borderColor: isDarkMode ? '#333' : '#ddd', color: isDarkMode ? '#fff' : '#000' }} />
                        <Legend />
                        <Line type="monotone" dataKey="Tcond" stroke="#2dd4bf" strokeWidth={2} dot={false} isAnimationActive={false} name="PV" />
                        <Line type="step" dataKey="SP_Tcond" stroke="#9ca3af" strokeDasharray="4 4" dot={false} isAnimationActive={false} name="SP" />
                      </LineChart>
                    </ResponsiveContainer>
                  </ChartCard>
                </>
              )}

              {activeChartPage === 1 && (
                <>
                  <ChartCard title="AIC-201: Density (g/cc)" id="chart-rho">
                    <ResponsiveContainer>
                      <LineChart data={simData}>
                        <CartesianGrid strokeDasharray="3 3" stroke={isDarkMode ? "#333" : "#eee"} />
                        <XAxis dataKey="t" stroke="#888" tick={{fontSize: 10}} />
                        <YAxis stroke="#888" tick={{fontSize: 10}} domain={['auto', 'auto']} tickFormatter={(v) => v.toFixed(3)} />
                        <RechartsTooltip contentStyle={{ backgroundColor: isDarkMode ? '#111' : '#fff', borderColor: isDarkMode ? '#333' : '#ddd', color: isDarkMode ? '#fff' : '#000' }} />
                        <Legend />
                        <Line type="monotone" dataKey="rho" stroke="#f472b6" strokeWidth={2} dot={false} isAnimationActive={false} name="PV" />
                        <Line type="step" dataKey="SP_rho" stroke="#9ca3af" strokeDasharray="4 4" dot={false} isAnimationActive={false} name="SP" />
                      </LineChart>
                    </ResponsiveContainer>
                  </ChartCard>
                  <ChartCard title="FIC-201: Reflux Flow (Cascade)" id="chart-flow">
                    <ResponsiveContainer>
                      <LineChart data={simData}>
                        <CartesianGrid strokeDasharray="3 3" stroke={isDarkMode ? "#333" : "#eee"} />
                        <XAxis dataKey="t" stroke="#888" tick={{fontSize: 10}} />
                        <YAxis stroke="#888" tick={{fontSize: 10}} domain={['auto', 'auto']} />
                        <RechartsTooltip contentStyle={{ backgroundColor: isDarkMode ? '#111' : '#fff', borderColor: isDarkMode ? '#333' : '#ddd', color: isDarkMode ? '#fff' : '#000' }} />
                        <Legend />
                        <Line type="monotone" dataKey="Freflux" stroke="#2dd4bf" strokeWidth={2} dot={false} isAnimationActive={false} name="Flow PV" />
                        <Line type="monotone" dataKey="SP_reflux" stroke="#a78bfa" strokeDasharray="3 3" dot={false} isAnimationActive={false} name="Flow SP" />
                      </LineChart>
                    </ResponsiveContainer>
                  </ChartCard>
                </>
              )}

              {activeChartPage === 2 && (
                <div className="xl:col-span-2">
                  <ChartCard title="Controller Outputs (MV %)" id="chart-mv">
                    <ResponsiveContainer>
                      <LineChart data={simData}>
                        <CartesianGrid strokeDasharray="3 3" stroke={isDarkMode ? "#333" : "#eee"} />
                        <XAxis dataKey="t" stroke="#888" tick={{fontSize: 10}} />
                        <YAxis stroke="#888" tick={{fontSize: 10}} domain={[0, 100]} />
                        <RechartsTooltip contentStyle={{ backgroundColor: isDarkMode ? '#111' : '#fff', borderColor: isDarkMode ? '#333' : '#ddd', color: isDarkMode ? '#fff' : '#000' }} />
                        <Legend />
                        <Line type="monotone" dataKey="u_steam" stroke="#facc15" strokeWidth={1} dot={false} isAnimationActive={false} name="Steam %" />
                        <Line type="monotone" dataKey="u_cw" stroke="#3b82f6" strokeWidth={1} dot={false} isAnimationActive={false} name="CW %" />
                        <Line type="monotone" dataKey="u_fv" stroke="#a78bfa" strokeWidth={1} dot={false} isAnimationActive={false} name="Reflux Valve %" />
                      </LineChart>
                    </ResponsiveContainer>
                  </ChartCard>
                </div>
              )}
            </div>
          </div>
        </section>
      </main>

      {/* FOOTER */}
      <footer className={`border-t py-6 mt-12 transition-colors duration-300
        ${isDarkMode ? 'bg-neutral-900 border-gray-800 text-gray-500' : 'bg-white border-gray-200 text-gray-400'}`}>
        <div className="max-w-7xl mx-auto px-4 flex flex-col md:flex-row justify-between items-center gap-4">
          <div className="flex items-center gap-3">
             <div className="opacity-50 grayscale hover:grayscale-0 transition-all">
                {/* Placeholder Logo for Footer */}
                <Logo19 className="w-8 h-8" />
             </div>
             <p className="text-sm font-medium">© 2024 Kelompok 19 DMPR. All rights reserved.</p>
          </div>
          <div className="flex gap-6 text-sm">
            <span>Client: PT. Aimtopindo</span>
            <span>Project: Digital Twin PID Control</span>
          </div>
        </div>
      </footer>
    </div>
  );
}