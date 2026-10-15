import React from 'react';
import featuresChart from '../../assets/features-chart.png';

const features = [
  {
    num: "001",
    title: "Dynamic Routing",
    desc: "Automatically route prompts to the most cost-effective model based on task complexity and your active token budgets."
  },
  {
    num: "002",
    title: "Semantic Caching",
    desc: "Achieve near-zero latency and eliminate redundant API costs by caching and serving semantically identical requests."
  },
  {
    num: "003",
    title: "Automated Failover",
    desc: "Ensure zero downtime. Instantly reroute requests to fallback providers if a primary API hits a 429 rate limit or times out."
  },
  {
    num: "004",
    title: "Quality Escalation",
    desc: "Protect your workflows from hallucinations. Automatically escalate prompts to frontier models if cheaper models break your required JSON schema."
  }
];

const FeaturesSection = () => {
  return (
    <section className="w-full bg-white flex flex-col items-center">
      <div className="relative w-full max-w-[1280px] mx-auto py-[60px] md:py-[120px] px-5 flex flex-col items-center gap-[40px]">
        <h2 className="font-radio-canada font-medium text-[28px] md:text-[40px] leading-[1em] tracking-[-0.03em] text-[#000000] text-center max-w-[700px]">
        Everything you need to route, optimize, and secure your agentic workflows
      </h2>

      <div className="w-full flex flex-col lg:flex-row items-start gap-[40px]">
        {/* Left Image */}
        <div className="w-full min-w-0 lg:w-[45%] lg:shrink-0">
          <img src={featuresChart} alt="Features Chart" className="w-full h-auto object-cover" />
        </div>

        {/* Right Feature List */}
        <div className="min-w-0 flex-1 flex flex-col">
          {features.map((feature, idx) => (
            <div 
              key={idx} 
              className={`py-[24px] flex flex-col gap-[16px] border-t border-solid border-[#DBE0EC] ${idx === features.length - 1 ? 'border-b' : ''}`}
            >
              <div className="flex justify-between items-center w-full">
                <h3 className="font-radio-canada font-medium text-[18px] md:text-[20px] leading-[1em] tracking-[-0.02em] text-[#000000]">
                  {feature.title}
                </h3>
                <span className="font-geist-mono font-normal text-[14px] leading-[1em] text-[#6C6C6C] text-right">
                  {feature.num}
                </span>
              </div>
              <p className="font-source-serif font-normal text-[16px] md:text-[20px] leading-[1.2em] tracking-[-0.04em] text-[#000000]">
                {feature.desc}
              </p>
            </div>
          ))}

        </div>
      </div>
      </div>
    </section>
  );
};

export default FeaturesSection;
