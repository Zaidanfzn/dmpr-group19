// src/App.jsx
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Play, RotateCcw, Settings, TrendingUp, BarChart3, Info, Sun, Moon, FileText, ChevronLeft, ChevronRight, Camera } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend, ResponsiveContainer } from 'recharts';

/**
 * --- COMPONENTS ---
 */

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

export default function App() {
  const [isDarkMode, setIsDarkMode] = useState(true);
  const [isSimulating, setIsSimulating] = useState(false);
  const [activeChartPage, setActiveChartPage] = useState(0);

  // ==== NEW: Mobile detection (no libs) ====
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(max-width: 640px)").matches; // Tailwind sm breakpoint
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 640px)");
    const onChange = (e) => setIsMobile(e.matches);
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else mq.addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", onChange);
      else mq.removeListener(onChange);
    };
  }, []);

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

  // ===========================
  // Web Worker setup
  // ===========================
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

  useEffect(() => { runSimulation(); }, []); // keep as-is

  const handleParamChange = (key, val) => setParams(prev => ({ ...prev, [key]: parseFloat(val) }));

  const SliderControl = ({ label, id, min, max, step, val, unit = "" }) => (
    <div className="mb-3">
      <div className={`flex justify-between text-[11px] sm:text-xs mb-1 ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`}>
        <label htmlFor={id} className="pr-2">{label}</label>
        <span className="text-teal-500 font-mono font-bold whitespace-nowrap">{val} {unit}</span>
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
      <div className="px-3 sm:px-4 py-2 sm:py-3 flex justify-between items-center border-b border-gray-100 dark:border-gray-800">
        <div className={`text-xs sm:text-sm font-bold uppercase tracking-wide ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
          {title}
        </div>
        <button
          onClick={() => downloadChartAsPng(id, title)}
          className={`p-1 sm:p-1.5 rounded-md transition-colors ${isDarkMode ? 'hover:bg-gray-700 text-gray-400' : 'hover:bg-gray-100 text-gray-500'}`}
          title="Unduh Grafik (PNG)"
        >
          <Camera size={16} />
        </button>
      </div>
      <div className="flex-1 p-1.5 sm:p-2">
        {children}
      </div>
    </div>
  );

  const CHART_PAGES = [
    { title: "Temperatures (E-101 & C-201)", charts: ["Tfeed", "Tcond"] },
    { title: "Quality & Reflux", charts: ["rho", "Freflux"] },
    { title: "Controller Outputs (MV)", charts: ["outputs"] }
  ];

  const fmt = (v, digits = 1) =>
    Number.isFinite(Number(v)) ? Number(v).toFixed(digits) : "-";

  // ==== NEW: Recharts mobile-friendly presets ====
  const axisTickFont = isMobile ? 9 : 10;
  const legendFont = isMobile ? 10 : 12;
  const legendIcon = isMobile ? 8 : 10;
  const chartMargin = isMobile
    ? { top: 6, right: 8, left: 0, bottom: 0 }
    : { top: 10, right: 16, left: 6, bottom: 0 };

  const tooltipStyle = {
    backgroundColor: isDarkMode ? '#111' : '#fff',
    borderColor: isDarkMode ? '#333' : '#ddd',
    color: isDarkMode ? '#fff' : '#000',
    padding: isMobile ? '6px 8px' : '10px 12px',
    fontSize: isMobile ? 11 : 12,
    borderRadius: 10
  };

  const ChartLegend = () => (
    <Legend
      verticalAlign={isMobile ? "bottom" : "top"}
      align="center"
      iconSize={legendIcon}
      wrapperStyle={{
        fontSize: legendFont,
        paddingTop: isMobile ? 2 : 6,
        paddingBottom: isMobile ? 0 : 0,
        lineHeight: isMobile ? "14px" : "18px"
      }}
    />
  );

  return (
    <div className={`min-h-screen font-sans transition-colors duration-300 flex flex-col
      ${isDarkMode ? 'bg-neutral-950 text-gray-200 selection:bg-teal-900 selection:text-white' : 'bg-gray-50 text-gray-800 selection:bg-teal-100 selection:text-teal-900'}`}>

      <header className={`border-b sticky top-0 z-50 backdrop-blur-md transition-colors duration-300
        ${isDarkMode ? 'border-gray-800 bg-neutral-900/80' : 'border-gray-200 bg-white/80'}`}>
        <div className="w-full px-3 sm:px-4 lg:px-8 py-2 sm:py-3 flex justify-between items-center">
          <div className="flex items-center gap-2 md:gap-4 min-w-0">
            <div className={`w-9 h-9 sm:w-10 sm:h-10 md:w-12 md:h-12 rounded-xl flex items-center justify-center border shadow-sm flex-shrink-0
               ${isDarkMode ? 'bg-neutral-800 border-gray-700' : 'bg-white border-gray-200'}`}>
              <Logo19 className="w-6 h-6 sm:w-6 sm:h-6 md:w-8 md:h-8" />
            </div>
            <div className="min-w-0">
              <h1 className={`text-base sm:text-lg md:text-lg font-bold tracking-tight truncate ${isDarkMode ? 'text-white' : 'text-gray-900'}`}>
                PT. Aimtopindo
              </h1>
              <p className="hidden md:block text-base text-teal-500 uppercase tracking-widest font-bold">
                Kelompok 19 DMPR
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 md:gap-4 flex-shrink-0">
            <button
              onClick={() => setIsDarkMode(!isDarkMode)}
              className={`p-2 rounded-full border transition-all
              ${isDarkMode ? 'bg-gray-800 border-gray-700 text-yellow-400' : 'bg-gray-100 border-gray-300 text-gray-600'}`}
              aria-label="Toggle theme"
            >
              {isDarkMode ? <Sun size={18} /> : <Moon size={18} />}
            </button>

            <button
              onClick={runSimulation}
              disabled={isSimulating}
              className={`flex items-center gap-2 px-3 sm:px-4 md:px-6 py-2 md:py-2.5 rounded-full font-medium transition-all shadow-lg
                ${isSimulating
                  ? 'bg-gray-700 text-gray-400 cursor-not-allowed'
                  : 'bg-teal-500 hover:bg-teal-400 text-white hover:scale-105 shadow-teal-500/20'}`}
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
            <div className={`flex items-center gap-2 mb-3 sm:mb-4 font-semibold border-b pb-2 text-sm sm:text-base ${isDarkMode ? 'text-white border-gray-800' : 'text-gray-900 border-gray-100'}`}>
              <Settings className="w-4 h-4 text-teal-500" /> Pengaturan Global
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
            <div className={`flex items-center gap-2 mb-3 sm:mb-4 font-semibold border-b pb-2 text-sm sm:text-base ${isDarkMode ? 'text-white border-gray-800' : 'text-gray-900 border-gray-100'}`}>
              <TrendingUp className="w-4 h-4 text-teal-500" /> Setpoints
            </div>
            <SliderControl label="SP Feed Temp (°C)" id="sp_Tfeed" min={90} max={150} step={1} val={params.sp_Tfeed} />
            <SliderControl label="SP Cond Temp (°C)" id="sp_Tcond" min={30} max={70} step={1} val={params.sp_Tcond} />
            <SliderControl label="SP Density (g/cc)" id="sp_rho" min={0.70} max={0.80} step={0.0005} val={params.sp_rho} />
          </div>

          <div className={`border rounded-xl overflow-hidden shadow-sm flex flex-col max-h-[560px] sm:max-h-[600px] ${isDarkMode ? 'bg-neutral-900 border-gray-800' : 'bg-white border-gray-200'}`}>
            <div className={`p-3 sm:p-4 font-semibold flex items-center gap-2 border-b text-sm sm:text-base ${isDarkMode ? 'bg-gray-800/30 border-gray-800 text-white' : 'bg-gray-50 border-gray-100 text-gray-900'}`}>
              <BarChart3 className="w-4 h-4 text-teal-500" /> Tuning PID
            </div>
            <div className="p-3 sm:p-4 space-y-5 sm:space-y-6 overflow-y-auto custom-scrollbar flex-1">
              {['TIC-101 (Preheater)|kp101|ti101', 'TIC-201 (Condenser)|kp201|ti201', 'AIC-201 (Density)|kpa|tia', 'FIC-201 (Reflux Flow)|kpf|tif', 'PIC-201 (Pressure)|kpp|tip'].map((grp, i) => {
                const [title, kId, tId] = grp.split('|');
                return (
                  <div key={i} className={i > 0 ? "border-t pt-4 border-gray-700/30" : ""}>
                    <h4 className="text-[11px] sm:text-xs font-bold text-teal-500 uppercase mb-2">{title}</h4>
                    <SliderControl label="Kp" id={kId} min={kId.includes('kpa') ? 50 : 0.2} max={kId.includes('kpa') ? 2000 : 10.0} step={kId.includes('kpa') ? 50 : 0.1} val={params[kId]} />
                    <SliderControl label="Ti (s)" id={tId} min={20} max={kId.includes('kpa') ? 2500 : 600} step={10} val={params[tId]} />
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
                      <tr><th className="px-3 sm:px-4 py-2">Loop</th><th className="px-3 sm:px-4 py-2">Kp</th><th className="px-3 sm:px-4 py-2">Ti</th></tr>
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
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 sm:gap-4 mb-3 sm:mb-4">
              <h2 className={`text-base sm:text-lg font-bold ${isDarkMode ? 'text-white' : 'text-gray-800'}`}>
                Grafik Simulasi: <span className="text-teal-500">{CHART_PAGES[activeChartPage].title}</span>
              </h2>

              <div className="flex items-center justify-between sm:justify-end gap-2">
                <button
                  onClick={() => setActiveChartPage(p => Math.max(0, p - 1))}
                  disabled={activeChartPage === 0}
                  className={`px-2.5 py-1.5 sm:p-2 rounded-lg border flex items-center gap-1 text-[11px] sm:text-sm font-medium transition-colors
                    ${isDarkMode ? 'border-gray-700 hover:bg-gray-800 disabled:opacity-30' : 'border-gray-200 hover:bg-gray-100 disabled:opacity-30'}`}
                >
                  <ChevronLeft size={16} />
                  Prev
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
                  className={`px-2.5 py-1.5 sm:p-2 rounded-lg border flex items-center gap-1 text-[11px] sm:text-sm font-medium transition-colors
                    ${isDarkMode ? 'border-gray-700 hover:bg-gray-800 disabled:opacity-30' : 'border-gray-200 hover:bg-gray-100 disabled:opacity-30'}`}
                >
                  Next
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:gap-6 animate-fadeIn">
              {activeChartPage === 0 && (
                <>
                  <ChartCard title="E-101: Feed Temp (°C)" id="chart-tfeed">
                    <ResponsiveContainer>
                      <LineChart data={simData} margin={chartMargin}>
                        <CartesianGrid strokeDasharray="3 3" stroke={isDarkMode ? "#333" : "#eee"} />
                        <XAxis
                          dataKey="t"
                          stroke="#888"
                          tick={{ fontSize: axisTickFont }}
                          interval={isMobile ? "preserveStartEnd" : 0}
                          minTickGap={isMobile ? 20 : 10}
                        />
                        <YAxis stroke="#888" tick={{ fontSize: axisTickFont }} domain={['auto', 'auto']} width={isMobile ? 34 : 40} />
                        <RechartsTooltip contentStyle={tooltipStyle} />
                        <ChartLegend />
                        <Line type="monotone" dataKey="Tfeed" stroke="#2dd4bf" strokeWidth={2} dot={false} isAnimationActive={false} name="PV" />
                        <Line type="step" dataKey="SP_Tfeed" stroke="#9ca3af" strokeDasharray="4 4" dot={false} isAnimationActive={false} name="SP" />
                      </LineChart>
                    </ResponsiveContainer>
                  </ChartCard>

                  <ChartCard title="C-201: Condenser Temp (°C)" id="chart-tcond">
                    <ResponsiveContainer>
                      <LineChart data={simData} margin={chartMargin}>
                        <CartesianGrid strokeDasharray="3 3" stroke={isDarkMode ? "#333" : "#eee"} />
                        <XAxis
                          dataKey="t"
                          stroke="#888"
                          tick={{ fontSize: axisTickFont }}
                          interval={isMobile ? "preserveStartEnd" : 0}
                          minTickGap={isMobile ? 20 : 10}
                        />
                        <YAxis stroke="#888" tick={{ fontSize: axisTickFont }} domain={['auto', 'auto']} width={isMobile ? 34 : 40} />
                        <RechartsTooltip contentStyle={tooltipStyle} />
                        <ChartLegend />
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
                      <LineChart data={simData} margin={chartMargin}>
                        <CartesianGrid strokeDasharray="3 3" stroke={isDarkMode ? "#333" : "#eee"} />
                        <XAxis
                          dataKey="t"
                          stroke="#888"
                          tick={{ fontSize: axisTickFont }}
                          interval={isMobile ? "preserveStartEnd" : 0}
                          minTickGap={isMobile ? 20 : 10}
                        />
                        <YAxis
                          stroke="#888"
                          tick={{ fontSize: axisTickFont }}
                          domain={['auto', 'auto']}
                          tickFormatter={(v) => v.toFixed(3)}
                          width={isMobile ? 40 : 48}
                        />
                        <RechartsTooltip contentStyle={tooltipStyle} />
                        <ChartLegend />
                        <Line type="monotone" dataKey="rho" stroke="#f472b6" strokeWidth={2} dot={false} isAnimationActive={false} name="PV" />
                        <Line type="step" dataKey="SP_rho" stroke="#9ca3af" strokeDasharray="4 4" dot={false} isAnimationActive={false} name="SP" />
                      </LineChart>
                    </ResponsiveContainer>
                  </ChartCard>

                  <ChartCard title="FIC-201: Reflux Flow (Cascade)" id="chart-flow">
                    <ResponsiveContainer>
                      <LineChart data={simData} margin={chartMargin}>
                        <CartesianGrid strokeDasharray="3 3" stroke={isDarkMode ? "#333" : "#eee"} />
                        <XAxis
                          dataKey="t"
                          stroke="#888"
                          tick={{ fontSize: axisTickFont }}
                          interval={isMobile ? "preserveStartEnd" : 0}
                          minTickGap={isMobile ? 20 : 10}
                        />
                        <YAxis stroke="#888" tick={{ fontSize: axisTickFont }} domain={['auto', 'auto']} width={isMobile ? 34 : 40} />
                        <RechartsTooltip contentStyle={tooltipStyle} />
                        <ChartLegend />
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
                      <LineChart data={simData} margin={chartMargin}>
                        <CartesianGrid strokeDasharray="3 3" stroke={isDarkMode ? "#333" : "#eee"} />
                        <XAxis
                          dataKey="t"
                          stroke="#888"
                          tick={{ fontSize: axisTickFont }}
                          interval={isMobile ? "preserveStartEnd" : 0}
                          minTickGap={isMobile ? 20 : 10}
                        />
                        <YAxis stroke="#888" tick={{ fontSize: axisTickFont }} domain={[0, 100]} width={isMobile ? 34 : 40} />
                        <RechartsTooltip contentStyle={tooltipStyle} />
                        <ChartLegend />
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

      <footer className={`border-t py-4 sm:py-6 mt-auto transition-colors duration-300
        ${isDarkMode ? 'bg-neutral-900 border-gray-800 text-gray-500' : 'bg-white border-gray-200 text-gray-400'}`}>
        <div className="w-full px-3 sm:px-4 lg:px-8 flex flex-col md:flex-row justify-between items-center gap-3 sm:gap-4">
          <div className="flex items-center gap-3">
            <div className="opacity-50 grayscale hover:grayscale-0 transition-all">
              <Logo19 className="w-7 h-7 sm:w-8 sm:h-8" />
            </div>
            <p className="text-xs sm:text-sm font-medium">© 2026 Kelompok 19 DMPR. All rights reserved.</p>
          </div>
          <div className="flex flex-col sm:flex-row gap-1 sm:gap-6 text-xs sm:text-sm text-center sm:text-left">
            <span>Client: PT. Aimtopindo</span>
            <span>Project: Destilasi Biohidrokarbon Semi-Continuous | PID Control</span>
          </div>
        </div>
      </footer>
    </div>
  );
}