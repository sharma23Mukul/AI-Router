import { GoogleAuthProvider, signInWithPopup } from 'firebase/auth';
import { auth } from './firebase';

// Firebase waits several seconds after a popup closes in case sign-in is still
// finishing. Watch the popup directly so a cancelled chooser releases the form
// promptly, while allowing a brief moment for a successful sign-in to settle.
export function signInWithGooglePopup() {
  const previousUser = auth.currentUser;
  const provider = new GoogleAuthProvider();

  return new Promise((resolve, reject) => {
    let settled = false;
    let popupHadFocus = false;
    let popupWindow;
    let focusTimer;
    let deadlineTimer;
    let popupPoll;
    let closeTimer;
    const originalOpen = window.open;

    const restoreOpen = () => {
      if (window.open === capturePopup) window.open = originalOpen;
    };

    const cleanup = () => {
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('focus', handleFocus);
      restoreOpen();
      clearTimeout(focusTimer);
      clearTimeout(deadlineTimer);
      clearTimeout(closeTimer);
      clearInterval(popupPoll);
    };

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };

    const handleBlur = () => {
      popupHadFocus = true;
      clearTimeout(focusTimer);
    };

    const handleFocus = () => {
      if (!popupHadFocus) return;
      if (popupWindow) return;
      clearTimeout(focusTimer);
      focusTimer = setTimeout(() => {
        if (auth.currentUser === previousUser) {
          finish(reject, { code: 'auth/popup-closed-by-user' });
        }
      }, 1000);
    };

    const capturePopup = (...args) => {
      const openedWindow = originalOpen.apply(window, args);
      if (openedWindow && String(args[0]).includes('/__/auth/handler')) {
        popupWindow = openedWindow;
        clearTimeout(focusTimer);
        restoreOpen();
        popupPoll = setInterval(() => {
          if (!popupWindow.closed) return;
          clearInterval(popupPoll);
          closeTimer = setTimeout(() => {
            if (auth.currentUser === previousUser) {
              finish(reject, { code: 'auth/popup-closed-by-user' });
            }
          }, 750);
        }, 100);
      }
      return openedWindow;
    };

    window.open = capturePopup;
    window.addEventListener('blur', handleBlur);
    window.addEventListener('focus', handleFocus);
    deadlineTimer = setTimeout(() => {
      finish(reject, { code: 'auth/popup-timeout' });
    }, 60000);

    signInWithPopup(auth, provider).then(
      (credential) => finish(resolve, credential),
      (error) => finish(reject, error),
    );
  });
}
