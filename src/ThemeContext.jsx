import React, { createContext, useContext, useState, useEffect } from 'react'

// Theme definitions
export const themes = {
    dark: {
        name: 'dark',
        bg: '#0a0a0a',
        bgSecondary: '#141414',
        bgTertiary: '#1a1a1a',
        text: '#fff',
        textSecondary: '#888',
        textMuted: '#444',
        border: '#1a1a1a',
        accent: '#fff',
        progressBg: '#222',
        statusActive: '#4ade80'
    },
    cream: {
        name: 'cream',
        bg: '#F5F0E6',
        bgSecondary: '#EDE6D6',
        bgTertiary: '#E8E0D0',
        text: '#1a1a1a',
        textSecondary: '#5a5040',
        textMuted: '#8a8070',
        border: '#D8D0C0',
        accent: '#1a1a1a',
        progressBg: '#D8D0C0',
        statusActive: '#059669'
    }
}

const ThemeContext = createContext()

export function ThemeProvider({ children }) {
    const [themeName, setThemeName] = useState(() => {
        // Load saved theme from localStorage
        const saved = localStorage.getItem('nextecg-theme')
        return saved || 'dark'
    })

    const theme = themes[themeName]

    const toggleTheme = () => {
        const newTheme = themeName === 'dark' ? 'cream' : 'dark'
        setThemeName(newTheme)
        localStorage.setItem('nextecg-theme', newTheme)
    }

    return (
        <ThemeContext.Provider value={{ theme, themeName, toggleTheme }}>
            {children}
        </ThemeContext.Provider>
    )
}

export function useTheme() {
    const context = useContext(ThemeContext)
    if (!context) {
        throw new Error('useTheme must be used within a ThemeProvider')
    }
    return context
}
