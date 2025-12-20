import React, { useState } from 'react'
import { motion } from 'framer-motion'
import { useNavigate } from 'react-router-dom'

export default function LandingPage() {
  const navigate = useNavigate()
  const [hoveredCard, setHoveredCard] = useState(null)

  const medicalOptions = [
    {
      id: 1,
      title: '6-LEAD ECG',
      subtitle: 'Multi-lead Analysis',
      path: '/6-lead-ecg'
    },
    {
      id: 2,
      title: "HOW'S MY HEART",
      subtitle: 'Quick Assessment',
      path: '/hows-my-heart'
    },
    {
      id: 3,
      title: 'AI AGENT',
      subtitle: 'Neural Analysis',
      path: '/ai-agent'
    },
    {
      id: 4,
      title: 'POST SURGERY',
      subtitle: 'Recovery Monitor',
      path: '/post-surgery'
    }
  ]

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0a0a0a',
      color: '#fff',
      fontFamily: "'Inter', -apple-system, sans-serif"
    }}>
      {/* Header */}
      <header style={{
        padding: '40px 60px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottom: '1px solid #1a1a1a'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <span style={{
            fontSize: '24px',
            fontWeight: 600,
            letterSpacing: '6px',
            color: '#fff'
          }}>
            NEXTECG
          </span>
          <span style={{
            fontSize: '10px',
            letterSpacing: '2px',
            color: '#444',
            padding: '4px 10px',
            border: '1px solid #222',
            marginLeft: '10px'
          }}>
            v2.0
          </span>
        </div>
        
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          fontSize: '11px',
          letterSpacing: '1px',
          color: '#444'
        }}>
          <span style={{
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            background: '#4ade80'
          }} />
          SYSTEM ACTIVE
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
              stroke="#fff"
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
          background: '#1a1a1a',
          maxWidth: '1000px',
          width: '100%'
        }}>
          {medicalOptions.map((option, index) => (
            <motion.div
              key={option.id}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: index * 0.1 }}
              onClick={() => navigate(option.path)}
              onMouseEnter={() => setHoveredCard(option.id)}
              onMouseLeave={() => setHoveredCard(null)}
              style={{
                background: hoveredCard === option.id ? '#141414' : '#0a0a0a',
                padding: '50px 30px',
                cursor: 'pointer',
                transition: 'all 0.2s ease',
                textAlign: 'center',
                position: 'relative'
              }}
            >
              {/* Number */}
              <div style={{
                fontSize: '48px',
                fontWeight: 200,
                color: hoveredCard === option.id ? '#fff' : '#333',
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
                color: '#fff',
                marginBottom: '8px'
              }}>
                {option.title}
              </div>

              {/* Subtitle */}
              <div style={{
                fontSize: '10px',
                letterSpacing: '1px',
                color: '#555'
              }}>
                {option.subtitle}
              </div>

              {/* Bottom line indicator */}
              <div style={{
                position: 'absolute',
                bottom: 0,
                left: 0,
                right: 0,
                height: '2px',
                background: hoveredCard === option.id ? '#fff' : 'transparent',
                transition: 'background 0.2s ease'
              }} />
            </motion.div>
          ))}
        </div>

        {/* Bottom Info */}
        <div style={{
          marginTop: '80px',
          display: 'flex',
          gap: '60px',
          fontSize: '10px',
          letterSpacing: '2px',
          color: '#333'
        }}>
          <span>99.8% ACCURACY</span>
          <span>FDA CLEARED</span>
          <span>CE CERTIFIED</span>
        </div>

      </main>

      {/* Footer */}
      <footer style={{
        padding: '30px 60px',
        borderTop: '1px solid #1a1a1a',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        fontSize: '10px',
        letterSpacing: '1px',
        color: '#333'
      }}>
        <span>© 2025 NEXTECG</span>
        <span>MEDICAL GRADE CARDIAC MONITORING</span>
      </footer>
    </div>
  )
}
