import React, { useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../utils/auth';

const navItems = [
  { path: '/dashboard/overview', label: 'Overview' },
  { path: '/dashboard/routing-policies', label: 'Routing Policies' },
  { path: '/dashboard/semantic-cache', label: 'Semantic Cache' },
  { path: '/prompt', label: 'Playground' },
];

export default function DashboardLayout() {
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const isOverview = useLocation().pathname === '/dashboard/overview';
  const isSemanticCache = useLocation().pathname === '/dashboard/semantic-cache';

  const userName = user?.displayName || (user?.email ? user.email.split('@')[0] : 'User');

  const handleLogout = async () => {
    try {
      await signOut();
      navigate('/login');
    } catch (error) {
      console.error('Logout failed:', error);
    }
  };

  // SVG Icons for nav items matching screenshot
  const getIcon = (label) => {
    switch (label) {
      case 'Overview':
        return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>;
      case 'Routing Policies':
        return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="18" r="3"></circle><circle cx="6" cy="6" r="3"></circle><path d="M13 6h3a2 2 0 0 1 2 2v7"></path><line x1="6" y1="9" x2="6" y2="21"></line></svg>;
      case 'Semantic Cache':
        return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path></svg>;
      case 'Budget':
        return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="8"></circle><path d="M12 16v-8"></path><path d="M9 10h6"></path><path d="M9 14h6"></path></svg>;
      case 'Playground':
        return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>;
      default:
        return null;
    }
  };

  return (
    <div className="min-h-screen w-full" style={{ background: 'linear-gradient(180deg, #A8D3FF 0%, #FFF4DF 100%)', backgroundAttachment: isSemanticCache ? 'fixed' : 'scroll' }}>
      <div className="min-h-screen flex flex-col">
        {/* Top Navigation */}
        <nav className="w-full pt-4 lg:pt-8 pb-4 flex flex-col lg:flex-row justify-between lg:justify-center items-center z-20 px-4 lg:px-0">
          <div className="flex w-full min-w-0 lg:w-auto items-center justify-between lg:justify-center lg:gap-6">
            
            {/* Hamburger Menu (Mobile Only) */}
            <button 
              className="lg:hidden flex shrink-0 items-center justify-center p-2 text-gray-700"
              onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
              aria-label={isMobileMenuOpen ? 'Close navigation' : 'Open navigation'}
              aria-expanded={isMobileMenuOpen}
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="3" y1="12" x2="21" y2="12"></line>
                <line x1="3" y1="6" x2="21" y2="6"></line>
                <line x1="3" y1="18" x2="21" y2="18"></line>
              </svg>
            </button>

            {/* Profile Section */}
            <div className="relative min-w-0">
              <div 
                className="cursor-pointer flex min-w-0 items-center gap-3 px-2 py-1 rounded-full transition-colors"
                onClick={() => setIsDropdownOpen(!isDropdownOpen)}
              >
                <div className="w-8 h-8 shrink-0 bg-[#212B36] rounded-full flex items-center justify-center text-white">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
                  </svg>
                </div>
                <span className="max-w-[min(65vw,240px)] truncate text-[16px] font-radio-canada font-medium text-white">{userName}</span>
              </div>
              {isDropdownOpen && (
                <div className="absolute right-0 mt-2 w-32 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden py-1 z-50">
                  <button 
                    onClick={handleLogout} 
                    className="block w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50 font-radio-canada"
                  >
                    Log out
                  </button>
                </div>
              )}
            </div>

            {/* Vertical Divider (Desktop Only) */}
            <div className="hidden lg:block h-6 w-[1px] bg-gray-400/50"></div>

            {/* Nav Items (Desktop) */}
            <div className="hidden lg:flex gap-5 xl:gap-8 items-center">
              {navItems.map((item) => {
                return (
                  <NavLink
                    key={item.path}
                    to={item.path}
                    className={({ isActive }) =>
                      `flex shrink-0 items-center gap-2 whitespace-nowrap text-[14px] xl:text-[15px] font-radio-canada font-bold transition-colors ${
                        isActive ? 'text-[#3B82F6]' : 'text-[#788FA8] hover:text-[#3B82F6]'
                      }`
                    }
                  >
                    {getIcon(item.label)}
                    {item.label}
                  </NavLink>
                );
              })}
            </div>

          </div>

          {/* Nav Items (Mobile) */}
          {isMobileMenuOpen && (
            <div className="lg:hidden w-full flex flex-col gap-2 mt-4 bg-white/40 backdrop-blur-md rounded-2xl p-4 shadow-sm border border-white/20">
              {navItems.map((item) => {
                return (
                  <NavLink
                    key={item.path}
                    to={item.path}
                    onClick={() => setIsMobileMenuOpen(false)}
                    className={({ isActive }) =>
                      `flex items-center gap-3 p-2 rounded-lg text-[16px] font-radio-canada font-bold transition-colors ${
                        isActive ? 'bg-white/50 text-[#3B82F6]' : 'text-gray-700 hover:bg-white/30'
                      }`
                    }
                  >
                    {getIcon(item.label)}
                    {item.label}
                  </NavLink>
                );
              })}
            </div>
          )}
        </nav>
        
        {/* Main Content Area */}
        <main className={`flex-1 w-full max-w-[1400px] mx-auto relative z-0 flex flex-col items-center ${isOverview ? 'px-4 pb-4 pt-2 md:px-6 md:pb-6 md:pt-2' : 'p-4 md:p-6'}`}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
