import React from 'react';
import HeroSection from '../components/home/HeroSection';
import FeaturesSection from '../components/home/FeaturesSection';
import ValuesSection from '../components/home/ValuesSection';
import CaseStudySection from '../components/home/CaseStudySection';
import BlogSection from '../components/home/BlogSection';
import TestimonialSection from '../components/home/TestimonialSection';
import CTASection from '../components/home/CTASection';
import FooterSection from '../components/home/FooterSection';

const HomePage = () => {
  return (
    <div className="relative w-full min-h-screen bg-white font-source-serif">
      {/* Top gradient background */}
      <div 
        className="absolute top-0 left-0 w-full h-[1200px] md:h-[2428.81px]"
        style={{
          background: 'linear-gradient(180deg, #A8D3FF 0%, #FFF4DF 40%, #FFF4DF 100%)',
          zIndex: 0
        }}
      />
      
      {/* Content wrapper to ensure it sits above the background gradient */}
      <div className="relative z-10 flex flex-col items-center">
        <HeroSection />
        <FeaturesSection />
        <ValuesSection />
        <CaseStudySection />
        <BlogSection />
        <TestimonialSection />
        <CTASection />
        <FooterSection />
      </div>
    </div>
  );
};

export default HomePage;
