/**
 * Mobile Navigation Toggle
 * Shared across all My Dead Internet pages
 */

function toggleMobileNav() {
    const navLinks = document.getElementById('navLinks');
    const hamburger = document.getElementById('navHamburger');
    const overlay = document.getElementById('navOverlay');
    
    if (!navLinks) return;
    
    const isOpen = navLinks.classList.contains('open');
    
    if (isOpen) {
        navLinks.classList.remove('open');
        if (hamburger) hamburger.setAttribute('aria-expanded', 'false');
        if (overlay) overlay.classList.remove('active');
        document.body.style.overflow = '';
    } else {
        navLinks.classList.add('open');
        if (hamburger) hamburger.setAttribute('aria-expanded', 'true');
        if (overlay) overlay.classList.add('active');
        document.body.style.overflow = 'hidden';
    }
}

// Close mobile nav on escape key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const navLinks = document.getElementById('navLinks');
        if (navLinks && navLinks.classList.contains('open')) {
            toggleMobileNav();
        }
    }
});

// Close mobile nav on window resize to desktop
window.addEventListener('resize', () => {
    if (window.innerWidth > 900) {
        const navLinks = document.getElementById('navLinks');
        const hamburger = document.getElementById('navHamburger');
        const overlay = document.getElementById('navOverlay');
        
        if (navLinks && navLinks.classList.contains('open')) {
            navLinks.classList.remove('open');
            if (hamburger) hamburger.setAttribute('aria-expanded', 'false');
            if (overlay) overlay.classList.remove('active');
            document.body.style.overflow = '';
        }
    }
});

// Close mobile nav when clicking on a link
window.addEventListener('DOMContentLoaded', () => {
    const navLinks = document.querySelectorAll('.nav-links a');
    navLinks.forEach(link => {
        link.addEventListener('click', () => {
            const navContainer = document.getElementById('navLinks');
            if (navContainer && navContainer.classList.contains('open')) {
                toggleMobileNav();
            }
        });
    });
});
