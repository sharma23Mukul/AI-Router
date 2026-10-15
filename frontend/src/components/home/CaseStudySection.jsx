import React from 'react';
import casestudyImg from '../../assets/casestudy-img.png';

const CaseStudySection = () => {
  return (
    <section className="w-full max-w-[1280px] mx-auto py-[60px] md:py-[120px] px-5">
      <div className="bg-[#F6F8FB] rounded-[16px] p-[20px] flex flex-col lg:flex-row gap-[40px] items-center">
        <img 
          src={casestudyImg} 
          alt="Case Study" 
          className="w-full lg:w-[48%] h-auto object-cover rounded-[8px]"
        />
        
        <div className="w-full min-w-0 lg:flex-1 flex flex-col gap-[32px]">
          <h3 className="font-radio-canada font-medium text-[20px] text-[#000000]">
            Why engineering teams choose OptiRoute
          </h3>
          <p className="font-source-serif font-normal text-[16px] md:text-[20px] text-[#000000]">
            Managing multiple LLM APIs, handling rate limits, and preventing hallucinations was consuming our engineering cycles. OptiRoute provided a single, unified middleware layer. The result? We cut our token costs by 45% via caching and completely eliminated user-facing API timeouts.
          </p>
        </div>
      </div>
    </section>
  );
};

export default CaseStudySection;
