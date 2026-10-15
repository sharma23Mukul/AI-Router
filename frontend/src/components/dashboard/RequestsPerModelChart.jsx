import { useEffect, useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { apiCall, API_BASE } from '../../utils/auth';

const COLORS = ['#1A73E8', '#00A3B4', '#E91E91', '#F4511E', '#8E24AA', '#34A853', '#F9AB00', '#6D4C41', '#455A64', '#7CB342', '#3949AB'];
const formatHour = (value) => new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(value));

export default function RequestsPerModelChart() {
  const [series, setSeries] = useState({ models: [], hours: [] });
  const [error, setError] = useState('');
  const [initialLoading, setInitialLoading] = useState(true);

  useEffect(() => {
    let active = true;
    let loading = false;
    const load = async () => {
      if (loading || document.hidden) return;
      loading = true;
      try {
        const response = await apiCall(`${API_BASE}/api/v1/dashboard/requests-per-model`);
        if (!response.ok) throw new Error('Request chart unavailable');
        const next = await response.json();
        if (active) {
          setSeries(next);
          setError('');
        }
      } catch (fetchError) {
        if (active) setError(fetchError.message);
      } finally {
        if (active) setInitialLoading(false);
        loading = false;
      }
    };

    load();
    const timer = window.setInterval(load, 3000);
    document.addEventListener('visibilitychange', load);
    window.addEventListener('focus', load);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', load);
      window.removeEventListener('focus', load);
    };
  }, []);

  const points = series.hours.map(({ time, counts }) => ({ time, ...counts }));
  const activeDotFor = (model, index) => ({ cx, cy, payload }) => {
    const count = Number(payload?.[model.id] ?? 0);
    if (count <= 0) return null;
    const tied = series.models.filter((candidate) => Number(payload?.[candidate.id] ?? 0) === count);
    const position = tied.findIndex((candidate) => candidate.id === model.id);
    const offset = (position - (tied.length - 1) / 2) * 10;
    return <circle cx={cx + offset} cy={cy} r={4.5} fill={COLORS[index % COLORS.length]} stroke="#fff" strokeWidth={1.5} />;
  };

  return (
    <section className="w-full lg:flex-1 lg:w-0 min-w-0 h-[340px] sm:h-[350px] lg:h-[clamp(210px,calc(100dvh-412px),400px)] rounded-[20px] bg-white shadow-sm p-4 md:p-5 font-radio-canada flex flex-col" aria-label="Requests per model">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-[17px] font-medium text-[#66778B]">Requests per model</h3>
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <rect x="3" y="9" width="3" height="8" fill="#1A73E8" />
          <rect x="9" y="3" width="3" height="14" fill="#00A3B4" />
          <rect x="15" y="12" width="3" height="5" fill="#F4511E" />
        </svg>
      </div>
      {error && <p className="mb-3 text-sm text-red-600" role="status">{error}</p>}
      {series.models.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-center text-[#66778B] text-sm">
          {initialLoading ? 'Loading request history…' : error ? 'Request history could not be loaded.' : 'Connect models to a workflow to see their request history.'}
        </div>
      ) : (
        <>
          <div className="flex-1 min-h-0 w-full" role="img" aria-label="Hourly request counts for each connected model over the last 24 hours">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={points} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="#E8ECF1" />
                <XAxis dataKey="time" tickFormatter={formatHour} interval={3} tickLine={false} axisLine={{ stroke: '#CBD3DD' }} tick={{ fill: '#748293', fontSize: 11 }} />
                <YAxis orientation="right" allowDecimals={false} domain={[0, (max) => Math.max(1, max)]} tickLine={false} axisLine={false} width={30} tick={{ fill: '#748293', fontSize: 11 }} />
                <Tooltip
                  labelFormatter={formatHour}
                  formatter={(value, name) => [value, name]}
                  itemSorter={(item) => -Number(item.value ?? 0)}
                  contentStyle={{ background: '#FFFFFF', border: '1px solid #DCE3EC', borderRadius: 10, color: '#25364A' }}
                />
                {series.models.map((model, index) => (
                  <Line key={model.id} type="linear" dataKey={model.id} name={model.name || model.id} stroke={COLORS[index % COLORS.length]} strokeWidth={2} dot={false} activeDot={activeDotFor(model, index)} isAnimationActive={false} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="max-h-[70px] overflow-y-auto flex flex-wrap gap-x-4 gap-y-2 pt-3 text-[12px] text-[#66778B]">
            {series.models.map((model, index) => (
              <div key={model.id} className="flex items-center gap-1.5 min-w-0" title={model.id}>
                <span className="w-3 h-3 shrink-0 rounded-full border border-white shadow-sm" style={{ backgroundColor: COLORS[index % COLORS.length] }} />
                <span className="truncate max-w-[150px]">{model.name || model.id}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
