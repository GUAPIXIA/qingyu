/** @type {import('tailwindcss').Config} */

export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    container: {
      center: true,
    },
    extend: {
      colors: {
        // 轻语品牌色（通过 CSS 变量支持深色/浅色切换）
        tavern: {
          bg: 'var(--tavern-bg)',
          'bg-soft': 'var(--tavern-bg-soft)',
          'bg-card': 'var(--tavern-bg-card)',
          'bg-hover': 'var(--tavern-bg-hover)',
          border: 'var(--tavern-border)',
          'border-soft': 'var(--tavern-border-soft)',
          text: 'var(--tavern-text)',
          'text-soft': 'var(--tavern-text-soft)',
          'text-muted': 'var(--tavern-text-muted)',
          accent: 'var(--color-accent)',
          'accent-hover': 'var(--color-accent-hover)',
          'accent-soft': 'var(--color-accent-soft)',
          user: 'var(--tavern-user)',
          assistant: 'var(--tavern-assistant)',
          danger: 'var(--tavern-danger)',
          success: 'var(--tavern-success)',
          warning: 'var(--tavern-warning)',
        },
      },
      fontFamily: {
        sans: ['"Noto Sans SC"', '"Microsoft YaHei"', 'sans-serif'],
        display: ['"Cinzel"', 'serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
      },
      animation: {
        'fade-in-up': 'fadeInUp 0.3s ease-out',
        'fade-in': 'fadeIn 0.2s ease-out',
        'slide-in-right': 'slideInRight 0.3s ease-out',
        'pulse-soft': 'pulseSoft 2s ease-in-out infinite',
      },
      keyframes: {
        fadeInUp: {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideInRight: {
          '0%': { transform: 'translateX(100%)' },
          '100%': { transform: 'translateX(0)' },
        },
        pulseSoft: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.6' },
        },
      },
    },
  },
  plugins: [],
};
