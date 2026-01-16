import React, { useState } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { ThemeProvider } from './ThemeContext'
import SplashScreen from './SplashScreen'
import LandingPage from './LandingPage'
import SixLeadECGPage from './pages/SixLeadECG/index'
import HowsMyHeart from './pages/HowsMyHeart/HowsMyHeart'

function MainApp() {
  const [showSplash, setShowSplash] = useState(true)

  if (showSplash) {
    return <SplashScreen onComplete={() => setShowSplash(false)} />
  }

  return <LandingPage />
}

export default function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<MainApp />} />
          <Route path="/6-lead-ecg" element={<SixLeadECGPage />} />
          <Route path="/hows-my-heart" element={<HowsMyHeart />} />
        </Routes>
      </BrowserRouter>
    </ThemeProvider>
  )
}
