# Design System Master File

> **LOGIC:** When building a specific page, first check `design-system/pages/[page-name].md`.
> If that file exists, its rules **override** this Master file.
> If not, strictly follow the rules below.

---

**Project:** ZSense
**Generated:** 2026-09-06
**Category:** RPA / Automation Dashboard
**Design Dials:** Variance 3/10 (Minimal) | Motion 3/10 (Subtle) | Density 7/10 (Compact Dashboard)

---

## Global Rules

### Color Palette

| Role | Hex | CSS Variable |
|------|-----|--------------|
| Primary | `#B4532A` | `--color-primary` |
| On Primary | `#FFFFFF` | `--color-on-primary` |
| Secondary | `#98431F` | `--color-secondary` |
| Accent/CTA | `#B4532A` | `--color-accent` |
| Background | `#F8F7F5` | `--color-background` |
| Card / Sidebar | `#FFFFFF` | `--color-surface` |
| Foreground | `#29231F` | `--color-foreground` |
| Muted | `#665E57` | `--color-muted` |
| Border | `#E8E1DA` | `--color-border` |
| Destructive | `#B13F34` | `--color-destructive` |
| Ring | `#B4532A` | `--color-ring` |

**Color Notes:** Warm white + terracotta + warm-neutral text. Green, blue, and amber are reserved for functional status and channel identity.

### Typography

- **Heading Font:** Inter
- **Body Font:** Inter
- **Mood:** light, calm, precise, clean, approachable, professional, low visual noise
- **Google Fonts:** [Inter + Inter](https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap)

**CSS Import:**
```css
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
```

### Spacing Variables

*Density: 8/10 — Dense / Dashboard*

| Token | Value | Usage |
|-------|-------|-------|
| `--space-xs` | `2px` / `0.125rem` | Tight gaps |
| `--space-sm` | `4px` / `0.25rem` | Icon gaps, inline spacing |
| `--space-md` | `8px` / `0.5rem` | Standard padding |
| `--space-lg` | `12px` / `0.75rem` | Section padding |
| `--space-xl` | `16px` / `1rem` | Large gaps |
| `--space-2xl` | `24px` / `1.5rem` | Section margins |
| `--space-3xl` | `32px` / `2rem` | Hero padding |

### Shadow Depths

| Level | Value | Usage |
|-------|-------|-------|
| `--shadow-sm` | `0 1px 2px rgba(0,0,0,0.05)` | Subtle lift |
| `--shadow-md` | `0 4px 6px rgba(0,0,0,0.1)` | Cards, buttons |
| `--shadow-lg` | `0 10px 15px rgba(0,0,0,0.1)` | Modals, dropdowns |
| `--shadow-xl` | `0 20px 25px rgba(0,0,0,0.15)` | Hero images, featured cards |

---

## Component Specs

### Buttons

```css
/* Primary Button */
.btn-primary {
  background: #B4532A;
  color: white;
  padding: 12px 24px;
  border-radius: 7px;
  font-weight: 600;
  transition: all 200ms ease;
  cursor: pointer;
}

.btn-primary:hover {
  opacity: 0.9;
  transform: translateY(-1px);
}

/* Secondary Button */
.btn-secondary {
  background: #FFFFFF;
  color: #98431F;
  border: 1px solid #D7CDC4;
  padding: 12px 24px;
  border-radius: 7px;
  font-weight: 600;
  transition: all 200ms ease;
  cursor: pointer;
}
```

### Cards

```css
.card {
  background: #FFFFFF;
  border: 1px solid #E8E1DA;
  border-radius: 10px;
  padding: 24px;
  box-shadow: none;
  transition: all 200ms ease;
  cursor: pointer;
}

.card:hover {
  border-color: #4A3E35;
}
```

### Inputs

```css
.input {
  padding: 12px 16px;
  border: 1px solid #E2E8F0;
  border-radius: 7px;
  font-size: 16px;
  transition: border-color 200ms ease;
}

.input:focus {
  border-color: #B4532A;
  outline: none;
  box-shadow: 0 0 0 3px #B4532A1C;
}
```

### Modals

```css
.modal-overlay {
  background: rgba(76, 61, 51, 0.24);
  backdrop-filter: blur(4px);
}

.modal {
  background: white;
  border-radius: 16px;
  padding: 32px;
  box-shadow: var(--shadow-xl);
  max-width: 500px;
  width: 90%;
}
```

---

## Style Guidelines

**Style:** Light Warm Minimal Operations Dashboard

**Keywords:** Warm white, terracotta accent, white cards, fine borders, low visual noise, compact information hierarchy

**Best For:** Business intelligence dashboards, financial analytics, enterprise reporting, operational dashboards, data warehousing

**Key Effects:** Subtle warm-gray row highlighting, visible focus rings, restrained 180ms transitions, no decorative glow or gradient

### Page Pattern

**Pattern Name:** Real-Time / Operations Landing

- **Conversion Strategy:** For ops/security/iot products. Demo or sandbox link. Trust signals.
- **CTA Placement:** Primary CTA in nav + After metrics
- **Section Order:** 1. Hero (product + live preview or status), 2. Key metrics/indicators, 3. How it works, 4. CTA (Start trial / Contact)

---

## Motion

**Parallax Scroll** (Standard) — Trigger: scroll (continuous) | Duration: tied to scroll position | Easing: `linear (scrub)`

```js
gsap.utils.toArray('.parallax-layer').forEach((layer, i) => { gsap.to(layer, { yPercent: (i + 1) * -8, ease: 'none', scrollTrigger: { trigger: layer.parentElement, scrub: 0.5 } }); });
```

**Framework notes:** Layer count beyond 3-4 has diminishing visual return and multiplies scroll-listener cost

- ✅ Vary speed per layer (background slowest, foreground fastest) to sell the depth illusion
- ❌ Don't let parallax layers overflow their container; clip with overflow: hidden on the wrapper
- ⚡ Batch all layers under one ScrollTrigger container where possible instead of one per layer

---

## Anti-Patterns (Do NOT Use)

- ❌ Neon purple as a global theme color
- ❌ Decorative gradients and glowing shadows
- ❌ Layout-shifting card hover effects
- ❌ Slow rendering

### Additional Forbidden Patterns

- ❌ **Emojis as icons** — Use SVG icons (Heroicons, Lucide, Simple Icons)
- ❌ **Missing cursor:pointer** — All clickable elements must have cursor:pointer
- ❌ **Layout-shifting hovers** — Avoid scale transforms that shift layout
- ❌ **Low contrast text** — Maintain 4.5:1 minimum contrast ratio
- ❌ **Instant state changes** — Always use transitions (150-300ms)
- ❌ **Invisible focus states** — Focus states must be visible for a11y

---

## Pre-Delivery Checklist

Before delivering any UI code, verify:

- [ ] No emojis used as icons (use SVG instead)
- [ ] All icons from consistent icon set (Heroicons/Lucide)
- [ ] `cursor-pointer` on all clickable elements
- [ ] Hover states with smooth transitions (150-300ms)
- [ ] Light mode: text contrast 4.5:1 minimum
- [ ] Focus states visible for keyboard navigation
- [ ] `prefers-reduced-motion` respected
- [ ] Responsive: 375px, 768px, 1024px, 1440px
- [ ] No content hidden behind fixed navbars
- [ ] No horizontal scroll on mobile
