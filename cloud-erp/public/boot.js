/* Runs before the page is drawn: someone who is signed in on this device (or opens an app screen) sees "Loading"
   while the app starts, instead of a flash of the visitors' home page. app.js keeps the flag. */
try { if (localStorage.getItem('st:in') === '1' || /^#\/./.test(location.hash)) document.documentElement.classList.add('in'); } catch (e) { /* storage off */ }
