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

// On Google's login hosts, present Firefox to page JS too (not just the request header),
// so navigator.userAgent matches and Google doesn't flag the embedded browser as insecure.
try {
  if (['accounts.google.com', 'accounts.youtube.com'].includes(location.host)) {
    const FF = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0';
    Object.defineProperty(navigator, 'userAgent', { get: () => FF });
    Object.defineProperty(navigator, 'appVersion', { get: () => '5.0 (Windows)' });
    Object.defineProperty(navigator, 'vendor', { get: () => '' });        // Firefox: empty
    Object.defineProperty(navigator, 'userAgentData', { get: () => undefined }); // Firefox has none
  }
} catch (e) {}
