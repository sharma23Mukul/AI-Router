import { useEffect, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { apiCall, API_BASE } from '../../utils/auth';

const TIER_COLORS = { light: '#B9D7F7', mid: '#5B9BD5', heavy: '#173F72' };

export default function WeeklyModelRequestsChart() {
  const [series, setSeries] = useState({ month: '', models: [], weeks: [] });
  const [error, setError] = useState('');
  const [initialLoading, setInitialLoading] = useState(true);

  useEffect(() => {
    let active = true;
    let loading = false;
    const load = async () => {
      if (loading || document.hidden) return;
      loading = true;
      try {
        const offset = -new Date().getTimezoneOffset();
        const response = await apiCall(`${API_BASE}/api/v1/dashboard/weekly-model-requests?timezone_offset_minutes=${offset}`);
        if (!response.ok) throw new Error('Weekly request chart unavailable');
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

  const points = series.weeks.map(({ week, counts }) => {
    const point = { week, light: 0, mid: 0, heavy: 0 };
    series.models.forEach((model) => {
      point[model.tier] += counts[model.key] || 0;
    });
    return point;
  });

  return (
    <section className="w-full lg:flex-1 lg:w-0 min-w-0 h-[340px] sm:h-[350px] lg:h-[clamp(210px,calc(100dvh-412px),400px)] rounded-[20px] bg-white shadow-sm p-4 md:p-5 font-radio-canada flex flex-col" aria-label="Weekly requests by tier">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="min-w-0">
          <h3 className="text-[17px] font-medium text-[#66778B]">Weekly requests by tier</h3>
          {series.month && <p className="text-[12px] text-[#8794A4]">{series.month}</p>}
        </div>
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="shrink-0">
          <rect x="3" y="9" width="3" height="8" fill={TIER_COLORS.light} />
          <rect x="9" y="3" width="3" height="14" fill={TIER_COLORS.mid} />
          <rect x="15" y="6" width="3" height="11" fill={TIER_COLORS.heavy} />
        </svg>
      </div>
      {error && <p className="mb-2 text-sm text-red-600" role="status">{error}</p>}
      {series.models.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-center text-[#66778B] text-sm">
          {initialLoading ? 'Loading weekly requests…' : error ? 'Weekly requests could not be loaded.' : 'Connect a workflow to see weekly requests.'}
        </div>
      ) : (
        <>
          <div className="flex-1 min-h-0 w-full" role="img" aria-label="Current month request counts for light, mid, and heavy tiers by week">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={points} barGap={3} barCategoryGap="25%" margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                <CartesianGrid vertical={false} stroke="#E8ECF1" />
                <XAxis dataKey="week" tickLine={false} axisLine={{ stroke: '#CBD3DD' }} tick={{ fill: '#748293', fontSize: 11 }} />
                <YAxis allowDecimals={false} domain={[0, (max) => Math.max(1, max)]} tickLine={false} axisLine={false} tick={{ fill: '#748293', fontSize: 11 }} width={42} label={{ value: 'Requests', angle: -90, position: 'insideLeft', fill: '#66778B', fontSize: 11 }} />
                <Tooltip cursor={{ fill: '#F5F9FE' }} formatter={(value, name) => [`${value} requests`, name]} itemSorter={(item) => -Number(item.value ?? 0)} contentStyle={{ background: '#FFFFFF', border: '1px solid #DCE3EC', borderRadius: 10, color: '#25364A' }} />
                <Bar dataKey="light" name="Light tier" fill={TIER_COLORS.light} maxBarSize={24} isAnimationActive={false} />
                <Bar dataKey="mid" name="Mid tier" fill={TIER_COLORS.mid} maxBarSize={24} isAnimationActive={false} />
                <Bar dataKey="heavy" name="Heavy tier" fill={TIER_COLORS.heavy} maxBarSize={24} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-2 pt-3 text-[12px] text-[#66778B]">
            {['light', 'mid', 'heavy'].map((tier) => (
              <div key={tier} className="flex items-center gap-1.5">
                <span className="w-3 h-3 shrink-0 rounded-sm" style={{ backgroundColor: TIER_COLORS[tier] }} />
                <span>{tier === 'mid' ? 'Mid tier' : `${tier[0].toUpperCase()}${tier.slice(1)} tier`}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
