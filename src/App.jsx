import React, { useState } from 'react'
import { BrowserRouter, HashRouter, Routes, Route } from 'react-router-dom'
import SplashScreen from './SplashScreen'
import LandingPage from './LandingPage'
import ECGVisualizer from './pages/SixLeadECG/ECGVisualizer'
import HowsMyHeart from './pages/HowsMyHeart/HowsMyHeart'

function MainApp() {
  const [showSplash, setShowSplash] = useState(true)

  if (showSplash) {
    return <SplashScreen onComplete={() => setShowSplash(false)} />
  }

  return <LandingPage />
}

export default function App() {
  const isCapacitor = typeof window !== 'undefined' && window.Capacitor !== undefined
  const Router = isCapacitor ? HashRouter : BrowserRouter
  return (
    <Router>
      <Routes>
        <Route path="/" element={<MainApp />} />
        <Route path="/6-lead-ecg" element={<ECGVisualizer />} />
        <Route path="/hows-my-heart" element={<HowsMyHeart />} />
      </Routes>
    </Router>
  )
}
