/* Theme: dark is the default (the :root tokens). A stored light preference is
   applied HERE, synchronously in <head>, so the first paint is already right -
   no flash, no inline script (CSP). Key: a402-theme = "light" | "dark"; light is the default, so only "dark" stamps. */
(function(){try{var t=localStorage.getItem('a402-theme');if(t==='dark'){document.documentElement.setAttribute('data-theme','dark');}}catch(e){}})();
