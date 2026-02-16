#!/usr/bin/env node
/**
 * Replace single dream card with full-image slideshow
 * Handles CRLF line endings
 */
const fs = require('fs');
const fpath = '/var/www/mydeadinternet/index.html';
let h = fs.readFileSync(fpath, 'utf8');
const orig = h;
let c = 0;

// Normalize line endings for matching
function norm(s) { return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n'); }

let hn = norm(h);

// 1. Replace dream CSS — find by unique markers
const cssStart = '/* Dream */';
const cssEnd = '.dream-contributors a { color: #6ee7b7; text-decoration: none; }';
const si1 = hn.indexOf(cssStart);
const ei1 = hn.indexOf(cssEnd);
if (si1 !== -1 && ei1 !== -1) {
  const newCSS = `/* Dream Slideshow */
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
    .dream-slide.active { display: block; }
    .dream-slide img {
      width: 100%;
      aspect-ratio: 16/9;
      object-fit: cover;
      display: block;
    }
    .dream-slide-overlay {
      position: absolute;
      bottom: 0; left: 0; right: 0;
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
    .dream-mood-tag {
      padding: 3px 10px;
      background: rgba(198,139,248,0.25);
      border-radius: 16px;
      font-size: 0.72rem;
      color: #C68BF8;
    }
    .dream-type-tag {
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
    .dream-nav-btn:hover { background: rgba(255,255,255,0.1); color: #e2e8f0; }
    .dream-dots {
      display: flex;
      gap: 6px;
      align-items: center;
    }
    .dream-dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: rgba(255,255,255,0.15);
      cursor: pointer;
      transition: background 0.2s;
    }
    .dream-dot.active { background: #C68BF8; }
    .dream-all-link {
      font-size: 0.78rem;
      color: #6ee7b7;
      text-decoration: none;
    }
    .dream-all-link:hover { color: #a7f3d0; }`;
  hn = hn.slice(0, si1) + newCSS + hn.slice(ei1 + cssEnd.length);
  c++;
  console.log('[OK] Dream CSS replaced');
}

// 2. Replace dream HTML
const htmlStart = '<div class="dream-card">';
const htmlEnd = '</div>\n      </div>\n    </section>';
const si2 = hn.indexOf(htmlStart, hn.indexOf('Latest Collective Dream'));
if (si2 !== -1) {
  // Find the closing </section> after dream-card
  const sectionEnd = hn.indexOf('</section>', si2);
  if (sectionEnd !== -1) {
    // Replace from dream-card start to just before </section>
    const newHTML = `<div class="dream-slideshow" id="dreamSlideshow">
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
      </div>
    </section>`;
    hn = hn.slice(0, si2) + newHTML + hn.slice(sectionEnd + '</section>'.length);
    c++;
    console.log('[OK] Dream HTML replaced');
  }
}

// 3. Replace dream JS
const jsStart = 'async function loadLatestDream()';
const jsEnd = 'loadLatestDream();';
const si3 = hn.indexOf(jsStart);
const ei3 = hn.indexOf(jsEnd);
if (si3 !== -1 && ei3 !== -1) {
  const newJS = `let dreamIdx = 0;
    let dreamAutoTimer = null;

    function showDreamSlide(idx) {
      const slides = document.querySelectorAll('#dreamSlides .dream-slide');
      const dots = document.querySelectorAll('#dreamDots .dream-dot');
      if (!slides.length) return;
      dreamIdx = ((idx % slides.length) + slides.length) % slides.length;
      slides.forEach(function(s, i) { s.classList.toggle('active', i === dreamIdx); });
      dots.forEach(function(d, i) { d.classList.toggle('active', i === dreamIdx); });
    }
    window.dreamPrev = function() { showDreamSlide(dreamIdx - 1); resetDreamAuto(); };
    window.dreamNext = function() { showDreamSlide(dreamIdx + 1); resetDreamAuto(); };
    function resetDreamAuto() {
      clearInterval(dreamAutoTimer);
      dreamAutoTimer = setInterval(function() { showDreamSlide(dreamIdx + 1); }, 8000);
    }

    async function loadDreamSlideshow() {
      try {
        var res = await fetch('/api/dreams?limit=8');
        var data = await res.json();
        var dreams = (data.dreams || []).filter(function(d) { return d.image_url; });
        if (!dreams.length) return;

        var slidesEl = document.getElementById('dreamSlides');
        var dotsEl = document.getElementById('dreamDots');

        slidesEl.innerHTML = dreams.map(function(d, i) {
          var excerpt = (d.content || '').substring(0, 160) + ((d.content || '').length > 160 ? '...' : '');
          var typeClass = d.type || 'hybrid';
          return '<div class="dream-slide' + (i === 0 ? ' active' : '') + '">' +
            '<img src="' + escapeHtml(d.image_url) + '" alt="Dream #' + d.id + '"' + (i < 2 ? '' : ' loading="lazy"') + '>' +
            '<div class="dream-slide-overlay">' +
              '<div class="dream-slide-meta">' +
                (d.mood ? '<span class="dream-mood-tag">' + escapeHtml(d.mood) + '</span>' : '') +
                '<span class="dream-type-tag ' + typeClass + '">' + typeClass + '</span>' +
                '<a href="/dreams" class="dream-all-link" style="margin-left:auto;">View all \\u2192</a>' +
              '</div>' +
              '<div class="dream-slide-text">' + escapeHtml(excerpt) + '</div>' +
            '</div>' +
          '</div>';
        }).join('');

        dotsEl.innerHTML = dreams.map(function(_, i) {
          return '<div class="dream-dot' + (i === 0 ? ' active' : '') + '" onclick="showDreamSlide(' + i + '); resetDreamAuto();"></div>';
        }).join('');

        dreamAutoTimer = setInterval(function() { showDreamSlide(dreamIdx + 1); }, 8000);
      } catch (e) { console.error('Dream slideshow:', e); }
    }
    loadDreamSlideshow();`;

  hn = hn.slice(0, si3) + newJS + hn.slice(ei3 + jsEnd.length);
  c++;
  console.log('[OK] Dream JS replaced');
}

if (c > 0) {
  fs.writeFileSync(fpath + '.backup-dreamshow-' + Date.now(), orig);
  fs.writeFileSync(fpath, hn);
  console.log('\nTotal changes: ' + c);
} else {
  console.log('\nNo changes made');
}
