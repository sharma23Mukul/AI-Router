import React from 'react';
import valuesBg from '../../assets/values-bg.png';

const values = [
  {
    title: "Granular Observability",
    desc: "Stop guessing why your agents fail. Get real-time visibility into token costs, latency spikes, and automated routing decisions across all your AI models"
  },
  {
    title: "Fault-Tolerant by Design",
    desc: "AI providers go down. Your application shouldn't. Automated failover instantly reroutes requests around timeouts and 429 errors to keep your workflows alive."
  },
  {
    title: "Cost-Aware Execution",
    desc: "Stop overpaying for simple prompts. Dynamic complexity routing and semantic caching ensure you only use expensive frontier models when absolutely necessary."
  }
];

const ValuesSection = () => {
  return (
    <section 
      className="w-full relative"
      style={{
        background: `url(${valuesBg}) center/cover no-repeat`
      }}
    >
      <div className="w-full max-w-[1280px] mx-auto py-[60px] md:py-[120px] px-5 flex flex-col gap-[40px] md:gap-[60px] items-center">
        <div className="flex flex-col items-center gap-2 text-center">
          <h2 className="font-source-serif font-normal text-[clamp(2.2rem,7vw,5rem)] leading-[1em] tracking-[-0.04em] text-[#000000]">
            Engineered for reliability
          </h2>
          <h3 className="font-radio-canada font-normal text-[clamp(2.2rem,7vw,5rem)] leading-[1em] tracking-[-0.05em] text-[#000000]">
            Built for scale
          </h3>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-[16px] w-full">
          {values.map((val, idx) => (
            <div key={idx} className="min-w-0 bg-[#FFFFFF] rounded-[16px] p-[24px] lg:p-[40px] flex flex-col gap-[24px]">
              <div className="w-[42px] h-[42px] flex items-center justify-center">
                {idx === 0 && (
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#000000" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="2" x2="12" y2="22" />
                    <line x1="12" y1="12" x2="22" y2="12" />
                  </svg>
                )}
                {idx === 1 && (
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#000000" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"/>
                    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
                    <path d="M2 12h20"/>
                  </svg>
                )}
                {idx === 2 && (
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#000000" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M8 16L16 8" />
                    <path d="M8 8h8v8" />
                  </svg>
                )}
              </div>
              <div className="flex flex-col gap-[8px]">
                <h4 className="font-radio-canada font-medium text-[18px] md:text-[20px] leading-[1em] tracking-[-0.02em] text-[#000000]">
                  {val.title}
                </h4>
                <p className="font-source-serif font-normal text-[16px] md:text-[20px] leading-[1.2em] tracking-[-0.04em] text-[#000000]">
                  {val.desc}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default ValuesSection;
