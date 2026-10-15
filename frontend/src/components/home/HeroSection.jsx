import React from 'react';
import { Link } from 'react-router-dom';
import heroDashboard from '../../assets/hero-dashboard.png';

const HeroSection = () => {
  return (
    <section className="relative w-full max-w-[1280px] pt-[100px] lg:pt-[140px] px-5 flex flex-col items-center mx-auto pb-16 lg:pb-0 lg:min-h-[950px]">
      <div className="flex flex-col items-center gap-[40px] md:gap-[56px] w-full z-10 relative">
        <div className="flex flex-col items-center gap-4 text-center">
          <h1 className="font-source-serif font-normal text-[clamp(2.2rem,7vw,5rem)] leading-[1em] tracking-[-0.04em] text-[#000000]">
            Intelligent LLM routing
          </h1>
          <h2 className="font-radio-canada font-normal text-[clamp(2.2rem,7vw,5rem)] leading-[1em] tracking-[-0.05em] text-[#000000]">
            built for scale
          </h2>
        </div>

        <p className="font-source-serif font-normal text-[16px] md:text-[18px] leading-[1.2em] tracking-[-0.03em] text-[#000000] text-center max-w-[1000px]">
          Prevent API outages, escalate hallucinated outputs, and ensure your agentic workflows never break mid-flight.
        </p>

        <Link 
          to="/signup" 
          className="flex items-center gap-[10px] bg-[#000000] text-[#FFFFFF] font-geist-mono font-medium text-[14px] p-4 rounded"
        >
          <div className="w-1 h-1 bg-white rounded-full"></div>
          Get started
        </Link>
      </div>

      {/* Hero Image */}
      <div className="relative mt-[40px] lg:absolute lg:mt-0 lg:top-[410px] lg:left-1/2 lg:-translate-x-1/2 w-full max-w-[778px] h-auto">
        <img src={heroDashboard} alt="OptiRoute Dashboard" className="w-full h-auto rounded shadow-lg" />
      </div>
    </section>
  );
};

export default HeroSection;
