import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  Play, RotateCcw, Settings, TrendingUp, BarChart3, Info,
  Sun, Moon, FileText, ChevronLeft, ChevronRight, Camera
} from 'lucide-react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend, ResponsiveContainer
} from 'recharts';

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

const downloadChartAsPng = (chartId, title) => {
  const root = document.getElementById(chartId);
  if (!root) return;

  const svg = root.querySelector("svg.recharts-surface");
  if (!svg) return;

  const rect = svg.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));

  const dpr = window.devicePixelRatio || 1;

  const bg = window.getComputedStyle(root).backgroundColor || "#ffffff";

  const cloned = svg.cloneNode(true);

  if (!cloned.getAttribute("xmlns")) cloned.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  if (!cloned.getAttribute("xmlns:xlink")) cloned.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");

  cloned.setAttribute("width", String(width));
  cloned.setAttribute("height", String(height));

  const bgRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  bgRect.setAttribute("x", "0");
  bgRect.setAttribute("y", "0");
  bgRect.setAttribute("width", String(width));
  bgRect.setAttribute("height", String(height));
  bgRect.setAttribute("fill", bg);
  cloned.insertBefore(bgRect, cloned.firstChild);

  const svgData = new XMLSerializer().serializeToString(cloned);
  const blob = new Blob([svgData], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const img = new Image();
  img.onload = () => {
    ctx.drawImage(img, 0, 0, width, height);

    URL.revokeObjectURL(url);

    const pngFile = canvas.toDataURL("image/png");
    const downloadLink = document.createElement("a");
    downloadLink.download = `${title.replace(/\s+/g, "_")}.png`;
    downloadLink.href = pngFile;
    downloadLink.click();
  };

  img.onerror = () => {
    URL.revokeObjectURL(url);
  };

  img.src = url;
};

const getSeriesValues = (data, keys) => {
  const out = [];
  for (const row of data || []) {
    for (const k of keys) {
      const v = row?.[k];
      if (Number.isFinite(Number(v))) out.push(Number(v));
    }
  }
  return out;
};

const niceStep = (rawStep) => {
  if (!Number.isFinite(rawStep) || rawStep <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const base = rawStep / pow;
  let niceBase = 1;
  if (base <= 1) niceBase = 1;
  else if (base <= 2) niceBase = 2;
  else if (base <= 5) niceBase = 5;
  else niceBase = 10;
  return niceBase * pow;
};

const floorTo = (x, step) => Math.floor(x / step) * step;
const ceilTo = (x, step) => Math.ceil(x / step) * step;

const buildTicks = (minV, maxV, targetCount) => {
  if (!Number.isFinite(minV) || !Number.isFinite(maxV)) return [];
  if (minV === maxV) return [minV];

  const span = maxV - minV;
  const raw = span / Math.max(2, targetCount - 1);
  const step = niceStep(raw);

  const start = floorTo(minV, step);
  const end = ceilTo(maxV, step);

  const ticks = [];
  for (let v = start; v <= end + step * 0.5; v += step) ticks.push(Number(v.toFixed(10)));

  if (ticks.length > targetCount + 3) {
    const skip = Math.ceil(ticks.length / targetCount);
    return ticks.filter((_, i) => i % skip === 0);
  }

  return ticks;
};

const buildXTicks = (data, targetCount) => {
  const xs = [];
  for (const row of data || []) {
    const t = row?.t;
    if (Number.isFinite(Number(t))) xs.push(Number(t));
  }
  if (xs.length === 0) return [];
  return buildTicks(Math.min(...xs), Math.max(...xs), targetCount);
};

const buildYTicksFromSeries = (data, keys, targetCount) => {
  const vals = getSeriesValues(data, keys);
  if (vals.length === 0) return { ticks: [], domain: ['auto', 'auto'] };
  const minV = Math.min(...vals);
  const maxV = Math.max(...vals);

  const span = maxV - minV || 1;
  const pad = span * 0.06;

  const ticks = buildTicks(minV - pad, maxV + pad, targetCount);
  if (ticks.length === 0) return { ticks: [], domain: ['auto', 'auto'] };

  return { ticks, domain: [ticks[0], ticks[ticks.length - 1]] };
};

const useViewport = () => {
  const [w, setW] = useState(() => (typeof window !== "undefined" ? window.innerWidth : 1024));
  useEffect(() => {
    const onResize = () => setW(window.innerWidth);
    window.addEventListener('resize', onResize, { passive: true });
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return w;
};

export default function App() {
  const [isDarkMode, setIsDarkMode] = useState(true);
  const [isSimulating, setIsSimulating] = useState(false);
  const [activeChartPage, setActiveChartPage] = useState(0);

  // ====== NEW PARAMS (P&ID v2) ======
  const [params, setParams] = useState({
    sim_s: 3600, dt: 1.0, noise: true,

    // setpoints
    sp_Ffeed: 50.0,
    sp_Tfeed: 120.0,
    sp_Treb: 165.0,
    sp_Tcond: 35.0,
    sp_Freflux: 50.0,
    sp_Lv201: 50.0,

    // PI tuning
    kpFIC101: 1.2, tiFIC101: 40,
    kpTIC101: 1.2, tiTIC101: 180,
    kpTIC102: 1.1, tiTIC102: 220,
    kpTIC201: 1.0, tiTIC201: 220,
    kpFIC201: 1.4, tiFIC201: 80,
    kpLIC201: 0.8, tiLIC201: 400,

    // gate knobs
    g_tt_low: 60.0,
    g_tt_high: 120.0,
    g_rho_low: 0.700,
    g_rho_high: 0.775,
    g_dTsub: 5.0,
    g_delay_on: 120,
    g_delay_off: 30,

    analyzerFail: true,
  });

  const [runParams, setRunParams] = useState(null);
  const [simData, setSimData] = useState([]);
  const [metrics, setMetrics] = useState(null);
  const [gateInfo, setGateInfo] = useState(null);
  const [eventLog, setEventLog] = useState([]);
  const [suiteResults, setSuiteResults] = useState(null);

  const workerRef = useRef(null);

  useEffect(() => {
    workerRef.current = new Worker(new URL('./sim.worker.js', import.meta.url), { type: 'module' });
    return () => {
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
    };
  }, []);

  const postToWorker = useCallback((payload) => {
    if (!workerRef.current) return;

    workerRef.current.onmessage = (ev) => {
      const p = ev?.data || {};
      if (p?.error) {
        setIsSimulating(false);
        return;
      }

      if (p.mode === "suite") {
        setSuiteResults(Array.isArray(p.suite) ? p.suite : []);
        setIsSimulating(false);
        return;
      }

      const chartData = Array.isArray(p.chartData) ? p.chartData : [];
      const m = Array.isArray(p.metrics) ? p.metrics : null;

      setSimData(chartData);
      setMetrics(m);
      setGateInfo(p.gate || null);
      setEventLog(Array.isArray(p.eventLog) ? p.eventLog : []);
      setSuiteResults(null);
      setIsSimulating(false);
    };

    workerRef.current.onerror = () => setIsSimulating(false);
    workerRef.current.postMessage(payload);
  }, []);

  const runSimulation = useCallback(async () => {
    setIsSimulating(true);
    await new Promise(r => setTimeout(r, 60));

    setRunParams({ ...params });
    setSimData([]);
    setMetrics(null);
    setGateInfo(null);
    setEventLog([]);
    setSuiteResults(null);

    postToWorker({ mode: "single", ...params });
  }, [params, postToWorker]);

  const runModeUji = useCallback(async () => {
    setIsSimulating(true);
    await new Promise(r => setTimeout(r, 60));

    setRunParams({ ...params });
    setSuiteResults(null);

    postToWorker({ mode: "suite", ...params });
  }, [params, postToWorker]);

  useEffect(() => { runSimulation(); }, []); // auto-run

  const handleParamChange = (key, val) => {
    if (key === "noise") {
      setParams(prev => ({ ...prev, noise: !!val }));
      return;
    }
    if (key === "analyzerFail") {
      setParams(prev => ({ ...prev, analyzerFail: !!val }));
      return;
    }
    setParams(prev => ({ ...prev, [key]: parseFloat(val) }));
  };

  const SliderControl = ({ label, id, min, max, step, val, unit = "" }) => (
    <div className="mb-3">
      <div className={`flex justify-between items-end gap-2 mb-1 ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`}>
        <label htmlFor={id} className="text-[11px] sm:text-xs leading-tight">{label}</label>
        <span className="text-teal-500 font-mono font-bold text-[11px] sm:text-xs whitespace-nowrap">
          {Number.isFinite(Number(val)) ? val : "-"} {unit}
        </span>
      </div>
      <input
        id={id} type="range" min={min} max={max} step={step} value={val}
        onChange={(e) => handleParamChange(id, e.target.value)}
        className="w-full h-1 bg-gray-300 dark:bg-gray-700 rounded-lg appearance-none cursor-pointer accent-teal-500 hover:accent-teal-400"
      />
    </div>
  );

  const ChartCard = ({ title, id, children }) => (
    <div
      className={`border rounded-xl p-1 shadow-sm h-[280px] sm:h-[320px] md:h-[400px] flex flex-col relative transition-colors duration-300
      ${isDarkMode ? 'bg-neutral-900 border-gray-800' : 'bg-white border-gray-200'}`}
      id={id}
    >
      <div className="px-3 py-2 sm:px-4 sm:py-3 flex justify-between items-center border-b border-gray-100 dark:border-gray-800">
        <div className={`text-xs sm:text-sm font-bold uppercase tracking-wide ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
          {title}
        </div>
        <button
          onClick={() => downloadChartAsPng(id, title)}
          className={`p-1.5 rounded-md transition-colors ${isDarkMode ? 'hover:bg-gray-700 text-gray-400' : 'hover:bg-gray-100 text-gray-500'}`}
          title="Unduh Grafik (PNG)"
          aria-label="Unduh grafik"
        >
          <Camera size={16} />
        </button>
      </div>
      <div className="flex-1 p-2">
        {children}
      </div>
    </div>
  );

  const CHART_PAGES = [
    { title: "Temperatures (TIC-101 & TIC-102)", charts: ["Tfeed", "Treb"] },
    { title: "Condenser & Top (TIC-201 & TT-106)", charts: ["Tcond", "TT106"] },
    { title: "Quality Gate (rho15 & ΔTsub)", charts: ["rho15", "dTsub"] },
    { title: "Flows & Level (FIC/LIC)", charts: ["Ffeed", "Lv201"] },
    { title: "Controller Outputs (MV %)", charts: ["outputs"] },
  ];

  const fmt = (v, digits = 2) => Number.isFinite(Number(v)) ? Number(v).toFixed(digits) : "-";

  const vw = useViewport();
  const isMobile = vw < 640;

  const X_TICK_TARGET = isMobile ? 5 : 7;
  const Y_TICK_TARGET = isMobile ? 5 : 6;

  const xTicks = useMemo(() => buildXTicks(simData, X_TICK_TARGET), [simData, X_TICK_TARGET]);

  const yTfeed = useMemo(() => buildYTicksFromSeries(simData, ["Tfeed", "SP_Tfeed"], Y_TICK_TARGET), [simData, Y_TICK_TARGET]);
  const yTreb  = useMemo(() => buildYTicksFromSeries(simData, ["Treb", "SP_Treb"], Y_TICK_TARGET), [simData, Y_TICK_TARGET]);
  const yTcond = useMemo(() => buildYTicksFromSeries(simData, ["Tcond", "SP_Tcond"], Y_TICK_TARGET), [simData, Y_TICK_TARGET]);
  const yTT106 = useMemo(() => buildYTicksFromSeries(simData, ["TT106"], Y_TICK_TARGET), [simData, Y_TICK_TARGET]);

  const yRho = useMemo(() => buildYTicksFromSeries(simData, ["rho15", "Gate_rho_low", "Gate_rho_high"], Y_TICK_TARGET), [simData, Y_TICK_TARGET]);
  const yDT  = useMemo(() => buildYTicksFromSeries(simData, ["dTsub", "Gate_dTsub_min"], Y_TICK_TARGET), [simData, Y_TICK_TARGET]);

  const yFfeed = useMemo(() => buildYTicksFromSeries(simData, ["Ffeed", "SP_Ffeed"], Y_TICK_TARGET), [simData, Y_TICK_TARGET]);
  const yLv = useMemo(() => buildYTicksFromSeries(simData, ["Lv201", "SP_Lv201"], Y_TICK_TARGET), [simData, Y_TICK_TARGET]);

  const yMV = useMemo(() => {
    const ticks = buildTicks(0, 100, isMobile ? 6 : 7);
    return { ticks, domain: [0, 100] };
  }, [isMobile]);

  const axisStroke = "#888";
  const tickStyle = { fontSize: isMobile ? 10 : 11 };
  const minTickGap = isMobile ? 18 : 22;

  return (
    <div className={`min-h-screen font-sans transition-colors duration-300 flex flex-col
      ${isDarkMode ? 'bg-neutral-950 text-gray-200 selection:bg-teal-900 selection:text-white' : 'bg-gray-50 text-gray-800 selection:bg-teal-100 selection:text-teal-900'}`}>

      <header className={`border-b sticky top-0 z-50 backdrop-blur-md transition-colors duration-300
        ${isDarkMode ? 'border-gray-800 bg-neutral-900/80' : 'border-gray-200 bg-white/80'}`}>
        <div className="w-full px-3 sm:px-4 lg:px-8 py-2 sm:py-3 flex justify-between items-center gap-2">
          <div className="flex items-center gap-2 sm:gap-4 min-w-0 flex-1">
            <div className={`w-9 h-9 sm:w-10 sm:h-10 md:w-12 md:h-12 rounded-xl flex items-center justify-center border shadow-sm flex-shrink-0
              ${isDarkMode ? 'bg-neutral-800 border-gray-700' : 'bg-white border-gray-200'}`}>
              <Logo19 className="w-5 h-5 sm:w-6 sm:h-6 md:w-8 md:h-8" />
            </div>

            <div className="min-w-0">
              <h1
                className={`!text-sm sm:!text-base md:!text-lg font-bold tracking-tight leading-tight
                ${isDarkMode ? 'text-white' : 'text-gray-900'}
                whitespace-nowrap truncate`}
              >
                PT. Aimtopindo
              </h1>

              <p className="text-[10px] sm:text-xs md:text-base text-teal-500 uppercase tracking-wider sm:tracking-widest font-bold leading-tight">
                Kelompok 19 DMPR
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
            <button
              onClick={() => setIsDarkMode(!isDarkMode)}
              className={`p-1.5 sm:p-2 rounded-full border transition-all
              ${isDarkMode ? 'bg-gray-800 border-gray-700 text-yellow-400' : 'bg-gray-100 border-gray-300 text-gray-600'}`}
              aria-label="Toggle theme"
            >
              {isDarkMode ? <Sun size={16} className="sm:hidden" /> : <Moon size={16} className="sm:hidden" />}
              {isDarkMode ? <Sun size={18} className="hidden sm:block" /> : <Moon size={18} className="hidden sm:block" />}
            </button>

            <button
              onClick={runModeUji}
              disabled={isSimulating}
              className={`flex items-center gap-2 px-3 sm:px-4 py-1.5 sm:py-2 rounded-full font-medium transition-all shadow-lg
                ${isSimulating
                  ? 'bg-gray-700 text-gray-400 cursor-not-allowed'
                  : 'bg-amber-500 hover:bg-amber-400 text-white hover:scale-105 shadow-amber-500/20'}`}
              aria-label="Run MODE UJI"
              title="Jalankan test suite (baseline, step tests, disturbance, analyzer fail)"
            >
              {isSimulating ? <RotateCcw className="w-4 h-4 animate-spin" /> : <BarChart3 className="w-4 h-4" />}
              <span className="hidden sm:inline">
                {isSimulating ? 'Running...' : 'Run MODE UJI'}
              </span>
            </button>

            <button
              onClick={runSimulation}
              disabled={isSimulating}
              className={`flex items-center gap-2 px-3 sm:px-4 md:px-6 py-1.5 sm:py-2 md:py-2.5 rounded-full font-medium transition-all shadow-lg
                ${isSimulating
                  ? 'bg-gray-700 text-gray-400 cursor-not-allowed'
                  : 'bg-teal-500 hover:bg-teal-400 text-white hover:scale-105 shadow-teal-500/20'}`}
              aria-label="Run simulation"
            >
              {isSimulating ? <RotateCcw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4 fill-current" />}
              <span className="hidden sm:inline">
                {isSimulating ? 'Running...' : 'Run Simulation'}
              </span>
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 w-full px-3 sm:px-4 lg:px-8 py-4 sm:py-6 grid grid-cols-1 lg:grid-cols-12 gap-4 sm:gap-6">

        <aside className="lg:col-span-3 space-y-4">

          <div className={`border rounded-xl p-4 sm:p-5 shadow-sm ${isDarkMode ? 'bg-neutral-900 border-gray-800' : 'bg-white border-gray-200'}`}>
            <div className={`flex items-center gap-2 mb-3 sm:mb-4 font-semibold border-b pb-2 ${isDarkMode ? 'text-white border-gray-800' : 'text-gray-900 border-gray-100'}`}>
              <Settings className="w-4 h-4 text-teal-500" />
              <span className="text-sm sm:text-base">Pengaturan Global</span>
            </div>

            <SliderControl label="Durasi (s)" id="sim_s" min={600} max={7200} step={300} val={params.sim_s} />
            <SliderControl label="Time Step (dt)" id="dt" min={0.5} max={2.0} step={0.5} val={params.dt} />

            <div className={`flex items-center justify-between mt-3 p-2 rounded ${isDarkMode ? 'bg-gray-800/50' : 'bg-gray-50 border border-gray-100'}`}>
              <label className={`text-[11px] sm:text-xs ${isDarkMode ? 'text-gray-300' : 'text-gray-600'}`}>Noise Pengukuran</label>
              <input
                type="checkbox"
                checked={!!params.noise}
                onChange={(e) => handleParamChange("noise", e.target.checked)}
                className="w-4 h-4 accent-teal-500"
              />
            </div>

            <div className={`flex items-center justify-between mt-2 p-2 rounded ${isDarkMode ? 'bg-gray-800/50' : 'bg-gray-50 border border-gray-100'}`}>
              <label className={`text-[11px] sm:text-xs ${isDarkMode ? 'text-gray-300' : 'text-gray-600'}`}>Inject Analyzer Fail</label>
              <input
                type="checkbox"
                checked={!!params.analyzerFail}
                onChange={(e) => handleParamChange("analyzerFail", e.target.checked)}
                className="w-4 h-4 accent-teal-500"
              />
            </div>
          </div>

          <div className={`border rounded-xl p-4 sm:p-5 shadow-sm ${isDarkMode ? 'bg-neutral-900 border-gray-800' : 'bg-white border-gray-200'}`}>
            <div className={`flex items-center gap-2 mb-3 sm:mb-4 font-semibold border-b pb-2 ${isDarkMode ? 'text-white border-gray-800' : 'text-gray-900 border-gray-100'}`}>
              <TrendingUp className="w-4 h-4 text-teal-500" />
              <span className="text-sm sm:text-base">Setpoints</span>
            </div>

            <SliderControl label="SP FIC-101 Feed Flow" id="sp_Ffeed" min={0} max={100} step={1} val={params.sp_Ffeed} />
            <SliderControl label="SP TIC-101 T_feed_out (°C)" id="sp_Tfeed" min={60} max={160} step={1} val={params.sp_Tfeed} />
            <SliderControl label="SP TIC-102 T_reboiler (°C)" id="sp_Treb" min={120} max={210} step={1} val={params.sp_Treb} />
            <SliderControl label="SP TIC-201 T_cond_out (°C)" id="sp_Tcond" min={20} max={70} step={1} val={params.sp_Tcond} />
            <SliderControl label="SP FIC-201 Reflux Flow" id="sp_Freflux" min={0} max={100} step={1} val={params.sp_Freflux} />
            <SliderControl label="SP LIC-201 V201 Level (%)" id="sp_Lv201" min={5} max={95} step={1} val={params.sp_Lv201} />
          </div>

          <div className={`border rounded-xl overflow-hidden shadow-sm flex flex-col max-h-[520px] sm:max-h-[600px] ${isDarkMode ? 'bg-neutral-900 border-gray-800' : 'bg-white border-gray-200'}`}>
            <div className={`p-3 sm:p-4 font-semibold flex items-center gap-2 border-b ${isDarkMode ? 'bg-gray-800/30 border-gray-800 text-white' : 'bg-gray-50 border-gray-100 text-gray-900'}`}>
              <BarChart3 className="w-4 h-4 text-teal-500" />
              <span className="text-sm sm:text-base">Tuning PI (Kp/Ti)</span>
            </div>

            <div className="p-3 sm:p-4 space-y-5 sm:space-y-6 overflow-y-auto custom-scrollbar flex-1">
              {[
                ['FIC-101 (Feed Flow)', 'kpFIC101', 'tiFIC101', 0.1, 6.0, 0.1, 10, 400, 5],
                ['TIC-101 (Preheater)', 'kpTIC101', 'tiTIC101', 0.1, 6.0, 0.1, 20, 800, 10],
                ['TIC-102 (Reboiler)', 'kpTIC102', 'tiTIC102', 0.1, 6.0, 0.1, 20, 1000, 10],
                ['TIC-201 (Condenser)', 'kpTIC201', 'tiTIC201', 0.1, 6.0, 0.1, 20, 1000, 10],
                ['FIC-201 (Reflux Flow)', 'kpFIC201', 'tiFIC201', 0.1, 6.0, 0.1, 10, 400, 5],
                ['LIC-201 (V201 Level - slow)', 'kpLIC201', 'tiLIC201', 0.1, 6.0, 0.1, 50, 2000, 25],
              ].map(([title, kId, tId, kMin, kMax, kStep, tMin, tMax, tStep], i) => (
                <div key={i} className={i > 0 ? "border-t pt-4 border-gray-700/30" : ""}>
                  <h4 className="text-[11px] sm:text-xs font-bold text-teal-500 uppercase mb-2">{title}</h4>

                  <SliderControl label="Kp" id={kId} min={kMin} max={kMax} step={kStep} val={params[kId]} />
                  <SliderControl label="Ti (s)" id={tId} min={tMin} max={tMax} step={tStep} val={params[tId]} />
                </div>
              ))}
            </div>
          </div>

          <div className={`border rounded-xl p-4 sm:p-5 shadow-sm ${isDarkMode ? 'bg-neutral-900 border-gray-800' : 'bg-white border-gray-200'}`}>
            <div className={`flex items-center gap-2 mb-3 sm:mb-4 font-semibold border-b pb-2 ${isDarkMode ? 'text-white border-gray-800' : 'text-gray-900 border-gray-100'}`}>
              <Info className="w-4 h-4 text-teal-500" />
              <span className="text-sm sm:text-base">Quality Gate</span>
            </div>

            <SliderControl label="TT-106 ON Low (°C)" id="g_tt_low" min={0} max={150} step={1} val={params.g_tt_low} />
            <SliderControl label="TT-106 ON High (°C)" id="g_tt_high" min={0} max={150} step={1} val={params.g_tt_high} />
            <SliderControl label="rho15 ON Low (g/cc)" id="g_rho_low" min={0.65} max={0.85} step={0.001} val={params.g_rho_low} />
            <SliderControl label="rho15 ON High (g/cc)" id="g_rho_high" min={0.65} max={0.85} step={0.001} val={params.g_rho_high} />
            <SliderControl label="ΔTsub Min (°C)" id="g_dTsub" min={0} max={20} step={0.5} val={params.g_dTsub} />
            <SliderControl label="Delay ON (s)" id="g_delay_on" min={0} max={600} step={10} val={params.g_delay_on} />
            <SliderControl label="Delay OFF (s)" id="g_delay_off" min={0} max={300} step={5} val={params.g_delay_off} />
          </div>
        </aside>

        <section className="lg:col-span-9 flex flex-col gap-4 sm:gap-6">

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6">
            {runParams && (
              <div className={`border rounded-xl overflow-hidden shadow-sm ${isDarkMode ? 'bg-neutral-900 border-gray-800' : 'bg-white border-gray-200'}`}>
                <div className={`p-3 border-b flex items-center gap-2 ${isDarkMode ? 'border-gray-800' : 'border-gray-100'}`}>
                  <FileText className="w-4 h-4 text-teal-500" />
                  <h3 className={`font-semibold text-sm ${isDarkMode ? 'text-white' : 'text-gray-900'}`}>Parameter (Input)</h3>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-[11px] sm:text-xs text-left">
                    <thead className={`${isDarkMode ? 'bg-gray-800 text-gray-400' : 'bg-gray-50 text-gray-600'} uppercase font-semibold`}>
                      <tr>
                        <th className="px-3 sm:px-4 py-2">Item</th>
                        <th className="px-3 sm:px-4 py-2">Nilai</th>
                      </tr>
                    </thead>
                    <tbody className={`divide-y ${isDarkMode ? 'divide-gray-800 text-gray-300' : 'divide-gray-100 text-gray-700'}`}>
                      {[
                        ["sim_s", runParams.sim_s],
                        ["dt", runParams.dt],
                        ["SP F_feed", runParams.sp_Ffeed],
                        ["SP T_feed_out", runParams.sp_Tfeed],
                        ["SP T_reboiler", runParams.sp_Treb],
                        ["SP T_cond_out", runParams.sp_Tcond],
                        ["SP F_reflux", runParams.sp_Freflux],
                        ["SP L_v201", runParams.sp_Lv201],
                        ["Analyzer fail", runParams.analyzerFail ? "ON" : "OFF"],
                      ].map(([n, v], i) => (
                        <tr key={i}>
                          <td className="px-3 sm:px-4 py-2 font-medium text-teal-500">{n}</td>
                          <td className="px-3 sm:px-4 py-2">{String(v)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="space-y-4">
              {gateInfo && (
                <div className={`border rounded-xl overflow-hidden shadow-sm ${isDarkMode ? 'bg-neutral-900 border-gray-800' : 'bg-white border-gray-200'}`}>
                  <div className={`p-3 border-b flex items-center gap-2 ${isDarkMode ? 'border-gray-800' : 'border-gray-100'}`}>
                    <Info className="w-4 h-4 text-teal-500" />
                    <h3 className={`font-semibold text-sm ${isDarkMode ? 'text-white' : 'text-gray-900'}`}>Ringkasan Gate</h3>
                  </div>
                  <div className="p-4 text-[11px] sm:text-xs">
                    <div className="flex justify-between">
                      <span className={isDarkMode ? 'text-gray-400' : 'text-gray-600'}>% waktu PRODUCT</span>
                      <span className="font-mono font-bold text-teal-500">{fmt(gateInfo.productPct, 1)}%</span>
                    </div>
                    <div className="flex justify-between mt-2">
                      <span className={isDarkMode ? 'text-gray-400' : 'text-gray-600'}>Jumlah switching</span>
                      <span className="font-mono font-bold">{gateInfo.switches}</span>
                    </div>
                  </div>
                </div>
              )}

              {metrics && (
                <div className={`border rounded-xl overflow-hidden shadow-sm ${isDarkMode ? 'bg-neutral-900 border-gray-800' : 'bg-white border-gray-200'}`}>
                  <div className={`p-3 border-b flex items-center gap-2 ${isDarkMode ? 'border-gray-800' : 'border-gray-100'}`}>
                    <BarChart3 className="w-4 h-4 text-teal-500" />
                    <h3 className={`font-semibold text-sm ${isDarkMode ? 'text-white' : 'text-gray-900'}`}>Kinerja Loop (Output)</h3>
                  </div>
                  <div className="overflow-x-auto max-h-[260px] custom-scrollbar">
                    <table className="w-full text-[11px] sm:text-xs text-left">
                      <thead className={`${isDarkMode ? 'bg-gray-800 text-gray-400' : 'bg-gray-50 text-gray-600'} uppercase font-semibold`}>
                        <tr>
                          <th className="px-3 sm:px-4 py-2">Loop</th>
                          <th className="px-3 sm:px-4 py-2">IAE</th>
                          <th className="px-3 sm:px-4 py-2">ITAE</th>
                          <th className="px-3 sm:px-4 py-2">OS (%)</th>
                          <th className="px-3 sm:px-4 py-2">Settling (s)</th>
                        </tr>
                      </thead>
                      <tbody className={`divide-y ${isDarkMode ? 'divide-gray-800 text-gray-300' : 'divide-gray-100 text-gray-700'}`}>
                        {metrics.map((row, idx) => (
                          <tr key={idx}>
                            <td className="px-3 sm:px-4 py-2 font-medium text-teal-500">{row.name}</td>
                            <td className="px-3 sm:px-4 py-2 font-mono">{fmt(row.IAE, 2)}</td>
                            <td className="px-3 sm:px-4 py-2 font-mono">{fmt(row.ITAE, 1)}</td>
                            <td className="px-3 sm:px-4 py-2 font-mono">{row.OvershootPct == null ? "-" : fmt(row.OvershootPct, 1)}</td>
                            <td className="px-3 sm:px-4 py-2 font-mono">{row.SettlingTime == null ? "-" : fmt(row.SettlingTime, 0)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          </div>

          {suiteResults && (
            <div className={`border rounded-xl overflow-hidden shadow-sm ${isDarkMode ? 'bg-neutral-900 border-gray-800' : 'bg-white border-gray-200'}`}>
              <div className={`p-3 border-b flex items-center gap-2 ${isDarkMode ? 'border-gray-800' : 'border-gray-100'}`}>
                <FileText className="w-4 h-4 text-teal-500" />
                <h3 className={`font-semibold text-sm ${isDarkMode ? 'text-white' : 'text-gray-900'}`}>MODE UJI — Ringkasan Test Suite</h3>
              </div>
              <div className="overflow-x-auto max-h-[260px] custom-scrollbar">
                <table className="w-full text-[11px] sm:text-xs text-left">
                  <thead className={`${isDarkMode ? 'bg-gray-800 text-gray-400' : 'bg-gray-50 text-gray-600'} uppercase font-semibold`}>
                    <tr>
                      <th className="px-3 sm:px-4 py-2">Test</th>
                      <th className="px-3 sm:px-4 py-2">% PRODUCT</th>
                      <th className="px-3 sm:px-4 py-2">Switches</th>
                      <th className="px-3 sm:px-4 py-2">Total IAE (norm)</th>
                    </tr>
                  </thead>
                  <tbody className={`divide-y ${isDarkMode ? 'divide-gray-800 text-gray-300' : 'divide-gray-100 text-gray-700'}`}>
                    {suiteResults.map((r, idx) => (
                      <tr key={idx}>
                        <td className="px-3 sm:px-4 py-2 font-medium text-teal-500">{r.name}</td>
                        <td className="px-3 sm:px-4 py-2 font-mono">{fmt(r.gate?.productPct, 1)}%</td>
                        <td className="px-3 sm:px-4 py-2 font-mono">{r.gate?.switches ?? "-"}</td>
                        <td className="px-3 sm:px-4 py-2 font-mono">{fmt(r.totalIAE, 2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className={`px-4 py-3 text-[11px] sm:text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                Interpretasi cepat: <span className="text-teal-500 font-semibold">switches rendah</span> = gate tidak “chattering”,
                dan <span className="text-teal-500 font-semibold">Total IAE lebih kecil</span> = tracking agregat lebih rapih.
              </div>
            </div>
          )}

          {eventLog?.length > 0 && (
            <div className={`border rounded-xl overflow-hidden shadow-sm ${isDarkMode ? 'bg-neutral-900 border-gray-800' : 'bg-white border-gray-200'}`}>
              <div className={`p-3 border-b flex items-center gap-2 ${isDarkMode ? 'border-gray-800' : 'border-gray-100'}`}>
                <Info className="w-4 h-4 text-teal-500" />
                <h3 className={`font-semibold text-sm ${isDarkMode ? 'text-white' : 'text-gray-900'}`}>Event Log (Gate & Interlock)</h3>
              </div>
              <div className="max-h-[200px] overflow-y-auto custom-scrollbar p-3 text-[11px] sm:text-xs font-mono">
                {eventLog.slice(0, 120).map((x, i) => (
                  <div key={i} className={`${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                    [t={fmt(x.t, 1)}s] {x.msg}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex-1 flex flex-col">
            <div className="flex justify-between items-center mb-3 sm:mb-4 gap-3">
              <h2 className={`text-base sm:text-lg font-bold ${isDarkMode ? 'text-white' : 'text-gray-800'} leading-tight`}>
                Grafik Simulasi: <span className="text-teal-500">{CHART_PAGES[activeChartPage].title}</span>
              </h2>

              <div className="flex gap-2 items-center flex-shrink-0">
                <button
                  onClick={() => setActiveChartPage(p => Math.max(0, p - 1))}
                  disabled={activeChartPage === 0}
                  className={`p-2 rounded-lg border flex items-center gap-1 text-xs sm:text-sm font-medium transition-colors
                    ${isDarkMode ? 'border-gray-700 hover:bg-gray-800 disabled:opacity-30' : 'border-gray-200 hover:bg-gray-100 disabled:opacity-30'}`}
                  aria-label="Prev page"
                >
                  <ChevronLeft size={16} />
                  <span className="hidden sm:inline">Prev</span>
                </button>

                <div className="hidden sm:flex items-center gap-1 px-1">
                  {CHART_PAGES.map((_, idx) => (
                    <div
                      key={idx}
                      className={`h-2 rounded-full transition-all ${activeChartPage === idx ? 'bg-teal-500 w-4' : 'bg-gray-500 w-2'}`}
                    />
                  ))}
                </div>

                <button
                  onClick={() => setActiveChartPage(p => Math.min(CHART_PAGES.length - 1, p + 1))}
                  disabled={activeChartPage === CHART_PAGES.length - 1}
                  className={`p-2 rounded-lg border flex items-center gap-1 text-xs sm:text-sm font-medium transition-colors
                    ${isDarkMode ? 'border-gray-700 hover:bg-gray-800 disabled:opacity-30' : 'border-gray-200 hover:bg-gray-100 disabled:opacity-30'}`}
                  aria-label="Next page"
                >
                  <span className="hidden sm:inline">Next</span>
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:gap-6 animate-fadeIn">
              {activeChartPage === 0 && (
                <>
                  <ChartCard title="TIC-101: T_feed_out (°C)" id="chart-tfeed">
                    <ResponsiveContainer>
                      <LineChart data={simData}>
                        <CartesianGrid strokeDasharray="3 3" stroke={isDarkMode ? "#333" : "#eee"} />
                        <XAxis dataKey="t" stroke={axisStroke} ticks={xTicks} interval={0} minTickGap={minTickGap} tick={tickStyle} />
                        <YAxis stroke={axisStroke} ticks={yTfeed.ticks} domain={yTfeed.domain} interval={0} minTickGap={minTickGap} tick={tickStyle} />
                        <RechartsTooltip contentStyle={{ backgroundColor: isDarkMode ? '#111' : '#fff', borderColor: isDarkMode ? '#333' : '#ddd' }} />
                        <Legend />
                        <Line type="monotone" dataKey="Tfeed" stroke="#2dd4bf" strokeWidth={2} dot={false} isAnimationActive={false} name="PV" />
                        <Line type="step" dataKey="SP_Tfeed" stroke="#9ca3af" strokeDasharray="4 4" dot={false} isAnimationActive={false} name="SP" />
                      </LineChart>
                    </ResponsiveContainer>
                  </ChartCard>

                  <ChartCard title="TIC-102: T_reboiler (°C)" id="chart-treb">
                    <ResponsiveContainer>
                      <LineChart data={simData}>
                        <CartesianGrid strokeDasharray="3 3" stroke={isDarkMode ? "#333" : "#eee"} />
                        <XAxis dataKey="t" stroke={axisStroke} ticks={xTicks} interval={0} minTickGap={minTickGap} tick={tickStyle} />
                        <YAxis stroke={axisStroke} ticks={yTreb.ticks} domain={yTreb.domain} interval={0} minTickGap={minTickGap} tick={tickStyle} />
                        <RechartsTooltip contentStyle={{ backgroundColor: isDarkMode ? '#111' : '#fff', borderColor: isDarkMode ? '#333' : '#ddd' }} />
                        <Legend />
                        <Line type="monotone" dataKey="Treb" stroke="#2dd4bf" strokeWidth={2} dot={false} isAnimationActive={false} name="PV" />
                        <Line type="step" dataKey="SP_Treb" stroke="#9ca3af" strokeDasharray="4 4" dot={false} isAnimationActive={false} name="SP" />
                      </LineChart>
                    </ResponsiveContainer>
                  </ChartCard>
                </>
              )}

              {activeChartPage === 1 && (
                <>
                  <ChartCard title="TIC-201: T_cond_out (°C)" id="chart-tcond">
                    <ResponsiveContainer>
                      <LineChart data={simData}>
                        <CartesianGrid strokeDasharray="3 3" stroke={isDarkMode ? "#333" : "#eee"} />
                        <XAxis dataKey="t" stroke={axisStroke} ticks={xTicks} interval={0} minTickGap={minTickGap} tick={tickStyle} />
                        <YAxis stroke={axisStroke} ticks={yTcond.ticks} domain={yTcond.domain} interval={0} minTickGap={minTickGap} tick={tickStyle} />
                        <RechartsTooltip contentStyle={{ backgroundColor: isDarkMode ? '#111' : '#fff', borderColor: isDarkMode ? '#333' : '#ddd' }} />
                        <Legend />
                        <Line type="monotone" dataKey="Tcond" stroke="#2dd4bf" strokeWidth={2} dot={false} isAnimationActive={false} name="PV" />
                        <Line type="step" dataKey="SP_Tcond" stroke="#9ca3af" strokeDasharray="4 4" dot={false} isAnimationActive={false} name="SP" />
                      </LineChart>
                    </ResponsiveContainer>
                  </ChartCard>

                  <ChartCard title="TT-106 (Top Temperature Proxy)" id="chart-tt106">
                    <ResponsiveContainer>
                      <LineChart data={simData}>
                        <CartesianGrid strokeDasharray="3 3" stroke={isDarkMode ? "#333" : "#eee"} />
                        <XAxis dataKey="t" stroke={axisStroke} ticks={xTicks} interval={0} minTickGap={minTickGap} tick={tickStyle} />
                        <YAxis stroke={axisStroke} ticks={yTT106.ticks} domain={yTT106.domain} interval={0} minTickGap={minTickGap} tick={tickStyle} />
                        <RechartsTooltip contentStyle={{ backgroundColor: isDarkMode ? '#111' : '#fff', borderColor: isDarkMode ? '#333' : '#ddd' }} />
                        <Legend />
                        <Line type="monotone" dataKey="TT106" stroke="#a78bfa" strokeWidth={2} dot={false} isAnimationActive={false} name="TT106" />
                      </LineChart>
                    </ResponsiveContainer>
                  </ChartCard>
                </>
              )}

              {activeChartPage === 2 && (
                <>
                  <ChartCard title="AT-201: rho15 (g/cc) + band" id="chart-rho15">
                    <ResponsiveContainer>
                      <LineChart data={simData}>
                        <CartesianGrid strokeDasharray="3 3" stroke={isDarkMode ? "#333" : "#eee"} />
                        <XAxis dataKey="t" stroke={axisStroke} ticks={xTicks} interval={0} minTickGap={minTickGap} tick={tickStyle} />
                        <YAxis
                          stroke={axisStroke}
                          ticks={yRho.ticks}
                          domain={yRho.domain}
                          interval={0}
                          minTickGap={minTickGap}
                          tick={tickStyle}
                          tickFormatter={(v) => Number(v).toFixed(3)}
                        />
                        <RechartsTooltip contentStyle={{ backgroundColor: isDarkMode ? '#111' : '#fff', borderColor: isDarkMode ? '#333' : '#ddd' }} />
                        <Legend />
                        <Line type="monotone" dataKey="rho15" stroke="#f472b6" strokeWidth={2} dot={false} isAnimationActive={false} name="rho15" />
                        <Line type="step" dataKey="Gate_rho_low" stroke="#9ca3af" strokeDasharray="4 4" dot={false} isAnimationActive={false} name="Gate Low" />
                        <Line type="step" dataKey="Gate_rho_high" stroke="#9ca3af" strokeDasharray="4 4" dot={false} isAnimationActive={false} name="Gate High" />
                      </LineChart>
                    </ResponsiveContainer>
                  </ChartCard>

                  <ChartCard title="ΔTsub = TT201 - T_cond_out (°C) + threshold" id="chart-dtsub">
                    <ResponsiveContainer>
                      <LineChart data={simData}>
                        <CartesianGrid strokeDasharray="3 3" stroke={isDarkMode ? "#333" : "#eee"} />
                        <XAxis dataKey="t" stroke={axisStroke} ticks={xTicks} interval={0} minTickGap={minTickGap} tick={tickStyle} />
                        <YAxis stroke={axisStroke} ticks={yDT.ticks} domain={yDT.domain} interval={0} minTickGap={minTickGap} tick={tickStyle} />
                        <RechartsTooltip contentStyle={{ backgroundColor: isDarkMode ? '#111' : '#fff', borderColor: isDarkMode ? '#333' : '#ddd' }} />
                        <Legend />
                        <Line type="monotone" dataKey="dTsub" stroke="#2dd4bf" strokeWidth={2} dot={false} isAnimationActive={false} name="ΔTsub" />
                        <Line type="step" dataKey="Gate_dTsub_min" stroke="#9ca3af" strokeDasharray="4 4" dot={false} isAnimationActive={false} name="Gate Min" />
                        <Line type="step" dataKey="route" stroke="#facc15" strokeWidth={2} dot={false} isAnimationActive={false} name="Route (0/1)" />
                      </LineChart>
                    </ResponsiveContainer>
                  </ChartCard>
                </>
              )}

              {activeChartPage === 3 && (
                <>
                  <ChartCard title="FIC-101: Feed Flow" id="chart-ffeed">
                    <ResponsiveContainer>
                      <LineChart data={simData}>
                        <CartesianGrid strokeDasharray="3 3" stroke={isDarkMode ? "#333" : "#eee"} />
                        <XAxis dataKey="t" stroke={axisStroke} ticks={xTicks} interval={0} minTickGap={minTickGap} tick={tickStyle} />
                        <YAxis stroke={axisStroke} ticks={yFfeed.ticks} domain={yFfeed.domain} interval={0} minTickGap={minTickGap} tick={tickStyle} />
                        <RechartsTooltip contentStyle={{ backgroundColor: isDarkMode ? '#111' : '#fff', borderColor: isDarkMode ? '#333' : '#ddd' }} />
                        <Legend />
                        <Line type="monotone" dataKey="Ffeed" stroke="#2dd4bf" strokeWidth={2} dot={false} isAnimationActive={false} name="PV" />
                        <Line type="step" dataKey="SP_Ffeed" stroke="#9ca3af" strokeDasharray="4 4" dot={false} isAnimationActive={false} name="SP" />
                      </LineChart>
                    </ResponsiveContainer>
                  </ChartCard>

                  <ChartCard title="LIC-201: V201 Level (%)" id="chart-lv201">
                    <ResponsiveContainer>
                      <LineChart data={simData}>
                        <CartesianGrid strokeDasharray="3 3" stroke={isDarkMode ? "#333" : "#eee"} />
                        <XAxis dataKey="t" stroke={axisStroke} ticks={xTicks} interval={0} minTickGap={minTickGap} tick={tickStyle} />
                        <YAxis stroke={axisStroke} ticks={yLv.ticks} domain={yLv.domain} interval={0} minTickGap={minTickGap} tick={tickStyle} />
                        <RechartsTooltip contentStyle={{ backgroundColor: isDarkMode ? '#111' : '#fff', borderColor: isDarkMode ? '#333' : '#ddd' }} />
                        <Legend />
                        <Line type="monotone" dataKey="Lv201" stroke="#a78bfa" strokeWidth={2} dot={false} isAnimationActive={false} name="PV" />
                        <Line type="step" dataKey="SP_Lv201" stroke="#9ca3af" strokeDasharray="4 4" dot={false} isAnimationActive={false} name="SP" />
                      </LineChart>
                    </ResponsiveContainer>
                  </ChartCard>
                </>
              )}

              {activeChartPage === 4 && (
                <ChartCard title="Controller Outputs (MV %)" id="chart-mv">
                  <ResponsiveContainer>
                    <LineChart data={simData}>
                      <CartesianGrid strokeDasharray="3 3" stroke={isDarkMode ? "#333" : "#eee"} />
                      <XAxis dataKey="t" stroke={axisStroke} ticks={xTicks} interval={0} minTickGap={minTickGap} tick={tickStyle} />
                      <YAxis stroke={axisStroke} ticks={yMV.ticks} domain={yMV.domain} interval={0} minTickGap={minTickGap} tick={tickStyle} />
                      <RechartsTooltip contentStyle={{ backgroundColor: isDarkMode ? '#111' : '#fff', borderColor: isDarkMode ? '#333' : '#ddd' }} />
                      <Legend />
                      <Line type="monotone" dataKey="u_feed" stroke="#3b82f6" strokeWidth={1} dot={false} isAnimationActive={false} name="u_feed" />
                      <Line type="monotone" dataKey="u_steam_pre" stroke="#facc15" strokeWidth={1} dot={false} isAnimationActive={false} name="u_steam_pre" />
                      <Line type="monotone" dataKey="u_steam_reb" stroke="#fb7185" strokeWidth={1} dot={false} isAnimationActive={false} name="u_steam_reb" />
                      <Line type="monotone" dataKey="u_cw" stroke="#22c55e" strokeWidth={1} dot={false} isAnimationActive={false} name="u_cw" />
                      <Line type="monotone" dataKey="u_reflux" stroke="#a78bfa" strokeWidth={1} dot={false} isAnimationActive={false} name="u_reflux" />
                      <Line type="monotone" dataKey="u_draw" stroke="#f472b6" strokeWidth={1} dot={false} isAnimationActive={false} name="u_draw" />
                    </LineChart>
                  </ResponsiveContainer>
                </ChartCard>
              )}
            </div>
          </div>
        </section>
      </main>

      <footer className={`border-t py-5 sm:py-6 mt-auto transition-colors duration-300
        ${isDarkMode ? 'bg-neutral-900 border-gray-800 text-gray-500' : 'bg-white border-gray-200 text-gray-400'}`}>
        <div className="w-full px-3 sm:px-4 lg:px-8 flex flex-col md:flex-row justify-between items-center gap-3 sm:gap-4">
          <div className="flex items-center gap-3">
            <div className="opacity-50 grayscale hover:grayscale-0 transition-all">
              <Logo19 className="w-7 h-7 sm:w-8 sm:h-8" />
            </div>
            <p className="text-xs sm:text-sm font-medium">© 2026 Kelompok 19 DMPR. All rights reserved.</p>
          </div>
          <div className="flex flex-col sm:flex-row gap-1 sm:gap-6 text-xs sm:text-sm text-center">
            <span>Client: PT. Aimtopindo</span>
            <span>Project: Destilasi Biohidrokarbon Semi-Continuous | PI Control + Quality Gate</span>
          </div>
        </div>
      </footer>
    </div>
  );
}