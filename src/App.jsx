import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Play, RotateCcw, Settings, TrendingUp, BarChart3, Info, Sun, Moon, FileText, ChevronLeft, ChevronRight, Camera } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend, ResponsiveContainer } from 'recharts';

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
  const svg = document.querySelector(`#${chartId} .recharts-surface`);
  if (!svg) return;

  const svgData = new XMLSerializer().serializeToString(svg);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const img = new Image();

  const svgSize = svg.getBoundingClientRect();
  canvas.width = svgSize.width;
  canvas.height = svgSize.height;

  img.onload = () => {
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
  for (let v = start; v <= end + step * 0.5; v += step) {
    const vv = Number(v.toFixed(10));
    ticks.push(vv);
  }

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
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  return buildTicks(minX, maxX, targetCount);
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

  const domainMin = ticks[0];
  const domainMax = ticks[ticks.length - 1];
  return { ticks, domain: [domainMin, domainMax] };
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

  const [runParams, setRunParams] = useState(null);
  const [simData, setSimData] = useState([]);
  const [metrics, setMetrics] = useState(null);

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

  const runSimulation = useCallback(async () => {
    setIsSimulating(true);
    await new Promise(r => setTimeout(r, 100));

    setRunParams({ ...params });
    setSimData([]);
    setMetrics(null);

    if (!workerRef.current) {
      setIsSimulating(false);
      return;
    }

    workerRef.current.onmessage = (ev) => {
      const payload = ev?.data || {};
      const chartData = Array.isArray(payload.chartData) ? payload.chartData : [];
      const m = Array.isArray(payload.metrics) ? payload.metrics : null;

      setSimData(chartData);
      setMetrics(m);
      setIsSimulating(false);
    };

    workerRef.current.onerror = () => {
      setIsSimulating(false);
    };

    workerRef.current.postMessage({ ...params });
  }, [params]);

  useEffect(() => { runSimulation(); }, []);

  const handleParamChange = (key, val) => setParams(prev => ({ ...prev, [key]: parseFloat(val) }));

  const SliderControl = ({ label, id, min, max, step, val, unit = "" }) => (
    <div className="mb-3">
      <div className={`flex justify-between items-end gap-2 mb-1 ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`}>
        <label htmlFor={id} className="text-[11px] sm:text-xs leading-tight">{label}</label>
        <span className="text-teal-500 font-mono font-bold text-[11px] sm:text-xs whitespace-nowrap">
          {val} {unit}
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
    { title: "Temperatures (E-101 & C-201)", charts: ["Tfeed", "Tcond"] },
    { title: "Quality & Reflux", charts: ["rho", "Freflux"] },
    { title: "Controller Outputs (MV)", charts: ["outputs"] }
  ];

  const fmt = (v, digits = 1) => Number.isFinite(Number(v)) ? Number(v).toFixed(digits) : "-";

  const vw = useViewport();
  const isMobile = vw < 640;

  const X_TICK_TARGET = isMobile ? 5 : 7;
  const Y_TICK_TARGET = isMobile ? 5 : 6;

  const xTicks = useMemo(() => buildXTicks(simData, X_TICK_TARGET), [simData, X_TICK_TARGET]);

  const yTfeed = useMemo(
    () => buildYTicksFromSeries(simData, ["Tfeed", "SP_Tfeed"], Y_TICK_TARGET),
    [simData, Y_TICK_TARGET]
  );
  const yTcond = useMemo(
    () => buildYTicksFromSeries(simData, ["Tcond", "SP_Tcond"], Y_TICK_TARGET),
    [simData, Y_TICK_TARGET]
  );
  const yRho = useMemo(
    () => buildYTicksFromSeries(simData, ["rho", "SP_rho"], Y_TICK_TARGET),
    [simData, Y_TICK_TARGET]
  );
  const yFlow = useMemo(
    () => buildYTicksFromSeries(simData, ["Freflux", "SP_reflux"], Y_TICK_TARGET),
    [simData, Y_TICK_TARGET]
  );

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

          <div className="flex items-center gap-2 sm:gap-4 flex-shrink-0">
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
            <SliderControl label="Durasi (s)" id="sim_s" min={1800} max={7200} step={300} val={params.sim_s} />
            <SliderControl label="Time Step (dt)" id="dt" min={0.5} max={2.0} step={0.5} val={params.dt} />
            <div className={`flex items-center justify-between mt-4 p-2 rounded ${isDarkMode ? 'bg-gray-800/50' : 'bg-gray-50 border border-gray-100'}`}>
              <label className={`text-[11px] sm:text-xs ${isDarkMode ? 'text-gray-300' : 'text-gray-600'}`}>Aktifkan Pressure Loop</label>
              <input
                type="checkbox"
                checked={params.enableP}
                onChange={(e) => setParams({ ...params, enableP: e.target.checked })}
                className="w-4 h-4 accent-teal-500"
              />
            </div>
          </div>

          <div className={`border rounded-xl p-4 sm:p-5 shadow-sm ${isDarkMode ? 'bg-neutral-900 border-gray-800' : 'bg-white border-gray-200'}`}>
            <div className={`flex items-center gap-2 mb-3 sm:mb-4 font-semibold border-b pb-2 ${isDarkMode ? 'text-white border-gray-800' : 'text-gray-900 border-gray-100'}`}>
              <TrendingUp className="w-4 h-4 text-teal-500" />
              <span className="text-sm sm:text-base">Setpoints</span>
            </div>
            <SliderControl label="SP Feed Temp (°C)" id="sp_Tfeed" min={90} max={150} step={1} val={params.sp_Tfeed} />
            <SliderControl label="SP Cond Temp (°C)" id="sp_Tcond" min={30} max={70} step={1} val={params.sp_Tcond} />
            <SliderControl label="SP Density (g/cc)" id="sp_rho" min={0.70} max={0.80} step={0.0005} val={params.sp_rho} />
          </div>

          <div className={`border rounded-xl overflow-hidden shadow-sm flex flex-col max-h-[520px] sm:max-h-[600px] ${isDarkMode ? 'bg-neutral-900 border-gray-800' : 'bg-white border-gray-200'}`}>
            <div className={`p-3 sm:p-4 font-semibold flex items-center gap-2 border-b ${isDarkMode ? 'bg-gray-800/30 border-gray-800 text-white' : 'bg-gray-50 border-gray-100 text-gray-900'}`}>
              <BarChart3 className="w-4 h-4 text-teal-500" />
              <span className="text-sm sm:text-base">Tuning PID</span>
            </div>
            <div className="p-3 sm:p-4 space-y-5 sm:space-y-6 overflow-y-auto custom-scrollbar flex-1">
              {['TIC-101 (Preheater)|kp101|ti101', 'TIC-201 (Condenser)|kp201|ti201', 'AIC-201 (Density)|kpa|tia', 'FIC-201 (Reflux Flow)|kpf|tif', 'PIC-201 (Pressure)|kpp|tip'].map((grp, i) => {
                const [title, kId, tId] = grp.split('|');
                return (
                  <div key={i} className={i > 0 ? "border-t pt-4 border-gray-700/30" : ""}>
                    <h4 className="text-[11px] sm:text-xs font-bold text-teal-500 uppercase mb-2">{title}</h4>
                    <SliderControl
                      label="Kp"
                      id={kId}
                      min={kId.includes('kpa') ? 50 : 0.2}
                      max={kId.includes('kpa') ? 2000 : 10.0}
                      step={kId.includes('kpa') ? 50 : 0.1}
                      val={params[kId]}
                    />
                    <SliderControl
                      label="Ti (s)"
                      id={tId}
                      min={20}
                      max={kId.includes('kpa') ? 2500 : 600}
                      step={10}
                      val={params[tId]}
                    />
                  </div>
                )
              })}
            </div>
          </div>
        </aside>

        <section className="lg:col-span-9 flex flex-col gap-4 sm:gap-6">

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6">
            {runParams && (
              <div className={`border rounded-xl overflow-hidden shadow-sm ${isDarkMode ? 'bg-neutral-900 border-gray-800' : 'bg-white border-gray-200'}`}>
                <div className={`p-3 border-b flex items-center gap-2 ${isDarkMode ? 'border-gray-800' : 'border-gray-100'}`}>
                  <FileText className="w-4 h-4 text-teal-500" />
                  <h3 className={`font-semibold text-sm ${isDarkMode ? 'text-white' : 'text-gray-900'}`}>Tabel Parameter (Input)</h3>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-[11px] sm:text-xs text-left">
                    <thead className={`${isDarkMode ? 'bg-gray-800 text-gray-400' : 'bg-gray-50 text-gray-600'} uppercase font-semibold`}>
                      <tr>
                        <th className="px-3 sm:px-4 py-2">Loop</th>
                        <th className="px-3 sm:px-4 py-2">Kp</th>
                        <th className="px-3 sm:px-4 py-2">Ti</th>
                      </tr>
                    </thead>
                    <tbody className={`divide-y ${isDarkMode ? 'divide-gray-800 text-gray-300' : 'divide-gray-100 text-gray-700'}`}>
                      {[
                        ["TIC-101", runParams.kp101, runParams.ti101],
                        ["TIC-201", runParams.kp201, runParams.ti201],
                        ["FIC-201", runParams.kpf, runParams.tif],
                        ["AIC-201", runParams.kpa, runParams.tia],
                        ["PIC-201", runParams.kpp, runParams.tip]
                      ].map(([n, k, t], i) => (
                        <tr key={i}>
                          <td className="px-3 sm:px-4 py-2 font-medium text-teal-500">{n}</td>
                          <td className="px-3 sm:px-4 py-2">{k}</td>
                          <td className="px-3 sm:px-4 py-2">{t}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {metrics && (
              <div className={`border rounded-xl overflow-hidden shadow-sm ${isDarkMode ? 'bg-neutral-900 border-gray-800' : 'bg-white border-gray-200'}`}>
                <div className={`p-3 border-b flex items-center gap-2 ${isDarkMode ? 'border-gray-800' : 'border-gray-100'}`}>
                  <Info className="w-4 h-4 text-teal-500" />
                  <h3 className={`font-semibold text-sm ${isDarkMode ? 'text-white' : 'text-gray-900'}`}>Tabel Kinerja (Output)</h3>
                </div>
                <div className="overflow-x-auto max-h-[200px] custom-scrollbar">
                  <table className="w-full text-[11px] sm:text-xs text-left">
                    <thead className={`${isDarkMode ? 'bg-gray-800 text-gray-400' : 'bg-gray-50 text-gray-600'} uppercase font-semibold`}>
                      <tr>
                        <th className="px-3 sm:px-4 py-2">Loop</th>
                        <th className="px-3 sm:px-4 py-2">IAE</th>
                        <th className="px-3 sm:px-4 py-2">Settling (s)</th>
                      </tr>
                    </thead>
                    <tbody className={`divide-y ${isDarkMode ? 'divide-gray-800 text-gray-300' : 'divide-gray-100 text-gray-700'}`}>
                      {metrics.map((row, idx) => (
                        <tr key={idx}>
                          <td className="px-3 sm:px-4 py-2 font-medium text-teal-500">{row.name.split(' ')[0]}</td>
                          <td className="px-3 sm:px-4 py-2">{fmt(row.IAE, 1)}</td>
                          <td className="px-3 sm:px-4 py-2">{fmt(row.SettlingTime, 0)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

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
                  <ChartCard title="E-101: Feed Temp (°C)" id="chart-tfeed">
                    <ResponsiveContainer>
                      <LineChart data={simData}>
                        <CartesianGrid strokeDasharray="3 3" stroke={isDarkMode ? "#333" : "#eee"} />
                        <XAxis
                          dataKey="t"
                          stroke={axisStroke}
                          ticks={xTicks}
                          interval={0}
                          minTickGap={minTickGap}
                          tick={tickStyle}
                          tickLine={{ stroke: axisStroke }}
                          axisLine={{ stroke: axisStroke }}
                        />
                        <YAxis
                          stroke={axisStroke}
                          ticks={yTfeed.ticks}
                          domain={yTfeed.domain}
                          interval={0}
                          minTickGap={minTickGap}
                          tick={tickStyle}
                          tickLine={{ stroke: axisStroke }}
                          axisLine={{ stroke: axisStroke }}
                        />
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
                        <XAxis
                          dataKey="t"
                          stroke={axisStroke}
                          ticks={xTicks}
                          interval={0}
                          minTickGap={minTickGap}
                          tick={tickStyle}
                          tickLine={{ stroke: axisStroke }}
                          axisLine={{ stroke: axisStroke }}
                        />
                        <YAxis
                          stroke={axisStroke}
                          ticks={yTcond.ticks}
                          domain={yTcond.domain}
                          interval={0}
                          minTickGap={minTickGap}
                          tick={tickStyle}
                          tickLine={{ stroke: axisStroke }}
                          axisLine={{ stroke: axisStroke }}
                        />
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
                        <XAxis
                          dataKey="t"
                          stroke={axisStroke}
                          ticks={xTicks}
                          interval={0}
                          minTickGap={minTickGap}
                          tick={tickStyle}
                          tickLine={{ stroke: axisStroke }}
                          axisLine={{ stroke: axisStroke }}
                        />
                        <YAxis
                          stroke={axisStroke}
                          ticks={yRho.ticks}
                          domain={yRho.domain}
                          interval={0}
                          minTickGap={minTickGap}
                          tick={tickStyle}
                          tickLine={{ stroke: axisStroke }}
                          axisLine={{ stroke: axisStroke }}
                          tickFormatter={(v) => Number(v).toFixed(3)}
                        />
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
                        <XAxis
                          dataKey="t"
                          stroke={axisStroke}
                          ticks={xTicks}
                          interval={0}
                          minTickGap={minTickGap}
                          tick={tickStyle}
                          tickLine={{ stroke: axisStroke }}
                          axisLine={{ stroke: axisStroke }}
                        />
                        <YAxis
                          stroke={axisStroke}
                          ticks={yFlow.ticks}
                          domain={yFlow.domain}
                          interval={0}
                          minTickGap={minTickGap}
                          tick={tickStyle}
                          tickLine={{ stroke: axisStroke }}
                          axisLine={{ stroke: axisStroke }}
                        />
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
                <ChartCard title="Controller Outputs (MV %)" id="chart-mv">
                  <ResponsiveContainer>
                    <LineChart data={simData}>
                      <CartesianGrid strokeDasharray="3 3" stroke={isDarkMode ? "#333" : "#eee"} />
                      <XAxis
                        dataKey="t"
                        stroke={axisStroke}
                        ticks={xTicks}
                        interval={0}
                        minTickGap={minTickGap}
                        tick={tickStyle}
                        tickLine={{ stroke: axisStroke }}
                        axisLine={{ stroke: axisStroke }}
                      />
                      <YAxis
                        stroke={axisStroke}
                        ticks={yMV.ticks}
                        domain={yMV.domain}
                        interval={0}
                        minTickGap={minTickGap}
                        tick={tickStyle}
                        tickLine={{ stroke: axisStroke }}
                        axisLine={{ stroke: axisStroke }}
                      />
                      <RechartsTooltip contentStyle={{ backgroundColor: isDarkMode ? '#111' : '#fff', borderColor: isDarkMode ? '#333' : '#ddd', color: isDarkMode ? '#fff' : '#000' }} />
                      <Legend />
                      <Line type="monotone" dataKey="u_steam" stroke="#facc15" strokeWidth={1} dot={false} isAnimationActive={false} name="Steam %" />
                      <Line type="monotone" dataKey="u_cw" stroke="#3b82f6" strokeWidth={1} dot={false} isAnimationActive={false} name="CW %" />
                      <Line type="monotone" dataKey="u_fv" stroke="#a78bfa" strokeWidth={1} dot={false} isAnimationActive={false} name="Reflux Valve %" />
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
            <span>Project: Destilasi Biohidrokarbon Semi-Continuous | PID Control</span>
          </div>
        </div>
      </footer>
    </div>
  );
}