// One fullscreen triangle, no textures or third-party renderer. All coordinates
// are procedural; this decorative canvas never sees account or form data.
const vertexSource = `
attribute vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }
`;
const fragmentSource = `
precision mediump float;
uniform vec2 resolution;
uniform float time;
uniform float dark;

float water(vec2 p) {
  p += vec2(sin(p.y * 1.7 + time * .16), cos(p.x * 1.4 - time * .12)) * .28;
  return sin(p.x * 2.8 + p.y * 1.9 + time * .22)
    + sin(p.x * -1.8 + p.y * 3.1 - time * .18) * .55
    + sin(p.x * 4.5 + p.y * 2.2 + time * .13) * .18;
}
void main() {
  vec2 uv = gl_FragCoord.xy / resolution;
  vec2 p = (uv - .5) * vec2(resolution.x / resolution.y, 1.0) * 3.0;
  float w = water(p);
  float depth = smoothstep(-1.5, 1.4, w + (uv.y - .5) * 1.2);
  vec3 deep = mix(vec3(.18, .43, .40), vec3(.025, .13, .14), dark);
  vec3 shallow = mix(vec3(.72, .85, .77), vec3(.13, .34, .32), dark);
  vec3 pearl = mix(vec3(.95, .96, .87), vec3(.32, .51, .44), dark);
  vec3 color = mix(deep, shallow, depth);
  color = mix(color, pearl, smoothstep(.3, 1.0, uv.y) * .72);
  // Broad refracted ribbons with thin caustic edges, softened behind the form.
  float ribbon = exp(-abs(w - .35) * 5.0);
  float caustic = pow(max(0.0, 1.0 - abs(w - .35)), 28.0);
  color += vec3(.18, .22, .16) * ribbon * mix(.35, .17, dark);
  color += vec3(.32, .37, .25) * caustic * mix(.22, .10, dark);
  float vignette = smoothstep(.2, 1.25, length((uv - .5) * vec2(1.0, .75)));
  color *= 1.0 - vignette * .16;
  gl_FragColor = vec4(color, 1.0);
}
`;

export interface WaterSurface {
  setPaused(paused: boolean): void;
  dispose(): void;
}

export function startWater(canvas: HTMLCanvasElement): WaterSurface {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const darkMode = matchMedia('(prefers-color-scheme: dark)');
  let paused = false;
  let disposed = false;
  let lost = false;
  let frame = 0;
  let lastTime: number | undefined;
  let elapsed = 0;
  let draw: (() => void) | undefined;
  let release = () => {};

  const cancel = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    lastTime = undefined;
  };
  const canAnimate = () => !disposed && !lost && !paused && !reduced.matches && !document.hidden;
  const tick = (now: number) => {
    frame = 0;
    if (!canAnimate() || !draw) return;
    // Cap drawing at 30 fps and freeze time while hidden or paused.
    if (lastTime === undefined || now - lastTime >= 1000 / 30) {
      if (lastTime !== undefined) elapsed += Math.min(now - lastTime, 100) / 1000;
      lastTime = now;
      draw();
    }
    frame = requestAnimationFrame(tick);
  };
  const refresh = () => {
    cancel();
    if (disposed || lost || document.hidden) return;
    draw?.();
    if (canAnimate() && draw) frame = requestAnimationFrame(tick);
  };

  const initialize = () => {
    const gl = canvas.getContext('webgl', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'low-power',
      preserveDrawingBuffer: false,
    });
    if (!gl) return;
    const shaders: WebGLShader[] = [];
    let program: WebGLProgram | null = null;
    let buffer: WebGLBuffer | null = null;
    release = () => {
      if (buffer) gl.deleteBuffer(buffer);
      if (program) gl.deleteProgram(program);
      shaders.forEach((shader) => gl.deleteShader(shader));
    };
    try {
      const compile = (type: number, source: string) => {
        const shader = gl.createShader(type);
        if (!shader) throw new Error('Shader unavailable');
        shaders.push(shader);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
          throw new Error('Shader unsupported');
        return shader;
      };
      program = gl.createProgram();
      if (!program) throw new Error('WebGL unavailable');
      gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSource));
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Program unsupported');
      gl.useProgram(program);
      buffer = gl.createBuffer();
      if (!buffer) throw new Error('Buffer unavailable');
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const position = gl.getAttribLocation(program, 'position');
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      const resolution = gl.getUniformLocation(program, 'resolution');
      const time = gl.getUniformLocation(program, 'time');
      const dark = gl.getUniformLocation(program, 'dark');
      draw = () => {
        // A soft background needs fewer pixels than the UI. Limit GPU work on
        // Retina/mobile displays and very large desktop windows alike.
        const scale = Math.min(
          window.devicePixelRatio || 1,
          1.25,
          1600 / Math.max(innerWidth, innerHeight),
        );
        const width = Math.max(1, Math.round(innerWidth * scale));
        const height = Math.max(1, Math.round(innerHeight * scale));
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
          gl.viewport(0, 0, width, height);
        }
        const theme = document.documentElement.dataset.theme;
        gl.uniform2f(resolution, width, height);
        gl.uniform1f(time, elapsed);
        gl.uniform1f(dark, theme === 'dark' || (theme !== 'light' && darkMode.matches) ? 1 : 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        canvas.dataset.ready = 'true';
      };
      refresh();
    } catch {
      release();
      release = () => {};
      draw = undefined;
      delete canvas.dataset.ready;
    }
  };
  const onLost = (event: Event) => {
    event.preventDefault();
    lost = true;
    cancel();
    draw = undefined;
    // The context owns the now-invalid objects. Recreate them on restoration.
    release = () => {};
    delete canvas.dataset.ready;
  };
  const onRestored = () => {
    lost = false;
    initialize();
  };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);
  window.addEventListener('resize', refresh);
  document.addEventListener('visibilitychange', refresh);
  reduced.addEventListener('change', refresh);
  darkMode.addEventListener('change', refresh);
  const observer = new MutationObserver(refresh);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  // Some restricted browsers throw instead of returning null from getContext.
  try {
    initialize();
  } catch {
    delete canvas.dataset.ready;
  }
  return {
    setPaused(value) {
      paused = value;
      refresh();
    },
    dispose() {
      disposed = true;
      cancel();
      observer.disconnect();
      window.removeEventListener('resize', refresh);
      document.removeEventListener('visibilitychange', refresh);
      reduced.removeEventListener('change', refresh);
      darkMode.removeEventListener('change', refresh);
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      release();
      draw = undefined;
      delete canvas.dataset.ready;
    },
  };
}
