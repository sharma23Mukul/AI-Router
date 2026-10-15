import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { 
  createUserWithEmailAndPassword,
  updatePassword,
  updateProfile,
  getAdditionalUserInfo
} from 'firebase/auth';
import { auth } from '../utils/firebase';
import { syncUser, handleFirebaseError } from '../utils/auth';
import { signInWithGooglePopup } from '../utils/googlePopup';

const SignupPage = () => {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  
  // State for Google Signup intercept
  const [googleUser, setGoogleUser] = useState(null);

  const getPasswordError = () => {
    if (!password) return null;
    if (password.length < 8) return 'Password must be at least 8 characters long';
    if (!/[A-Za-z]/.test(password)) return 'Password must contain at least one letter';
    if (!/\d/.test(password)) return 'Password must contain at least one number';
    return null;
  };

  const passwordError = getPasswordError();
  const isPasswordValid = password.length > 0 && !passwordError;

  const handleSignup = async (e) => {
    e.preventDefault();
    
    if (passwordError) {
      setError(passwordError);
      return;
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    
    setLoading(true);
    setError('');
    
    try {
      const userCredential = await createUserWithEmailAndPassword(auth, email, password);
      
      // Save the name they typed to their Firebase Auth profile
      if (name) {
        await updateProfile(userCredential.user, { displayName: name });
      }

      const idToken = await userCredential.user.getIdToken(true);
      await syncUser(idToken, name);
      navigate('/dashboard/overview');
    } catch (err) {
      setError(handleFirebaseError(err));
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignup = async () => {
    setLoading(true);
    setError('');
    try {
      const userCredential = await signInWithGooglePopup();
      
      const additionalInfo = getAdditionalUserInfo(userCredential);
      if (!additionalInfo.isNewUser) {
        // They are an existing user trying to sign up again.
        await auth.signOut();
        throw { code: 'auth/email-already-in-use' };
      }

      const hasPassword = userCredential.user.providerData.some(p => p.providerId === 'password');
      
      if (hasPassword) {
        // Already has a password, just sync and login (unlikely for new user, but safe)
        const idToken = await userCredential.user.getIdToken(true);
        await syncUser(idToken, name || userCredential.user.displayName || '');
        navigate('/dashboard/overview');
      } else {
        // Intercept to ask for password
        setGoogleUser(userCredential.user);
        setName(userCredential.user.displayName || userCredential.user.email.split('@')[0]);
      }
    } catch (err) {
      setError(handleFirebaseError(err));
    } finally {
      setLoading(false);
    }
  };

  const handleCompleteGoogleProfile = async (e) => {
    e.preventDefault();
    if (passwordError) {
      setError(passwordError);
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setLoading(true);
    setError('');
    
    try {
      await updatePassword(googleUser, password);
      if (name !== googleUser.displayName) {
        await updateProfile(googleUser, { displayName: name });
      }
      
      const idToken = await googleUser.getIdToken(true);
      await syncUser(idToken, name);
      navigate('/dashboard/overview');
    } catch (err) {
      setError(handleFirebaseError(err));
    } finally {
      setLoading(false);
    }
  };

  // Render the "Complete Profile" form if a Google user was intercepted
  if (googleUser) {
    return (
      <div 
        className="min-h-screen w-full flex flex-col items-center py-12 md:justify-center overflow-y-auto"
        style={{ background: 'linear-gradient(180deg, rgba(168, 211, 255, 1) 0%, rgba(255, 244, 223, 1) 100%)' }}
      >
        <div className="flex flex-col items-center w-full px-4 md:px-0 mt-8 md:mt-0">
          <div 
            className="bg-white/60 backdrop-blur-md flex flex-col items-center justify-center shadow-sm w-full max-w-[820px] min-h-[520px] rounded-[24px] sm:rounded-[40px] py-[48px]"
          >
            <form onSubmit={handleCompleteGoogleProfile} className="flex flex-col gap-5 w-full max-w-[400px] px-4 md:px-0">
              <h2 className="font-radio-canada text-3xl font-semibold text-center text-text-primary mb-2">
                Complete your profile
              </h2>
              <p className="text-center font-source-serif text-[14px] text-[#6C6C6C] mb-2">
                Set a password so you can log in with your email later.
              </p>
              
              <div className="flex flex-col gap-1.5">
                <label className="font-source-serif text-[16px] text-text-primary">
                  Full Name
                </label>
                <input 
                  type="text" 
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="px-4 py-3 rounded-xl border border-border-divider bg-white/80 focus:outline-none focus:border-[#A8D3FF] font-source-serif text-[16px]"
                  placeholder="Enter your name"
                  required
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="font-source-serif text-[16px] text-text-primary">
                  Create Password
                </label>
                <div className="relative">
                  <input 
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className={`w-full px-4 py-3 pr-12 rounded-xl border ${passwordError ? 'border-red-400 focus:border-red-500' : 'border-border-divider focus:border-[#A8D3FF]'} bg-white/80 focus:outline-none font-source-serif text-[16px]`}
                    placeholder="Create a password"
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
                {passwordError && (
                  <span className="text-red-500 text-[13px] font-source-serif mt-1">{passwordError}</span>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <label className={`font-source-serif text-[16px] ${isPasswordValid ? 'text-text-primary' : 'text-gray-400'}`}>
                  Confirm Password
                </label>
                <div className="relative">
                  <input 
                    type={showConfirmPassword ? "text" : "password"}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    disabled={!isPasswordValid}
                    className={`w-full px-4 py-3 pr-12 rounded-xl border border-border-divider bg-white/80 focus:outline-none focus:border-[#A8D3FF] font-source-serif text-[16px] ${!isPasswordValid ? 'opacity-50 cursor-not-allowed' : ''}`}
                    placeholder="Confirm your password"
                    required
                  />
                  <button
                    type="button"
                    disabled={!isPasswordValid}
                    onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                    className={`absolute right-4 top-1/2 -translate-y-1/2 focus:outline-none ${!isPasswordValid ? 'text-gray-300 cursor-not-allowed' : 'text-gray-400 hover:text-gray-600'}`}
                  >
                    {showConfirmPassword ? (
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>
                    ) : (
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
                    )}
                  </button>
                </div>
              </div>

              {error && (
                <p className="text-red-500 text-[14px] font-source-serif text-center">{error}</p>
              )}
              
              <button 
                type="submit"
                disabled={loading}
                className="mt-4 bg-[#000000] text-white font-geist-mono font-medium text-[14px] py-[14px] px-6 rounded-[12px] hover:bg-gray-800 transition-colors w-full disabled:bg-gray-400"
              >
                {loading ? 'Saving...' : 'Complete Account'}
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div 
      className="min-h-screen w-full flex flex-col items-center py-12 md:justify-center overflow-y-auto"
      style={{ background: 'linear-gradient(180deg, rgba(168, 211, 255, 1) 0%, rgba(255, 244, 223, 1) 100%)' }}
    >
      <div className="flex flex-col items-center w-full px-4 md:px-0 mt-8 md:mt-0">
        <Link 
          to="/" 
          className="font-source-serif font-bold text-[18px] leading-[1.2em] tracking-[-0.03em] text-[#000000] mb-[40px] md:mb-[60px]"
        >
          ← Back to Home
        </Link>

        <div 
          className="bg-white/60 backdrop-blur-md flex flex-col items-center justify-center shadow-sm w-full max-w-[820px] min-h-[520px] rounded-[24px] sm:rounded-[40px] py-[48px]"
        >
          <form onSubmit={handleSignup} className="flex flex-col gap-5 w-full max-w-[400px] px-4 md:px-0">
            <h2 className="font-radio-canada text-3xl font-semibold text-center text-text-primary mb-2">
              Create your account
            </h2>
            
            <div className="flex flex-col gap-1.5">
              <label className="font-source-serif text-[16px] text-text-primary">
                Full Name
              </label>
              <input 
                type="text" 
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="px-4 py-3 rounded-xl border border-border-divider bg-white/80 focus:outline-none focus:border-[#A8D3FF] font-source-serif text-[16px]"
                placeholder="Enter your name"
                required
              />
            </div>

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
                  className={`w-full px-4 py-3 pr-12 rounded-xl border ${passwordError ? 'border-red-400 focus:border-red-500' : 'border-border-divider focus:border-[#A8D3FF]'} bg-white/80 focus:outline-none font-source-serif text-[16px]`}
                  placeholder="Create a password"
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
              {passwordError && (
                <span className="text-red-500 text-[13px] font-source-serif mt-1">{passwordError}</span>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <label className={`font-source-serif text-[16px] ${isPasswordValid ? 'text-text-primary' : 'text-gray-400'}`}>
                Confirm Password
              </label>
              <div className="relative">
                <input 
                  type={showConfirmPassword ? "text" : "password"}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  disabled={!isPasswordValid}
                  className={`w-full px-4 py-3 pr-12 rounded-xl border border-border-divider bg-white/80 focus:outline-none focus:border-[#A8D3FF] font-source-serif text-[16px] ${!isPasswordValid ? 'opacity-50 cursor-not-allowed' : ''}`}
                  placeholder="Confirm your password"
                  required
                />
                <button
                  type="button"
                  disabled={!isPasswordValid}
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  className={`absolute right-4 top-1/2 -translate-y-1/2 focus:outline-none ${!isPasswordValid ? 'text-gray-300 cursor-not-allowed' : 'text-gray-400 hover:text-gray-600'}`}
                >
                  {showConfirmPassword ? (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>
                  ) : (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
                  )}
                </button>
              </div>
            </div>

            {error && (
              <p className="text-red-500 text-[14px] font-source-serif text-center">{error}</p>
            )}
            
            <div className="flex flex-col gap-3 mt-2">
              <button 
                type="submit"
                disabled={loading}
                className="bg-[#000000] text-white font-geist-mono font-medium text-[14px] py-[14px] px-6 rounded-[12px] hover:bg-gray-800 transition-colors w-full disabled:bg-gray-400"
              >
                {loading ? 'Creating account...' : 'Sign Up'}
              </button>

              <button 
                type="button"
                onClick={handleGoogleSignup}
                disabled={loading}
                className="bg-white text-[#000000] border border-[#E5E5E5] flex items-center justify-center gap-2 font-geist-mono font-medium text-[14px] py-[14px] px-6 rounded-[12px] hover:bg-gray-50 transition-colors w-full disabled:bg-gray-200"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                  <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                  <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                  <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                  <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                </svg>
                Sign up with Google
              </button>
            </div>

            <p className="text-center font-source-serif text-[14px] text-[#6C6C6C]">
              Already have an account?{' '}
              <Link to="/login" className="text-[#000000] font-bold hover:underline">
                Log in
              </Link>
            </p>
          </form>
        </div>
      </div>
    </div>
  );
};

export default SignupPage;
