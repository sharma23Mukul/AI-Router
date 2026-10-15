import React, { createContext, useContext, useEffect, useState } from 'react';
import { onAuthStateChanged, signOut as firebaseSignOut } from 'firebase/auth';
import { auth } from './firebase';

const AuthContext = createContext();

export const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8000';

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  const signOut = () => {
    return firebaseSignOut(auth);
  };

  return (
    <AuthContext.Provider value={{ user, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}

export async function getAuthHeaders() {
  if (!auth.currentUser) return {};
  const token = await auth.currentUser.getIdToken();
  return { 'Authorization': `Bearer ${token}` };
}

export async function syncUser(idToken, organizationName) {
  const body = {};
  if (organizationName) {
    body.organization_name = organizationName;
  }
  const response = await fetch(`${API_BASE}/api/auth/sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${idToken}`,
    },
    body: JSON.stringify(body),
  });
  
  if (!response.ok) {
    throw new Error('Failed to sync user');
  }
  return response.json();
}

export function handleFirebaseError(error) {
  switch (error.code) {
    case 'auth/invalid-credential':
      return 'Incorrect email or password. If you signed up with Google, use "Sign in with Google".';
    case 'auth/account-exists-with-different-credential':
      return 'An account already exists with the same email address but different sign-in credentials. Sign in using a provider associated with this email address.';
    case 'auth/wrong-password':
      return 'Incorrect password';
    case 'auth/user-not-found':
      return 'User with this email does not exist. Please sign up first.';
    case 'auth/email-already-in-use':
      return 'User with this email already exist try log in';
    case 'auth/weak-password':
      return 'Password should be at least 6 characters';
    case 'auth/invalid-email':
      return 'Invalid email address';
    case 'auth/too-many-requests':
      return 'Too many attempts. Please try again later';
    case 'auth/popup-closed-by-user':
      return 'Google sign-in was cancelled. Please try again.';
    case 'auth/popup-timeout':
      return 'Google sign-in took too long. Please try again.';
    default:
      return error.message;
  }
}

export async function apiCall(url, options = {}) {
  const headers = await getAuthHeaders();
  const mergedHeaders = { ...headers, ...(options.headers || {}) };
  const res = await fetch(url, { ...options, headers: mergedHeaders });
  if (res.status === 401) {
    firebaseSignOut(auth);
    window.location.href = '/login';
    throw new Error('Session expired');
  }
  return res;
}

