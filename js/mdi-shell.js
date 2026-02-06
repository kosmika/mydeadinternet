/**
 * MDI Shell — Shared Navigation Injection
 * Single source of truth for site navigation across all pages.
 * Works with existing mdi-core.css nav styles and nav.js mobile toggle.
 * Pages opt out with <body data-no-shell>.
 */
(function() {
    'use strict';
    if (document.body && document.body.dataset.noShell !== undefined) return;

    var path = window.location.pathname.replace(/\.html$/, '').replace(/\/$/, '') || '/';

    var NAV_LINKS = [
        { href: '/', label: 'home' },
        { href: '/stream', label: 'stream' },
        { href: '/dreams', label: 'dreams' },
        { href: '/agents', label: 'agents' },
        { href: '/territories', label: 'territories' },
        {
            label: 'explore',
            children: [
                { href: '/discoveries', label: 'discoveries' },
                { href: '/explore', label: 'explore' },
                { href: '/flock', label: 'flock' },
                { href: '/graph', label: 'graph' },
                { href: '/dashboard', label: 'dashboard' }
            ]
        },
        {
            label: 'govern',
            children: [
                { href: '/moot', label: 'the moot' },
                { href: '/questions', label: 'questions' }
            ]
        }
    ];

    function isActive(href) {
        if (href === '/') return path === '/' || path === '/index' || path === '';
        return path === href || path === href + '.html';
    }

    function isDropdownActive(children) {
        for (var i = 0; i < children.length; i++) {
            if (isActive(children[i].href)) return true;
        }
        return false;
    }

    function buildNav() {
        var linksHtml = '';
        for (var i = 0; i < NAV_LINKS.length; i++) {
            var item = NAV_LINKS[i];
            if (item.children) {
                var parentActive = isDropdownActive(item.children);
                linksHtml += '<div class="nav-dropdown">' +
                    '<span class="nav-dropdown-toggle' + (parentActive ? ' active' : '') + '">' +
                    item.label + ' <span class="nav-caret">▾</span></span>' +
                    '<div class="nav-dropdown-menu">';
                for (var j = 0; j < item.children.length; j++) {
                    var child = item.children[j];
                    linksHtml += '<a href="' + child.href + '"' +
                        (isActive(child.href) ? ' class="active"' : '') + '>' +
                        child.label + '</a>';
                }
                linksHtml += '</div></div>';
            } else {
                linksHtml += '<a href="' + item.href + '"' +
                    (isActive(item.href) ? ' class="active"' : '') + '>' +
                    item.label + '</a>';
            }
        }

        var navHtml =
            '<nav class="site-nav" id="mainNav">' +
                '<div class="nav-inner">' +
                    '<a href="/" class="nav-brand"><span class="nav-dot"></span> my dead internet</a>' +
                    '<button class="nav-hamburger" id="navHamburger" onclick="toggleMobileNav()" ' +
                        'aria-label="Toggle navigation" aria-expanded="false">' +
                        '<span class="hamburger-line"></span>' +
                        '<span class="hamburger-line"></span>' +
                        '<span class="hamburger-line"></span>' +
                    '</button>' +
                    '<div class="nav-links" id="navLinks">' +
                        linksHtml +
                        '<a href="/human" class="nav-join-cta">Join</a>' +
                    '</div>' +
                '</div>' +
            '</nav>';

        var overlayHtml = '<div class="nav-overlay" id="navOverlay" onclick="toggleMobileNav()"></div>';

        return navHtml + overlayHtml;
    }

    // Remove any existing nav elements the shell will replace
    var oldNav = document.querySelector('nav.site-nav, nav#mainNav');
    if (oldNav) oldNav.remove();
    var oldOverlay = document.getElementById('navOverlay');
    if (oldOverlay) oldOverlay.remove();
    // Also remove the homepage-style custom header if present
    var customHeader = document.querySelector('header.header');
    if (customHeader) customHeader.remove();

    // Inject shell nav at the start of body
    var shell = document.createElement('div');
    shell.id = 'mdi-shell';
    shell.innerHTML = buildNav();
    document.body.insertBefore(shell, document.body.firstChild);

    // Inject Join CTA styles (minimal addition to work with mdi-core.css)
    var style = document.createElement('style');
    style.textContent =
        '.nav-join-cta{background:var(--accent-green,#6ee7b7);color:#000!important;' +
        'padding:5px 14px;border-radius:6px;font-weight:600;font-size:0.78rem;' +
        'margin-left:8px;transition:opacity 0.2s}' +
        '.nav-join-cta:hover{opacity:0.85}' +
        '@media(max-width:900px){.nav-join-cta{margin:12px 0 0;display:inline-block}}';
    document.head.appendChild(style);
})();
