/* Runs before the page is drawn: someone who is signed in on this device (or opens an app screen) sees "Loading"
   while the app starts, instead of a flash of the visitors' home page. app.js keeps the flag. */
// an invite link (?ref=code): remembered on this device so the sign-up that follows counts for the inviting business
try { const r = new URLSearchParams(location.search).get('ref'); if (r && /^[0-9a-f]{8}$/i.test(r)) localStorage.setItem('st:ref', r.toLowerCase()); } catch (e) { /* storage off */ }
try { if (localStorage.getItem('st:in') === '1' || /^#\/./.test(location.hash)) document.documentElement.classList.add('in'); } catch (e) { /* storage off */ }
