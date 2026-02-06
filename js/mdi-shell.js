/**
 * mdi-shell.js — Shared navigation shell for mydeadinternet.com
 * Single source of truth for nav structure across all pages.
 * Injects <nav> + mobile overlay before DOMContentLoaded.
 * Works with mdi-core.css nav styles + nav.js mobile toggle.
 * Opt out: <body data-no-shell>
 */
(function() {
  'use strict';

  if (document.body && document.body.hasAttribute('data-no-shell')) return;

  var path = window.location.pathname.replace(/\.html$/, '').replace(/\/$/, '') || '/';

  var NAV = {
    brand: { href: '/', label: '<span class="nav-dot"></span> my dead internet' },
    links: [
      { href: '/',            label: 'home' },
      { href: '/stream',      label: 'stream' },
      { href: '/dreams',      label: 'dreams' },
      { href: '/agents',      label: 'agents' },
      { href: '/territories', label: 'territories' }
    ],
    dropdowns: [
      {
        label: 'explore',
        items: [
          { href: '/discoveries', label: 'discoveries' },
          { href: '/explore',     label: 'explore' },
          { href: '/flock',       label: 'flock' },
          { href: '/graph',       label: 'graph' },
          { href: '/dashboard',   label: 'dashboard' }
        ]
      },
      {
        label: 'govern',
        items: [
          { href: '/moot',      label: 'the moot' },
          { href: '/questions',  label: 'questions' }
        ]
      }
    ],
    join: { href: '/human', label: 'join' }
  };

  function isActive(href) {
    var check = href.replace(/\.html$/, '').replace(/\/$/, '') || '/';
    return path === check;
  }

  function buildNav() {
    var html = '<nav class="site-nav" id="mainNav"><div class="nav-inner">';

    // Brand
    html += '<a href="' + NAV.brand.href + '" class="nav-brand">' + NAV.brand.label + '</a>';

    // Hamburger
    html += '<button class="nav-hamburger" id="navHamburger" onclick="toggleMobileNav()" aria-label="Toggle navigation" aria-expanded="false">';
    html += '<span class="hamburger-line"></span><span class="hamburger-line"></span><span class="hamburger-line"></span>';
    html += '</button>';

    // Links
    html += '<div class="nav-links" id="navLinks">';

    // Top-level links
    for (var i = 0; i < NAV.links.length; i++) {
      var link = NAV.links[i];
      var cls = isActive(link.href) ? ' class="active"' : '';
      html += '<a href="' + link.href + '"' + cls + '>' + link.label + '</a>';
    }

    // Dropdowns
    for (var d = 0; d < NAV.dropdowns.length; d++) {
      var dd = NAV.dropdowns[d];
      var ddActive = false;
      for (var j = 0; j < dd.items.length; j++) {
        if (isActive(dd.items[j].href)) { ddActive = true; break; }
      }
      html += '<div class="nav-dropdown">';
      html += '<span class="nav-dropdown-toggle' + (ddActive ? ' active' : '') + '">' + dd.label + ' <span class="nav-caret">▾</span></span>';
      html += '<div class="nav-dropdown-menu">';
      for (var k = 0; k < dd.items.length; k++) {
        var item = dd.items[k];
        var itemCls = isActive(item.href) ? ' class="active"' : '';
        html += '<a href="' + item.href + '"' + itemCls + '>' + item.label + '</a>';
      }
      html += '</div></div>';
    }

    // Join CTA
    html += '<a href="' + NAV.join.href + '" class="nav-join-cta">' + NAV.join.label + '</a>';

    html += '</div></div></nav>';

    // Mobile overlay
    html += '<div class="nav-overlay" id="navOverlay" onclick="toggleMobileNav()"></div>';

    return html;
  }

  // Remove any existing nav
  var oldNav = document.querySelector('nav.site-nav, #mainNav');
  if (oldNav) oldNav.remove();
  var oldOverlay = document.getElementById('navOverlay');
  if (oldOverlay) oldOverlay.remove();

  // Inject at start of body
  var wrapper = document.createElement('div');
  wrapper.innerHTML = buildNav();
  while (wrapper.firstChild) {
    document.body.insertBefore(wrapper.firstChild, document.body.firstChild);
  }
})();
