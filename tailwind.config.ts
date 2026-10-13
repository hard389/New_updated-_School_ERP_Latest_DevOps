import type { Config } from "tailwindcss";

export default {
  darkMode: ["class"],
  content: ["./pages/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./app/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}"],
  prefix: "",
  theme: {
    container: {
      center: true,
      padding: '2rem',
      screens: {
        '2xl': '1400px'
      }
    },
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))'
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))'
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))'
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))'
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))'
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))'
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))'
        },
        sidebar: {
          DEFAULT: 'hsl(var(--sidebar-background))',
          foreground: 'hsl(var(--sidebar-foreground))',
          primary: 'hsl(var(--sidebar-primary))',
          'primary-foreground': 'hsl(var(--sidebar-primary-foreground))',
          accent: 'hsl(var(--sidebar-accent))',
          'accent-foreground': 'hsl(var(--sidebar-accent-foreground))',
          border: 'hsl(var(--sidebar-border))',
          ring: 'hsl(var(--sidebar-ring))'
        }
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 4px)',
        sm: 'calc(var(--radius) - 8px)',
        xl: 'calc(var(--radius) + 4px)',
        '2xl': 'calc(var(--radius) + 8px)',
        '3xl': 'calc(var(--radius) + 16px)'
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0', opacity: '0' },
          to: { height: 'var(--radix-accordion-content-height)', opacity: '1' }
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)', opacity: '1' },
          to: { height: '0', opacity: '0' }
        },
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(8px) scale(0.98)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' }
        },
        'fade-out': {
          from: { opacity: '1', transform: 'translateY(0) scale(1)' },
          to: { opacity: '0', transform: 'translateY(8px) scale(0.98)' }
        },
        'slide-in-right': {
          from: { transform: 'translateX(100%)', opacity: '0' },
          to: { transform: 'translateX(0)', opacity: '1' }
        },
        'slide-out-right': {
          from: { transform: 'translateX(0)', opacity: '1' },
          to: { transform: 'translateX(100%)', opacity: '0' }
        },
        'scale-in': {
          from: { transform: 'scale(0.95)', opacity: '0' },
          to: { transform: 'scale(1)', opacity: '1' }
        },
        'scale-out': {
          from: { transform: 'scale(1)', opacity: '1' },
          to: { transform: 'scale(0.95)', opacity: '0' }
        },
        'blur-in': {
          from: { opacity: '0', filter: 'blur(10px)' },
          to: { opacity: '1', filter: 'blur(0)' }
        },
        'glow-pulse': {
          '0%, 100%': { boxShadow: '0 0 20px hsl(var(--primary) / 0.3)' },
          '50%': { boxShadow: '0 0 40px hsl(var(--primary) / 0.5)' }
        },
        'shimmer': {
          from: { backgroundPosition: '-200% 0' },
          to: { backgroundPosition: '200% 0' }
        },
        'float': {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-5px)' }
        }
      },
      animation: {
        'accordion-down': 'accordion-down 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
        'accordion-up': 'accordion-up 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
        'fade-in': 'fade-in 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
        'fade-out': 'fade-out 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-in-right': 'slide-in-right 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-out-right': 'slide-out-right 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
        'scale-in': 'scale-in 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
        'scale-out': 'scale-out 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
        'blur-in': 'blur-in 0.5s cubic-bezier(0.16, 1, 0.3, 1)',
        'glow-pulse': 'glow-pulse 2s ease-in-out infinite',
        'shimmer': 'shimmer 2s infinite',
        'float': 'float 3s ease-in-out infinite',
        'enter': 'fade-in 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
        'exit': 'fade-out 0.3s cubic-bezier(0.16, 1, 0.3, 1)'
      },
      fontFamily: {
        sans: [
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          'SF Pro Display',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif'
        ],
        serif: [
          'Georgia',
          'Times New Roman',
          'serif'
        ],
        mono: [
          'SF Mono',
          'Monaco',
          'Consolas',
          'Liberation Mono',
          'Courier New',
          'monospace'
        ]
      },
      boxShadow: {
        '2xs': 'var(--shadow-2xs)',
        'xs': 'var(--shadow-xs)',
        'sm': 'var(--shadow-sm)',
        'DEFAULT': 'var(--shadow)',
        'md': 'var(--shadow-md)',
        'lg': 'var(--shadow-lg)',
        'xl': 'var(--shadow-xl)',
        '2xl': 'var(--shadow-2xl)',
        'glass': '0 8px 32px 0 rgba(31, 38, 135, 0.15)',
        'glass-lg': '0 16px 48px 0 rgba(31, 38, 135, 0.2)',
        'glow': '0 0 30px hsl(var(--primary) / 0.3)',
        'glow-lg': '0 0 50px hsl(var(--primary) / 0.4)'
      },
      backdropBlur: {
        'xs': '2px',
        '3xl': '64px'
      },
      transitionTimingFunction: {
        'ios': 'cubic-bezier(0.16, 1, 0.3, 1)',
        'bounce-in': 'cubic-bezier(0.68, -0.55, 0.265, 1.55)'
      }
    }
  },
  plugins: [require("tailwindcss-animate")],
} satisfies Config;
