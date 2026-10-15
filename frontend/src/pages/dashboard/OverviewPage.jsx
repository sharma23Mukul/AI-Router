import React from 'react';
import RequestsPerModelChart from '../../components/dashboard/RequestsPerModelChart';
import WeeklyModelRequestsChart from '../../components/dashboard/WeeklyModelRequestsChart';

import { useState, useEffect } from 'react';
import { apiCall, API_BASE } from '../../utils/auth';

export default function OverviewPage() {
  const [data, setData] = useState({ total_requests: '...', cost_saved: '...', cache_hit_rate: '...', active_failovers: '...', alerts: [] });
  useEffect(() => {
    let active = true;
    let loading = false;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try {
        const response = await apiCall(`${API_BASE}/api/v1/dashboard/overview`);
        if (!response.ok) throw new Error(`Overview request failed (${response.status})`);
        const updated = await response.json();
        if (active) setData(updated);
      } catch (error) {
        if (active) console.error(error);
      } finally {
        loading = false;
      }
    };
    refresh();
    const interval = window.setInterval(refresh, 3000);
    return () => { active = false; window.clearInterval(interval); };
  }, []);

  const cacheHitRate = Number.isFinite(Number(data.cache_hit_rate))
    ? Math.min(100, Math.max(0, Number(data.cache_hit_rate)))
    : 0;
  const totalRequests = Number(data.total_requests) || 0;
  const requestRecency = data.request_recency || {};
  const requestPeriods = [
    { label: 'Last 24h', count: requestRecency.last_24h || 0, color: 'bg-blue-600' },
    { label: 'Prior 6 days', count: requestRecency.previous_6d || 0, color: 'bg-blue-400' },
    { label: 'Older', count: requestRecency.older || 0, color: 'bg-blue-200' },
  ];
  const cacheHits = Number(data.cache_hits) || 0;
  const generatedAnswers = Number(data.generated_answers) || 0;
  return (
    <div className="w-full flex justify-center pt-0 md:pt-6 pb-4 md:pb-0">
      <div 
        className="bg-[#788FA8] rounded-[20px] shadow-lg flex flex-col p-4 md:p-6 gap-4 w-full max-w-[1080px]"
      >
        {/* Top Cards Row */}
        <div className="grid grid-cols-1 lg:grid-cols-2 w-full gap-4 md:gap-[20px]">
          <div className="flex min-h-[176px] flex-col justify-between rounded-[20px] bg-white p-4 shadow-sm">
            <div>
              <h3 className="font-radio-canada text-[16px] font-semibold text-slate-700">Total Requests</h3>
            </div>
            <div className="my-1">
              <div className="font-radio-canada text-[36px] font-bold leading-none tracking-tight text-slate-950">{data.total_requests}</div>
              <p className="mt-1 font-radio-canada text-[12px] text-slate-500">Completed prompts across your workflows</p>
            </div>
            <div className="border-t border-slate-100 pt-3">
              <div className="flex h-2 w-full overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
                {requestPeriods.map((period) => <div key={period.label} className={period.color} style={{ width: `${totalRequests ? (period.count / totalRequests) * 100 : 0}%` }} />)}
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                {requestPeriods.map((period) => (
                  <div key={period.label} className="flex min-w-0 items-center gap-1.5 font-radio-canada text-[11px] text-slate-500">
                    <span className={`size-2 shrink-0 rounded-full ${period.color}`} />
                    <span>{period.label}</span>
                    <strong className="text-xs text-slate-800">{period.count}</strong>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="flex min-h-[176px] flex-col justify-between rounded-[20px] bg-white p-4 shadow-sm">
            <div>
              <h3 className="font-radio-canada text-[16px] font-semibold text-slate-700">Cache Hit Rate</h3>
            </div>
            <div className="my-1">
              <div className="font-radio-canada text-[36px] font-bold leading-none tracking-tight text-slate-950">{data.cache_hit_rate === '...' ? '...' : `${cacheHitRate}%`}</div>
              <p className="mt-1 font-radio-canada text-[12px] text-slate-500">of completed prompts answered from cache</p>
            </div>
            <div className="border-t border-slate-100 pt-3">
              <div className="flex h-2 w-full overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
                <div className="bg-blue-600" style={{ width: `${totalRequests ? (cacheHits / totalRequests) * 100 : 0}%` }} />
                <div className="bg-blue-200" style={{ width: `${totalRequests ? (generatedAnswers / totalRequests) * 100 : 0}%` }} />
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 font-radio-canada">
                <div className="text-[12px] text-slate-500"><span className="mr-2 inline-block size-2 rounded-full bg-blue-600" />Cache hits <strong className="ml-1 text-sm text-slate-800">{cacheHits}</strong></div>
                <div className="text-[12px] text-slate-500"><span className="mr-2 inline-block size-2 rounded-full bg-blue-200" />Model answers <strong className="ml-1 text-sm text-slate-800">{generatedAnswers}</strong></div>
              </div>
            </div>
          </div>
        </div>

        {/* Charts Row */}
        <div className="flex flex-col lg:flex-row w-full gap-4 items-stretch justify-between">
          <RequestsPerModelChart />
          <WeeklyModelRequestsChart />
        </div>
      </div>
    </div>
  );
}

