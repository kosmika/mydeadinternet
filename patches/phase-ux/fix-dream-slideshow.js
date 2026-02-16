#!/usr/bin/env node
/**
 * Replace the single dream card with a full-image slideshow
 */
const fs = require('fs');
const path = '/var/www/mydeadinternet/index.html';
let h = fs.readFileSync(path, 'utf8');
const orig = h;
let c = 0;

// 1. Replace dream CSS
const oldDreamCSS = `/* Dream */
    .dream-card {
      background: rgba(255,255,255,0.03);
      border-radius: 14px;
      overflow: hidden;
      border: 1px solid rgba(255,255,255,0.08);
    }
    .dream-image {
      width: 100%;
      height: 220px;
      object-fit: cover;
    }
    .dream-content { padding: 20px; }
    .dream-mood {
      display: inline-block;
      padding: 4px 10px;
      background: rgba(198,139,248,0.2);
      border-radius: 16px;
      font-size: 0.75rem;
      color: #C68BF8;
      margin-bottom: 12px;
    }
    .dream-type {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 16px;
      font-size: 0.75rem;
      margin-bottom: 12px;
      margin-left: 6px;
    }
    .dream-type.hybrid { background: rgba(110,231,183,0.15); color: #6ee7b7; }
    .dream-type.creative { background: rgba(92,140,255,0.12); color: #93b4ff; }
    .dream-type.synthesis { background: rgba(243,156,18,0.12); color: #f39c12; }
    .dream-text {
      color: #cbd5e1;
      line-height: 1.7;
      font-size: 0.92rem;
    }
    .dream-contributors {
      margin-top: 16px;
      font-size: 0.8rem;
      color: #64748b;
    }
    .dream-contributors a { color: #6ee7b7; text-decoration: none; }`;

const newDreamCSS = `/* Dream Slideshow */
    .dream-slideshow {
      position: relative;
      border-radius: 14px;
      overflow: hidden;
      border: 1px solid rgba(255,255,255,0.08);
      background: #0a0a0a;
    }
    .dream-slide {
      display: none;
      position: relative;
    }
    .dream-slide.active {
      display: block;
    }
    .dream-slide img {
      width: 100%;
      aspect-ratio: 16/9;
      object-fit: cover;
      display: block;
    }
    .dream-slide-overlay {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      background: linear-gradient(transparent, rgba(0,0,0,0.85) 40%);
      padding: 40px 20px 20px;
    }
    .dream-slide-meta {
      display: flex;
      gap: 8px;
      align-items: center;
      margin-bottom: 8px;
      flex-wrap: wrap;
    }
    .dream-mood {
      display: inline-block;
      padding: 3px 10px;
      background: rgba(198,139,248,0.25);
      border-radius: 16px;
      font-size: 0.72rem;
      color: #C68BF8;
    }
    .dream-type-tag {
      display: inline-block;
      padding: 3px 10px;
      border-radius: 16px;
      font-size: 0.72rem;
    }
    .dream-type-tag.hybrid { background: rgba(110,231,183,0.2); color: #6ee7b7; }
    .dream-type-tag.creative { background: rgba(92,140,255,0.15); color: #93b4ff; }
    .dream-type-tag.synthesis { background: rgba(243,156,18,0.15); color: #f39c12; }
    .dream-slide-text {
      color: #cbd5e1;
      font-size: 0.85rem;
      line-height: 1.6;
      max-height: 3.2em;
      overflow: hidden;
    }
    .dream-nav {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 16px;
      background: rgba(255,255,255,0.02);
      border-top: 1px solid rgba(255,255,255,0.06);
    }
    .dream-nav-btn {
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.1);
      color: #94a3b8;
      padding: 6px 14px;
      border-radius: 8px;
      cursor: pointer;
      font-family: inherit;
      font-size: 0.78rem;
      transition: background 0.15s;
    }
    .dream-nav-btn:hover {
      background: rgba(255,255,255,0.1);
      color: #e2e8f0;
    }
    .dream-dots {
      display: flex;
      gap: 6px;
      align-items: center;
    }
    .dream-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: rgba(255,255,255,0.15);
      cursor: pointer;
      transition: background 0.2s;
    }
    .dream-dot.active {
      background: #C68BF8;
    }
    .dream-all-link {
      font-size: 0.78rem;
      color: #6ee7b7;
      text-decoration: none;
    }
    .dream-all-link:hover { color: #a7f3d0; }`;

if (h.includes(oldDreamCSS)) {
  h = h.replace(oldDreamCSS, newDreamCSS);
  c++;
  console.log('[OK] Dream CSS replaced');
} else {
  console.log('[SKIP] Dream CSS — marker not found');
}

// 2. Replace dream HTML
const oldDreamHTML = `<div class="dream-card">
        <img src="" alt="Dream" class="dream-image" id="dream-img" style="display:none">
        <div class="dream-content">
          <span class="dream-mood" id="dream-mood-badge">loading</span>
          <span class="dream-type hybrid" id="dream-type-badge" style="display:none"></span>
          <p class="dream-text" id="dream-text">Loading latest dream...</p>
          <p class="dream-contributors" id="dream-contributors">
            <a href="/dreams">View all dreams</a>
          </p>
        </div>
      </div>`;

const newDreamHTML = `<div class="dream-slideshow" id="dreamSlideshow">
        <div id="dreamSlides">
          <div class="dream-slide active">
            <div style="height:300px;display:flex;align-items:center;justify-content:center;color:#64748b;font-size:0.85rem;">Loading dreams...</div>
          </div>
        </div>
        <div class="dream-nav">
          <button class="dream-nav-btn" onclick="dreamPrev()">&larr; Prev</button>
          <div class="dream-dots" id="dreamDots"></div>
          <button class="dream-nav-btn" onclick="dreamNext()">Next &rarr;</button>
        </div>
      </div>`;

if (h.includes(oldDreamHTML)) {
  h = h.replace(oldDreamHTML, newDreamHTML);
  c++;
  console.log('[OK] Dream HTML replaced');
} else {
  console.log('[SKIP] Dream HTML — marker not found');
}

// 3. Replace dream JS
const oldDreamJS = `async function loadLatestDream() {
      try {
        const res = await fetch('/api/dreams?limit=1');
        const dream = (await res.json()).dreams[0];
        if (!dream) return;
        document.getElementById('dream-text').textContent = dream.content.substring(0, 250) + (dream.content.length > 250 ? '...' : '');
        const img = document.getElementById('dream-img');
        if (dream.image_url) {
          img.src = dream.image_url;
          img.style.display = 'block';
        }
        if (dream.mood) document.getElementById('dream-mood-badge').textContent = dream.mood;
        if (dream.type) {
          const typeBadge = document.getElementById('dream-type-badge');
          typeBadge.textContent = dream.type;
          typeBadge.className = 'dream-type ' + dream.type;
          typeBadge.style.display = 'inline-block';
        }
        document.getElementById('dream-contributors').innerHTML =
          'Synthesized by the collective \\u2014 <a href="/dreams" style="color:#6ee7b7;">View all dreams</a>';
      } catch (e) {}
    }
    loadLatestDream();`;

const newDreamJS = `let dreamSlideIdx = 0;
    let dreamSlideCount = 0;
    let dreamAutoTimer = null;

    function showDreamSlide(idx) {
      const slides = document.querySelectorAll('#dreamSlides .dream-slide');
      const dots = document.querySelectorAll('#dreamDots .dream-dot');
      if (!slides.length) return;
      dreamSlideIdx = ((idx % slides.length) + slides.length) % slides.length;
      slides.forEach((s, i) => s.classList.toggle('active', i === dreamSlideIdx));
      dots.forEach((d, i) => d.classList.toggle('active', i === dreamSlideIdx));
    }
    window.dreamPrev = function() { showDreamSlide(dreamSlideIdx - 1); resetDreamAuto(); };
    window.dreamNext = function() { showDreamSlide(dreamSlideIdx + 1); resetDreamAuto(); };
    function resetDreamAuto() {
      clearInterval(dreamAutoTimer);
      dreamAutoTimer = setInterval(() => showDreamSlide(dreamSlideIdx + 1), 8000);
    }

    async function loadDreamSlideshow() {
      try {
        const res = await fetch('/api/dreams?limit=8');
        const data = await res.json();
        const dreams = (data.dreams || []).filter(d => d.image_url);
        if (!dreams.length) return;
        dreamSlideCount = dreams.length;

        const slidesEl = document.getElementById('dreamSlides');
        const dotsEl = document.getElementById('dreamDots');

        slidesEl.innerHTML = dreams.map((d, i) => {
          const excerpt = (d.content || '').substring(0, 160) + ((d.content || '').length > 160 ? '...' : '');
          const typeClass = d.type || 'hybrid';
          return '<div class="dream-slide' + (i === 0 ? ' active' : '') + '">' +
            '<img src="' + escapeHtml(d.image_url) + '" alt="Dream #' + d.id + '" loading="' + (i < 2 ? 'eager' : 'lazy') + '">' +
            '<div class="dream-slide-overlay">' +
              '<div class="dream-slide-meta">' +
                (d.mood ? '<span class="dream-mood">' + escapeHtml(d.mood) + '</span>' : '') +
                '<span class="dream-type-tag ' + typeClass + '">' + typeClass + '</span>' +
                '<a href="/dreams" class="dream-all-link" style="margin-left:auto;">View all \\u2192</a>' +
              '</div>' +
              '<div class="dream-slide-text">' + escapeHtml(excerpt) + '</div>' +
            '</div>' +
          '</div>';
        }).join('');

        dotsEl.innerHTML = dreams.map((_, i) =>
          '<div class="dream-dot' + (i === 0 ? ' active' : '') + '" onclick="showDreamSlide(' + i + '); resetDreamAuto();"></div>'
        ).join('');

        dreamAutoTimer = setInterval(() => showDreamSlide(dreamSlideIdx + 1), 8000);
      } catch (e) { console.error('Dream slideshow:', e); }
    }
    loadDreamSlideshow();`;

if (h.includes(oldDreamJS)) {
  h = h.replace(oldDreamJS, newDreamJS);
  c++;
  console.log('[OK] Dream JS replaced');
} else {
  console.log('[SKIP] Dream JS — marker not found');
}

if (c > 0) {
  fs.writeFileSync(path + '.backup-dreamshow-' + Date.now(), orig);
  fs.writeFileSync(path, h);
  console.log('\\nTotal changes: ' + c);
} else {
  console.log('\\nNo changes made');
}
