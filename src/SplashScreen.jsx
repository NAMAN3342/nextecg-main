import React, { useEffect, useState } from 'react'

export default function SplashScreen({ onComplete }) {
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    const interval = setInterval(() => {
      setProgress(prev => {
        if (prev >= 100) {
          clearInterval(interval)
          setTimeout(() => onComplete(), 300)
          return 100
        }
        return prev + 4
      })
    }, 40)

    return () => clearInterval(interval)
  }, [onComplete])

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      width: '100%',
      height: '100vh',
      background: '#0a0a0a',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 9999
    }}>
      {/* Logo */}
      <div style={{
        fontSize: '32px',
        fontWeight: 600,
        letterSpacing: '8px',
        color: '#fff',
        marginBottom: '60px'
      }}>
        NEXTECG
      </div>

      {/* ECG Line */}
      <svg width="300" height="40" viewBox="0 0 300 40" style={{ marginBottom: '40px' }}>
        <path
          d="M0,20 L80,20 L100,20 L110,8 L120,32 L130,2 L140,20 L160,20 L300,20"
          stroke="#fff"
          strokeWidth="1"
          fill="none"
          opacity="0.5"
        />
      </svg>

      {/* Progress Bar */}
      <div style={{
        width: '200px',
        height: '1px',
        background: '#222',
        marginBottom: '20px'
      }}>
        <div style={{
          width: `${progress}%`,
          height: '100%',
          background: '#fff',
          transition: 'width 0.1s ease'
        }} />
      </div>

      {/* Progress Text */}
      <div style={{
        fontSize: '11px',
        letterSpacing: '2px',
        color: '#444'
      }}>
        {progress}%
      </div>
    </div>
  )
}
