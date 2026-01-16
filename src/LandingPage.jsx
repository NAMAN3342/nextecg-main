import React, { useState } from 'react'
import { motion } from 'framer-motion'
import { useNavigate } from 'react-router-dom'
import { useTheme } from './ThemeContext'

export default function LandingPage() {
  const [hoveredCard, setHoveredCard] = useState(null)
  const navigate = useNavigate()
  const { theme, themeName, toggleTheme } = useTheme()

  const medicalOptions = [
    {
      id: 1,
      title: '6-LEAD ECG',
      subtitle: 'Multi-lead Analysis',
      route: '/6-lead-ecg'
    },
    {
      id: 2,
      title: "HOW'S MY HEART",
      subtitle: 'Quick Assessment',
      route: '/hows-my-heart'
    },
    {
      id: 3,
      title: 'AI AGENT',
      subtitle: 'Neural Analysis',
      route: '#ai-agent'
    },
    {
      id: 4,
      title: 'POST SURGERY',
      subtitle: 'Recovery Monitor',
      route: '#post-surgery'
    }
  ]

  return (
    <div style={{
      minHeight: '100vh',
      background: theme.bg,
      color: theme.text,
      fontFamily: "'Inter', -apple-system, sans-serif",
      transition: 'background 0.3s ease, color 0.3s ease'
    }}>
      {/* Header */}
      <header style={{
        padding: '40px 60px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottom: `1px solid ${theme.border}`
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <span style={{
            fontSize: '24px',
            fontWeight: 600,
            letterSpacing: '6px',
            color: theme.text
          }}>
            NEXTECG
          </span>
          <span style={{
            fontSize: '10px',
            letterSpacing: '2px',
            color: theme.textMuted,
            padding: '4px 10px',
            border: `1px solid ${theme.border}`,
            marginLeft: '10px'
          }}>
            v2.0
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '24px' }}>
          {/* Theme Toggle Switch */}
          <div
            onClick={toggleTheme}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              cursor: 'pointer',
              padding: '8px 16px',
              borderRadius: '24px',
              border: `1px solid ${theme.border}`,
              background: theme.bgSecondary,
              transition: 'all 0.3s ease'
            }}
          >
            <span style={{
              fontSize: '10px',
              letterSpacing: '1px',
              color: theme.textSecondary,
              fontWeight: 500
            }}>
              {themeName === 'dark' ? '🌙 DARK' : '☀️ CREAM'}
            </span>
            {/* Toggle Track */}
            <div style={{
              width: '36px',
              height: '18px',
              borderRadius: '9px',
              background: themeName === 'dark' ? '#333' : '#D8D0C0',
              position: 'relative',
              transition: 'background 0.3s ease'
            }}>
              {/* Toggle Knob */}
              <div style={{
                width: '14px',
                height: '14px',
                borderRadius: '50%',
                background: theme.text,
                position: 'absolute',
                top: '2px',
                left: themeName === 'dark' ? '2px' : '20px',
                transition: 'left 0.3s ease'
              }} />
            </div>
          </div>

          {/* System Status */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            fontSize: '11px',
            letterSpacing: '1px',
            color: theme.textMuted
          }}>
            <span style={{
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              background: theme.statusActive
            }} />
            SYSTEM ACTIVE
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 'calc(100vh - 200px)',
        padding: '60px 40px'
      }}>

        {/* ECG Line */}
        <div style={{ marginBottom: '80px', opacity: 0.4 }}>
          <svg width="400" height="60" viewBox="0 0 400 60">
            <path
              d="M0,30 L120,30 L140,30 L150,15 L160,45 L170,5 L180,30 L200,30 L400,30"
              stroke={theme.text}
              strokeWidth="1"
              fill="none"
            />
          </svg>
        </div>

        {/* Options Grid */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: '2px',
          background: theme.border,
          maxWidth: '1000px',
          width: '100%'
        }}>
          {medicalOptions.map((option, index) => {
            const isComingSoon = option.route.startsWith('#')

            return (
              <motion.div
                key={option.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: index * 0.1 }}
                onClick={() => {
                  if (isComingSoon) {
                    alert('Coming Soon!')
                  } else {
                    navigate(option.route)
                  }
                }}
                onMouseEnter={() => setHoveredCard(option.id)}
                onMouseLeave={() => setHoveredCard(null)}
                style={{
                  background: hoveredCard === option.id ? theme.bgSecondary : theme.bg,
                  padding: '50px 30px',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease',
                  textAlign: 'center',
                  position: 'relative',
                  opacity: isComingSoon ? 0.6 : 1
                }}
              >
                {/* Number */}
                <div style={{
                  fontSize: '48px',
                  fontWeight: 200,
                  color: hoveredCard === option.id ? theme.text : theme.textMuted,
                  marginBottom: '20px',
                  transition: 'color 0.2s ease',
                  fontFamily: "'Space Mono', monospace"
                }}>
                  0{option.id}
                </div>

                {/* Title */}
                <div style={{
                  fontSize: '12px',
                  fontWeight: 500,
                  letterSpacing: '3px',
                  color: theme.text,
                  marginBottom: '8px'
                }}>
                  {option.title}
                </div>

                {/* Subtitle */}
                <div style={{
                  fontSize: '10px',
                  letterSpacing: '1px',
                  color: theme.textSecondary
                }}>
                  {option.subtitle}
                </div>

                {/* Coming Soon Badge */}
                {isComingSoon && (
                  <div style={{
                    position: 'absolute',
                    top: '12px',
                    right: '12px',
                    fontSize: '8px',
                    fontWeight: 600,
                    letterSpacing: '1px',
                    color: theme.textSecondary,
                    background: theme.bgTertiary,
                    padding: '4px 8px',
                    borderRadius: '4px'
                  }}>
                    SOON
                  </div>
                )}

                {/* Bottom line indicator */}
                <div style={{
                  position: 'absolute',
                  bottom: 0,
                  left: 0,
                  right: 0,
                  height: '2px',
                  background: hoveredCard === option.id ? theme.accent : 'transparent',
                  transition: 'background 0.2s ease'
                }} />
              </motion.div>
            )
          })}
        </div>

        {/* Bottom Info */}
        <div style={{
          marginTop: '80px',
          display: 'flex',
          gap: '60px',
          fontSize: '10px',
          letterSpacing: '2px',
          color: theme.textMuted
        }}>
          <span>99.8% ACCURACY</span>
          <span>FDA CLEARED</span>
          <span>CE CERTIFIED</span>
        </div>

      </main>

      {/* Footer */}
      <footer style={{
        padding: '30px 60px',
        borderTop: `1px solid ${theme.border}`,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        fontSize: '10px',
        letterSpacing: '1px',
        color: theme.textMuted
      }}>
        <span>© 2025 NEXTECG</span>
        <span>MEDICAL GRADE CARDIAC MONITORING</span>
      </footer>
    </div>
  )
}
