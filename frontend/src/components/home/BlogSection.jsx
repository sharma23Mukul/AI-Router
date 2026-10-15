import React from 'react';
import thumb1 from '../../assets/article-thumb-1.png';
import thumb2 from '../../assets/article-thumb-2.png';
import thumb3 from '../../assets/article-thumb-3.png';

const articles = [
  {
    img: thumb1,
    title: "How to Build a Climate-Ready Data Stack",
    category: "Engineering",
    time: "4 min",
    desc: "Managing multiple LLM APIs, handling rate limits, and preventing hallucinations was consuming our engineering cycles."
  },
  {
    img: thumb2,
    title: "How to Build a Climate-Ready Data Stack",
    category: "Tutorial",
    time: "4 min",
    desc: "Managing multiple LLM APIs, handling rate limits, and preventing hallucinations was consuming our engineering cycles."
  },
  {
    img: thumb3,
    title: "How to Build a Climate-Ready Data Stack",
    category: "Case Study",
    time: "4 min",
    desc: "Managing multiple LLM APIs, handling rate limits, and preventing hallucinations was consuming our engineering cycles."
  }
];

const BlogSection = () => {
  return (
    <section className="w-full max-w-[1280px] mx-auto py-10 px-5 flex flex-col gap-[40px] items-center">
      <h2 className="font-radio-canada font-medium text-[28px] md:text-[40px] text-[#000000] self-start ml-0 md:ml-24">
        Engineering Blog & Tutorials
      </h2>

      <div className="flex flex-col w-full max-w-[620px]">
        {articles.map((article, idx) => (
          <div key={idx} className="flex flex-col md:flex-row gap-[16px] py-[24px] border-b border-solid border-[#DBE0EC]">
            <img src={article.img} alt="Article Thumbnail" className="w-full md:w-[165px] h-[200px] md:h-[100px] object-cover rounded" />
            <div className="w-full min-w-0 md:flex-1 flex flex-col gap-[8px]">
              <h3 className="font-radio-canada font-medium text-[18px] md:text-[20px] text-[#000000]">
                {article.title}
              </h3>
              <div className="flex flex-row items-center gap-[8px] font-geist-mono font-normal text-[14px] text-[#6C6C6C]">
                <span>{article.category}</span>
                <span>·</span>
                <span>{article.time}</span>
              </div>
              <p className="font-source-serif font-normal text-[16px] md:text-[20px] leading-[1.2em] text-[#000000]">
                {article.desc}
              </p>
            </div>
          </div>
        ))}
      </div>

    </section>
  );
};

export default BlogSection;
