// Runs in each guest page (streaming sites, Google login) at document start, in the page's
// main world (the webview attaches with contextIsolation:false). Neuters WebAuthn so Google's
// "Choose a passkey" (Windows Hello) dialog never pops and login falls back to password.
try {
  delete window.PublicKeyCredential;
  if (window.navigator && navigator.credentials) {
    navigator.credentials.get = () => Promise.reject(new DOMException('WebAuthn disabled', 'NotAllowedError'));
    navigator.credentials.create = () => Promise.reject(new DOMException('WebAuthn disabled', 'NotAllowedError'));
  }
} catch (e) {}
