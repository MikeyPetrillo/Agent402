/* Theme: light is the default (the :root tokens). A stored choice wins
   (a402-theme = "light" | "dark", set by the toggle); with none stored, the
   OS dark preference stamps dark. Applied HERE, synchronously in <head>, so the
   first paint is already right: no flash, no inline script (CSP). */
(function(){try{var t=localStorage.getItem('a402-theme');}catch(e){}try{if(t==='dark'||(t!=='light'&&window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches)){document.documentElement.setAttribute('data-theme','dark');}}catch(e){}})();
