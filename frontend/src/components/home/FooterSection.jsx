import React from 'react';
import footerImg from '../../assets/footer-img.png';

const FooterSection = () => {
  return (
    <footer className="w-full">
      <div className="bg-[#FFF546] p-[20px] flex flex-col gap-[20px] rounded-t-[16px]">
        <div className="flex justify-end w-full">
          <p className="font-source-serif font-normal text-[16px] md:text-[18px] text-center text-[#66640F]">
            © 2026 · All rights reserved
          </p>
        </div>

        {/* Footer Image */}
        <div className="w-full h-[180px] md:h-[280px] overflow-hidden rounded-[8px]">
          <img 
            src={footerImg} 
            alt="Footer Graphics" 
            className="w-full h-full object-cover opacity-90"
          />
        </div>
        
        {/* OptiRoute Massive Logo */}
        <div className="w-full mt-4 flex items-end overflow-hidden justify-center md:justify-start">
          <span className="font-radio-canada font-bold text-[clamp(2.7rem,14vw,11.25rem)] leading-[0.85] tracking-[-0.04em] text-[#66640F] pb-4">
            OptiRoute
          </span>
        </div>
      </div>
    </footer>
  );
};

export default FooterSection;
