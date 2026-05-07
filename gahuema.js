// ─── State ────────────────────────────────────────────────────────────────────
let originalImageData = null;
let debounceTimer = null;
let anchorS = 100; 
let anchorL = 50;  
let gpuRenderer = null;

// ─── Element refs ─────────────────────────────────────────────────────────────
const imageInput        = document.getElementById('imageInput');
const anchorHueInput    = document.getElementById('anchorHue');
const anchorPreview     = document.getElementById('anchorPreview');
const factorInput       = document.getElementById('factor');
const transformSelect   = document.getElementById('transformType');
const processingBackend = document.getElementById('processingBackend');
const backendStatus     = document.getElementById('backendStatus');
const saveBtn           = document.getElementById('saveBtn');
const originalPixelInfo = document.getElementById('originalPixelInfo');
const modifiedPixelInfo = document.getElementById('modifiedPixelInfo');
const dropPrompt        = document.getElementById('dropPrompt');
const workspace         = document.getElementById('workspace');
const dropZone          = document.getElementById('dropZone');
const originalCanvas    = document.getElementById('originalCanvas');
const modifiedCanvas    = document.getElementById('modifiedCanvas');

// ─── Color math ───────────────────────────────────────────────────────────────

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h, s;
  const l = (max + min) / 2;
  if (max === min) {
    h = s = 0;
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return [h * 360, s * 100, l * 100];
}

function hslToRgb(h, s, l) {
  h /= 360; s /= 100; l /= 100;
  let r, g, b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1/3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1/3);
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function rgbToOklch(r, g, b) {
  let f = (c) => (c /= 255) > 0.04045 ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92;
  let lr = f(r), lg = f(g), lb = f(b);
  let l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  let m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  let s = 0.0883024619 * lr + 0.2817188582 * lg + 0.6299787009 * lb;
  let l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
  let L = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_;
  let a = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_;
  let b_ = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_;
  let C = Math.sqrt(a * a + b_ * b_);
  let H = (Math.atan2(b_, a) * 180 / Math.PI + 360) % 360;
  return [L, C, H];
}

function oklchToRgb(L, C, H) {
  let a = C * Math.cos(H * Math.PI / 180);
  let b = C * Math.sin(H * Math.PI / 180);
  let l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  let m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  let s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  let l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
  let lr = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  let lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  let lb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  let fInv = (c) => c > 0.0031308 ? 1.055 * Math.pow(c, 1 / 2.4) - 0.055 : 12.92 * c;
  return [
    Math.max(0, Math.min(255, Math.round(fInv(lr) * 255))),
    Math.max(0, Math.min(255, Math.round(fInv(lg) * 255))),
    Math.max(0, Math.min(255, Math.round(fInv(lb) * 255)))
  ];
}

function normalizeAngle(angle) {
  angle = angle % 360;
  return angle < 0 ? angle + 360 : angle;
}

// ─── Refactored Transform Engine ──────────────────────────────────────────────

const transforms = {
  execute(pixelHue, anchorHue, params) {
    const { mode, factor, m, p, a, preventCrossing } = params;
    let hueDiff = pixelHue - anchorHue;
    if (hueDiff > 180) hueDiff -= 360;
    if (hueDiff < -180) hueDiff += 360;
    if (hueDiff === 0) return anchorHue;
    const sign = Math.sign(hueDiff);
    let transformedHueDiff;
    if (mode === 'add') {
      transformedHueDiff = hueDiff + (sign * factor);
    } else if (mode === 'multiply') {
      transformedHueDiff = hueDiff * factor;
    } else {
      let pHueDiff = sign * Math.pow(Math.abs(hueDiff), p);
      transformedHueDiff = (m * pHueDiff) + (sign * a);
    }
    if (preventCrossing) {
      if (Math.sign(transformedHueDiff) !== sign) transformedHueDiff = 0;
      else if (Math.abs(transformedHueDiff) > 180) transformedHueDiff = 180 * sign;
    }
    return normalizeAngle(anchorHue + transformedHueDiff);
  }
};

// ─── Processing Logic ─────────────────────────────────────────────────────────

function processImageCPU() {
  if (!originalImageData) return;
  const params = getParams();
  const transform = transforms.execute;
  modifiedCanvas.width  = originalImageData.width;
  modifiedCanvas.height = originalImageData.height;
  const ctx = modifiedCanvas.getContext('2d');
  const imageData = new ImageData(new Uint8ClampedArray(originalImageData.data), originalImageData.width, originalImageData.height);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    let h, s_c, l_v;
    if (params.colorSpace === 'oklch') {
      [l_v, s_c, h] = rgbToOklch(data[i], data[i+1], data[i+2]);
      const newHue = transform(h, params.anchorHue, params);
      const [r, g, b] = oklchToRgb(l_v, s_c, newHue);
      data[i] = r; data[i+1] = g; data[i+2] = b;
    } else {
      [h, s_c, l_v] = rgbToHsl(data[i], data[i+1], data[i+2]);
      const newHue = transform(h, params.anchorHue, params);
      const [r, g, b] = hslToRgb(newHue, s_c, l_v);
      data[i] = r; data[i+1] = g; data[i+2] = b;
    }
  }
  ctx.putImageData(imageData, 0, 0);
}

function processImage() {
  if (!originalImageData) return;
  if (shouldUseGpu()) {
    const succeeded = processImageGPU();
    if (succeeded) {
      setBackendStatus('Backend: GPU (WebGL)');
      return;
    }
    setBackendStatus('Backend: Auto fallback to CPU', true);
  } else {
    setBackendStatus('Backend: CPU (JavaScript)');
  }
  processImageCPU();
}

function createGpuRenderer(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: false }) || canvas.getContext('webgl', { premultipliedAlpha: false });
  if (!gl) return null;

  const vertexSrc = `
    attribute vec2 a_pos;
    varying vec2 v_uv;
    void main() {
      v_uv = (a_pos + 1.0) * 0.5;
      gl_Position = vec4(a_pos, 0.0, 1.0);
    }
  `;

  const fragmentSrc = `
    precision highp float;
    varying vec2 v_uv;
    uniform sampler2D u_image;
    uniform float u_anchorHue, u_factor, u_m, u_p, u_a;
    uniform int u_mode, u_preventCrossing, u_colorSpace;

    vec3 rgb2oklch(vec3 c) {
      vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
      vec3 lo = c / 12.92;
      c = vec3(c.r > 0.04045 ? hi.r : lo.r, c.g > 0.04045 ? hi.g : lo.g, c.b > 0.04045 ? hi.b : lo.b);
      float l = 0.4122 * c.r + 0.5363 * c.g + 0.0514 * c.b;
      float m = 0.2119 * c.r + 0.6807 * c.g + 0.1074 * c.b;
      float s = 0.0883 * c.r + 0.2817 * c.g + 0.6300 * c.b;
      float l_ = pow(l, 1.0/3.0), m_ = pow(m, 1.0/3.0), s_ = pow(s, 1.0/3.0);
      float L = 0.2104 * l_ + 0.7936 * m_ - 0.0041 * s_;
      float a = 1.9779 * l_ - 2.4285 * m_ + 0.4506 * s_;
      float b = 0.0259 * l_ + 0.7827 * m_ - 0.8087 * s_;
      return vec3(L, sqrt(a*a + b*b), mod(degrees(atan(b, a)) + 360.0, 360.0));
    }

    vec3 oklch2rgb(vec3 lch) {
      float H = radians(lch.z);
      float a = lch.y * cos(H), b = lch.y * sin(H);
      float l_ = lch.x + 0.3963 * a + 0.2158 * b, m_ = lch.x - 0.1055 * a - 0.0638 * b, s_ = lch.x - 0.0894 * a - 1.2914 * b;
      float l = l_*l_*l_, m = m_*m_*m_, s = s_*s_*s_;
      vec3 rgb = vec3(4.076 * l - 3.307 * m + 0.230 * s, -1.268 * l + 2.609 * m - 0.341 * s, -0.004 * l - 0.703 * m + 1.707 * s);
      vec3 hi = 1.055 * pow(max(rgb, 0.0), vec3(1.0/2.4)) - 0.055;
      vec3 lo = 12.92 * rgb;
      return vec3(rgb.r > 0.00313 ? hi.r : lo.r, rgb.g > 0.00313 ? hi.g : lo.g, rgb.b > 0.00313 ? hi.b : lo.b);
    }

    vec3 rgb2hsl(vec3 c) {
      float maxc = max(c.r, max(c.g, c.b)), minc = min(c.r, min(c.g, c.b));
      float h = 0.0, s = 0.0, l = (maxc + minc) * 0.5;
      if (maxc != minc) {
        float d = maxc - minc;
        s = l > 0.5 ? d / (2.0 - maxc - minc) : d / (maxc + minc);
        if (maxc == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
        else if (maxc == c.g) h = (c.b - c.r) / d + 2.0;
        else h = (c.r - c.g) / d + 4.0;
        h /= 6.0;
      }
      return vec3(h * 360.0, s * 100.0, l * 100.0);
    }

    float hue2rgb(float p, float q, float t) {
      if (t < 0.0) t += 1.0; if (t > 1.0) t -= 1.0;
      if (t < 1.0/6.0) return p + (q - p) * 6.0 * t;
      if (t < 1.0/2.0) return q;
      if (t < 2.0/3.0) return p + (q - p) * (2.0/3.0 - t) * 6.0;
      return p;
    }

    vec3 hsl2rgb(vec3 hsl) {
      float h = hsl.x / 360.0, s = hsl.y / 100.0, l = hsl.z / 100.0;
      if (s == 0.0) return vec3(l);
      float q = l < 0.5 ? l * (1.0 + s) : l + s - l * s;
      float p = 2.0 * l - q;
      return vec3(hue2rgb(p, q, h + 1.0/3.0), hue2rgb(p, q, h), hue2rgb(p, q, h - 1.0/3.0));
    }

    float applyGahuemaTransform(float currentHue) {
      float hueDiff = currentHue - u_anchorHue;
      if (hueDiff > 180.0) hueDiff -= 360.0; if (hueDiff < -180.0) hueDiff += 360.0;
      if (hueDiff == 0.0) return u_anchorHue;
      float transformed = hueDiff, sv = sign(hueDiff);
      if (u_mode == 0) transformed = hueDiff + (sv * u_factor);
      else if (u_mode == 1) transformed = hueDiff * u_factor;
      else transformed = (u_m * sv * pow(abs(hueDiff), u_p)) + (sv * u_a);
      if (u_preventCrossing == 1) {
        if (sign(transformed) != sv && sv != 0.0) transformed = 0.0;
        else if (abs(transformed) > 180.0) transformed = 180.0 * sv;
      }
      return mod(mod(u_anchorHue + transformed, 360.0) + 360.0, 360.0);
    }

    void main() {
      vec4 src = texture2D(u_image, v_uv);
      vec3 res;
      if (u_colorSpace == 1) {
        vec3 lch = rgb2oklch(src.rgb);
        res = oklch2rgb(vec3(lch.xy, applyGahuemaTransform(lch.z)));
      } else {
        vec3 hsl = rgb2hsl(src.rgb);
        res = hsl2rgb(vec3(applyGahuemaTransform(hsl.x), hsl.yz));
      }
      gl_FragColor = vec4(res, src.a);
    }
  `;

  const compile = (type, src) => {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : (console.error(gl.getShaderInfoLog(s)), null);
  };
  const vs = compile(gl.VERTEX_SHADER, vertexSrc), fs = compile(gl.FRAGMENT_SHADER, fragmentSrc);
  if (!vs || !fs) return null;
  const program = gl.createProgram(); gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;

  const positionBuffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

  const texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

  return {
    canvas, gl, program, texture, positionBuffer,
    positionLocation: gl.getAttribLocation(program, 'a_pos'),
    uniformLocations: {
      image: gl.getUniformLocation(program, 'u_image'),
      anchorHue: gl.getUniformLocation(program, 'u_anchorHue'),
      factor: gl.getUniformLocation(program, 'u_factor'),
      m: gl.getUniformLocation(program, 'u_m'), p: gl.getUniformLocation(program, 'u_p'), a: gl.getUniformLocation(program, 'u_a'),
      mode: gl.getUniformLocation(program, 'u_mode'),
      preventCrossing: gl.getUniformLocation(program, 'u_preventCrossing'),
      colorSpace: gl.getUniformLocation(program, 'u_colorSpace')
    }
  };
}

function processImageGPU() {
  if (!originalImageData) return false;
  const w = originalImageData.width, h = originalImageData.height;
  if (!gpuRenderer || gpuRenderer.canvas.width !== w || gpuRenderer.canvas.height !== h) {
    gpuRenderer = createGpuRenderer(w, h);
    if (!gpuRenderer) return false;
  }
  const { gl, program, texture, positionBuffer, positionLocation, uniformLocations } = gpuRenderer;
  const params = getParams();
  const modeMap = { add: 0, multiply: 1, binomial: 2 };

  gl.viewport(0, 0, w, h); gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer); gl.enableVertexAttribArray(positionLocation);
  gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, originalImageData.data);

  gl.uniform1i(uniformLocations.image, 0);
  gl.uniform1f(uniformLocations.anchorHue, params.anchorHue);
  gl.uniform1f(uniformLocations.factor, params.factor);
  gl.uniform1f(uniformLocations.m, params.m);
  gl.uniform1f(uniformLocations.p, params.p);
  gl.uniform1f(uniformLocations.a, params.a);
  gl.uniform1i(uniformLocations.mode, modeMap[params.mode] ?? 0);
  gl.uniform1i(uniformLocations.preventCrossing, params.preventCrossing ? 1 : 0);
  gl.uniform1i(uniformLocations.colorSpace, params.colorSpace === 'oklch' ? 1 : 0);

  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  const out = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
  const flipped = new Uint8ClampedArray(out.length);
  for (let y = 0; y < h; y++) {
    flipped.set(out.subarray(y * w * 4, (y + 1) * w * 4), (h - 1 - y) * w * 4);
  }
  modifiedCanvas.width = w; modifiedCanvas.height = h;
  modifiedCanvas.getContext('2d').putImageData(new ImageData(flipped, w, h), 0, 0);
  return true;
}

function getParams() {
  return {
    colorSpace:      document.getElementById('colorSpace').value,
    mode:            transformSelect.value,
    anchorHue:       parseFloat(anchorHueInput.value),
    factor:          parseFloat(factorInput.value),
    m:               parseFloat(document.getElementById('advM').value) || 0,
    p:               parseFloat(document.getElementById('advP').value) || 1,
    a:               parseFloat(document.getElementById('advA').value) || 0,
    preventCrossing: document.getElementById('preventCrossing').checked,
  };
}

// ─── Initialization & UI Handlers ──────────────────────────────────────────────

function setBackendStatus(message, isFallback = false) {
  if (!backendStatus) return;
  backendStatus.textContent = message;
  backendStatus.style.color = isFallback ? '#f0b56a' : '#8cb4d8';
}

function shouldUseGpu() {
  const choice = processingBackend?.value || 'auto';
  return choice !== 'cpu';
}

function scheduleProcess() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(processImage, 80);
}

function initDynamicSliders() {
  document.querySelectorAll('.dynamic-slider-group').forEach(group => {
    const valInput = group.querySelector('.val-input'), minInput = group.querySelector('.min-input');
    const maxInput = group.querySelector('.max-input'), slider = group.querySelector('.param-slider');
    const sync = () => {
      let v = parseFloat(valInput.value) || 0, min = parseFloat(minInput.value) || 0, max = parseFloat(maxInput.value) || 100;
      if (v < min) { min = v; minInput.value = min; }
      if (v > max) { max = v; maxInput.value = max; }
      slider.min = min; slider.max = max; slider.value = v;
    };
    valInput.addEventListener('input', () => { sync(); if (originalImageData) scheduleProcess(); });
    slider.addEventListener('input', () => { valInput.value = slider.value; if (originalImageData) scheduleProcess(); });
    [minInput, maxInput].forEach(el => el.addEventListener('input', sync));
    sync();
  });
}

const basicControls = document.getElementById('basicControls'), binomialControls = document.getElementById('binomialControls');
const factorLabel = document.getElementById('factorLabel'), factorLabels = { add: 'Shift Amount (°):', multiply: 'Scale Factor:' };

function updateControlVisibility() {
  const m = transformSelect.value;
  binomialControls.style.display = m === 'binomial' ? 'block' : 'none';
  basicControls.style.display = m === 'binomial' ? 'none' : 'flex';
  if (factorLabel && factorLabels[m]) factorLabel.textContent = factorLabels[m];
}

transformSelect.addEventListener('change', () => {
  const m = transformSelect.value, fg = document.querySelector('[data-param="factor"]'), vi = fg.querySelector('.val-input');
  if (m === 'multiply') { fg.querySelector('.min-input').value = -3; fg.querySelector('.max-input').value = 3; vi.value = 1.1; }
  else if (m === 'add') { fg.querySelector('.min-input').value = -180; fg.querySelector('.max-input').value = 180; vi.value = 1.5; }
  vi.dispatchEvent(new Event('input')); updateControlVisibility();
});

function updateAnchorPreview(hue) {
  const ctx = anchorPreview.getContext('2d'), w = anchorPreview.width, h = anchorPreview.height;
  for (let y = 0; y < h; y++) {
    const l = 100 - (y / h) * 100;
    for (let x = 0; x < w; x++) {
      ctx.fillStyle = `hsl(${hue}, ${(x / w) * 100}%, ${l}%)`;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  const cx = (anchorS / 100) * w, cy = ((100 - anchorL) / 100) * h;
  ctx.strokeStyle = 'white'; ctx.lineWidth = 1.5; ctx.beginPath();
  ctx.moveTo(cx-6, cy); ctx.lineTo(cx+6, cy); ctx.moveTo(cx, cy-6); ctx.lineTo(cx, cy+6); ctx.stroke();
}

(function initSLPicker() {
  let picking = false;
  const pick = (e) => {
    const r = anchorPreview.getBoundingClientRect();
    const x = ((e.touches ? e.touches[0].clientX : e.clientX) - r.left) * (anchorPreview.width / r.width);
    const y = ((e.touches ? e.touches[0].clientY : e.clientY) - r.top) * (anchorPreview.height / r.height);
    anchorS = Math.round(Math.max(0, Math.min(100, (x / anchorPreview.width) * 100)));
    anchorL = Math.round(Math.max(0, Math.min(100, 100 - (y / anchorPreview.height) * 100)));
    const hue = parseFloat(anchorHueInput.value) || 0;
    updateAnchorPreview(hue);
    document.getElementById('hueSliderThumb').style.backgroundColor = `hsl(${hue}, ${anchorS}%, ${anchorL}%)`;
  };
  anchorPreview.addEventListener('pointerdown', (e) => { picking = true; anchorPreview.setPointerCapture(e.pointerId); pick(e); });
  anchorPreview.addEventListener('pointermove', (e) => { if (picking) pick(e); });
  anchorPreview.addEventListener('pointerup', () => picking = false);
})();

(function initCircularHueSlider() {
  const track = document.getElementById('hueSlider'), grad = document.getElementById('hueSliderGradient'), thumb = document.getElementById('hueSliderThumb');
  let isDragging = false, dragStartX = 0, dragStartHue = 180;
  const apply = (h) => {
    h = normalizeAngle(h); grad.style.transform = `translateX(${-(h - 180) * (track.offsetWidth / 360)}px)`;
    thumb.style.backgroundColor = `hsl(${h}, ${anchorS}%, ${anchorL}%)`;
    anchorHueInput.value = Math.round(h); updateAnchorPreview(h);
    if (originalImageData) scheduleProcess();
  };
  track.addEventListener('pointerdown', (e) => { isDragging = true; dragStartX = e.clientX; dragStartHue = parseFloat(anchorHueInput.value); track.setPointerCapture(e.pointerId); });
  track.addEventListener('pointermove', (e) => { if (isDragging) apply(dragStartHue - (e.clientX - dragStartX) / (track.offsetWidth / 360)); });
  track.addEventListener('pointerup', () => isDragging = false);
  anchorHueInput.addEventListener('input', (e) => apply(parseFloat(e.target.value) || 0));
  apply(180);
})();

function handleImageFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      originalCanvas.width = modifiedCanvas.width = img.width; originalCanvas.height = modifiedCanvas.height = img.height;
      const oCtx = originalCanvas.getContext('2d'); oCtx.drawImage(img, 0, 0);
      originalImageData = oCtx.getImageData(0, 0, img.width, img.height);
      dropPrompt.style.display = 'none'; workspace.style.display = 'block'; dropZone.classList.add('loaded');
      processImage();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

// Reprocess when the Color Space is toggled
document.getElementById('colorSpace').addEventListener('change', () => {
  if (originalImageData) {
    // We call processImage immediately for a snappier feel 
    // when switching modes
    processImage(); 
  }
});

imageInput.addEventListener('change', (e) => { if (e.target.files[0]) handleImageFile(e.target.files[0]); });
dropPrompt.addEventListener('click', () => imageInput.click());
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', (e) => { e.preventDefault(); dropZone.classList.remove('drag-over'); const f = e.dataTransfer.files[0]; if (f && f.type.startsWith('image/')) handleImageFile(f); });
saveBtn.addEventListener('click', () => {
  const link = document.createElement('a'); link.download = `${document.getElementById('filenameInput')?.value || 'gahuema'}.png`;
  link.href = modifiedCanvas.toDataURL(); link.click();
});
document.getElementById('uploadBtn')?.addEventListener('click', () => imageInput.click());

initDynamicSliders();
updateControlVisibility();
setBackendStatus('Backend: Auto (prefer GPU)');