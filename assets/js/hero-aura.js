// The home hero's slow color field: two soft blobs of the accent drifting over
// the page ground, drawn on a canvas behind the headline. A small hand-written
// WebGL fragment shader, no library. Colors come from the theme tokens
// (--accent, --paper) so both themes stay on the design system, and are read
// again when the theme changes.
//
// Never in the way: the canvas is aria-hidden and takes no pointer events; it
// pauses when the tab is hidden or the hero is scrolled away; under
// prefers-reduced-motion it draws one still frame; without WebGL it does
// nothing and the hero keeps its plain ground.
(function () {
  var canvas = document.querySelector('canvas.hm-aura');
  if (!canvas) return;
  var gl = canvas.getContext('webgl', { alpha: true, antialias: false, premultipliedAlpha: true, powerPreference: 'low-power' });
  if (!gl) return;

  var VERT = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
  var FRAG = [
    'precision mediump float;',
    'uniform vec2 r;uniform float t;uniform vec3 a;uniform vec3 g;',
    'float blob(vec2 uv,vec2 c,float s){float d=length(uv-c);return exp(-d*d/s);}',
    'void main(){',
    '  vec2 uv=gl_FragCoord.xy/r;uv.x*=r.x/r.y;',
    '  float w=r.x/r.y;',
    '  vec2 c1=vec2(w*(.26+.07*sin(t*.11)),.58+.09*cos(t*.13));',
    '  vec2 c2=vec2(w*(.58+.08*cos(t*.09)),.16+.07*sin(t*.07));',
    '  float k=blob(uv,c1,.20)*.70+blob(uv,c2,.14)*.45;',
    '  float grain=(fract(sin(dot(gl_FragCoord.xy,vec2(12.9898,78.233)))*43758.5453)-.5)*.03;',
    '  float al=clamp(k+grain*k,0.,1.);',
    '  gl_FragColor=vec4(mix(a,g,.15)*al,al);',
    '}'
  ].join('\n');

  function shader(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
  }
  var vs = shader(gl.VERTEX_SHADER, VERT), fs = shader(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return;
  var prog = gl.createProgram();
  gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
  gl.useProgram(prog);
  var buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  var loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  var uR = gl.getUniformLocation(prog, 'r'), uT = gl.getUniformLocation(prog, 't');
  var uA = gl.getUniformLocation(prog, 'a'), uG = gl.getUniformLocation(prog, 'g');

  // A token's color as 0-1 rgb, resolved by the browser (any CSS color form).
  var probe = document.createElement('span');
  probe.style.display = 'none';
  document.body.appendChild(probe);
  function tokenRgb(name) {
    probe.style.color = 'var(' + name + ')';
    var m = getComputedStyle(probe).color.match(/[\d.]+/g) || [0, 0, 0];
    return [m[0] / 255, m[1] / 255, m[2] / 255];
  }
  function readColors() {
    var a = tokenRgb('--accent'), g = tokenRgb('--paper');
    gl.uniform3f(uA, a[0], a[1], a[2]);
    gl.uniform3f(uG, g[0], g[1], g[2]);
  }

  // The field is two soft blurred blobs, so it is drawn at half the CSS
  // pixel size and stretched: a quarter of the fragments, no visible change.
  var SCALE = 0.5;
  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 1.5) * SCALE;
    var w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); }
    gl.uniform2f(uR, w, h);
  }

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
  var visible = true, running = false, start = performance.now();
  function draw(now) {
    resize();
    gl.uniform1f(uT, ((now || performance.now()) - start) / 1000 + 40);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  // A slow drift needs no more than about 30 frames a second.
  var FRAME_MS = 33, last = 0;
  function loop(now) {
    if (!running) return;
    if (now - last >= FRAME_MS) { last = now; draw(now); }
    requestAnimationFrame(loop);
  }
  var started = false;
  function update() {
    if (!started) return;
    var should = visible && !document.hidden && !(reduce && reduce.matches);
    if (should && !running) { running = true; requestAnimationFrame(loop); }
    else if (!should) { running = false; draw(); }
  }

  // Start after the page has loaded and the browser is idle, so the field
  // never competes with the headline's first paint.
  function begin() {
    started = true;
    readColors();
    canvas.classList.add('is-on');
    draw();
    update();
  }
  function whenIdle() { if ('requestIdleCallback' in window) requestIdleCallback(begin, { timeout: 2000 }); else setTimeout(begin, 200); }
  if (document.readyState === 'complete') whenIdle(); else window.addEventListener('load', whenIdle, { once: true });
  document.addEventListener('visibilitychange', update);
  if (reduce && reduce.addEventListener) reduce.addEventListener('change', update);
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (es) { visible = es[0].isIntersecting; update(); }).observe(canvas);
  }
  window.addEventListener('resize', function () { if (!running) draw(); });
  // The theme toggle sets data-theme on <html> (the site never follows the OS setting).
  new MutationObserver(function () { readColors(); if (!running) draw(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
})();
