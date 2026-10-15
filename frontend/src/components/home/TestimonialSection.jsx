import React from 'react';
import portrait from '../../assets/testimonial-portrait.png';

const TestimonialSection = () => {
  return (
    <section className="w-full max-w-[1280px] mx-auto py-[60px] md:py-[120px] px-5 flex flex-col lg:flex-row items-center justify-center gap-[32px] lg:gap-[40px]">
      <img 
        src={portrait} 
        alt="Sourav" 
        className="w-full max-w-[451px] lg:w-[38%] h-auto object-cover rounded"
      />
      
      <div className="min-w-0 flex-1 flex flex-col gap-[32px] lg:gap-[56px] w-full lg:max-w-[700px] lg:px-6">
        <svg width="24" height="20" viewBox="0 0 24 20" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M9.81818 0V4.36364C7.05455 5.52727 5.52727 7.70909 5.23636 10.9091H9.81818V20H0V10.9091C0 4.8 3.27273 1.16364 9.81818 0ZM24 0V4.36364C21.2364 5.52727 19.7091 7.70909 19.4182 10.9091H24V20H14.1818V10.9091C14.1818 4.8 17.4545 1.16364 24 0Z" fill="#DBE0EC"/>
        </svg>

        <p className="font-radio-canada font-medium text-[20px] md:text-[24px] leading-[1em] tracking-[-0.03em] text-[#000000]">
          "Integrating OptiRoute into our AI stack took less than 10 minutes. It completely eliminated our user-facing API timeouts and instantly reduced our OpenAI bill through semantic caching"
        </p>

        <div className="flex flex-col">
          <h4 className="font-radio-canada font-medium text-[20px] text-[#000000]">
            Sourav
          </h4>
          <span className="font-source-serif font-normal text-[16px] md:text-[20px] text-[#6C6C6C]">
            Lead AI Engineer , designer
          </span>
        </div>
      </div>
    </section>
  );
};

export default TestimonialSection;
