import { Outlet, Link } from 'react-router-dom';

export default function PublicLayout() {
  return (
    <div className="min-h-screen bg-white relative">
      <nav className="absolute top-0 left-0 w-full z-50">
        <div className="container-site flex justify-between items-center gap-4 py-5 px-5 md:px-6">
          <Link to="/" className="font-radio-canada font-bold text-[18px] md:text-[20px] leading-[1.2em] text-[#000000] hover:opacity-70 transition-opacity">
            Optiroute
          </Link>
          <Link to="/login" className="font-radio-canada font-medium text-[14px] md:text-[16px] leading-[1.2em] text-[#000000] hover:opacity-70 transition-opacity">
            Log in
          </Link>
        </div>
      </nav>
      <Outlet />
    </div>
  );
}
