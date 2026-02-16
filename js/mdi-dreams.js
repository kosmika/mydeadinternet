/**
 * MDI Dream Slideshow Controller
 * Manages .dream-slide transitions, auto-advance, keyboard nav.
 * Self-contained IIFE — safe to load on any page.
 */
(function() {
  'use strict';

  var slides = document.querySelectorAll('.dream-slide');
  if (!slides.length) return; // No dream slideshow on this page

  var dots = document.querySelectorAll('.dream-dot');
  var threadItems = document.querySelectorAll('.dream-thread-item');
  var prevBtn = document.getElementById('dream-prev');
  var nextBtn = document.getElementById('dream-next');
  var progressBar = document.getElementById('dream-progress-bar');
  var current = 0;
  var total = slides.length;
  var AUTO_ADVANCE_MS = 12000;
  var autoTimer = null;
  var progressInterval = null;
  var progressStart = 0;

  function goToSlide(n) {
    slides.forEach(function(s) { s.classList.remove('active'); });
    dots.forEach(function(d) { d.classList.remove('active'); });
    threadItems.forEach(function(t) { t.classList.remove('thread-active'); });

    current = ((n % total) + total) % total;

    slides[current].classList.add('active');
    if (dots[current]) dots[current].classList.add('active');

    // Highlight matching thread items across all slides
    document.querySelectorAll('.dream-thread-item[data-goto="' + current + '"]')
      .forEach(function(t) { t.classList.add('thread-active'); });

    resetAutoAdvance();
  }

  function nextSlide() { goToSlide(current + 1); }
  function prevSlide() { goToSlide(current - 1); }

  // Progress bar animation
  function startProgress() {
    progressStart = Date.now();
    if (progressBar) progressBar.style.width = '0%';
    progressInterval = setInterval(function() {
      var elapsed = Date.now() - progressStart;
      var pct = Math.min((elapsed / AUTO_ADVANCE_MS) * 100, 100);
      if (progressBar) progressBar.style.width = pct + '%';
    }, 50);
  }

  function resetAutoAdvance() {
    clearTimeout(autoTimer);
    clearInterval(progressInterval);
    startProgress();
    autoTimer = setTimeout(nextSlide, AUTO_ADVANCE_MS);
  }

  // Button listeners
  if (nextBtn) nextBtn.addEventListener('click', nextSlide);
  if (prevBtn) prevBtn.addEventListener('click', prevSlide);

  // Dot listeners
  dots.forEach(function(dot) {
    dot.addEventListener('click', function() {
      goToSlide(parseInt(dot.dataset.slide, 10));
    });
  });

  // Thread item listeners
  threadItems.forEach(function(item) {
    item.addEventListener('click', function() {
      goToSlide(parseInt(item.dataset.goto, 10));
    });
  });

  // Keyboard navigation (only when dream section is visible)
  document.addEventListener('keydown', function(e) {
    var dreamSection = document.querySelector('.dream-showcase');
    if (!dreamSection) return;
    var rect = dreamSection.getBoundingClientRect();
    var inView = rect.top < window.innerHeight && rect.bottom > 0;
    if (!inView) return;
    if (e.key === 'ArrowRight') nextSlide();
    if (e.key === 'ArrowLeft') prevSlide();
  });

  // Pause on hover
  var showcase = document.querySelector('.dream-showcase');
  if (showcase) {
    showcase.addEventListener('mouseenter', function() {
      clearTimeout(autoTimer);
      clearInterval(progressInterval);
    });
    showcase.addEventListener('mouseleave', resetAutoAdvance);
  }

  // Respect reduced motion
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    clearTimeout(autoTimer);
    clearInterval(progressInterval);
  } else {
    resetAutoAdvance();
  }
})();
