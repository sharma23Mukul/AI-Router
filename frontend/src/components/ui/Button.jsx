import { Link } from 'react-router-dom';

export default function Button({ variant = 'primary', children, className = '', disabled = false, to, ...rest }) {
  const baseClasses = 'inline-flex items-center justify-center transition-all duration-200 font-geist-mono';
  
  const variants = {
    primary: 'bg-text-primary text-white text-label uppercase tracking-wider px-6 py-3 rounded-sm hover:opacity-90 focus:ring-2 focus:ring-text-primary focus:ring-offset-2',
    outline: 'bg-white border border-border-divider text-text-primary text-label px-6 py-3 rounded-sm hover:bg-soft-bg focus:ring-2 focus:ring-border-divider',
    ghost: 'bg-transparent text-text-primary font-source-serif hover:underline focus:underline',
    cta: 'bg-accent-yellow text-cta-olive-dark text-label uppercase tracking-wider px-6 py-3 rounded-sm hover:brightness-95 focus:ring-2 focus:ring-accent-yellow focus:ring-offset-2',
    dashboard: 'bg-white/30 text-white text-label px-4 py-1.5 rounded-full hover:bg-white/50 backdrop-blur-sm focus:ring-2 focus:ring-white/50',
  };

  const classes = `${baseClasses} ${variants[variant] || variants.primary} ${disabled ? 'opacity-50 cursor-not-allowed pointer-events-none' : ''} ${className}`;

  if (to && !disabled) {
    return <Link to={to} className={classes} {...rest}>{children}</Link>;
  }

  return <button className={classes} disabled={disabled} {...rest}>{children}</button>;
}
