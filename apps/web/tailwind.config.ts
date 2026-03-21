import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Brand — electric violet-indigo
        brand: {
          50:  "#f0eeff",
          100: "#e3deff",
          200: "#cbbfff",
          300: "#aa97fd",
          400: "#8b6bf8",
          500: "#7c3aed", // primary
          600: "#6d28d9",
          700: "#5b21b6",
          800: "#4c1d95",
          900: "#2e1065",
        },
        // Neutral — slate-based (not generic grey)
        surface: {
          0:  "hsl(var(--surface-0))",
          1:  "hsl(var(--surface-1))",
          2:  "hsl(var(--surface-2))",
          3:  "hsl(var(--surface-3))",
        },
        border:   "hsl(var(--border))",
        ring:     "hsl(var(--ring))",
        text: {
          primary:   "hsl(var(--text-primary))",
          secondary: "hsl(var(--text-secondary))",
          tertiary:  "hsl(var(--text-tertiary))",
        },
        // Status
        success: { DEFAULT: "#10B981", light: "#D1FAE5" },
        warning: { DEFAULT: "#F59E0B", light: "#FEF3C7" },
        danger:  { DEFAULT: "#EF4444", light: "#FEE2E2" },
        info:    { DEFAULT: "#3B82F6", light: "#DBEAFE" },
      },
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
        mono: ["var(--font-jetbrains)", "ui-monospace", "monospace"],
      },
      fontSize: {
        "2xs": ["0.625rem", { lineHeight: "0.875rem" }],
      },
      borderRadius: {
        "4xl": "2rem",
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0" },
          to:   { opacity: "1" },
        },
        "slide-up": {
          from: { opacity: "0", transform: "translateY(8px)" },
          to:   { opacity: "1", transform: "translateY(0)" },
        },
        "slide-in-right": {
          from: { opacity: "0", transform: "translateX(16px)" },
          to:   { opacity: "1", transform: "translateX(0)" },
        },
        shimmer: {
          "0%":   { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        "pulse-dot": {
          "0%, 100%": { opacity: "1" },
          "50%":       { opacity: "0.4" },
        },
      },
      animation: {
        "fade-in":       "fade-in 0.2s ease-out",
        "slide-up":      "slide-up 0.25s ease-out",
        "slide-in-right":"slide-in-right 0.25s ease-out",
        shimmer:         "shimmer 2s linear infinite",
        "pulse-dot":     "pulse-dot 1.5s ease-in-out infinite",
      },
      boxShadow: {
        "elevation-1": "0 1px 3px 0 rgb(0 0 0 / 0.08), 0 1px 2px -1px rgb(0 0 0 / 0.06)",
        "elevation-2": "0 4px 12px -2px rgb(0 0 0 / 0.12), 0 2px 6px -2px rgb(0 0 0 / 0.06)",
        "elevation-3": "0 8px 24px -4px rgb(0 0 0 / 0.16), 0 4px 10px -4px rgb(0 0 0 / 0.08)",
        "brand-glow":  "0 0 0 3px rgb(124 58 237 / 0.25)",
        "brand-glow-sm": "0 0 0 2px rgb(124 58 237 / 0.20)",
      },
    },
  },
  plugins: [],
};

export default config;
