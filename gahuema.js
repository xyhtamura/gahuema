// ─── State ────────────────────────────────────────────────────────────────────

let originalImageData = null;
let debounceTimer = null;
let anchorS = 100; // saturation for preview crosshair / slider thumb color
let anchorL = 50;  // lightness for preview crosshair / slider thumb color

// ─── Element refs ─────────────────────────────────────────────────────────────

const imageInput        = document.getElementById('imageInput');
const anchorHueInput    = document.getElementById('anchorHue');
const anchorPreview     = document.getElementById('anchorPreview');
const factorInput       = document.getElementById('factor');
const transformSelect   = document.getElementById('transformType');
const saveBtn           = document.getElementById('saveBtn');
const originalPixelInfo = document.getElementById('originalPixelInfo');
const modifiedPixelInfo = document.getElementById('modifiedPixelInfo');
const dropPrompt        = document.getElementById('dropPrompt');
const workspace         = document.getElementById('workspace');
const dropZone       = document.getElementById('dropZone');
const originalCanvas = document.getElementById('originalCanvas');
const modifiedCanvas = document.getElementById('modifiedCanvas');

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

/** Wraps an angle into [0, 360). */
function normalizeAngle(angle) {
  angle = angle % 360;
  return angle < 0 ? angle + 360 : angle;
}

/**
 * Shortest signed hue difference from anchor to pixel,
 * in the range (-180, 180].
 * Positive = clockwise from anchor to pixel.
 */
function shortestHueDiff(pixelHue, anchorHue) {
  const raw = normalizeAngle(pixelHue - anchorHue);
  return raw > 180 ? raw - 360 : raw;
}

//GAHUEMA PROCESSING
// ─── Crossing prevention ──────────────────────────────────────────────────────

/**
 * Clamps the proposed move so the hue never crosses the anchor point (0°
 * relative) or the opposite pole (±180° relative).
 */
function applyPreventCrossing(pixelHue, anchorHue, hueDiff, totalMove) {
  const proposedRel = hueDiff + totalMove;

  // Crossed the anchor itself
  if ((hueDiff > 0 && proposedRel <= 0) || (hueDiff < 0 && proposedRel >= 0)) {
    return anchorHue;
  }

  // Crossed the opposite pole
  if (proposedRel > 180 || proposedRel < -180) {
    return normalizeAngle(anchorHue + 180);
  }

  return normalizeAngle(pixelHue + totalMove);
}

// ─── Refactored Transform Engine ──────────────────────────────────────────────

const transforms = {
  // Common engine to handle Add, Multiply, and Binomial
  execute(pixelHue, anchorHue, params) {
    const { mode, factor, m, p, a, preventCrossing } = params;

    // 1. Calculate Shortest Hue Distance [-180, 180]
    let hueDiff = pixelHue - anchorHue;
    if (hueDiff > 180) hueDiff -= 360;
    if (hueDiff < -180) hueDiff += 360;

    if (hueDiff === 0) return anchorHue;

    const sign = Math.sign(hueDiff);
    let transformedHueDiff;

    // 2. Process based on mode
    if (mode === 'add') {
      // Direct shift: hueDiff + (sign * factor)
      transformedHueDiff = hueDiff + (sign * factor);
    } 
    else if (mode === 'multiply') {
      // Scaling: hueDiff * factor
      transformedHueDiff = hueDiff * factor;
    } 
    else if (mode === 'binomial') {
      // Power: Math.sign(hueDiff) * |hueDiff|^p
      let pHueDiff = sign * Math.pow(Math.abs(hueDiff), p);
      // Multiplication: m * pHueDiff
      let mHueDiff = m * pHueDiff;
      // Addition: mHueDiff + (sign * a)
      transformedHueDiff = mHueDiff + (sign * a);
    }

    // 3. Prevent Crossing Logic
    if (preventCrossing) {
      // Crossed the anchor point (sign flip)
      if (Math.sign(transformedHueDiff) !== sign) {
        transformedHueDiff = 0;
      }
      // Crossed the opposite pole (overflow 180)
      else if (Math.abs(transformedHueDiff) > 180) {
        transformedHueDiff = 180 * sign;
      }
    }

    // 4. Final Hue Calculation
    return normalizeAngle(anchorHue + transformedHueDiff);
  }
};

// ─── Updated processImage loop ───────────────────────────────────────────────

function processImage() {
  if (!originalImageData) return;

  const params = getParams();
  // We now use the unified execute function
  const transform = transforms.execute;

  modifiedCanvas.width  = originalImageData.width;
  modifiedCanvas.height = originalImageData.height;
  const ctx = modifiedCanvas.getContext('2d');

  const imageData = new ImageData(
    new Uint8ClampedArray(originalImageData.data),
    originalImageData.width,
    originalImageData.height
  );
  const data = imageData.data;

  for (let i = 0; i < data.length; i += 4) {
    const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    
    // Call the refactored engine
    const newHue = transform(h, params.anchorHue, params);
    
    const [r, g, b] = hslToRgb(newHue, s, l);
    data[i] = r; data[i + 1] = g; data[i + 2] = b;
  }

  ctx.putImageData(imageData, 0, 0);
}

// ─── Read current params from UI ─────────────────────────────────────────────

function getParams() {
  return {
    mode:            transformSelect.value,
    anchorHue:       parseFloat(anchorHueInput.value),
    factor:          parseFloat(factorInput.value),
    m:               parseFloat(document.getElementById('advM').value) || 0,
    p:               parseFloat(document.getElementById('advP').value) || 1,
    a:               parseFloat(document.getElementById('advA').value) || 0,
    preventCrossing: document.getElementById('preventCrossing').checked,
  };
}



function scheduleProcess() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(processImage, 80);
}

//DYNAMIC SLIDERS

// ─── UI: control panel visibility ─────────────────────────────────────────────

function initDynamicSliders() {
  const groups = document.querySelectorAll('.dynamic-slider-group');

  groups.forEach(group => {
    const valInput = group.querySelector('.val-input');
    const minInput = group.querySelector('.min-input');
    const maxInput = group.querySelector('.max-input');
    const slider   = group.querySelector('.param-slider');

    const sync = () => {
      let val = parseFloat(valInput.value) || 0;
      let min = parseFloat(minInput.value) || 0;
      let max = parseFloat(maxInput.value) || 100;

      // 1. Expand range if value exceeds bounds
      if (val < min) {
        min = val;
        minInput.value = min;
      }
      if (val > max) {
        max = val;
        maxInput.value = max;
      }

      // 2. Update slider attributes
      slider.min = min;
      slider.max = max;
      slider.value = val;
    };

    // Listeners
    valInput.addEventListener('input', () => {
      sync();
      if (originalImageData) scheduleProcess();
    });

    slider.addEventListener('input', () => {
      valInput.value = slider.value;
      if (originalImageData) scheduleProcess();
    });

    [minInput, maxInput].forEach(el => {
      el.addEventListener('input', () => {
        sync(); // Re-calc bounds
      });
    });

    // Initialize state
    sync();
  });
}

const basicControls    = document.getElementById('basicControls');
const binomialControls = document.getElementById('binomialControls');
const factorLabel  = document.getElementById('factorLabel');
const factorLabels = {
  add:      'Shift Amount (°):',
  multiply: 'Scale Factor:',
};

function updateControlVisibility() {
  const mode = transformSelect.value;
  
  if (mode === 'binomial') {
    basicControls.style.display = 'none';
    binomialControls.style.display = 'block';
  } else {
    basicControls.style.display = 'flex'; 
    binomialControls.style.display = 'none';
    if (factorLabel && factorLabels[mode]) {
      factorLabel.textContent = factorLabels[mode];
    }
  }
}


transformSelect.addEventListener('change', () => {
  const mode = transformSelect.value;
  const factorGroup = document.querySelector('[data-param="factor"]');
  
  if (mode === 'multiply') {
    factorGroup.querySelector('.min-input').value = -3;
    factorGroup.querySelector('.max-input').value = 3;
    factorGroup.querySelector('.val-input').value = 1.1; // reasonable default for scaling
  } else if (mode === 'add') {
    factorGroup.querySelector('.min-input').value = -180;
    factorGroup.querySelector('.max-input').value = 180;
    factorGroup.querySelector('.val-input').value = 1.5;
  }

  // Re-sync the specific factor slider after changing defaults
  const valIn = factorGroup.querySelector('.val-input');
  valIn.dispatchEvent(new Event('input')); 
  
  updateControlVisibility();
  if (originalImageData) scheduleProcess();
});

updateControlVisibility();

// ─── UI: anchor hue controls ──────────────────────────────────────────────────

function updateAnchorPreview(hue) {
  const canvas = document.getElementById('anchorPreview');
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;

  // Draw the HSL gradient square
  // X-axis: Saturation (0% to 100%)
  // Y-axis: Lightness (100% at top to 0% at bottom)
  for (let y = 0; y < height; y++) {
    const lightness = 100 - (y / height) * 100;
    for (let x = 0; x < width; x++) {
      const saturation = (x / width) * 100;
      ctx.fillStyle = `hsl(${hue}, ${saturation}%, ${lightness}%)`;
      ctx.fillRect(x, y, 1, 1);
    }
  }

  // Draw crosshair at current anchorS / anchorL position
  const cx = (anchorS / 100) * width;
  const cy = ((100 - anchorL) / 100) * height;
  const r = 6;

  // Shadow for visibility on any background
  ctx.save();
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(cx - r - 1, cy); ctx.lineTo(cx + r + 1, cy);
  ctx.moveTo(cx, cy - r - 1); ctx.lineTo(cx, cy + r + 1);
  ctx.stroke();

  ctx.strokeStyle = 'white';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy);
  ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r);
  ctx.stroke();

  // Small circle around the point
  ctx.beginPath();
  ctx.arc(cx, cy, r - 1, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.strokeStyle = 'white';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

// ─── Interactive SL picker on anchorPreview ───────────────────────────────────

(function initSLPicker() {
  const canvas = document.getElementById('anchorPreview');
  let picking = false;

  function pickSL(e) {
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const x = Math.max(0, Math.min(canvas.width,  (clientX - rect.left) * (canvas.width  / rect.width)));
    const y = Math.max(0, Math.min(canvas.height, (clientY - rect.top)  * (canvas.height / rect.height)));

    anchorS = Math.round((x / canvas.width)  * 100);
    anchorL = Math.round(100 - (y / canvas.height) * 100);

    const hue = parseFloat(document.getElementById('anchorHue').value) || 0;

    // Redraw the SL field with updated crosshair
    updateAnchorPreview(hue);

    // Update hue slider thumb to reflect chosen S/L
    const thumb = document.getElementById('hueSliderThumb');
    if (thumb) thumb.style.backgroundColor = `hsl(${hue}, ${anchorS}%, ${anchorL}%)`;
  }

  canvas.addEventListener('pointerdown', (e) => {
    picking = true;
    canvas.setPointerCapture(e.pointerId);
    pickSL(e);
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!picking) return;
    pickSL(e);
  });
  canvas.addEventListener('pointerup',     () => { picking = false; });
  canvas.addEventListener('pointercancel', () => { picking = false; });
})();

// ─── Custom circular hue slider ───────────────────────────────────────────────

(function initCircularHueSlider() {
  const track    = document.getElementById('hueSlider');
  const gradient = document.getElementById('hueSliderGradient');
  const thumb    = document.getElementById('hueSliderThumb');

  // px of drag == 1° of hue  (360° spread across the track width feels natural)
  // We'll compute px-per-degree dynamically from track width.
  let currentHue = parseFloat(anchorHueInput.value) || 180;
  // gradientOffset tracks how many px the gradient has been shifted
  // We map hue -> offset so that hue 0 and hue 360 wrap seamlessly.
  // Strategy: offset = -(currentHue / 360) * trackWidth, clamped to one period.
  let isDragging = false;
  let dragStartX = 0;
  let dragStartHue = currentHue;

  function pxPerDegree() {
    return track.offsetWidth / 360;
  }

  function applyHue(hue) {
    hue = ((hue % 360) + 360) % 360; // normalize
    currentHue = hue;
    // Shift gradient so the selected hue color sits under the center thumb.
    // gradient left is -100% (== -trackWidth), so center of gradient strip
    // corresponds to hue 180 at offset 0. We shift by -(hue - 180) * pxPerDeg.
    const offset = -(hue - 180) * pxPerDegree();
    gradient.style.transform = `translateX(${offset}px)`;
    thumb.style.backgroundColor = `hsl(${hue}, ${anchorS}%, ${anchorL}%)`;
    anchorHueInput.value = Math.round(hue);
    track.setAttribute('aria-valuenow', Math.round(hue));
    updateAnchorPreview(hue);
    if (originalImageData) scheduleProcess();
  }

  // Init
  applyHue(currentHue);

  // Pointer events for drag
  track.addEventListener('pointerdown', (e) => {
    isDragging = true;
    dragStartX = e.clientX;
    dragStartHue = currentHue;
    track.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  track.addEventListener('pointermove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - dragStartX;
    const deltaHue = dx / pxPerDegree();
    applyHue(dragStartHue - deltaHue); // drag right = hue increases (gradient scrolls left)
  });

  track.addEventListener('pointerup',    () => { isDragging = false; });
  track.addEventListener('pointercancel',() => { isDragging = false; });

  // Sync from number input
  anchorHueInput.addEventListener('input', (e) => {
    const value = Math.min(360, Math.max(0, parseFloat(e.target.value) || 0));
    applyHue(value);
  });
})();

// Live reprocess on any parameter control change
document.querySelector('.controls').addEventListener('input', (e) => {
  // Exclude inputs already handled above and the transform select
  if (e.target === anchorHueInput || e.target === transformSelect) return;
  if (originalImageData) scheduleProcess();
});

//PIXEL HOVER AND CANVAS
// ─── UI: pixel info display ───────────────────────────────────────────────────

function getPixelInfo(canvas, x, y) {
  const ctx   = canvas.getContext('2d');
  const pixel = ctx.getImageData(x, y, 1, 1).data;
  const [h, s, l] = rgbToHsl(pixel[0], pixel[1], pixel[2]);
  return { hue: Math.round(h), saturation: Math.round(s), lightness: Math.round(l), pixel, x, y };
}

function renderPixelInfo(infoEl, pixel, x, y, h, s, l, hueDiff = null) {
  const rgb = `rgb(${pixel[0]}, ${pixel[1]}, ${pixel[2]})`;
  infoEl.innerHTML = `
    <div class="color-swatch" style="background-color:${rgb}"></div>
    <div class="info-text">
      Position: (${x}, ${y})<br>
      H: ${Math.round(h)}&deg; &nbsp;S: ${Math.round(s)}% &nbsp;L: ${Math.round(l)}%
      ${hueDiff !== null ? `<br>Hue shift: ${Math.round(hueDiff)}&deg;` : ''}
    </div>`;
}

function updatePixelInfo(e, sourceCanvas, sourceInfoEl, otherCanvas, otherInfoEl) {
  const rect = sourceCanvas.getBoundingClientRect();
  const x = Math.floor((e.clientX - rect.left) * (sourceCanvas.width  / rect.width));
  const y = Math.floor((e.clientY - rect.top)  * (sourceCanvas.height / rect.height));

  if (x < 0 || x >= sourceCanvas.width || y < 0 || y >= sourceCanvas.height) return;

  const srcInfo = getPixelInfo(sourceCanvas, x, y);
  renderPixelInfo(sourceInfoEl, srcInfo.pixel, x, y, srcInfo.hue, srcInfo.saturation, srcInfo.lightness);

  if (otherCanvas.width && otherCanvas.height) {
    const otherInfo  = getPixelInfo(otherCanvas, x, y);
    const diff       = normalizeAngle(otherInfo.hue - srcInfo.hue);
    const signedDiff = diff > 180 ? diff - 360 : diff;
    renderPixelInfo(otherInfoEl, otherInfo.pixel, x, y, otherInfo.hue, otherInfo.saturation, otherInfo.lightness, signedDiff);
  }
}

// ─── UI: click to set anchor from canvas ─────────────────────────────────────

function setAnchorFromCanvas(canvas, e) {
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor((e.clientX - rect.left) * (canvas.width  / rect.width));
  const y = Math.floor((e.clientY - rect.top)  * (canvas.height / rect.height));
  if (x < 0 || x >= canvas.width || y < 0 || y >= canvas.height) return;

  const { hue } = getPixelInfo(canvas, x, y);
  // Dispatch an input event on the number input so the circular slider IIFE syncs
  anchorHueInput.value = hue;
  anchorHueInput.dispatchEvent(new Event('input'));
}

// Single set of listeners per canvas — no duplicates
originalCanvas.addEventListener('mousemove', (e) =>
  updatePixelInfo(e, originalCanvas, originalPixelInfo, modifiedCanvas, modifiedPixelInfo));
modifiedCanvas.addEventListener('mousemove', (e) =>
  updatePixelInfo(e, modifiedCanvas, modifiedPixelInfo, originalCanvas, originalPixelInfo));

originalCanvas.addEventListener('click', (e) => {
  setAnchorFromCanvas(originalCanvas, e);
  updatePixelInfo(e, originalCanvas, originalPixelInfo, modifiedCanvas, modifiedPixelInfo);
});
modifiedCanvas.addEventListener('click', (e) => {
  setAnchorFromCanvas(modifiedCanvas, e);
  updatePixelInfo(e, modifiedCanvas, modifiedPixelInfo, originalCanvas, originalPixelInfo);
});

// ─── Image loading ───────────────────────────────────────────────────

function handleImageFile(file) {
  const reader = new FileReader();
  reader.onload = (event) => {
    const img = new Image();
    img.onload = () => {
      originalCanvas.width  = modifiedCanvas.width  = img.width;
      originalCanvas.height = modifiedCanvas.height = img.height;

      const originalCtx = originalCanvas.getContext('2d');
      originalCtx.drawImage(img, 0, 0);
      originalImageData = originalCtx.getImageData(0, 0, img.width, img.height);

      dropPrompt.style.display = 'none';
      workspace.style.display  = 'block';
      dropZone.classList.add('loaded');

      processImage();
    };
    img.src = event.target.result;
  };
  reader.readAsDataURL(file);
}

imageInput.addEventListener('change', (e) => {
  if (e.target.files[0]) handleImageFile(e.target.files[0]);
});

dropPrompt.addEventListener('click', () => imageInput.click());

// ─── Robust drag-and-drop handling ───
['dragenter', 'dragover'].forEach(eventName => {
  dropZone.addEventListener(eventName, (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
});

dropZone.addEventListener('dragleave', (e) => {
  e.preventDefault();
  // Only remove the visual cue if leaving the actual dropZone entirely, 
  // preventing flicker when dragging over child elements like the canvas.
  if (!dropZone.contains(e.relatedTarget)) {
    dropZone.classList.remove('drag-over');
  }
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith('image/')) handleImageFile(file);
});
// ─── Save ─────────────────────────────────────────────────────────────────────

const filenameInput = document.getElementById('filenameInput');

saveBtn.addEventListener('click', () => {
  if (!modifiedCanvas.width) return;
  
  // Grab the filename, fallback to default if the user cleared the input
  let filename = filenameInput ? filenameInput.value.trim() : 'gahuema-processed';
  if (!filename) filename = 'gahuema-processed';

  const link      = document.createElement('a');
  link.download   = `${filename}.png`;
  link.href       = modifiedCanvas.toDataURL('image/png');
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
});
// ─── Top Upload Button ────────────────────────────────────────────────────────

const uploadBtn = document.getElementById('uploadBtn');

if (uploadBtn) {
  uploadBtn.addEventListener('click', () => {
    imageInput.click();
  });
}

initDynamicSliders();