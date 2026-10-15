import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { 
  signInWithEmailAndPassword, 
  sendPasswordResetEmail,
  getAdditionalUserInfo
} from 'firebase/auth';
import { auth } from '../utils/firebase';
import { syncUser, handleFirebaseError } from '../utils/auth';
import { signInWithGooglePopup } from '../utils/googlePopup';

const LoginPage = () => {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [resetEmail, setResetEmail] = useState('');
  const [showReset, setShowReset] = useState(false);
  const [resetMsg, setResetMsg] = useState('');

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    
    try {
      const userCredential = await signInWithEmailAndPassword(auth, email, password);
      const idToken = await userCredential.user.getIdToken(true);
      await syncUser(idToken);
      navigate('/dashboard/overview');
    } catch (err) {
      setError(handleFirebaseError(err));
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleLogin = async () => {
    setLoading(true);
    setError('');
    try {
      const userCredential = await signInWithGooglePopup();
      
      const additionalInfo = getAdditionalUserInfo(userCredential);
      if (additionalInfo.isNewUser) {
        // User does not exist in our system. Clean up the Firebase account it just created.
        await userCredential.user.delete();
        throw new Error('user-not-found-google');
      }

      const idToken = await userCredential.user.getIdToken(true);
      await syncUser(idToken);
      navigate('/dashboard/overview');
    } catch (err) {
      if (err.message === 'user-not-found-google') {
        setError('User with this email does not exist. Please sign up first.');
      } else {
        setError(handleFirebaseError(err));
      }
    } finally {
      setLoading(false);
    }
  };

  const handleResetPassword = async (e) => {
    e.preventDefault();
    if (!resetEmail) return;
    setLoading(true);
    setError('');
    setResetMsg('');
    try {
      await sendPasswordResetEmail(auth, resetEmail);
      setResetMsg('Password reset email sent! Check your inbox.');
    } catch (err) {
      setError(handleFirebaseError(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div 
      className="min-h-screen w-full flex flex-col items-center py-12 md:justify-center overflow-y-auto"
      style={{ background: 'linear-gradient(180deg, rgba(168, 211, 255, 1) 0%, rgba(255, 244, 223, 1) 100%)' }}
    >
      <div className="flex flex-col items-center w-full px-4 md:px-0 mt-8 md:mt-0">
        <Link 
          to="/" 
          className="font-source-serif font-bold text-[18px] leading-[1.2em] tracking-[-0.03em] text-[#000000] mb-[40px] md:mb-[80px]"
        >
          ← Back to Home
        </Link>

        <div 
          className="bg-white/60 backdrop-blur-md flex flex-col items-center justify-center shadow-sm w-full max-w-[820px] h-auto rounded-[24px] sm:rounded-[40px] py-10"
        >
          <form onSubmit={handleLogin} className="flex flex-col gap-6 w-full max-w-[400px] px-4 md:px-0">
            <h2 className="font-radio-canada text-3xl font-semibold text-center text-text-primary mb-2">
              Welcome Back
            </h2>
            
            <div className="flex flex-col gap-1.5">
              <label className="font-source-serif text-[16px] text-text-primary">
                Email
              </label>
              <input 
                type="email" 
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="px-4 py-3 rounded-xl border border-border-divider bg-white/80 focus:outline-none focus:border-[#A8D3FF] font-source-serif text-[16px]"
                placeholder="Enter your email"
                required
              />
            </div>
            
            <div className="flex flex-col gap-1.5">
              <label className="font-source-serif text-[16px] text-text-primary">
                Password
              </label>
              <div className="relative">
                <input 
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-4 py-3 pr-12 rounded-xl border border-border-divider bg-white/80 focus:outline-none focus:border-[#A8D3FF] font-source-serif text-[16px]"
                  placeholder="Enter your password"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 focus:outline-none"
                >
                  {showPassword ? (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>
                  ) : (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
                  )}
                </button>
              </div>
              <button 
                type="button" 
                onClick={() => setShowReset(!showReset)}
                className="self-end text-sm text-[#6C6C6C] hover:text-[#000000] font-source-serif mt-1"
              >
                Forgot password?
              </button>
            </div>
            
            {showReset && (
              <div className="flex flex-col gap-2 p-3 bg-white/40 rounded-xl border border-[#A8D3FF]">
                <input 
                  type="email" 
                  value={resetEmail}
                  onChange={(e) => setResetEmail(e.target.value)}
                  className="px-3 py-2 rounded-lg border border-border-divider bg-white/80 focus:outline-none font-source-serif text-[14px]"
                  placeholder="Enter email to reset"
                />
                <button
                  type="button"
                  onClick={handleResetPassword}
                  disabled={loading || !resetEmail}
                  className="bg-[#000000] text-white font-geist-mono text-[12px] py-2 px-4 rounded-lg hover:bg-gray-800 transition-colors disabled:bg-gray-400"
                >
                  Send Reset Email
                </button>
                {resetMsg && <p className="text-green-600 text-xs">{resetMsg}</p>}
              </div>
            )}
            
            {error && (
              <p className="text-red-500 font-source-serif text-[14px]">{error}</p>
            )}
            
            <div className="flex flex-col gap-3">
              <button 
                type="submit"
                disabled={loading}
                className="bg-[#000000] text-white font-geist-mono font-medium text-[14px] py-[14px] px-6 rounded-[12px] hover:bg-gray-800 transition-colors w-full disabled:bg-gray-400"
              >
                {loading ? 'Logging in...' : 'Log In'}
              </button>
              
              <button 
                type="button"
                onClick={handleGoogleLogin}
                disabled={loading}
                className="bg-white text-[#000000] border border-[#E5E5E5] flex items-center justify-center gap-2 font-geist-mono font-medium text-[14px] py-[14px] px-6 rounded-[12px] hover:bg-gray-50 transition-colors w-full disabled:bg-gray-200"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                  <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                  <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                  <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                  <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                </svg>
                Sign in with Google
              </button>
            </div>

            <p className="text-center font-source-serif text-[14px] text-[#6C6C6C]">
              Don't have an account?{' '}
              <Link to="/signup" className="text-[#000000] font-bold hover:underline">
                Sign up
              </Link>
            </p>
          </form>
        </div>
      </div>
    </div>
  );
};

export default LoginPage;
