/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        /* Page gradient */
        'page-gradient-start': 'var(--color-page-gradient-start)',
        'page-gradient-end': 'var(--color-page-gradient-end)',

        /* Text */
        'text-primary': 'var(--color-text-primary)',
        'text-muted': 'var(--color-text-muted)',

        /* Backgrounds */
        'soft-bg': 'var(--color-soft-bg)',
        'border-divider': 'var(--color-border-divider)',
        'cream': 'var(--color-cream)',

        /* Accent */
        'accent-yellow': 'var(--color-accent-yellow)',
        'olive-label': 'var(--color-olive-label)',
        'cta-olive-dark': 'var(--color-cta-olive-dark)',

        /* Dashboard blues */
        'dash-blue-1': 'var(--color-dash-blue-1)',
        'dash-blue-2': 'var(--color-dash-blue-2)',
        'dash-blue-3': 'var(--color-dash-blue-3)',

        /* Dashboard slates */
        'dash-slate-1': 'var(--color-dash-slate-1)',
        'dash-slate-2': 'var(--color-dash-slate-2)',
        'dash-slate-3': 'var(--color-dash-slate-3)',

        /* Sampled colors */
        'hero-mid': 'var(--color-hero-mid)',
        'values-warm': 'var(--color-values-warm)',
        'blog-tag-orange': 'var(--color-blog-tag-orange)',
        'testimonial-blue': 'var(--color-testimonial-blue)',

        /* Login/Prompt card gradients */
        'login-card-top': 'var(--color-login-card-top)',
        'login-card-mid': 'var(--color-login-card-mid)',
        'login-card-bottom': 'var(--color-login-card-bottom)',
        'prompt-card-mid': 'var(--color-prompt-card-mid)',
        'prompt-card-bottom': 'var(--color-prompt-card-bottom)',

        /* Dashboard sampled */
        'dash-card-slate': 'var(--color-dash-card-slate)',
        'req-grey-card': 'var(--color-req-grey-card)',
        'scrollbar-thumb': 'var(--color-scrollbar-thumb)',
        'budget-bg-mid': 'var(--color-budget-bg-mid)',
        'budget-bg-bottom': 'var(--color-budget-bg-bottom)',
      },
      fontFamily: {
        'radio-canada': ['"Radio Canada Big"', 'sans-serif'],
        'source-serif': ['"Source Serif Pro"', 'serif'],
        'geist-mono': ['"Geist Mono"', 'monospace'],
      },
      fontSize: {
        'hero': ['clamp(3rem, 6vw, 80px)', { lineHeight: '1.05' }],
        'section': ['clamp(2.5rem, 4vw, 56px)', { lineHeight: '1.1' }],
        'heading': ['clamp(2rem, 3vw, 40px)', { lineHeight: '1.2' }],
        'body-lg': ['clamp(1.125rem, 1.5vw, 20px)', { lineHeight: '1.5' }],
        'body': ['16px', { lineHeight: '1.6' }],
        'label': ['14px', { lineHeight: '1.4' }],
      },
      borderRadius: {
        'card': '16px',
        'sm': '8px',
        'md': '10px',
        'lg': '20px',
      },
      maxWidth: {
        'site': '1280px',
      },
    },
  },
  plugins: [],
}
